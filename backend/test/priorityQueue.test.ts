import { describe, expect, it } from 'vitest';
import { MinHeap } from '../src/routing/priorityQueue.js';

describe('MinHeap', () => {
  it('pops items in ascending priority order', () => {
    const heap = new MinHeap<string>();
    const input = [5, 3, 9, 1, 7, 2, 8, 0, 6, 4];
    for (const p of input) heap.push(`item${p}`, p);
    const out: string[] = [];
    while (heap.size > 0) out.push(heap.pop()!);
    expect(out).toEqual([...input].sort((a, b) => a - b).map((p) => `item${p}`));
  });

  it('returns undefined when empty', () => {
    expect(new MinHeap<number>().pop()).toBeUndefined();
  });
});
