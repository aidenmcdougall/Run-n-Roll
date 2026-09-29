import type { InfraCategory } from '../src/domain/infrastructure.js';
import type { LngLat } from '../src/routing/geo.js';
import type { PathSegment } from '../src/routing/graph.js';

// Test networks are drawn in metres around a Melbourne-ish origin so
// expectations can be written in real-world units.
const ORIGIN: LngLat = [145, -37.8];
// Matches the sphere used by haversineMeters (mean radius 6,371,008.8 m).
const M_PER_DEG_LAT = (2 * Math.PI * 6_371_008.8) / 360;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN[1] * Math.PI) / 180);

/** Converts local (east, north) metre offsets into WGS84 coordinates. */
export function at(eastM: number, northM: number): LngLat {
  return [ORIGIN[0] + eastM / M_PER_DEG_LNG, ORIGIN[1] + northM / M_PER_DEG_LAT];
}

let nextId = 1;
export function segment(
  points: [number, number][],
  category: InfraCategory = 'shared_use_path',
  overrides: Partial<PathSegment> = {},
): PathSegment {
  return {
    id: nextId++,
    coordinates: Float64Array.from(points.flatMap(([e, n]) => at(e, n))),
    category,
    name: null,
    hazards: [],
    surfaceClass: 'smooth',
    surfaceInferred: false,
    direction: 'both',
    bridgeGaps: true,
    ...overrides,
  };
}
