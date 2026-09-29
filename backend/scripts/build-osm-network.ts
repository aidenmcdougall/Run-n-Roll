/**
 * Merges OpenStreetMap ways (loaded into `osm.ways` by `npm run osm:load`)
 * into the routing network:
 *
 *   1. Coverage: clusters the DTP bike network into regions and buffers
 *      them. OSM ways are only imported within these areas, so the network
 *      stays focused on where the core dataset is (and fits in memory).
 *   2. Gap filling: every routable OSM way in coverage becomes a `paths` row
 *      (source 'osm'), except ways the DTP data already represents in full.
 *   3. Enrichment: DTP rows get OSM surface/smoothness/tags via `osm_id`.
 *
 * Runs in a single transaction, so it is idempotent and can be re-run after
 * refreshing either dataset.
 *
 * Usage: npm run osm:build
 */
import type { PoolClient } from 'pg';
import { pool } from '../src/db/pool.js';
import { waitForDatabase } from '../src/db/waitForDatabase.js';
import { classifyOsmWay, type OsmTags } from '../src/domain/osm.js';
import { BIN_SOURCE, OSM_SOURCE } from './dataset.js';
import { enrichDtpPathsFromOsm } from './osm-enrichment.js';
import { readOsmMetadata } from './osm-metadata.js';

const FETCH_SIZE = 10_000;

/** Buffer around each DTP cluster's convex hull, in metres. */
const COVERAGE_BUFFER_M = 1000;

/**
 * DTP segments closer than this (in EPSG:3857 units, ~0.79 real metres per
 * unit at Melbourne's latitude) are clustered into the same coverage region.
 */
const CLUSTER_EPS_3857 = 3000;

/** An OSM way is skipped if DTP rows with its ID cover this share of its length. */
const DTP_COVERAGE_THRESHOLD = 0.9;

async function rebuildCoverage(client: PoolClient): Promise<number> {
  await client.query('DELETE FROM coverage_areas');
  const { rowCount } = await client.query(
    `INSERT INTO coverage_areas (geom)
     SELECT (ST_Dump(ST_Union(ST_Buffer(hull::geography, $2)::geometry))).geom
     FROM (
       SELECT ST_ConvexHull(ST_Collect(geom)) AS hull
       FROM (
         SELECT geom, ST_ClusterDBSCAN(geom_3857, eps := $3, minpoints := 1) OVER () AS cid
         FROM paths WHERE source = $1
       ) AS clustered
       GROUP BY cid
     ) AS hulls`,
    [BIN_SOURCE, COVERAGE_BUFFER_M, CLUSTER_EPS_3857],
  );
  return rowCount ?? 0;
}

interface WayRow {
  way_id: number;
  tags: OsmTags;
}

// Geometry is copied inside the database by joining back on way_id, so only
// tags cross the wire to Node for classification.
const INSERT_SQL = `
  INSERT INTO paths (
    source, import_id, osm_id, name, infra_type, infra_category, highway_type,
    surface, smoothness, width_m, hazards, direction, properties, osm_tags, geom, length_m
  )
  SELECT
    $2, $3, w.way_id, r.name, 'OSM highway=' || w.highway, r.category, w.highway,
    r.surface, r.smoothness, r.width_m, '{}', r.direction, '{}', w.tags, -- tags stored once, in osm_tags
    w.geom, ST_Length(w.geom::geography)
  FROM jsonb_to_recordset($1::jsonb) AS r(
    way_id bigint, name text, category text, surface text, smoothness text,
    width_m real, direction text
  )
  JOIN osm.ways w ON w.way_id = r.way_id
  WHERE ST_NPoints(w.geom) >= 2
`;

async function build(): Promise<void> {
  await waitForDatabase(pool);
  const client = await pool.connect();
  try {
    const { rows: exists } = await client.query<{ ok: boolean }>(`SELECT to_regclass('osm.ways') IS NOT NULL AS ok`);
    if (!exists[0]?.ok) throw new Error('osm.ways not found. Run `npm run osm:load` first.');
    const metadata = await readOsmMetadata();

    await client.query('BEGIN');

    const areas = await rebuildCoverage(client);
    console.log(`Coverage: ${areas} area(s) around the DTP network.`);

    const { rows: importRows } = await client.query<{ id: number }>(
      `INSERT INTO dataset_imports (source, source_url, file_sha256, feature_count, path_count)
       VALUES ($1, $2, $3, 0, 0) RETURNING id`,
      [OSM_SOURCE, metadata?.url ?? null, metadata?.sha256 ?? 'unknown'],
    );
    const importId = importRows[0]!.id;

    const deleted = await client.query('DELETE FROM paths WHERE source = $1', [OSM_SOURCE]);
    console.log(`Removed ${deleted.rowCount ?? 0} OSM paths from the previous build.`);

    // Length of each OSM way already represented by DTP rows. ST_Union
    // dissolves the per-direction duplicates DTP has for on-road lanes.
    await client.query(
      `CREATE TEMP TABLE dtp_way_coverage ON COMMIT DROP AS
       SELECT osm_id, ST_Length(ST_Union(geom)::geography) AS covered_m
       FROM paths WHERE source = $1 AND osm_id IS NOT NULL GROUP BY osm_id`,
      [BIN_SOURCE],
    );
    await client.query('CREATE INDEX ON dtp_way_coverage (osm_id)');

    await client.query(
      `DECLARE candidate_ways NO SCROLL CURSOR FOR
       SELECT w.way_id, w.tags
       FROM osm.ways w
       WHERE EXISTS (SELECT 1 FROM coverage_areas c WHERE ST_Intersects(w.geom, c.geom))
         AND NOT EXISTS (
           SELECT 1 FROM dtp_way_coverage d
           WHERE d.osm_id = w.way_id AND d.covered_m >= $1 * ST_Length(w.geom::geography)
         )`,
      [DTP_COVERAGE_THRESHOLD],
    );

    let candidates = 0;
    let inserted = 0;
    const skipped = new Map<string, number>();
    for (;;) {
      const { rows } = await client.query<WayRow>(`FETCH ${FETCH_SIZE} FROM candidate_ways`);
      if (rows.length === 0) break;
      candidates += rows.length;

      const records = [];
      for (const row of rows) {
        const way = classifyOsmWay(row.tags);
        if (!way) {
          const key = row.tags.highway ?? 'unknown';
          skipped.set(key, (skipped.get(key) ?? 0) + 1);
          continue;
        }
        records.push({
          way_id: row.way_id,
          name: way.name,
          category: way.category,
          surface: way.surface,
          smoothness: way.smoothness,
          width_m: way.widthM,
          direction: way.direction,
        });
      }
      if (records.length > 0) {
        const result = await client.query(INSERT_SQL, [JSON.stringify(records), OSM_SOURCE, importId]);
        inserted += result.rowCount ?? 0;
      }
      process.stdout.write(`\rClassified ${candidates} OSM ways, inserted ${inserted}...`);
    }
    process.stdout.write('\n');
    await client.query('CLOSE candidate_ways');

    const enriched = await enrichDtpPathsFromOsm(client);

    await client.query(
      'UPDATE dataset_imports SET feature_count = $1, path_count = $2 WHERE id = $3',
      [candidates, inserted, importId],
    );
    await client.query('COMMIT');
    await client.query('ANALYZE paths');

    const skippedSummary = [...skipped].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
    console.log(`Skipped (not routable): ${skippedSummary.join(', ') || 'none'}`);
    console.log(`Enriched ${enriched} DTP paths with OSM surface data.`);
    console.log(`OSM build #${importId} complete: ${inserted} paths. Restart the API to load the new network.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

build().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
