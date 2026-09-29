import { INFRA_CATEGORIES, type InfraCategory } from '../domain/infrastructure.js';
import type { SurfaceClass } from '../domain/surface.js';

/**
 * Edge kinds the router can traverse: every infrastructure category from the
 * dataset, plus synthetic `connector` edges the graph builder adds to bridge
 * small gaps between segments that don't share a vertex (see graph.ts).
 */
export type EdgeKind = InfraCategory | 'connector';

/** Every edge kind, in a stable order (the graph stores kinds as indices into this). */
export const EDGE_KINDS: readonly EdgeKind[] = [...INFRA_CATEGORIES, 'connector'];

/**
 * A routing profile turns an edge's physical length into a traversal cost:
 *
 *   cost = length_m × kindMultiplier × Π hazardMultiplier × surfaceMultiplier
 *
 * A multiplier of 1 means "as good as it gets"; 2 means a metre of this edge
 * is as undesirable as two metres of an ideal one. All multipliers must be
 * positive. Keeping every weight here (rather than scattered through the
 * code) is what lets future activity modes — running, skating, couples — be
 * expressed as data.
 */
export interface RoutingProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kindMultipliers: Readonly<Record<EdgeKind, number>>;
  /** Applied once per hazard on an edge; hazards not listed cost nothing extra. */
  readonly hazardMultipliers: Readonly<Record<string, number>>;
  /** Keyed by normalised surface class (see domain/surface.ts). */
  readonly surfaceMultipliers: Readonly<Record<SurfaceClass, number>>;
  /** Whether to honour one-way bike lanes (relevant for cycling, not running). */
  readonly respectOneWay: boolean;
}

/** Edge attributes the cost function needs; a subset of GraphEdge. */
export interface CostableEdge {
  readonly lengthM: number;
  readonly kind: EdgeKind;
  readonly hazards: readonly string[];
  readonly surfaceClass: SurfaceClass;
}

export function edgeCost(edge: CostableEdge, profile: RoutingProfile): number {
  let multiplier = profile.kindMultipliers[edge.kind];
  for (const hazard of edge.hazards) {
    multiplier *= profile.hazardMultipliers[hazard] ?? 1;
  }
  multiplier *= profile.surfaceMultipliers[edge.surfaceClass];
  return edge.lengthM * multiplier;
}

/**
 * Lower bound on cost per metre for any edge under this profile. A* scales
 * its straight-line heuristic by this so the heuristic never overestimates
 * (i.e. stays admissible) and routes remain optimal for the profile.
 */
export function minCostPerMeter(profile: RoutingProfile): number {
  const kind = Math.min(...Object.values(profile.kindMultipliers));
  const surface = Math.min(...Object.values(profile.surfaceMultipliers));
  // Hazards only lower the cost if a multiplier < 1 is configured; the worst
  // case is an edge carrying every discounting hazard at once.
  const hazard = Object.values(profile.hazardMultipliers)
    .filter((value) => value < 1)
    .reduce((product, value) => product * value, 1);
  return kind * hazard * surface;
}

export function validateProfile(profile: RoutingProfile): void {
  const all = [
    ...Object.values(profile.kindMultipliers),
    ...Object.values(profile.hazardMultipliers),
    ...Object.values(profile.surfaceMultipliers),
  ];
  if (all.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`Routing profile "${profile.id}" has a non-positive or non-finite multiplier`);
  }
}

const NEUTRAL_SURFACES: Record<SurfaceClass, number> = {
  smooth: 1,
  paved: 1,
  rough_paved: 1,
  compacted: 1,
  gravel: 1,
  unpaved: 1,
  unknown: 1,
};

/**
 * Pure distance: every metre costs the same. Useful as a baseline and for
 * comparing how much a preference-aware profile detours.
 */
export const SHORTEST_PROFILE: RoutingProfile = {
  id: 'shortest',
  label: 'Shortest',
  description: 'Shortest distance along the network, ignoring path quality.',
  kindMultipliers: {
    shared_use_path: 1,
    separated_path: 1,
    protected_lane: 1,
    buffered_lane: 1,
    painted_lane: 1,
    shared_parking_lane: 1,
    shared_street: 1,
    informal: 1,
    footpath: 1,
    trail: 1,
    track: 1,
    steps: 1,
    quiet_street: 1,
    road: 1,
    busy_road: 1,
    unknown: 1,
    connector: 1,
  },
  hazardMultipliers: {},
  surfaceMultipliers: NEUTRAL_SURFACES,
  respectOneWay: false,
};

/**
 * Default profile: prefers smooth off-road paths, then protected lanes, then
 * painted lanes and footpaths, then quiet streets, and treats busy roads,
 * steps and unbridged gaps (connectors, typically unmarked road crossings)
 * as expensive. Rough or loose ground costs extra on any kind of edge.
 */
export const PREFER_PATHS_PROFILE: RoutingProfile = {
  id: 'prefer_paths',
  label: 'Prefer paths',
  description: 'Favours off-road shared and separated paths over on-road lanes.',
  kindMultipliers: {
    shared_use_path: 1,
    separated_path: 1,
    protected_lane: 1.2,
    buffered_lane: 1.5,
    painted_lane: 1.8,
    shared_parking_lane: 2,
    shared_street: 2,
    informal: 2.5,
    // OpenStreetMap
    trail: 1.3, // off-road, but often narrow; surface multipliers do the rest
    footpath: 1.5, // shared with pedestrians, frequent driveways and kerbs
    quiet_street: 1.6,
    track: 1.8,
    road: 2.5,
    busy_road: 4,
    steps: 6,
    unknown: 2,
    connector: 3,
  },
  hazardMultipliers: {
    parking: 1.1,
    traffic_merging: 1.3,
    tram_line: 1.5,
  },
  surfaceMultipliers: {
    smooth: 1,
    paved: 1.05,
    rough_paved: 1.2,
    compacted: 1.3,
    gravel: 1.7,
    unpaved: 2,
    unknown: 1.1, // slight penalty: could be anything
  },
  respectOneWay: false,
};

export const ROUTING_PROFILES: Readonly<Record<string, RoutingProfile>> = {
  [PREFER_PATHS_PROFILE.id]: PREFER_PATHS_PROFILE,
  [SHORTEST_PROFILE.id]: SHORTEST_PROFILE,
};

export const DEFAULT_PROFILE_ID = PREFER_PATHS_PROFILE.id;

for (const profile of Object.values(ROUTING_PROFILES)) validateProfile(profile);
