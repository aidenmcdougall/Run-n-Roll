import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/routing/graph.js';
import { segment } from './helpers.js';

describe('buildGraph', () => {
  it('turns a single segment into one edge between two nodes', () => {
    const graph = buildGraph([segment([[0, 0], [50, 0], [100, 0]])]);
    expect(graph.stats).toMatchObject({ nodes: 2, edges: 1, connectors: 0, components: 1 });
    expect(graph.edges[0]!.lengthM).toBeCloseTo(100, 0);
    expect(graph.edges[0]!.coordinates).toHaveLength(3);
  });

  it('splits segments where they share a vertex (a crossroads)', () => {
    const graph = buildGraph([
      segment([[-100, 0], [0, 0], [100, 0]]),
      segment([[0, -100], [0, 0], [0, 100]]),
    ]);
    // Four arms meeting at one central junction.
    expect(graph.stats).toMatchObject({ nodes: 5, edges: 4, components: 1 });
    const degrees = graph.adjacency.map((edges) => edges.length).sort();
    expect(degrees).toEqual([1, 1, 1, 1, 4]);
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
    const connector = graph.edges.find((e) => e.kind === 'connector')!;
    expect(connector.lengthM).toBeCloseTo(8, 0);
  });

  it('bridges a path ending just short of the middle of another line (T-junction)', () => {
    const graph = buildGraph([
      segment([[0, 0], [200, 0]], 'painted_lane'),
      segment([[100, 5], [100, 100]]), // stops 5 m short of the lane
    ]);
    expect(graph.stats).toMatchObject({ connectors: 1, components: 1 });
    // The lane is split at the inserted vertex: two halves + stem + connector.
    expect(graph.edges.filter((e) => e.kind === 'painted_lane').map((e) => Math.round(e.lengthM))).toEqual([100, 100]);
  });

  it('leaves gaps larger than the tolerance unbridged', () => {
    const graph = buildGraph([segment([[0, 0], [100, 0]]), segment([[150, 0], [250, 0]])], { connectorToleranceM: 15 });
    expect(graph.stats).toMatchObject({ connectors: 0, components: 2 });
  });

  it('ignores degenerate segments and duplicate consecutive vertices', () => {
    const graph = buildGraph([segment([[0, 0]]), segment([[0, 0], [0, 0], [50, 0]])]);
    expect(graph.stats).toMatchObject({ segments: 1, edges: 1 });
    expect(graph.edges[0]!.coordinates).toHaveLength(2);
  });
});
