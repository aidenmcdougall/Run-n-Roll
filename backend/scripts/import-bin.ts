/**
 * Imports the DTP Bicycle Infrastructure Network GeoJSON into PostGIS.
 *
 * The import is idempotent: inside a single transaction it removes every path
 * from the previous import of this source and inserts the new ones, so the
 * dataset can be refreshed at any time and readers never see a partial load.
 *
 * Usage: npm run data:import [-- <path-to-geojson>]
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../src/db/pool.js';
import { waitForDatabase } from '../src/db/waitForDatabase.js';
import { categoriseInfraType, parseHazards } from '../src/domain/infrastructure.js';
import { BIN_LOCAL_PATH, BIN_SOURCE } from './dataset.js';

const BATCH_SIZE = 2000;

// Validate the shape we depend on; unknown extra properties are preserved.
const PropertiesSchema = z.looseObject({
  OsmID: z.number().int().nullable().optional(),
  InfraType: z.string(),
  Name: z.string().nullable().optional(),
  HwyType: z.string().nullable().optional(),
  Width: z.number().nullable().optional(),
  Hazards: z.string().nullable().optional(),
  DirRelToWay: z.string().nullable().optional(),
  DirCardinal: z.string().nullable().optional(),
});

const FeatureSchema = z.object({
  type: z.literal('Feature'),
  properties: PropertiesSchema,
  geometry: z.object({
    type: z.enum(['LineString', 'MultiLineString']),
    coordinates: z.array(z.unknown()),
  }),
});

const FeatureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
});

interface PathRecord {
  osm_id: number | null;
  name: string | null;
  infra_type: string;
  infra_category: string;
  highway_type: string | null;
  width_m: number | null;
  hazards: string[];
  direction: 'both' | 'forward' | 'reverse';
  direction_cardinal: string | null;
  properties: Record<string, unknown>;
  geometry: unknown;
}

/** Treats empty strings and the literal string "null" (present in the data) as missing. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.toLowerCase() !== 'null' ? trimmed : null;
}

function toDirection(value: string | null | undefined): PathRecord['direction'] {
  const lower = clean(value)?.toLowerCase();
  return lower === 'forward' || lower === 'reverse' ? lower : 'both';
}

function toRecord(feature: z.infer<typeof FeatureSchema>): PathRecord {
  const p = feature.properties;
  return {
    osm_id: p.OsmID ?? null,
    name: clean(p.Name),
    infra_type: p.InfraType,
    infra_category: categoriseInfraType(p.InfraType),
    highway_type: clean(p.HwyType)?.toLowerCase() ?? null,
    width_m: p.Width != null && p.Width > 0 ? p.Width : null,
    hazards: parseHazards(p.Hazards),
    direction: toDirection(p.DirRelToWay),
    direction_cardinal: clean(p.DirCardinal),
    properties: p,
    geometry: feature.geometry,
  };
}

// Multi-part geometries are exploded into one row per LineString (ST_Dump).
// Lengths are measured on the WGS84 spheroid by casting to geography.
const INSERT_SQL = `
  INSERT INTO paths (
    source, import_id, osm_id, name, infra_type, infra_category, highway_type,
    width_m, hazards, direction, direction_cardinal, properties, geom, length_m
  )
  SELECT
    $2, $3, r.osm_id, r.name, r.infra_type, r.infra_category, r.highway_type,
    r.width_m, ARRAY(SELECT jsonb_array_elements_text(r.hazards)), r.direction,
    r.direction_cardinal, r.properties, d.geom, ST_Length(d.geom::geography)
  FROM jsonb_to_recordset($1::jsonb) AS r(
    osm_id bigint, name text, infra_type text, infra_category text, highway_type text,
    width_m real, hazards jsonb, direction text, direction_cardinal text,
    properties jsonb, geometry jsonb
  )
  CROSS JOIN LATERAL ST_Dump(
    ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(r.geometry::text), 4326))
  ) AS d
  WHERE GeometryType(d.geom) = 'LINESTRING' AND ST_NPoints(d.geom) >= 2
`;

async function importDataset(filePath: string): Promise<void> {
  console.log(`Reading ${filePath}`);
  const buffer = await readFile(filePath).catch(() => {
    throw new Error(`Cannot read ${filePath}. Run \`npm run data:download\` first.`);
  });
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const collection = FeatureCollectionSchema.parse(JSON.parse(buffer.toString('utf8')));

  const records: PathRecord[] = [];
  let skipped = 0;
  const unknownTypes = new Set<string>();
  for (const raw of collection.features) {
    const parsed = FeatureSchema.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const record = toRecord(parsed.data);
    if (record.infra_category === 'unknown') unknownTypes.add(record.infra_type);
    records.push(record);
  }
  console.log(`Parsed ${records.length} features (${skipped} skipped as invalid).`);
  if (unknownTypes.size > 0) {
    console.warn(`Unrecognised InfraType values (stored as 'unknown'): ${[...unknownTypes].join(', ')}`);
  }

  await waitForDatabase(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO dataset_imports (source, source_url, file_sha256, feature_count, path_count)
       VALUES ($1, $2, $3, $4, 0) RETURNING id`,
      [BIN_SOURCE, process.env.BIN_DATASET_URL ?? null, sha256, records.length],
    );
    const importId = rows[0]!.id;

    const deleted = await client.query('DELETE FROM paths WHERE source = $1', [BIN_SOURCE]);
    console.log(`Removed ${deleted.rowCount ?? 0} paths from the previous import.`);

    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const result = await client.query(INSERT_SQL, [JSON.stringify(batch), BIN_SOURCE, importId]);
      inserted += result.rowCount ?? 0;
      process.stdout.write(`\rInserted ${inserted} paths...`);
    }
    process.stdout.write('\n');

    await client.query('UPDATE dataset_imports SET path_count = $1 WHERE id = $2', [inserted, importId]);
    await client.query('COMMIT');
    await client.query('ANALYZE paths');
    console.log(`Import #${importId} complete: ${inserted} paths (sha256 ${sha256.slice(0, 12)}…).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

importDataset(path.resolve(process.argv[2] ?? BIN_LOCAL_PATH)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
