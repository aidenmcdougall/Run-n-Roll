import { projectOntoSegmentXY, type LngLat, type SegmentProjection } from './geo.js';

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Line geometry the grid indexes. An "owner" is a polyline (a segment or an
 * edge) and a "piece" is the straight part between two consecutive vertices.
 */
export interface PieceSource {
  readonly ownerCount: number;
  pieceCount(owner: number): number;
  /** Writes the piece's endpoints into `out` as [aLng, aLat, bLng, bLat]. */
  readPiece(owner: number, piece: number, out: Float64Array): void;
}

export interface NearestPiece {
  owner: number;
  piece: number;
  projection: SegmentProjection;
}

/**
 * Uniform grid over line pieces, for nearest-line queries.
 *
 * Each piece is registered in every cell its bounding box touches. Storage
 * is compact, for millions of pieces: cell keys are sorted in a
 * Float64Array, and a cell's (owner, piece) entries sit contiguously in one
 * Int32Array (CSR layout). A hand-rolled grid avoids an R-tree dependency
 * and is plenty for a single region.
 */
export class SegmentGrid {
  private readonly offset: number;
  private readonly span: number;

  private constructor(
    private readonly source: PieceSource,
    private readonly cellSizeDeg: number,
    private readonly cellKeys: Float64Array,
    private readonly cellStart: Int32Array,
    private readonly entries: Int32Array,
  ) {
    [this.offset, this.span] = keySpace(cellSizeDeg);
  }

  /** @param cellSizeDeg cell edge length in degrees (0.001° ≈ 110 m N–S). */
  static build(source: PieceSource, cellSizeDeg = 0.001): SegmentGrid {
    const [offset, span] = keySpace(cellSizeDeg);
    const scratch = new Float64Array(4);
    const forEachCell = (visit: (key: number, owner: number, piece: number) => void): void => {
      for (let owner = 0; owner < source.ownerCount; owner++) {
        const pieces = source.pieceCount(owner);
        for (let piece = 0; piece < pieces; piece++) {
          source.readPiece(owner, piece, scratch);
          const x0 = Math.floor(Math.min(scratch[0]!, scratch[2]!) / cellSizeDeg);
          const x1 = Math.floor(Math.max(scratch[0]!, scratch[2]!) / cellSizeDeg);
          const y0 = Math.floor(Math.min(scratch[1]!, scratch[3]!) / cellSizeDeg);
          const y1 = Math.floor(Math.max(scratch[1]!, scratch[3]!) / cellSizeDeg);
          for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) visit((x + offset) * span + (y + offset), owner, piece);
          }
        }
      }
    };

    // Pass 1: count entries per cell.
    const counts = new Map<number, number>();
    let total = 0;
    forEachCell((key) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    });

    // Sort cell keys and lay cells out contiguously.
    const cellKeys = Float64Array.from(counts.keys()).sort();
    const cellStart = new Int32Array(cellKeys.length + 1);
    for (let i = 0; i < cellKeys.length; i++) {
      const key = cellKeys[i]!;
      cellStart[i + 1] = cellStart[i]! + counts.get(key)!;
      counts.set(key, i); // reuse the map as key -> cell index for pass 2
    }

    // Pass 2: fill entries.
    const entries = new Int32Array(total * 2);
    const cursor = cellStart.slice(0, cellKeys.length);
    forEachCell((key, owner, piece) => {
      const at = cursor[counts.get(key)!]!++;
      entries[at * 2] = owner;
      entries[at * 2 + 1] = piece;
    });

    return new SegmentGrid(source, cellSizeDeg, cellKeys, cellStart, entries);
  }

  private findCell(key: number): number {
    let lo = 0;
    let hi = this.cellKeys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = this.cellKeys[mid]!;
      if (value === key) return mid;
      if (value < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Finds the closest piece to `point` within `maxDistanceM`, optionally
   * ignoring owners rejected by `accept`.
   */
  nearest(point: LngLat, maxDistanceM: number, accept?: (owner: number) => boolean): NearestPiece | null {
    // Convert the metric search radius into a (conservative) cell radius.
    const latDeg = maxDistanceM / METERS_PER_DEGREE_LAT;
    const lngDeg = latDeg / Math.max(0.01, Math.cos((point[1] * Math.PI) / 180));
    const cx = Math.floor(point[0] / this.cellSizeDeg);
    const cy = Math.floor(point[1] / this.cellSizeDeg);
    const rx = Math.ceil(lngDeg / this.cellSizeDeg);
    const ry = Math.ceil(latDeg / this.cellSizeDeg);

    const scratch = new Float64Array(4);
    let best: NearestPiece | null = null;
    const seen = new Set<number>();
    for (let x = cx - rx; x <= cx + rx; x++) {
      for (let y = cy - ry; y <= cy + ry; y++) {
        const cell = this.findCell((x + this.offset) * this.span + (y + this.offset));
        if (cell < 0) continue;
        for (let i = this.cellStart[cell]!; i < this.cellStart[cell + 1]!; i++) {
          const owner = this.entries[i * 2]!;
          const piece = this.entries[i * 2 + 1]!;
          // Pieces spanning several cells appear in each; test them once.
          const id = owner * 1_048_576 + piece;
          if (seen.has(id)) continue;
          seen.add(id);
          if (accept && !accept(owner)) continue;
          this.source.readPiece(owner, piece, scratch);
          const projection = projectOntoSegmentXY(point[0], point[1], scratch[0]!, scratch[1]!, scratch[2]!, scratch[3]!);
          if (projection.distanceM <= maxDistanceM && (!best || projection.distanceM < best.projection.distanceM)) {
            best = { owner, piece, projection };
          }
        }
      }
    }
    return best;
  }
}

/** Integer cell (x, y) → one exact numeric key: (x + offset) * span + (y + offset). */
function keySpace(cellSizeDeg: number): [offset: number, span: number] {
  const offset = Math.ceil(180 / cellSizeDeg) + 2;
  return [offset, 2 * offset + 1];
}
