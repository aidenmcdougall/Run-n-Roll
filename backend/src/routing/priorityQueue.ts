/**
 * Binary min-heap keyed by a numeric priority. Used by A* for the open set.
 * Decrease-key is handled by the caller via lazy deletion (stale entries are
 * pushed again and skipped when popped), which is simpler and typically
 * faster than an indexed heap for sparse road-like graphs.
 */
export class MinHeap<T> {
  private readonly items: T[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T, priority: number): void {
    this.items.push(item);
    this.priorities.push(priority);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (n > 1) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent]! <= this.priorities[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(index: number): void {
    const n = this.items.length;
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.priorities[left]! < this.priorities[smallest]!) smallest = left;
      if (right < n && this.priorities[right]! < this.priorities[smallest]!) smallest = right;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b]!, this.priorities[a]!];
  }
}
