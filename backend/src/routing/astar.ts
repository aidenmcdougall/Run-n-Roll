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
 * Per-node search state, reused across searches. Allocating it per request
 * would cost ~17 MB of garbage per route on a million-node graph. A search
 * records every node it touches and resets only those afterwards, so reuse
 * costs O(nodes touched) rather than O(graph).
 */
class SearchState {
  g: Float64Array;
  prevNode: Int32Array;
  prevRef: Int32Array;
  settled: Uint8Array;
  private touched: Int32Array;
  private touchedCount = 0;

  constructor(readonly size: number) {
    this.g = new Float64Array(size).fill(Infinity);
    this.prevNode = new Int32Array(size).fill(-1);
    this.prevRef = new Int32Array(size);
    this.settled = new Uint8Array(size);
    this.touched = new Int32Array(1024);
  }

  touch(node: number): void {
    if (this.g[node] !== Infinity) return; // already recorded
    if (this.touchedCount === this.touched.length) {
      const grown = new Int32Array(this.touched.length * 2);
      grown.set(this.touched);
      this.touched = grown;
    }
    this.touched[this.touchedCount++] = node;
  }

  reset(): void {
    for (let i = 0; i < this.touchedCount; i++) {
      const node = this.touched[i]!;
      this.g[node] = Infinity;
      this.prevNode[node] = -1;
      this.settled[node] = 0;
    }
    this.touchedCount = 0;
  }
}

// Searches are synchronous, so one shared state object is safe to reuse.
let shared: SearchState | null = null;

function acquireState(size: number): SearchState {
  if (!shared || shared.size < size) shared = new SearchState(size);
  return shared;
}

/**
 * A* shortest path. With an admissible, consistent heuristic the first time
 * the target is popped its cost is optimal. With `heuristic = () => 0` this
 * is exactly Dijkstra's algorithm.
 */
export function aStar(space: SearchSpace, source: number, target: number): SearchResult | null {
  const state = acquireState(space.nodeCount);
  const { g, prevNode, prevRef, settled } = state;
  const open = new MinHeap<number>();
  let settledCount = 0;

  try {
    state.touch(source);
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
          state.touch(to);
          g[to] = candidate;
          prevNode[to] = node;
          prevRef[to] = ref;
          open.push(to, candidate + space.heuristic(to));
        }
      });
    }
    return null;
  } finally {
    state.reset();
  }
}
