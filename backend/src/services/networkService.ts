import type { Pool } from 'pg';
import { isInfraCategory } from '../domain/infrastructure.js';
import { BIN_SOURCE } from '../domain/sources.js';
import { effectiveSurface, parseSmoothness } from '../domain/surface.js';
import { buildGraph, type PathSegment, type RoutingGraph, type TravelDirection } from '../routing/graph.js';

interface PathRow {
  id: number;
  source: string;
  infra_category: string;
  name: string | null;
  hazards: string[];
  surface: string | null;
  smoothness: string | null;
  direction: TravelDirection;
  is_sidewalk: boolean;
  wkb: Buffer;
}

export type NetworkState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; graph: RoutingGraph; builtAt: Date; buildMs: number }
  | { status: 'error'; error: string };

/** What HTTP handlers need from the network: its current state. */
export interface NetworkStateProvider {
  getState(): NetworkState;
}

const FETCH_SIZE = 50_000;

/**
 * Decodes a WKB LineString (as returned by ST_AsBinary) into flat
 * [lng, lat, ...] coordinates. Binary geometry is several times smaller and
 * faster to decode than GeoJSON text for ~6M vertices.
 *
 * Layout: byte order (1 byte), geometry type (uint32), point count (uint32),
 * then x/y doubles.
 */
export function decodeWkbLineString(wkb: Uint8Array): Float64Array {
  const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
  const littleEndian = view.getUint8(0) === 1;
  const type = view.getUint32(1, littleEndian);
  if (type !== 2) throw new Error(`Expected a WKB LineString (type 2), got type ${type}`);
  const points = view.getUint32(5, littleEndian);
  const out = new Float64Array(points * 2);
  for (let i = 0; i < points * 2; i++) out[i] = view.getFloat64(9 + i * 8, littleEndian);
  return out;
}

/**
 * Owns the in-memory routing graph. The graph is built from PostGIS once and
 * reused for every request; call `reload()` after re-importing data.
 *
 * Holding the network in memory is the right trade-off at this scale (~600k
 * segments): A* over typed arrays answers in milliseconds, whereas running
 * the search in SQL would need pgRouting and a round-trip per query.
 */
export class NetworkService implements NetworkStateProvider {
  private state: NetworkState = { status: 'loading' };
  private pending: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  getState(): NetworkState {
    return this.state;
  }

  reload(): Promise<void> {
    this.pending ??= this.load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(): Promise<void> {
    const started = performance.now();
    try {
      const segments = await this.fetchSegments();
      if (segments.length === 0) {
        this.state = { status: 'empty' };
        return;
      }
      const graph = buildGraph(segments);
      const buildMs = Math.round(performance.now() - started);
      this.state = { status: 'ready', graph, builtAt: new Date(), buildMs };
      console.log(`Routing graph ready in ${buildMs} ms`, graph.stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { status: 'error', error: message };
      console.error('Failed to build routing graph:', message);
    }
  }

  /** Streams all paths through a cursor so the full result set is never held at once. */
  private async fetchSegments(): Promise<PathSegment[]> {
    const client = await this.pool.connect();
    const segments: PathSegment[] = [];
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        `DECLARE path_rows NO SCROLL CURSOR FOR
         SELECT id, source, infra_category, name, hazards, surface, smoothness, direction,
                coalesce(osm_tags->>'footway' = 'sidewalk', false) AS is_sidewalk,
                ST_AsBinary(geom) AS wkb
         FROM paths`,
      );
      for (;;) {
        const { rows } = await client.query<PathRow>(`FETCH ${FETCH_SIZE} FROM path_rows`);
        if (rows.length === 0) break;
        for (const row of rows) {
          const category = isInfraCategory(row.infra_category) ? row.infra_category : 'unknown';
          const surface = effectiveSurface(category, row.surface, { sealedByDefault: row.is_sidewalk });
          segments.push({
            id: row.id,
            coordinates: decodeWkbLineString(row.wkb),
            category,
            name: row.name,
            hazards: row.hazards,
            surfaceClass: surface.surfaceClass,
            surfaceInferred: surface.inferred,
            smoothness: parseSmoothness(row.smoothness),
            direction: row.direction,
            bridgeGaps: row.source === BIN_SOURCE,
          });
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return segments;
  }
}
