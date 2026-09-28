import { aStar, type SearchSpace } from './astar.js';
import { cumulativeLengths, haversineMeters, slicePolyline, type LngLat } from './geo.js';
import type { GraphEdge, RoutingGraph } from './graph.js';
import { edgeCost, minCostPerMeter, type EdgeKind, type RoutingProfile } from './weights.js';

export const DEFAULT_MAX_SNAP_DISTANCE_M = 500;

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

export interface RoutePlan {
  readonly coordinates: LngLat[];
  readonly distanceM: number;
  /** Profile-weighted cost; equals distanceM for the "shortest" profile. */
  readonly cost: number;
  /** Consecutive stretches of the same kind and name, in travel order. */
  readonly legs: RouteLeg[];
  /** Metres travelled on each kind of edge. */
  readonly distanceByKind: Partial<Record<EdgeKind, number>>;
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
}

/**
 * Snaps a point to the closest location on the network, optionally only
 * considering edges in a given connected component.
 */
export function snapToNetwork(
  graph: RoutingGraph,
  point: LngLat,
  maxDistanceM: number,
  component?: number,
): SnappedPoint | null {
  const hit = graph.edgeIndex.nearest(
    point,
    maxDistanceM,
    component === undefined ? undefined : (edgeId) => graph.componentOf[graph.edges[edgeId]!.from] === component,
  );
  if (!hit) return null;
  const edge = graph.edges[hit.owner]!;
  const cumulative = cumulativeLengths(edge.coordinates);
  const pieceStart = cumulative[hit.piece]!;
  const pieceLength = cumulative[hit.piece + 1]! - pieceStart;
  return {
    edgeId: edge.id,
    alongM: Math.min(edge.lengthM, pieceStart + pieceLength * hit.projection.t),
    point: hit.projection.point,
    distanceM: hit.projection.distanceM,
  };
}

const componentOfSnap = (graph: RoutingGraph, snap: SnappedPoint): number =>
  graph.componentOf[graph.edges[snap.edgeId]!.from]!;

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

/** Per-profile edge costs, computed once per graph and reused across requests. */
const costCache = new WeakMap<RoutingGraph, Map<string, Float64Array>>();

function edgeCosts(graph: RoutingGraph, profile: RoutingProfile): Float64Array {
  let byProfile = costCache.get(graph);
  if (!byProfile) costCache.set(graph, (byProfile = new Map()));
  let costs = byProfile.get(profile.id);
  if (!costs) {
    costs = Float64Array.from(graph.edges, (edge) => edgeCost(edge, profile));
    byProfile.set(profile.id, costs);
  }
  return costs;
}

function canTraverse(edge: GraphEdge, forward: boolean, profile: RoutingProfile): boolean {
  if (!profile.respectOneWay || edge.direction === 'both') return true;
  return forward === (edge.direction === 'forward');
}

/**
 * Plans the cheapest route between two arbitrary points under `profile`.
 *
 * Both points are snapped to the closest point on the network, which is
 * usually part-way along an edge. Rather than rounding to the nearest
 * junction (which could be hundreds of metres away), we add a virtual start
 * node S and end node T joined to the ends of their edges by partial-cost
 * arcs, then run A* from S to T.
 */
export function planRoute(
  graph: RoutingGraph,
  from: LngLat,
  to: LngLat,
  profile: RoutingProfile,
  options: PlanOptions = {},
): PlanResult {
  const maxSnap = options.maxSnapDistanceM ?? DEFAULT_MAX_SNAP_DISTANCE_M;
  const nearestStart = snapToNetwork(graph, from, maxSnap);
  if (!nearestStart) {
    return { ok: false, code: 'START_NOT_NEAR_NETWORK', message: `No path within ${maxSnap} m of the start point.` };
  }
  const nearestEnd = snapToNetwork(graph, to, maxSnap);
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
  const startEdge = graph.edges[start.edgeId]!;
  const endEdge = graph.edges[end.edgeId]!;

  const costs = edgeCosts(graph, profile);
  const S = graph.nodes.length;
  const T = S + 1;
  const costPerM = (edge: GraphEdge): number => (edge.lengthM > 0 ? costs[edge.id]! / edge.lengthM : 0);
  const startCostPerM = costPerM(startEdge);
  const endCostPerM = costPerM(endEdge);
  const heuristicScale = minCostPerMeter(profile);

  const space: SearchSpace = {
    nodeCount: graph.nodes.length + 2,
    heuristic: (node) =>
      node === T ? 0 : haversineMeters(node === S ? start.point : graph.nodes[node]!, end.point) * heuristicScale,
    forEachArc(node, visit) {
      if (node === T) return;
      if (node === S) {
        if (canTraverse(startEdge, false, profile)) visit(startEdge.from, start.alongM * startCostPerM, REF_START_TO_FROM);
        if (canTraverse(startEdge, true, profile)) {
          visit(startEdge.to, (startEdge.lengthM - start.alongM) * startCostPerM, REF_START_TO_TO);
        }
        if (start.edgeId === end.edgeId && canTraverse(startEdge, end.alongM >= start.alongM, profile)) {
          visit(T, Math.abs(end.alongM - start.alongM) * startCostPerM, REF_START_TO_END);
        }
        return;
      }
      for (const edgeId of graph.adjacency[node]!) {
        const edge = graph.edges[edgeId]!;
        const forward = edge.from === node;
        if (!canTraverse(edge, forward, profile)) continue;
        visit(forward ? edge.to : edge.from, costs[edgeId]!, edgeId);
      }
      if (node === endEdge.from && canTraverse(endEdge, true, profile)) {
        visit(T, end.alongM * endCostPerM, REF_FROM_TO_END);
      }
      if (node === endEdge.to && canTraverse(endEdge, false, profile)) {
        visit(T, (endEdge.lengthM - end.alongM) * endCostPerM, REF_TO_TO_END);
      }
    },
  };

  const result = aStar(space, S, T);
  if (!result) {
    return { ok: false, code: 'NO_ROUTE', message: 'No route could be found between these points.' };
  }

  // Rebuild geometry and per-leg stats from the arcs taken.
  const coordinates: LngLat[] = [];
  const legs: RouteLeg[] = [];
  const distanceByKind: Partial<Record<EdgeKind, number>> = {};
  let distanceM = 0;

  const append = (edge: GraphEdge, piece: LngLat[], lengthM: number): void => {
    // Consecutive pieces share their joining vertex; don't duplicate it.
    coordinates.push(...(coordinates.length > 0 ? piece.slice(1) : piece));
    if (lengthM <= 0) return;
    distanceM += lengthM;
    distanceByKind[edge.kind] = (distanceByKind[edge.kind] ?? 0) + lengthM;
    const last = legs[legs.length - 1];
    if (last && last.kind === edge.kind && last.name === edge.name) {
      legs[legs.length - 1] = { ...last, lengthM: last.lengthM + lengthM };
    } else {
      legs.push({ kind: edge.kind, name: edge.name, lengthM });
    }
  };

  const partial = (edge: GraphEdge, fromM: number, toM: number): void => {
    append(edge, slicePolyline(edge.coordinates, cumulativeLengths(edge.coordinates), fromM, toM), Math.abs(toM - fromM));
  };

  result.refs.forEach((ref, i) => {
    const fromNode = result.nodes[i]!;
    switch (ref) {
      case REF_START_TO_FROM:
        return partial(startEdge, start.alongM, 0);
      case REF_START_TO_TO:
        return partial(startEdge, start.alongM, startEdge.lengthM);
      case REF_FROM_TO_END:
        return partial(endEdge, 0, end.alongM);
      case REF_TO_TO_END:
        return partial(endEdge, endEdge.lengthM, end.alongM);
      case REF_START_TO_END:
        return partial(startEdge, start.alongM, end.alongM);
      default: {
        const edge = graph.edges[ref]!;
        const piece = edge.from === fromNode ? [...edge.coordinates] : [...edge.coordinates].reverse();
        return append(edge, piece, edge.lengthM);
      }
    }
  });

  return {
    ok: true,
    route: { coordinates, distanceM, cost: result.cost, legs, distanceByKind, start, end, nodesSettled: result.settled },
  };
}
