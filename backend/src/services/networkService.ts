import type { Pool } from 'pg';
import { isInfraCategory } from '../domain/infrastructure.js';
import type { LngLat } from '../routing/geo.js';
import { buildGraph, type PathSegment, type RoutingGraph, type TravelDirection } from '../routing/graph.js';

interface PathRow {
  id: number;
  infra_category: string;
  name: string | null;
  hazards: string[];
  surface: string | null;
  direction: TravelDirection;
  geojson: string;
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

/**
 * Owns the in-memory routing graph. The graph is built from PostGIS once and
 * reused for every request; call `reload()` after re-importing data.
 *
 * Holding the whole network in memory is the right trade-off at this scale
 * (~55k segments): A* over typed arrays answers in milliseconds, whereas
 * running the search in SQL would need pgRouting and a round-trip per query.
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
      // 7 decimal places = OSM's native precision (~1 cm).
      const { rows } = await this.pool.query<PathRow>(
        `SELECT id, infra_category, name, hazards, surface, direction, ST_AsGeoJSON(geom, 7) AS geojson
         FROM paths`,
      );
      if (rows.length === 0) {
        this.state = { status: 'empty' };
        return;
      }
      const segments: PathSegment[] = rows.map((row) => ({
        id: row.id,
        coordinates: (JSON.parse(row.geojson) as { coordinates: LngLat[] }).coordinates,
        category: isInfraCategory(row.infra_category) ? row.infra_category : 'unknown',
        name: row.name,
        hazards: row.hazards,
        surface: row.surface,
        direction: row.direction,
      }));
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
}
