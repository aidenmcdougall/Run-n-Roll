import { projectOntoSegment, type LngLat, type SegmentProjection } from './geo.js';

const METERS_PER_DEGREE_LAT = 111_320;

export interface NearestPiece {
  owner: number;
  piece: number;
  projection: SegmentProjection;
}

/**
 * Uniform grid over line "pieces" (the straight segment between two
 * consecutive vertices of a polyline), for nearest-line queries.
 *
 * A hand-rolled grid is plenty for tens of thousands of lines in one region
 * and avoids pulling in an R-tree dependency. Each piece is registered in
 * every cell its bounding box touches, so queries only inspect nearby cells.
 */
export class SegmentGrid {
  private readonly cells = new Map<string, number[]>();

  /**
   * @param getPiece resolves (owner, piece) to its two endpoints.
   * @param cellSizeDeg cell edge length in degrees (0.001° ≈ 110 m N–S).
   */
  constructor(
    private readonly getPiece: (owner: number, piece: number) => readonly [LngLat, LngLat],
    private readonly cellSizeDeg = 0.001,
  ) {}

  private cellIndex(value: number): number {
    return Math.floor(value / this.cellSizeDeg);
  }

  insert(owner: number, piece: number): void {
    const [a, b] = this.getPiece(owner, piece);
    const x0 = this.cellIndex(Math.min(a[0], b[0]));
    const x1 = this.cellIndex(Math.max(a[0], b[0]));
    const y0 = this.cellIndex(Math.min(a[1], b[1]));
    const y1 = this.cellIndex(Math.max(a[1], b[1]));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        let bucket = this.cells.get(key);
        if (!bucket) this.cells.set(key, (bucket = []));
        bucket.push(owner, piece);
      }
    }
  }

  /**
   * Finds the closest piece to `point` within `maxDistanceM`, optionally
   * ignoring pieces rejected by `accept`.
   */
  nearest(point: LngLat, maxDistanceM: number, accept?: (owner: number) => boolean): NearestPiece | null {
    // Convert the metric search radius into a (conservative) cell radius.
    const latDeg = maxDistanceM / METERS_PER_DEGREE_LAT;
    const lngDeg = latDeg / Math.max(0.01, Math.cos((point[1] * Math.PI) / 180));
    const cx = this.cellIndex(point[0]);
    const cy = this.cellIndex(point[1]);
    const rx = Math.ceil(lngDeg / this.cellSizeDeg);
    const ry = Math.ceil(latDeg / this.cellSizeDeg);

    let best: NearestPiece | null = null;
    const seen = new Set<number>();
    for (let x = cx - rx; x <= cx + rx; x++) {
      for (let y = cy - ry; y <= cy + ry; y++) {
        const bucket = this.cells.get(`${x},${y}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 2) {
          const owner = bucket[i]!;
          const piece = bucket[i + 1]!;
          // Pieces spanning several cells appear in each; test them once.
          const id = owner * 1_048_576 + piece;
          if (seen.has(id)) continue;
          seen.add(id);
          if (accept && !accept(owner)) continue;
          const [a, b] = this.getPiece(owner, piece);
          const projection = projectOntoSegment(point, a, b);
          if (projection.distanceM <= maxDistanceM && (!best || projection.distanceM < best.projection.distanceM)) {
            best = { owner, piece, projection };
          }
        }
      }
    }
    return best;
  }
}
