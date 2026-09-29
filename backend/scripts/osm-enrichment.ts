import type { PoolClient } from 'pg';
import { BIN_SOURCE } from './dataset.js';

/**
 * Copies OSM surface, smoothness and tags onto DTP rows with a matching
 * `osm_id`. The DTP dataset was extracted from OSM but carries no surface
 * information, so this is how DTP paths get a ground type.
 *
 * Shared by the DTP importer (so a re-import keeps its enrichment) and the
 * OSM build. It is a no-op if OSM has not been loaded yet.
 */
export async function enrichDtpPathsFromOsm(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ ok: boolean }>(`SELECT to_regclass('osm.ways') IS NOT NULL AS ok`);
  if (!rows[0]?.ok) return 0;
  const result = await client.query(
    `UPDATE paths p
     SET surface = w.tags->>'surface', smoothness = w.tags->>'smoothness', osm_tags = w.tags
     FROM osm.ways w
     WHERE p.source = $1 AND w.way_id = p.osm_id`,
    [BIN_SOURCE],
  );
  return result.rowCount ?? 0;
}
