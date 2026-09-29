import type { SurfaceClass } from '../domain/surface.js';
import type { EdgeKind, RoutingProfile } from './weights.js';

/**
 * User preferences layered on top of a base routing profile. They compose:
 * "prefer paths" + "avoid gravel" + "avoid steps" is one request, rather than
 * a hard-coded profile per combination.
 *
 * Preferences are strong penalties, not bans. A route is still found when
 * the only way through is, say, 50 m of gravel, and the response shows how
 * much of it is included. A ban would instead fail with "no route".
 */
export interface RoutePreferences {
  surface: SurfacePreference;
  avoidSteps: boolean;
  avoidBusyRoads: boolean;
}

export const SURFACE_PREFERENCES = ['any', 'avoid_loose', 'smooth_only'] as const;
export type SurfacePreference = (typeof SURFACE_PREFERENCES)[number];

export const DEFAULT_PREFERENCES: RoutePreferences = {
  surface: 'any',
  avoidSteps: false,
  avoidBusyRoads: false,
};

type Multipliers<K extends string> = Partial<Record<K, number>>;

/**
 * Extra cost multipliers per surface preference, applied on top of the base
 * profile's. A multiplier of 10 means "take a detour of up to ~10× the
 * length rather than use this".
 */
export const SURFACE_PENALTIES: Readonly<Record<SurfacePreference, Multipliers<SurfaceClass>>> = {
  any: {},
  // "No gravel": loose and natural ground are all but excluded; compacted
  // fine gravel is tolerated at a cost. Unknown surfaces might be gravel.
  avoid_loose: { compacted: 3, gravel: 10, unpaved: 10, unknown: 1.5 },
  // Skate-friendly: also avoid bumpy pavers, bricks and boardwalks.
  smooth_only: { paved: 1.2, rough_paved: 4, compacted: 10, gravel: 15, unpaved: 15, unknown: 2 },
};

export const STEPS_PENALTY: Multipliers<EdgeKind> = { steps: 20 };
export const BUSY_ROAD_PENALTY: Multipliers<EdgeKind> = { busy_road: 3, road: 1.5 };

/** Surfaces the user asked to avoid; used to warn when a route still includes them. */
export function avoidedSurfaces(preferences: RoutePreferences): SurfaceClass[] {
  return (Object.entries(SURFACE_PENALTIES[preferences.surface]) as [SurfaceClass, number][])
    .filter(([surface, factor]) => factor >= 3 && surface !== 'unknown')
    .map(([surface]) => surface);
}

function multiply<K extends string>(base: Readonly<Record<K, number>>, extra: Multipliers<K>): Record<K, number> {
  const out: Record<K, number> = { ...base };
  for (const [key, factor] of Object.entries(extra) as [K, number][]) out[key] = out[key] * factor;
  return out;
}

/** Stable identifier for a preference combination, e.g. "surface=avoid_loose,steps". */
export function preferencesKey(preferences: RoutePreferences): string {
  const parts = [`surface=${preferences.surface}`];
  if (preferences.avoidSteps) parts.push('steps');
  if (preferences.avoidBusyRoads) parts.push('busy_roads');
  return parts.join(',');
}

/**
 * Derives the effective routing profile. The result gets a distinct `id`
 * (base id + preferences) so per-profile edge costs are cached correctly.
 * The base profile is never mutated.
 */
export function applyPreferences(base: RoutingProfile, preferences: RoutePreferences): RoutingProfile {
  const key = preferencesKey(preferences);
  if (key === preferencesKey(DEFAULT_PREFERENCES)) return base;

  let kindMultipliers = { ...base.kindMultipliers };
  if (preferences.avoidSteps) kindMultipliers = multiply(kindMultipliers, STEPS_PENALTY);
  if (preferences.avoidBusyRoads) kindMultipliers = multiply(kindMultipliers, BUSY_ROAD_PENALTY);

  return {
    ...base,
    id: `${base.id}+${key}`,
    kindMultipliers,
    surfaceMultipliers: multiply(base.surfaceMultipliers, SURFACE_PENALTIES[preferences.surface]),
  };
}
