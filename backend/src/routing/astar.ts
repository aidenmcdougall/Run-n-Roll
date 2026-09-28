import { MinHeap } from './priorityQueue.js';

/**
 * The graph as seen by the search. Abstracting it lets the planner overlay
 * temporary "virtual" start/end nodes on the shared, immutable graph.
 */
export interface SearchSpace {
  readonly nodeCount: number;
  /** Calls `visit` for every arc leaving `node`. `ref` identifies the arc for path reconstruction. */
  forEachArc(node: number, visit: (to: number, cost: number, ref: number) => void): void;
  /** Admissible estimate of the remaining cost from `node` to the target. Return 0 for Dijkstra. */
  heuristic(node: number): number;
}

export interface SearchResult {
  /** Nodes visited from source to target, inclusive. */
  readonly nodes: number[];
  /** Arc refs taken; `refs[i]` leads from `nodes[i]` to `nodes[i + 1]`. */
  readonly refs: number[];
  readonly cost: number;
  /** Nodes settled during the search (a rough measure of work done). */
  readonly settled: number;
}

/**
 * A* shortest path. With an admissible, consistent heuristic the first time
 * the target is popped its cost is optimal. With `heuristic = () => 0` this
 * is exactly Dijkstra's algorithm.
 */
export function aStar(space: SearchSpace, source: number, target: number): SearchResult | null {
  const g = new Float64Array(space.nodeCount).fill(Infinity);
  const prevNode = new Int32Array(space.nodeCount).fill(-1);
  const prevRef = new Int32Array(space.nodeCount);
  const settled = new Uint8Array(space.nodeCount);
  const open = new MinHeap<number>();
  let settledCount = 0;

  g[source] = 0;
  open.push(source, space.heuristic(source));

  while (open.size > 0) {
    const node = open.pop()!;
    if (settled[node]) continue; // stale heap entry (lazy decrease-key)
    settled[node] = 1;
    settledCount++;

    if (node === target) {
      const nodes = [target];
      const refs: number[] = [];
      for (let n = target; n !== source; n = prevNode[n]!) {
        refs.push(prevRef[n]!);
        nodes.push(prevNode[n]!);
      }
      return { nodes: nodes.reverse(), refs: refs.reverse(), cost: g[target]!, settled: settledCount };
    }

    const base = g[node]!;
    space.forEachArc(node, (to, cost, ref) => {
      if (settled[to]) return;
      const candidate = base + cost;
      if (candidate < g[to]!) {
        g[to] = candidate;
        prevNode[to] = node;
        prevRef[to] = ref;
        open.push(to, candidate + space.heuristic(to));
      }
    });
  }
  return null;
}
