/** A WGS84 coordinate in GeoJSON order: [longitude, latitude]. */
export type LngLat = readonly [lng: number, lat: number];

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean Earth radius
const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance in metres between two WGS84 coordinates. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  return haversineXY(a[0], a[1], b[0], b[1]);
}

/** As `haversineMeters`, on raw numbers: avoids allocating tuples in hot loops. */
export function haversineXY(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cumulative distance (m) at each vertex of a polyline; result[0] === 0. */
export function cumulativeLengths(coords: readonly LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1]! + haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return out;
}

export interface SegmentProjection {
  /** Closest point on segment AB to P. */
  point: LngLat;
  /** Position of `point` along AB, 0 (at A) to 1 (at B). */
  t: number;
  /** Distance from P to `point` in metres. */
  distanceM: number;
}

/**
 * Projects P onto segment AB.
 *
 * Uses a local equirectangular approximation (x scaled by cos(latitude)),
 * which is accurate to well under 1% over the tens-to-hundreds of metres we
 * snap across, and much cheaper than true geodesic projection.
 */
export function projectOntoSegment(p: LngLat, a: LngLat, b: LngLat): SegmentProjection {
  return projectOntoSegmentXY(p[0], p[1], a[0], a[1], b[0], b[1]);
}

/** As `projectOntoSegment`, on raw numbers (P, then segment A→B). */
export function projectOntoSegmentXY(
  pLng: number,
  pLat: number,
  aLng: number,
  aLat: number,
  bLng: number,
  bLat: number,
): SegmentProjection {
  const kx = Math.cos(pLat * DEG_TO_RAD);
  const ax = aLng * kx;
  const dx = bLng * kx - ax;
  const dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((pLng * kx - ax) * dx + (pLat - aLat) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const lng = aLng + (bLng - aLng) * t;
  const lat = aLat + (bLat - aLat) * t;
  return { point: [lng, lat], t, distanceM: haversineXY(pLng, pLat, lng, lat) };
}

/**
 * Returns the part of a polyline between two distances along it. If
 * `fromM > toM` the slice is returned reversed (i.e. in travel direction).
 */
export function slicePolyline(
  coords: readonly LngLat[],
  cumulative: readonly number[],
  fromM: number,
  toM: number,
): LngLat[] {
  if (fromM > toM) return slicePolyline(coords, cumulative, toM, fromM).reverse();
  const out: LngLat[] = [pointAtDistance(coords, cumulative, fromM)];
  for (let i = 0; i < coords.length; i++) {
    const d = cumulative[i]!;
    if (d > fromM && d < toM) out.push(coords[i]!);
  }
  out.push(pointAtDistance(coords, cumulative, toM));
  return out;
}

/** Interpolates the point at a given distance (m) along a polyline. */
export function pointAtDistance(coords: readonly LngLat[], cumulative: readonly number[], distanceM: number): LngLat {
  if (distanceM <= 0) return coords[0]!;
  for (let i = 1; i < coords.length; i++) {
    const end = cumulative[i]!;
    if (distanceM <= end) {
      const start = cumulative[i - 1]!;
      const t = end === start ? 0 : (distanceM - start) / (end - start);
      const a = coords[i - 1]!;
      const b = coords[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return coords[coords.length - 1]!;
}
