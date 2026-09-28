import { describe, expect, it } from 'vitest';
import { aStar, type SearchSpace } from '../src/routing/astar.js';
import { haversineMeters } from '../src/routing/geo.js';
import { buildGraph, type PathSegment } from '../src/routing/graph.js';
import { planRoute } from '../src/routing/planner.js';
import { PREFER_PATHS_PROFILE, SHORTEST_PROFILE, type RoutingProfile } from '../src/routing/weights.js';
import { at, segment } from './helpers.js';

/**
 * Two ways from (0,0) to (1000,0):
 *   - direct painted lane along the road: 1000 m
 *   - off-road shared path detouring via (500, 300): ~1166 m
 */
function detourNetwork(): PathSegment[] {
  return [
    segment([[0, 0], [1000, 0]], 'painted_lane', { name: 'Main Road' }),
    segment([[0, 0], [500, 300], [1000, 0]], 'shared_use_path', { name: 'Creek Trail' }),
  ];
}

describe('planRoute', () => {
  it('takes the direct road under the shortest profile', () => {
    const result = planRoute(buildGraph(detourNetwork()), at(0, 0), at(1000, 0), SHORTEST_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceM).toBeCloseTo(1000, 0);
    expect(result.route.legs).toEqual([{ kind: 'painted_lane', name: 'Main Road', lengthM: expect.any(Number) }]);
  });

  it('prefers the longer off-road path under prefer_paths', () => {
    const result = planRoute(buildGraph(detourNetwork()), at(0, 0), at(1000, 0), PREFER_PATHS_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceM).toBeGreaterThan(1150);
    expect(result.route.distanceByKind).toEqual({ shared_use_path: expect.any(Number) });
    expect(result.route.cost).toBeCloseTo(result.route.distanceM, 6); // multiplier 1
  });

  it('snaps start and end to the middle of edges rather than the nearest junction', () => {
    const graph = buildGraph([segment([[0, 0], [1000, 0]])]);
    const result = planRoute(graph, at(200, 20), at(700, -10), SHORTEST_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceM).toBeCloseTo(500, 0);
    expect(result.route.start.distanceM).toBeCloseTo(20, 0);
    const first = result.route.coordinates[0]!;
    const last = result.route.coordinates[result.route.coordinates.length - 1]!;
    expect(haversineMeters(first, at(200, 0))).toBeLessThan(1);
    expect(haversineMeters(last, at(700, 0))).toBeLessThan(1);
  });

  it('routes backwards along a single edge', () => {
    const graph = buildGraph([segment([[0, 0], [1000, 0]])]);
    const result = planRoute(graph, at(800, 0), at(100, 0), SHORTEST_PROFILE);
    expect(result.ok && result.route.distanceM).toBeCloseTo(700, 0);
  });

  it('crosses a bridged gap and reports the connector', () => {
    const graph = buildGraph([segment([[0, 0], [500, 0]]), segment([[510, 0], [1000, 0]])]);
    const result = planRoute(graph, at(0, 0), at(1000, 0), PREFER_PATHS_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceByKind.connector).toBeCloseTo(10, 0);
    expect(result.route.legs.map((l) => l.kind)).toEqual(['shared_use_path', 'connector', 'shared_use_path']);
  });

  it('honours one-way edges only when the profile asks for it', () => {
    const graph = buildGraph([segment([[0, 0], [1000, 0]], 'painted_lane', { direction: 'forward' })]);
    const oneWay: RoutingProfile = { ...SHORTEST_PROFILE, id: 'one_way_test', respectOneWay: true };
    expect(planRoute(graph, at(900, 0), at(100, 0), SHORTEST_PROFILE).ok).toBe(true);
    expect(planRoute(graph, at(100, 0), at(900, 0), oneWay).ok).toBe(true);
    expect(planRoute(graph, at(900, 0), at(100, 0), oneWay)).toMatchObject({ ok: false, code: 'NO_ROUTE' });
  });

  it('reports points that are too far from the network', () => {
    const graph = buildGraph([segment([[0, 0], [1000, 0]])]);
    expect(planRoute(graph, at(0, 2000), at(1000, 0), SHORTEST_PROFILE)).toMatchObject({
      ok: false,
      code: 'START_NOT_NEAR_NETWORK',
    });
    expect(planRoute(graph, at(0, 0), at(1000, 2000), SHORTEST_PROFILE)).toMatchObject({
      ok: false,
      code: 'END_NOT_NEAR_NETWORK',
    });
  });

  it('reports disconnected networks without searching', () => {
    const graph = buildGraph([segment([[0, 0], [100, 0]]), segment([[300, 0], [400, 0]])]);
    const options = { maxSnapDistanceM: 50 }; // too small to re-snap onto the other fragment
    expect(planRoute(graph, at(0, 0), at(400, 0), SHORTEST_PROFILE, options)).toMatchObject({ ok: false, code: 'NO_ROUTE' });
  });
});

describe('aStar', () => {
  // A* with an admissible heuristic must find the same cost as Dijkstra.
  it('matches Dijkstra on a grid network', () => {
    const segments: PathSegment[] = [];
    const kinds = ['shared_use_path', 'painted_lane', 'protected_lane', 'shared_street'] as const;
    const n = 8;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const kind = kinds[(i * 7 + j * 3) % kinds.length]!;
        if (i + 1 < n) segments.push(segment([[i * 100, j * 100], [(i + 1) * 100, j * 100]], kind));
        if (j + 1 < n) segments.push(segment([[i * 100, j * 100], [i * 100, (j + 1) * 100]], kind));
      }
    }
    const graph = buildGraph(segments, { connectorToleranceM: 0 });
    const target = graph.nodes.length - 1;

    const space = (useHeuristic: boolean): SearchSpace => ({
      nodeCount: graph.nodes.length,
      heuristic: (node) => (useHeuristic ? haversineMeters(graph.nodes[node]!, graph.nodes[target]!) : 0),
      forEachArc(node, visit) {
        for (const id of graph.adjacency[node]!) {
          const e = graph.edges[id]!;
          const mult = PREFER_PATHS_PROFILE.kindMultipliers[e.kind];
          visit(e.from === node ? e.to : e.from, e.lengthM * mult, id);
        }
      },
    });

    const astar = aStar(space(true), 0, target)!;
    const dijkstra = aStar(space(false), 0, target)!;
    expect(astar.cost).toBeCloseTo(dijkstra.cost, 6);
    expect(astar.settled).toBeLessThanOrEqual(dijkstra.settled);
  });
});

describe('planRoute snapping across components', () => {
  it('skips a nearer isolated fragment in favour of a reachable edge', () => {
    const graph = buildGraph(
      [
        segment([[0, 0], [1000, 0]], 'shared_use_path', { name: 'Main Trail' }),
        // A short, disconnected stub closer to the start click than the trail.
        segment([[-20, 60], [20, 60]], 'painted_lane', { name: 'Isolated Stub' }),
      ],
      { connectorToleranceM: 0 },
    );
    const result = planRoute(graph, at(0, 50), at(900, 10), SHORTEST_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.start.distanceM).toBeCloseTo(50, 0);
    expect(result.route.legs.map((l) => l.name)).toEqual(['Main Trail']);
  });

  it('still reports NO_ROUTE when no connected alternative is within range', () => {
    const graph = buildGraph([segment([[0, 0], [100, 0]]), segment([[5000, 0], [5100, 0]])], { connectorToleranceM: 0 });
    expect(planRoute(graph, at(0, 0), at(5100, 0), SHORTEST_PROFILE)).toMatchObject({ ok: false, code: 'NO_ROUTE' });
  });
});
