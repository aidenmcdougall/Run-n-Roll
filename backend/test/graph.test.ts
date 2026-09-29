import { describe, expect, it } from 'vitest';
import { buildGraph, getEdge, type RoutingGraph } from '../src/routing/graph.js';
import { at, segment } from './helpers.js';

const edges = (graph: RoutingGraph) => Array.from({ length: graph.edgeCount }, (_, id) => getEdge(graph, id));
const degrees = (graph: RoutingGraph) =>
  Array.from({ length: graph.nodeCount }, (_, n) => graph.adjOffset[n + 1]! - graph.adjOffset[n]!).sort();

describe('buildGraph', () => {
  it('turns a single segment into one edge between two nodes', () => {
    const graph = buildGraph([segment([[0, 0], [50, 0], [100, 0]])]);
    expect(graph.stats).toMatchObject({ nodes: 2, edges: 1, connectors: 0, components: 1 });
    expect(getEdge(graph, 0).lengthM).toBeCloseTo(100, 0);
    expect(getEdge(graph, 0).coordinates).toHaveLength(3);
  });

  it('splits segments where they share a vertex (a crossroads)', () => {
    const graph = buildGraph([
      segment([[-100, 0], [0, 0], [100, 0]]),
      segment([[0, -100], [0, 0], [0, 100]]),
    ]);
    // Four arms meeting at one central junction.
    expect(graph.stats).toMatchObject({ nodes: 5, edges: 4, components: 1 });
    expect(degrees(graph)).toEqual([1, 1, 1, 1, 4]);
  });

  it('does not create a junction where lines cross without sharing a vertex (e.g. a bridge)', () => {
    const graph = buildGraph(
      [segment([[-100, 0], [100, 0]]), segment([[0, -100], [0, 100]])],
      { connectorToleranceM: 0 },
    );
    expect(graph.stats).toMatchObject({ nodes: 4, edges: 2, components: 2 });
  });

  it('bridges a small end-to-end gap with a connector edge', () => {
    const graph = buildGraph([segment([[0, 0], [100, 0]]), segment([[108, 0], [200, 0]])]);
    expect(graph.stats).toMatchObject({ connectors: 1, components: 1 });
    const connector = edges(graph).find((e) => e.kind === 'connector')!;
    expect(connector.lengthM).toBeCloseTo(8, 0);
  });

  it('bridges a path ending just short of the middle of another line (T-junction)', () => {
    const graph = buildGraph([
      segment([[0, 0], [200, 0]], 'painted_lane'),
      segment([[100, 5], [100, 100]]), // stops 5 m short of the lane
    ]);
    expect(graph.stats).toMatchObject({ connectors: 1, components: 1 });
    // The lane is split at the inserted vertex: two halves + stem + connector.
    expect(edges(graph).filter((e) => e.kind === 'painted_lane').map((e) => Math.round(e.lengthM))).toEqual([100, 100]);
  });

  it('leaves gaps larger than the tolerance unbridged', () => {
    const graph = buildGraph([segment([[0, 0], [100, 0]]), segment([[150, 0], [250, 0]])], { connectorToleranceM: 15 });
    expect(graph.stats).toMatchObject({ connectors: 0, components: 2 });
  });

  it('ignores degenerate segments and duplicate consecutive vertices', () => {
    const graph = buildGraph([segment([[0, 0]]), segment([[0, 0], [0, 0], [50, 0]])]);
    expect(graph.stats).toMatchObject({ segments: 1, edges: 1 });
    expect(getEdge(graph, 0).coordinates).toHaveLength(2);
  });
});

describe('buildGraph gap bridging scope', () => {
  it('only bridges from segments that opt in', () => {
    const lane = segment([[0, 0], [100, 0]], 'painted_lane');
    const deadEnd = segment([[108, 0], [200, 0]], 'quiet_street', { bridgeGaps: false });
    expect(buildGraph([deadEnd, segment([[0, 5], [0, 100]], 'quiet_street', { bridgeGaps: false })]).stats.connectors).toBe(0);
    // The DTP lane's dangling end may still bridge onto the OSM street.
    expect(buildGraph([lane, deadEnd]).stats).toMatchObject({ connectors: 1, components: 1 });
  });
});

describe('buildGraph compact storage', () => {
  it('round-trips edge attributes through the typed arrays', () => {
    const graph = buildGraph([
      segment([[0, 0], [100, 0]], 'painted_lane', {
        name: 'Main St',
        hazards: ['tram_line', 'parking'],
        surfaceClass: 'rough_paved',
        surfaceInferred: true,
        smoothness: 'intermediate',
        direction: 'reverse',
      }),
    ]);
    expect(getEdge(graph, 0)).toMatchObject({
      kind: 'painted_lane',
      name: 'Main St',
      hazards: ['tram_line', 'parking'],
      surfaceClass: 'rough_paved',
      surfaceInferred: true,
      smoothness: 'intermediate',
      direction: 'reverse',
    });
  });

  it('keeps coordinates to OSM precision (1e-7 degrees)', () => {
    const graph = buildGraph([segment([[0, 0], [123.456, 78.9]])]);
    const [, end] = getEdge(graph, 0).coordinates;
    expect(Math.abs(end![0] - at(123.456, 78.9)[0])).toBeLessThan(1e-7);
    expect(Math.abs(end![1] - at(123.456, 78.9)[1])).toBeLessThan(1e-7);
  });

  it('builds CSR adjacency that lists every incident edge', () => {
    const graph = buildGraph([
      segment([[-100, 0], [0, 0], [100, 0]]),
      segment([[0, -100], [0, 0], [0, 100]]),
    ]);
    const hub = Array.from({ length: graph.nodeCount }, (_, n) => n).find(
      (n) => graph.adjOffset[n + 1]! - graph.adjOffset[n]! === 4,
    )!;
    const incident = [...graph.adjEdges.subarray(graph.adjOffset[hub]!, graph.adjOffset[hub + 1]!)].sort();
    expect(incident).toEqual([0, 1, 2, 3]);
  });
});
