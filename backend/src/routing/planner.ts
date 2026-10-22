import { SURFACE_CLASSES, type Smoothness, type SurfaceClass } from '../domain/surface.js';
import { aStar, type SearchSpace } from './astar.js';
import { cumulativeLengths, haversineXY, slicePolyline, type LngLat } from './geo.js';
import { edgeCoordinates, edgeDirection, edgeSmoothness, getEdge, type GraphEdge, type RoutingGraph } from './graph.js';
import { EDGE_KINDS, edgeCost, minCostPerMeter, type CostableEdge, type EdgeKind, type RoutingProfile } from './weights.js';

export const DEFAULT_MAX_SNAP_DISTANCE_M = 500;

/**
 * A snap this close (m) to either end of an edge is treated as being at that
 * junction. Stops routes gaining millimetre-long "legs" from float and
 * fixed-point rounding when a point sits on a junction.
 */
const JUNCTION_SNAP_M = 0.5;

/** A point on the network: a distance along a specific edge. */
export interface SnappedPoint {
  readonly edgeId: number;
  readonly alongM: number;
  readonly point: LngLat;
  /** How far the requested point was from the network. */
  readonly distanceM: number;
}

export interface RouteLeg {
  readonly kind: EdgeKind;
  readonly name: string | null;
  readonly lengthM: number;
}

/**
 * A stretch of the route with uniform attributes (consecutive edges with the
 * same kind, surface, smoothness and hazards are merged). The input to route
 * scoring.
 */
export interface RouteStretch {
  readonly kind: EdgeKind;
  readonly surfaceClass: SurfaceClass;
  readonly surfaceInferred: boolean;
  readonly smoothness: Smoothness | null;
  readonly hazards: readonly string[];
  readonly lengthM: number;
}

/**
 * A stretch of one edge travelled by a route, from `fromM` to `toM` along the
 * edge's geometry (`fromM > toM` means travelled backwards). Whole edges run
 * from 0 to the edge's length.
 */
export interface RoutePiece {
  readonly edgeId: number;
  readonly fromM: number;
  readonly toM: number;
}

export interface RoutePlan {
  readonly coordinates: LngLat[];
  readonly distanceM: number;
  /** Profile-weighted cost; equals distanceM for the "shortest" profile. */
  readonly cost: number;
  /** Consecutive stretches of the same kind and name, in travel order. */
  readonly legs: RouteLeg[];
  /** Metres travelled on each kind of edge. */
  readonly distanceByKind: Partial<Record<EdgeKind, number>>;
  /** Metres travelled on each surface class. */
  readonly distanceBySurface: Partial<Record<SurfaceClass, number>>;
  /** Metres whose surface class was inferred rather than tagged. */
  readonly inferredSurfaceM: number;
  /** The route as uniform stretches, in travel order. */
  readonly stretches: RouteStretch[];
  /** The edges travelled, in order. */
  readonly pieces: RoutePiece[];
  readonly start: SnappedPoint;
  readonly end: SnappedPoint;
  readonly nodesSettled: number;
}

export type PlanErrorCode = 'START_NOT_NEAR_NETWORK' | 'END_NOT_NEAR_NETWORK' | 'NO_ROUTE';

export type PlanResult =
  | { readonly ok: true; readonly route: RoutePlan }
  | { readonly ok: false; readonly code: PlanErrorCode; readonly message: string };

export interface PlanOptions {
  maxSnapDistanceM?: number;
  /**
   * Surfaces the user wants to avoid. A route must travel along the edge its
   * start snaps to until it reaches a junction, so a click beside a long
   * gravel track would force the route to cover that gravel. When the nearest
   * edge has an avoided surface, the point may instead snap to an acceptable
   * edge further away (see `snapPreferring`).
   */
  avoidSurfacesAtEnds?: readonly SurfaceClass[];
}

/** Minimum extra distance (m) we'll snap to reach an edge with an acceptable surface. */
export const PREFERRED_SNAP_EXTRA_M = 75;

/**
 * Snaps a point to the closest location on the network, optionally only
 * considering edges in a given connected component.
 */
export function snapToNetwork(
  graph: RoutingGraph,
  point: LngLat,
  maxDistanceM: number,
  component?: number,
  accept?: (edgeId: number) => boolean,
): SnappedPoint | null {
  const inComponent =
    component === undefined ? undefined : (edgeId: number) => graph.componentOf[graph.edgeFrom[edgeId]!] === component;
  const filter =
    inComponent && accept ? (edgeId: number) => inComponent(edgeId) && accept(edgeId) : (inComponent ?? accept);
  const hit = graph.edgeIndex.nearest(point, maxDistanceM, filter);
  if (!hit) return null;
  const cumulative = cumulativeLengths(edgeCoordinates(graph, hit.owner));
  const pieceStart = cumulative[hit.piece]!;
  const pieceLength = cumulative[hit.piece + 1]! - pieceStart;
  const lengthM = graph.edgeLength[hit.owner]!;
  let alongM = Math.min(lengthM, pieceStart + pieceLength * hit.projection.t);
  if (alongM < JUNCTION_SNAP_M) alongM = 0;
  else if (lengthM - alongM < JUNCTION_SNAP_M) alongM = lengthM;
  return { edgeId: hit.owner, alongM, point: hit.projection.point, distanceM: hit.projection.distanceM };
}

const componentOfSnap = (graph: RoutingGraph, snap: SnappedPoint): number =>
  graph.componentOf[graph.edgeFrom[snap.edgeId]!]!;

/**
 * The closest edge to a point is sometimes a short isolated fragment even
 * though the main network is only a little further away. If the nearest
 * snaps are in different connected components, consider re-snapping so both
 * ends are mutually reachable — the end into the start's component, the start
 * into the end's, or both into the main network — and keep whichever option
 * moves the points least in total.
 */
function chooseConnectedSnap(
  graph: RoutingGraph,
  from: LngLat,
  to: LngLat,
  start: SnappedPoint,
  end: SnappedPoint,
  maxSnap: number,
): { start: SnappedPoint; end: SnappedPoint } | null {
  const startComponent = componentOfSnap(graph, start);
  const endComponent = componentOfSnap(graph, end);
  if (startComponent === endComponent) return { start, end };

  const candidates: { start: SnappedPoint | null; end: SnappedPoint | null }[] = [
    { start, end: snapToNetwork(graph, to, maxSnap, startComponent) },
    { start: snapToNetwork(graph, from, maxSnap, endComponent), end },
  ];
  const main = graph.largestComponent;
  if (startComponent !== main && endComponent !== main) {
    candidates.push({ start: snapToNetwork(graph, from, maxSnap, main), end: snapToNetwork(graph, to, maxSnap, main) });
  }

  let best: { start: SnappedPoint; end: SnappedPoint } | null = null;
  for (const c of candidates) {
    if (!c.start || !c.end) continue;
    if (!best || c.start.distanceM + c.end.distanceM < best.start.distanceM + best.end.distanceM) {
      best = { start: c.start, end: c.end };
    }
  }
  return best;
}

// Arc refs >= 0 are real edge IDs; these negative refs are partial-edge arcs
// to and from the virtual start (S) and end (T) nodes.
const REF_START_TO_FROM = -1; // S → start edge's `from` node
const REF_START_TO_TO = -2; // S → start edge's `to` node
const REF_FROM_TO_END = -3; // end edge's `from` node → T
const REF_TO_TO_END = -4; // end edge's `to` node → T
const REF_START_TO_END = -5; // S → T along a single shared edge

/**
 * Per-profile edge costs, computed once per graph and reused across
 * requests. Each array is ~12 MB on the full network and preferences
 * multiply the number of possible profiles, so only the most recently used
 * few are kept (least-recently-used eviction).
 */
export const MAX_CACHED_PROFILES = 6;
const costCache = new WeakMap<RoutingGraph, Map<string, Float64Array>>();

export function edgeCosts(graph: RoutingGraph, profile: RoutingProfile): Float64Array {
  let byProfile = costCache.get(graph);
  if (!byProfile) costCache.set(graph, (byProfile = new Map()));
  const cached = byProfile.get(profile.id);
  if (cached) {
    // Re-insert to mark as most recently used (Maps iterate in insertion order).
    byProfile.delete(profile.id);
    byProfile.set(profile.id, cached);
    return cached;
  }

  const costs = new Float64Array(graph.edgeCount);
  // One reusable view object keeps this allocation-free over 1M+ edges
  // while still going through the single `edgeCost` definition.
  const view: { -readonly [K in keyof CostableEdge]: CostableEdge[K] } = {
    lengthM: 0,
    kind: 'unknown',
    hazards: [],
    surfaceClass: 'unknown',
    smoothness: null,
  };
  for (let e = 0; e < graph.edgeCount; e++) {
    view.lengthM = graph.edgeLength[e]!;
    view.kind = EDGE_KINDS[graph.edgeKind[e]!]!;
    view.hazards = graph.hazardSets[graph.edgeHazards[e]!]!;
    view.surfaceClass = SURFACE_CLASSES[graph.edgeSurface[e]!]!;
    view.smoothness = edgeSmoothness(graph, e);
    costs[e] = edgeCost(view, profile);
  }
  byProfile.set(profile.id, costs);
  if (byProfile.size > MAX_CACHED_PROFILES) byProfile.delete(byProfile.keys().next().value!);
  return costs;
}

/** Number of profiles with cached costs for a graph (for tests and diagnostics). */
export function cachedProfileCount(graph: RoutingGraph): number {
  return costCache.get(graph)?.size ?? 0;
}

function canTraverse(graph: RoutingGraph, edge: number, forward: boolean, profile: RoutingProfile): boolean {
  if (!profile.respectOneWay) return true;
  const direction = edgeDirection(graph, edge);
  return direction === 'both' || forward === (direction === 'forward');
}

/**
 * Snaps like `snapToNetwork`, but steps off an avoided surface onto an
 * acceptable edge when that is the better trade (see
 * `PlanOptions.avoidSurfacesAtEnds`).
 *
 * The trade: snapping to the avoided edge forces the route to travel along
 * it to its nearest end (`exitM`). We'll snap up to that much further away
 * instead — never less than PREFERRED_SNAP_EXTRA_M, never beyond the normal
 * snapping range — so "start 90 m away on a sealed path" beats "cover 900 m
 * of dirt first".
 */
export function snapPreferring(
  graph: RoutingGraph,
  point: LngLat,
  maxDistanceM: number,
  avoid: ReadonlySet<number>,
): SnappedPoint | null {
  const nearest = snapToNetwork(graph, point, maxDistanceM);
  if (!nearest || avoid.size === 0 || !avoid.has(graph.edgeSurface[nearest.edgeId]!)) return nearest;
  const exitM = Math.min(nearest.alongM, graph.edgeLength[nearest.edgeId]! - nearest.alongM);
  const reach = Math.min(maxDistanceM, nearest.distanceM + Math.max(PREFERRED_SNAP_EXTRA_M, exitM));
  return snapToNetwork(graph, point, reach, undefined, (edge) => !avoid.has(graph.edgeSurface[edge]!)) ?? nearest;
}

/**
 * Plans the cheapest route between two arbitrary points under `profile`:
 * snaps both to the network (see `snapPreferring` and `chooseConnectedSnap`),
 * then routes between the snapped points (see `routeBetween`).
 */
export function planRoute(
  graph: RoutingGraph,
  from: LngLat,
  to: LngLat,
  profile: RoutingProfile,
  options: PlanOptions = {},
): PlanResult {
  const maxSnap = options.maxSnapDistanceM ?? DEFAULT_MAX_SNAP_DISTANCE_M;
  const avoid = new Set((options.avoidSurfacesAtEnds ?? []).map((surface) => SURFACE_CLASSES.indexOf(surface)));
  const nearestStart = snapPreferring(graph, from, maxSnap, avoid);
  if (!nearestStart) {
    return { ok: false, code: 'START_NOT_NEAR_NETWORK', message: `No path within ${maxSnap} m of the start point.` };
  }
  const nearestEnd = snapPreferring(graph, to, maxSnap, avoid);
  if (!nearestEnd) {
    return { ok: false, code: 'END_NOT_NEAR_NETWORK', message: `No path within ${maxSnap} m of the destination.` };
  }
  const endpoints = chooseConnectedSnap(graph, from, to, nearestStart, nearestEnd, maxSnap);
  if (!endpoints) {
    return {
      ok: false,
      code: 'NO_ROUTE',
      message: 'The start and destination are on parts of the path network that are not connected.',
    };
  }
  const { start, end } = endpoints;
  const leg = routeBetween(graph, start, end, profile);
  if (!leg) {
    return { ok: false, code: 'NO_ROUTE', message: 'No route could be found between these points.' };
  }
  return { ok: true, route: assemblePlan(graph, leg.pieces, { cost: leg.cost, start, end, nodesSettled: leg.settled }) };
}

export interface LegOptions {
  /** Edges that cost `penaltyFactor` times more, e.g. ones a loop has already used. */
  readonly penalisedEdges?: ReadonlySet<number>;
  readonly penaltyFactor?: number;
}

export interface Leg {
  readonly pieces: RoutePiece[];
  /** Cost under the profile, including any penalties from `LegOptions`. */
  readonly cost: number;
  readonly settled: number;
}

/**
 * The cheapest route between two points already on the network, or null if
 * there is none.
 *
 * Both points are usually part-way along an edge. Rather than rounding to the
 * nearest junction (which could be hundreds of metres away), we add a virtual
 * start node S and end node T joined to the ends of their edges by
 * partial-cost arcs, then run A* from S to T.
 */
export function routeBetween(
  graph: RoutingGraph,
  start: SnappedPoint,
  end: SnappedPoint,
  profile: RoutingProfile,
  options: LegOptions = {},
): Leg | null {
  const startEdge = getEdge(graph, start.edgeId);
  const endEdge = getEdge(graph, end.edgeId);

  const baseCosts = edgeCosts(graph, profile);
  const penalised = options.penalisedEdges;
  const penaltyFactor = options.penaltyFactor ?? 1;
  // Penalties are >= 1, so the A* heuristic below stays admissible.
  const cost = penalised && penalised.size > 0 && penaltyFactor !== 1
    ? (edge: number) => (penalised.has(edge) ? baseCosts[edge]! * penaltyFactor : baseCosts[edge]!)
    : (edge: number) => baseCosts[edge]!;
  const S = graph.nodeCount;
  const T = S + 1;
  const costPerM = (edge: GraphEdge): number => (edge.lengthM > 0 ? cost(edge.id) / edge.lengthM : 0);
  const startCostPerM = costPerM(startEdge);
  const endCostPerM = costPerM(endEdge);
  const heuristicScale = minCostPerMeter(profile);
  const [endLng, endLat] = end.point;
  const { nodeCoords, adjOffset, adjEdges, edgeFrom, edgeTo } = graph;

  const space: SearchSpace = {
    nodeCount: graph.nodeCount + 2,
    heuristic: (node) => {
      if (node === T) return 0;
      if (node === S) return haversineXY(start.point[0], start.point[1], endLng, endLat) * heuristicScale;
      return haversineXY(nodeCoords[node * 2]!, nodeCoords[node * 2 + 1]!, endLng, endLat) * heuristicScale;
    },
    forEachArc(node, visit) {
      if (node === T) return;
      if (node === S) {
        if (canTraverse(graph, startEdge.id, false, profile)) {
          visit(startEdge.from, start.alongM * startCostPerM, REF_START_TO_FROM);
        }
        if (canTraverse(graph, startEdge.id, true, profile)) {
          visit(startEdge.to, (startEdge.lengthM - start.alongM) * startCostPerM, REF_START_TO_TO);
        }
        if (start.edgeId === end.edgeId && canTraverse(graph, startEdge.id, end.alongM >= start.alongM, profile)) {
          visit(T, Math.abs(end.alongM - start.alongM) * startCostPerM, REF_START_TO_END);
        }
        return;
      }
      for (let i = adjOffset[node]!; i < adjOffset[node + 1]!; i++) {
        const edge = adjEdges[i]!;
        const forward = edgeFrom[edge] === node;
        if (!canTraverse(graph, edge, forward, profile)) continue;
        visit(forward ? edgeTo[edge]! : edgeFrom[edge]!, cost(edge), edge);
      }
      if (node === endEdge.from && canTraverse(graph, endEdge.id, true, profile)) {
        visit(T, end.alongM * endCostPerM, REF_FROM_TO_END);
      }
      if (node === endEdge.to && canTraverse(graph, endEdge.id, false, profile)) {
        visit(T, (endEdge.lengthM - end.alongM) * endCostPerM, REF_TO_TO_END);
      }
    },
  };

  const result = aStar(space, S, T);
  if (!result) return null;

  const pieces = result.refs.map((ref, i): RoutePiece => {
    switch (ref) {
      case REF_START_TO_FROM:
        return { edgeId: startEdge.id, fromM: start.alongM, toM: 0 };
      case REF_START_TO_TO:
        return { edgeId: startEdge.id, fromM: start.alongM, toM: startEdge.lengthM };
      case REF_FROM_TO_END:
        return { edgeId: endEdge.id, fromM: 0, toM: end.alongM };
      case REF_TO_TO_END:
        return { edgeId: endEdge.id, fromM: endEdge.lengthM, toM: end.alongM };
      case REF_START_TO_END:
        return { edgeId: startEdge.id, fromM: start.alongM, toM: end.alongM };
      default: {
        const lengthM = graph.edgeLength[ref]!;
        return edgeFrom[ref] === result.nodes[i] ? { edgeId: ref, fromM: 0, toM: lengthM } : { edgeId: ref, fromM: lengthM, toM: 0 };
      }
    }
  });
  return { pieces, cost: result.cost, settled: result.settled };
}

/** Profile cost of travelling some pieces (without leg penalties). */
export function piecesCost(graph: RoutingGraph, pieces: readonly RoutePiece[], profile: RoutingProfile): number {
  const costs = edgeCosts(graph, profile);
  let total = 0;
  for (const { edgeId, fromM, toM } of pieces) {
    const lengthM = graph.edgeLength[edgeId]!;
    if (lengthM > 0) total += (costs[edgeId]! / lengthM) * Math.abs(toM - fromM);
  }
  return total;
}

/** Builds the route's geometry and per-kind, per-surface and per-stretch stats from the pieces travelled. */
export function assemblePlan(
  graph: RoutingGraph,
  pieces: readonly RoutePiece[],
  meta: { cost: number; start: SnappedPoint; end: SnappedPoint; nodesSettled: number },
): RoutePlan {
  const coordinates: LngLat[] = [];
  const legs: RouteLeg[] = [];
  const distanceByKind: Partial<Record<EdgeKind, number>> = {};
  const distanceBySurface: Partial<Record<SurfaceClass, number>> = {};
  const stretches: RouteStretch[] = [];
  let distanceM = 0;
  let inferredSurfaceM = 0;

  const sameStretch = (a: RouteStretch, e: GraphEdge): boolean =>
    a.kind === e.kind &&
    a.surfaceClass === e.surfaceClass &&
    a.surfaceInferred === e.surfaceInferred &&
    a.smoothness === e.smoothness &&
    a.hazards.join() === e.hazards.join();

  const append = (edge: GraphEdge, piece: LngLat[], lengthM: number): void => {
    // Consecutive pieces share their joining vertex; don't duplicate it.
    coordinates.push(...(coordinates.length > 0 ? piece.slice(1) : piece));
    if (lengthM <= 0) return;
    distanceM += lengthM;
    distanceByKind[edge.kind] = (distanceByKind[edge.kind] ?? 0) + lengthM;
    distanceBySurface[edge.surfaceClass] = (distanceBySurface[edge.surfaceClass] ?? 0) + lengthM;
    if (edge.surfaceInferred) inferredSurfaceM += lengthM;
    const last = legs[legs.length - 1];
    if (last && last.kind === edge.kind && last.name === edge.name) {
      legs[legs.length - 1] = { ...last, lengthM: last.lengthM + lengthM };
    } else {
      legs.push({ kind: edge.kind, name: edge.name, lengthM });
    }
    const lastStretch = stretches[stretches.length - 1];
    if (lastStretch && sameStretch(lastStretch, edge)) {
      stretches[stretches.length - 1] = { ...lastStretch, lengthM: lastStretch.lengthM + lengthM };
    } else {
      stretches.push({
        kind: edge.kind,
        surfaceClass: edge.surfaceClass,
        surfaceInferred: edge.surfaceInferred,
        smoothness: edge.smoothness,
        hazards: edge.hazards,
        lengthM,
      });
    }
  };

  for (const { edgeId, fromM, toM } of pieces) {
    const edge = getEdge(graph, edgeId);
    const whole = Math.min(fromM, toM) === 0 && Math.max(fromM, toM) === edge.lengthM;
    if (whole && edge.lengthM > 0) {
      append(edge, fromM === 0 ? edge.coordinates : [...edge.coordinates].reverse(), edge.lengthM);
    } else {
      append(edge, slicePolyline(edge.coordinates, cumulativeLengths(edge.coordinates), fromM, toM), Math.abs(toM - fromM));
    }
  }

  return {
    coordinates,
    distanceM,
    cost: meta.cost,
    legs,
    distanceByKind,
    distanceBySurface,
    inferredSurfaceM,
    stretches,
    pieces: [...pieces],
    start: meta.start,
    end: meta.end,
    nodesSettled: meta.nodesSettled,
  };
}
