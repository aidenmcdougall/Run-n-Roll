import { SURFACE_CLASSES, type SurfaceClass } from '../domain/surface.js';
import { destinationPoint, type LngLat } from './geo.js';
import type { RoutingGraph } from './graph.js';
import {
  assemblePlan,
  DEFAULT_MAX_SNAP_DISTANCE_M,
  piecesCost,
  routeBetween,
  snapPreferring,
  snapToNetwork,
  type RoutePiece,
  type RoutePlan,
  type SnappedPoint,
} from './planner.js';
import { minCostPerMeter, type RoutingProfile } from './weights.js';

/**
 * Routes of a target length from a start point: "a 5 km loop from here", or
 * "10 km in any direction".
 *
 * There's no destination to search towards, so we make some. For each of
 * several compass bearings:
 *
 *  - **loop:** two waypoints that form an equilateral triangle with the start
 *    (start → W1 → W2 → start), one at bearing − 30° and one at bearing + 30°;
 *  - **one way:** one waypoint straight out along the bearing.
 *
 * Each leg is planned with the normal A* router under the activity profile.
 * Edges a loop has already used cost REUSE_PENALTY× more on later legs, so it
 * comes home a different way where it reasonably can.
 *
 * Paths wind, so the network distance is longer than the straight lines
 * between waypoints. We start by assuming a detour factor of 1.3, measure the
 * real ratio, and rescale the waypoints until the route is within
 * DISTANCE_TOLERANCE of the target (at most MAX_ATTEMPTS per bearing).
 *
 * Candidates are ranked by how pleasant they are under the profile (cost per
 * metre), how much they double back on themselves, and how far they miss the
 * target distance. The best few distinct ones are returned, so the user can
 * flick through alternatives.
 */

export const ROUTE_SHAPES = ['loop', 'one_way'] as const;
export type RouteShape = (typeof ROUTE_SHAPES)[number];

export const MIN_TARGET_M = 500;
export const MAX_TARGET_M = 50_000;

/** Compass bearings tried, evenly spaced from north. */
export const BEARING_COUNT = 8;
/** First guess at network distance ÷ straight-line distance between waypoints. */
const INITIAL_DETOUR = 1.3;
/** Detour estimates are clamped to this range so one odd attempt can't send the next one wild. */
const MIN_DETOUR = 1;
const MAX_DETOUR = 3;
/** Rescaling attempts per bearing. */
const MAX_ATTEMPTS = 3;
/** Routes within this share of the target count as on target. */
export const DISTANCE_TOLERANCE = 0.05;
/** Routes further than this share from the target are dropped (the network is too sparse here). */
export const MAX_DISTANCE_ERROR = 0.3;
/** Cost multiplier on edges a loop has already travelled. */
export const REUSE_PENALTY = 3;
/** Ranking weights: how much doubling back and missing the target distance count against a route. */
const REPEAT_WEIGHT = 2;
const DISTANCE_WEIGHT = 4;
/** Alternatives sharing more than this share of their length with a better route are dropped. */
const MAX_SHARED_SHARE = 0.5;
/** A start in a network fragment smaller than this many nodes is moved to a bigger one nearby. */
const MIN_COMPONENT_NODES = 1000;

export interface DistanceRouteOptions {
  readonly shape: RouteShape;
  readonly targetM: number;
  /** Surfaces to keep the start and waypoints off (see PlanOptions.avoidSurfacesAtEnds). */
  readonly avoidSurfaces?: readonly SurfaceClass[];
  readonly maxSnapDistanceM?: number;
  /** How many distinct routes to return, best first. */
  readonly maxRoutes?: number;
}

export interface DistanceRoute {
  readonly route: RoutePlan;
  /** The compass bearing the route heads out on. */
  readonly bearingDeg: number;
  /** (distance − target) ÷ target. */
  readonly distanceError: number;
  /** Metres travelled more than once, e.g. out and back along a dead end. */
  readonly repeatedM: number;
  /** Mean cost per metre relative to an ideal metre under the profile (1 = ideal throughout). */
  readonly costRatio: number;
  /** Lower is better. */
  readonly rank: number;
}

export type DistancePlanResult =
  | { readonly ok: true; readonly routes: DistanceRoute[]; readonly candidates: number }
  | { readonly ok: false; readonly code: 'START_NOT_NEAR_NETWORK' | 'NO_ROUTE'; readonly message: string };

interface Candidate {
  readonly bearingDeg: number;
  readonly pieces: RoutePiece[];
  readonly waypoints: SnappedPoint[];
  readonly distanceM: number;
  readonly repeatedM: number;
  readonly costRatio: number;
  readonly distanceError: number;
  readonly rank: number;
  readonly settled: number;
}

const componentSizeCache = new WeakMap<RoutingGraph, Int32Array>();

/** Node count of each connected component, computed once per graph. */
function componentSizes(graph: RoutingGraph): Int32Array {
  let sizes = componentSizeCache.get(graph);
  if (!sizes) {
    let max = 0;
    for (let n = 0; n < graph.nodeCount; n++) max = Math.max(max, graph.componentOf[n]!);
    sizes = new Int32Array(max + 1);
    for (let n = 0; n < graph.nodeCount; n++) sizes[graph.componentOf[n]!]!++;
    componentSizeCache.set(graph, sizes);
  }
  return sizes;
}

const degree = (graph: RoutingGraph, node: number): number => graph.adjOffset[node + 1]! - graph.adjOffset[node]!;

/** Metres covered more than once: per edge, total length travelled minus the length of the union of the intervals. */
export function repeatedMetres(pieces: readonly RoutePiece[]): number {
  const byEdge = new Map<number, [number, number][]>();
  for (const { edgeId, fromM, toM } of pieces) {
    if (fromM === toM) continue;
    const intervals = byEdge.get(edgeId) ?? [];
    intervals.push([Math.min(fromM, toM), Math.max(fromM, toM)]);
    byEdge.set(edgeId, intervals);
  }
  let repeated = 0;
  for (const intervals of byEdge.values()) {
    if (intervals.length < 2) continue;
    intervals.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let union = 0;
    let [lo, hi] = intervals[0]!;
    for (const [a, b] of intervals) {
      total += b - a;
      if (a > hi) {
        union += hi - lo;
        [lo, hi] = [a, b];
      } else {
        hi = Math.max(hi, b);
      }
    }
    union += hi - lo;
    repeated += total - union;
  }
  return repeated;
}

const travelled = (pieces: readonly RoutePiece[]): number => pieces.reduce((sum, p) => sum + Math.abs(p.toM - p.fromM), 0);

/** Share of `a`'s length on edges that `b` also uses. */
function sharedShare(a: Candidate, b: Candidate): number {
  const other = new Set(b.pieces.map((p) => p.edgeId));
  const shared = a.pieces.reduce((sum, p) => sum + (other.has(p.edgeId) ? Math.abs(p.toM - p.fromM) : 0), 0);
  return a.distanceM > 0 ? shared / a.distanceM : 1;
}

export function planDistanceRoutes(
  graph: RoutingGraph,
  from: LngLat,
  profile: RoutingProfile,
  options: DistanceRouteOptions,
): DistancePlanResult {
  const maxSnap = options.maxSnapDistanceM ?? DEFAULT_MAX_SNAP_DISTANCE_M;
  const avoid = new Set((options.avoidSurfaces ?? []).map((surface) => SURFACE_CLASSES.indexOf(surface)));
  const sizes = componentSizes(graph);
  const componentOfEdge = (edge: number): number => graph.componentOf[graph.edgeFrom[edge]!]!;

  let nearest = snapPreferring(graph, from, maxSnap, avoid);
  if (!nearest) {
    return { ok: false, code: 'START_NOT_NEAR_NETWORK', message: `No path within ${maxSnap} m of the start point.` };
  }
  // A loop can't be built inside a tiny isolated fragment; step onto a real network if one is in range.
  if (sizes[componentOfEdge(nearest.edgeId)]! < MIN_COMPONENT_NODES) {
    nearest =
      snapToNetwork(graph, from, maxSnap, undefined, (e) => sizes[componentOfEdge(e)]! >= MIN_COMPONENT_NODES) ?? nearest;
  }
  const start = nearest;
  const component = componentOfEdge(start.edgeId);

  // Waypoints stay in the start's component and off avoided surfaces. Loop
  // waypoints also avoid dead-end edges, which would force an out-and-back.
  const acceptWaypoint = (edge: number): boolean =>
    componentOfEdge(edge) === component &&
    !avoid.has(graph.edgeSurface[edge]!) &&
    (options.shape === 'one_way' || (degree(graph, graph.edgeFrom[edge]!) > 1 && degree(graph, graph.edgeTo[edge]!) > 1));
  const snapWaypoint = (point: LngLat): SnappedPoint | null =>
    snapToNetwork(graph, point, maxSnap, undefined, acceptWaypoint) ?? snapToNetwork(graph, point, maxSnap, component);

  const legsPerSide = options.shape === 'loop' ? 3 : 1; // straight-line length = legsPerSide × side
  const idealCost = minCostPerMeter(profile);

  const attempt = (bearingDeg: number, sideM: number): Candidate | null => {
    const targets =
      options.shape === 'loop'
        ? [destinationPoint(start.point, bearingDeg - 30, sideM), destinationPoint(start.point, bearingDeg + 30, sideM)]
        : [destinationPoint(start.point, bearingDeg, sideM)];
    const waypoints: SnappedPoint[] = [start];
    for (const target of targets) {
      const snapped = snapWaypoint(target);
      if (!snapped) return null;
      waypoints.push(snapped);
    }
    if (options.shape === 'loop') waypoints.push(start);

    const pieces: RoutePiece[] = [];
    const used = new Set<number>();
    let settled = 0;
    for (let i = 0; i + 1 < waypoints.length; i++) {
      const leg = routeBetween(graph, waypoints[i]!, waypoints[i + 1]!, profile, {
        penalisedEdges: used,
        penaltyFactor: REUSE_PENALTY,
      });
      if (!leg) return null;
      settled += leg.settled;
      for (const piece of leg.pieces) {
        pieces.push(piece);
        used.add(piece.edgeId);
      }
    }

    const distanceM = travelled(pieces);
    if (distanceM <= 0) return null;
    const repeatedM = repeatedMetres(pieces);
    const costRatio = piecesCost(graph, pieces, profile) / distanceM / idealCost;
    const distanceError = (distanceM - options.targetM) / options.targetM;
    const rank =
      costRatio *
      (1 + REPEAT_WEIGHT * (repeatedM / distanceM)) *
      (1 + DISTANCE_WEIGHT * Math.max(0, Math.abs(distanceError) - DISTANCE_TOLERANCE));
    return { bearingDeg, pieces, waypoints, distanceM, repeatedM, costRatio, distanceError, rank, settled };
  };

  const candidates: Candidate[] = [];
  for (let b = 0; b < BEARING_COUNT; b++) {
    const bearingDeg = (360 / BEARING_COUNT) * b;
    let detour = INITIAL_DETOUR;
    let best: Candidate | null = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const sideM = options.targetM / (detour * legsPerSide);
      const candidate = attempt(bearingDeg, sideM);
      if (!candidate) break;
      if (!best || candidate.rank < best.rank) best = candidate;
      if (Math.abs(candidate.distanceError) <= DISTANCE_TOLERANCE) break;
      // Measured detour for this bearing; rescale so the next attempt lands on target.
      detour = Math.min(MAX_DETOUR, Math.max(MIN_DETOUR, candidate.distanceM / (sideM * legsPerSide)));
    }
    if (best && Math.abs(best.distanceError) <= MAX_DISTANCE_ERROR) candidates.push(best);
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'NO_ROUTE',
      message: 'Could not find a route of that length from here. Try a different distance or start point.',
    };
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const chosen: Candidate[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= (options.maxRoutes ?? 3)) break;
    if (chosen.every((other) => sharedShare(candidate, other) <= MAX_SHARED_SHARE)) chosen.push(candidate);
  }

  return {
    ok: true,
    candidates: candidates.length,
    routes: chosen.map((c) => ({
      route: assemblePlan(graph, c.pieces, {
        cost: c.costRatio * idealCost * c.distanceM,
        start: c.waypoints[0]!,
        end: c.waypoints[c.waypoints.length - 1]!,
        nodesSettled: c.settled,
      }),
      bearingDeg: c.bearingDeg,
      distanceError: c.distanceError,
      repeatedM: c.repeatedM,
      costRatio: c.costRatio,
      rank: c.rank,
    })),
  };
}
