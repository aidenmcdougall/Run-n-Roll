import { SMOOTHNESS_LEVELS, SURFACE_CLASSES, type Smoothness, type SurfaceClass } from '../domain/surface.js';
import { RUN_MODEL, SKATE_MODEL, type Activity, type ActivityModel } from './scoring.js';
import { EDGE_KINDS, type EdgeKind, type RoutingProfile } from './weights.js';

/**
 * Activity routing profiles: route by the same factors the skate and run
 * scores rate with (see scoring.ts), so the router chooses what the scores
 * reward.
 *
 * A suitability factor in [0, 1] becomes a cost multiplier of 1 / factor:
 * a stretch that is half as good to skate costs twice as much per metre.
 * Factors of 0 (gravel or steps on skates) are floored so they become a very
 * strong penalty rather than a ban; a route is still found when there is no
 * other way through, and the score then reports the walking.
 *
 * Several activities together ("run + skate") take the worse factor of each
 * activity per table entry, so the route suits everyone.
 */

/** Lowest suitability used for costing: a factor of 0 costs 20× an ideal metre. */
export const MIN_ROUTING_SUITABILITY = 0.05;

export const ACTIVITY_SETS = ['run', 'skate', 'run_skate'] as const;
export type ActivitySet = (typeof ACTIVITY_SETS)[number];

const MODELS: Record<Activity, ActivityModel> = { run: RUN_MODEL, skate: SKATE_MODEL };

const ACTIVITIES: Record<ActivitySet, readonly Activity[]> = {
  run: ['run'],
  skate: ['skate'],
  run_skate: ['run', 'skate'],
};

const DESCRIPTIONS: Record<ActivitySet, { label: string; description: string }> = {
  run: { label: 'Running', description: 'Off-road paths and trails, avoiding traffic. Gravel and dirt are welcome.' },
  skate: {
    label: 'Skating',
    description: 'Smooth asphalt and concrete, away from tram tracks; avoids gravel, pavers and steps.',
  },
  run_skate: {
    label: 'Running + skating',
    description: 'A route that suits both: as smooth as skating needs, as traffic-free as running prefers.',
  },
};

const toMultiplier = (factor: number): number => 1 / Math.max(MIN_ROUTING_SUITABILITY, factor);

/** Worst (lowest) factor for `key` across the models that define it, as a multiplier. */
function worst<K extends string>(
  models: readonly ActivityModel[],
  keys: readonly K[],
  table: (m: ActivityModel) => Partial<Record<K, number>> | undefined,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const factors = models.map((m) => table(m)?.[key]).filter((f): f is number => f !== undefined);
    if (factors.length > 0) out[key] = toMultiplier(Math.min(...factors));
  }
  return out;
}

export function activityProfile(set: ActivitySet): RoutingProfile {
  const models = ACTIVITIES[set].map((activity) => MODELS[activity]);
  const hazards = [...new Set(models.flatMap((m) => Object.keys(m.hazards)))];
  const smoothness = worst<Smoothness>(models, SMOOTHNESS_LEVELS, (m) => m.smoothness);
  return {
    id: set,
    ...DESCRIPTIONS[set],
    kindMultipliers: worst<EdgeKind>(models, EDGE_KINDS, (m) => m.kind) as Record<EdgeKind, number>,
    hazardMultipliers: worst<string>(models, hazards, (m) => m.hazards) as Record<string, number>,
    surfaceMultipliers: worst<SurfaceClass>(models, SURFACE_CLASSES, (m) => m.surface) as Record<SurfaceClass, number>,
    ...(Object.keys(smoothness).length > 0 ? { smoothnessMultipliers: smoothness } : {}),
    respectOneWay: false,
  };
}

export const RUN_PROFILE = activityProfile('run');
export const SKATE_PROFILE = activityProfile('skate');
export const RUN_SKATE_PROFILE = activityProfile('run_skate');
