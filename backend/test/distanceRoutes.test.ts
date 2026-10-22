import { describe, expect, it } from 'vitest';
import { RUN_PROFILE, SKATE_PROFILE } from '../src/routing/activities.js';
import {
  DISTANCE_TOLERANCE,
  planDistanceRoutes,
  repeatedMetres,
  type DistanceRouteOptions,
} from '../src/routing/distanceRoutes.js';
import { destinationPoint, haversineMeters } from '../src/routing/geo.js';
import { buildGraph } from '../src/routing/graph.js';
import { avoidedSurfaces } from '../src/routing/preferences.js';
import { PREFER_PATHS_PROFILE } from '../src/routing/weights.js';
import { at, grid, segment } from './helpers.js';

const loop = (targetM: number, extra: Partial<DistanceRouteOptions> = {}): DistanceRouteOptions => ({
  shape: 'loop',
  targetM,
  ...extra,
});

describe('planDistanceRoutes: loops', () => {
  const graph = buildGraph(grid());

  it('returns loops that start and finish at the start point, close to the target distance', () => {
    const result = planDistanceRoutes(graph, at(30, 10), PREFER_PATHS_PROFILE, loop(3000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes.length).toBeGreaterThan(0);
    for (const { route, distanceError } of result.routes) {
      const coords = route.coordinates;
      expect(haversineMeters(coords[0]!, coords[coords.length - 1]!)).toBeLessThan(0.01);
      expect(Math.abs(route.distanceM - 3000) / 3000).toBeLessThanOrEqual(DISTANCE_TOLERANCE + 0.05);
      expect(distanceError).toBeCloseTo((route.distanceM - 3000) / 3000, 9);
    }
  });

  it('comes home a different way rather than retracing its steps', () => {
    const result = planDistanceRoutes(graph, at(30, 10), PREFER_PATHS_PROFILE, loop(3000));
    if (!result.ok) throw new Error(result.message);
    const best = result.routes[0]!;
    expect(best.repeatedM / best.route.distanceM).toBeLessThan(0.1);
    expect(best.repeatedM).toBeCloseTo(repeatedMetres(best.route.pieces), 9);
  });

  it('returns distinct alternatives, best first', () => {
    const result = planDistanceRoutes(graph, at(30, 10), PREFER_PATHS_PROFILE, loop(3000, { maxRoutes: 3 }));
    if (!result.ok) throw new Error(result.message);
    expect(result.routes).toHaveLength(3);
    const ranks = result.routes.map((r) => r.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(result.routes.map((r) => r.bearingDeg)).size).toBe(3);
  });

  it('scales to longer targets', () => {
    const result = planDistanceRoutes(graph, at(30, 10), PREFER_PATHS_PROFILE, loop(8000));
    if (!result.ok) throw new Error(result.message);
    expect(Math.abs(result.routes[0]!.distanceError)).toBeLessThanOrEqual(DISTANCE_TOLERANCE);
  });
});

describe('planDistanceRoutes: one way', () => {
  const graph = buildGraph(grid());

  it('ends away from the start, close to the target distance', () => {
    const result = planDistanceRoutes(graph, at(0, 0), PREFER_PATHS_PROFILE, { shape: 'one_way', targetM: 2000 });
    if (!result.ok) throw new Error(result.message);
    for (const { route, distanceError, repeatedM } of result.routes) {
      const coords = route.coordinates;
      expect(haversineMeters(coords[0]!, coords[coords.length - 1]!)).toBeGreaterThan(1000);
      expect(Math.abs(distanceError)).toBeLessThanOrEqual(DISTANCE_TOLERANCE + 0.05);
      expect(repeatedM).toBe(0);
    }
  });
});

describe('planDistanceRoutes: activities', () => {
  // The eastern half of the grid is compacted gravel trails: ideal for running, hopeless on skates.
  const graph = buildGraph(grid(200, (e) => (e > 0 ? { surfaceClass: 'compacted', category: 'trail' } : {})));

  it('keeps a skating loop on sealed ground', () => {
    const result = planDistanceRoutes(graph, at(-100, 0), SKATE_PROFILE, loop(3000, { avoidSurfaces: avoidedSurfaces(SKATE_PROFILE) }));
    if (!result.ok) throw new Error(result.message);
    expect(result.routes[0]!.route.distanceBySurface.compacted ?? 0).toBe(0);
  });

  it('heads for the trails when running', () => {
    const result = planDistanceRoutes(graph, at(-100, 0), RUN_PROFILE, loop(3000));
    if (!result.ok) throw new Error(result.message);
    const best = result.routes[0]!.route;
    expect((best.distanceBySurface.compacted ?? 0) / best.distanceM).toBeGreaterThan(0.5);
  });
});

describe('planDistanceRoutes: failures', () => {
  it('reports a start too far from the network', () => {
    const graph = buildGraph(grid());
    expect(planDistanceRoutes(graph, at(0, 5000), PREFER_PATHS_PROFILE, loop(3000))).toMatchObject({
      ok: false,
      code: 'START_NOT_NEAR_NETWORK',
    });
  });

  it('reports NO_ROUTE when the network is far too small for the distance', () => {
    const graph = buildGraph([segment([[0, 0], [300, 0]]), segment([[300, 0], [300, 300]]), segment([[300, 300], [0, 0]])]);
    expect(planDistanceRoutes(graph, at(0, 0), PREFER_PATHS_PROFILE, loop(10_000))).toMatchObject({ ok: false, code: 'NO_ROUTE' });
  });
});

describe('repeatedMetres', () => {
  it('counts overlapping parts of the same edge once', () => {
    expect(
      repeatedMetres([
        { edgeId: 1, fromM: 0, toM: 100 },
        { edgeId: 2, fromM: 0, toM: 50 },
        { edgeId: 1, fromM: 100, toM: 40 }, // back over 60 m of edge 1
      ]),
    ).toBeCloseTo(60, 9);
  });

  it('does not count different parts of an edge as repeated', () => {
    expect(
      repeatedMetres([
        { edgeId: 1, fromM: 0, toM: 40 },
        { edgeId: 1, fromM: 60, toM: 100 },
      ]),
    ).toBe(0);
  });
});

describe('destinationPoint', () => {
  it('lands the requested distance away on the requested bearing', () => {
    const origin = at(0, 0);
    const north = destinationPoint(origin, 0, 1000);
    expect(haversineMeters(origin, north)).toBeCloseTo(1000, 3);
    expect(north[0]).toBeCloseTo(origin[0], 9);
    expect(north[1]).toBeGreaterThan(origin[1]);
    const east = destinationPoint(origin, 90, 500);
    expect(haversineMeters(origin, east)).toBeCloseTo(500, 3);
    expect(east[0]).toBeGreaterThan(origin[0]);
  });
});
