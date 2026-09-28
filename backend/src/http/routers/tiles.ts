import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { HttpError } from '../errors.js';

const TileParamsSchema = z
  .object({
    z: z.coerce.number().int().min(0).max(22),
    x: z.coerce.number().int().min(0),
    y: z.coerce.number().int().min(0),
  })
  .refine(({ z: zoom, x, y }) => x < 2 ** zoom && y < 2 ** zoom, { message: 'Tile coordinates out of range' });

/**
 * PostGIS builds each Mapbox Vector Tile directly:
 *   - ST_TileEnvelope gives the tile's Web Mercator (EPSG:3857) bounds,
 *   - the `&&` bbox test uses the GiST index on the pre-projected
 *     `geom_3857` column (see migration 002),
 *   - ST_AsMVTGeom clips/quantises geometry into tile space, and
 *   - ST_AsMVT encodes the rows as a protobuf layer named "paths".
 */
const DETAIL_TILE_SQL = `
  WITH bounds AS (SELECT ST_TileEnvelope($1, $2, $3) AS geom)
  SELECT ST_AsMVT(tile, 'paths', 4096, 'geom') AS mvt
  FROM (
    SELECT
      p.id, p.osm_id, p.name, p.infra_type, p.infra_category, p.highway_type,
      p.surface, p.width_m, array_to_string(p.hazards, ',') AS hazards,
      ST_AsMVTGeom(p.geom_3857, bounds.geom, 4096, 64, true) AS geom
    FROM paths p, bounds
    WHERE p.geom_3857 && bounds.geom
  ) AS tile
  WHERE tile.geom IS NOT NULL
`;

/**
 * Zoomed out, a single tile can cover the whole metro network. Sending every
 * segment with full attributes there produces multi-megabyte tiles, so
 * instead we merge segments per category and simplify to roughly one screen
 * pixel ($4, in metres). Per-segment attributes aren't useful at this scale.
 */
const OVERVIEW_TILE_SQL = `
  WITH bounds AS (SELECT ST_TileEnvelope($1, $2, $3) AS geom)
  SELECT ST_AsMVT(tile, 'paths', 4096, 'geom') AS mvt
  FROM (
    SELECT
      p.infra_category,
      ST_AsMVTGeom(ST_Simplify(ST_Collect(p.geom_3857), $4), bounds.geom, 4096, 64, true) AS geom
    FROM paths p, bounds
    WHERE p.geom_3857 && bounds.geom
    GROUP BY p.infra_category, bounds.geom
  ) AS tile
  WHERE tile.geom IS NOT NULL
`;

/** Tiles at or above this zoom carry full per-segment attributes. */
export const DETAIL_TILE_ZOOM = 12;

/** Web Mercator world width in metres. */
const WORLD_WIDTH_M = 40_075_016.686;

/** Below this zoom the whole metro network would land in a handful of huge tiles. */
export const MIN_TILE_ZOOM = 8;

export function tilesRouter(pool: Pool): Router {
  const router = Router();

  router.get('/paths/:z/:x/:y.pbf', async (req, res) => {
    const { z: zoom, x, y } = TileParamsSchema.parse(req.params);
    if (zoom < MIN_TILE_ZOOM) {
      throw new HttpError(400, 'ZOOM_TOO_LOW', `Path tiles are available from zoom ${MIN_TILE_ZOOM}`);
    }
    const { rows } =
      zoom >= DETAIL_TILE_ZOOM
        ? await pool.query<{ mvt: Buffer }>(DETAIL_TILE_SQL, [zoom, x, y])
        : // A 512 px tile at zoom z spans WORLD_WIDTH_M / 2^z metres.
          await pool.query<{ mvt: Buffer }>(OVERVIEW_TILE_SQL, [zoom, x, y, WORLD_WIDTH_M / 2 ** zoom / 512]);
    const tile = rows[0]?.mvt ?? Buffer.alloc(0);
    res
      .status(tile.length === 0 ? 204 : 200)
      .type('application/vnd.mapbox-vector-tile')
      .set('Cache-Control', 'public, max-age=3600')
      .send(tile);
  });

  return router;
}
