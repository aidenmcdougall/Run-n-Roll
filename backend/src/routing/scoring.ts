import type { Smoothness, SurfaceClass } from '../domain/surface.js';
import type { RouteStretch } from './planner.js';
import type { EdgeKind } from './weights.js';

/**
 * Activity scores for a planned route: how enjoyable it is to skate or to
 * run, 0–100.
 *
 * Each stretch gets a suitability in [0, 1] for the activity:
 *
 *   suitability = surfaceFactor × kindFactor × Π hazardFactor
 *
 * (skating also uses OSM `smoothness` in place of the surface factor when
 * tagged). The score is the length-weighted mean × 100, minus a penalty per
 * stretch that can't be done at all on skates. Scoring only describes a
 * route; it doesn't change which route is chosen.
 *
 * All factors are in the tables below so they can be tuned in one place.
 */

export type Activity = 'skate' | 'run';
export type Rating = 'great' | 'good' | 'fair' | 'poor';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScoreNote {
  /** Whether this note explains a strength or a weakness of the route. */
  tone: 'positive' | 'negative';
  text: string;
  /** Metres the note refers to. */
  metres: number;
  /** Score points this factor cost (negative notes only). */
  points?: number;
}

export interface ActivityScore {
  score: number;
  rating: Rating;
  /** How much of the route's surface was tagged rather than assumed or unknown. */
  confidence: Confidence;
  notes: ScoreNote[];
}

export type RouteScores = Record<Activity, ActivityScore>;

type Table<K extends string> = Readonly<Record<K, number>>;

interface ActivityModel {
  surface: Table<SurfaceClass>;
  /** Replaces the surface factor when OSM smoothness is tagged (skating only). */
  smoothness?: Table<Smoothness>;
  kind: Table<EdgeKind>;
  hazards: Readonly<Record<string, number>>;
  /** Activity-specific wording for surfaces in notes, overriding the defaults. */
  surfacePhrases?: Partial<Record<SurfaceClass, string>>;
}

export const SKATE_MODEL: ActivityModel = {
  surface: {
    smooth: 1,
    paved: 0.85, // usually asphalt/concrete tagged generically; also coarse chipseal
    rough_paved: 0.35, // pavers and boardwalk joints rattle and catch wheels
    compacted: 0.1,
    gravel: 0,
    unpaved: 0,
    unknown: 0.5,
  },
  smoothness: {
    excellent: 1,
    good: 0.9,
    intermediate: 0.55,
    bad: 0.2,
    very_bad: 0.05,
    horrible: 0,
    very_horrible: 0,
    impassable: 0,
  },
  kind: {
    shared_use_path: 1,
    separated_path: 1,
    protected_lane: 0.95,
    buffered_lane: 0.85,
    painted_lane: 0.7,
    shared_parking_lane: 0.6, // door zone
    shared_street: 0.65,
    informal: 0.55,
    footpath: 0.8, // pedestrians, kerbs, driveway lips
    trail: 0.9, // surface does the work
    track: 0.8,
    steps: 0,
    quiet_street: 0.75,
    road: 0.5,
    busy_road: 0.25,
    unknown: 0.6,
    connector: 0.7, // usually a road crossing
  },
  hazards: {
    tram_line: 0.4, // tram tracks catch small wheels
    traffic_merging: 0.7,
    parking: 0.85,
  },
};

export const RUN_MODEL: ActivityModel = {
  surface: {
    smooth: 0.9, // hard on the legs, but fine
    paved: 0.9,
    rough_paved: 0.85,
    compacted: 1, // ideal running surface
    gravel: 0.8,
    unpaved: 0.85, // trails are great, mud less so
    unknown: 0.85,
  },
  kind: {
    shared_use_path: 1,
    separated_path: 1,
    footpath: 0.9,
    trail: 1,
    track: 0.95,
    steps: 0.7,
    quiet_street: 0.8,
    shared_street: 0.7,
    // On-road bike lanes usually have a footpath alongside; the traffic is what hurts.
    protected_lane: 0.7,
    buffered_lane: 0.65,
    painted_lane: 0.6,
    shared_parking_lane: 0.6,
    informal: 0.55,
    road: 0.6,
    busy_road: 0.45,
    unknown: 0.7,
    connector: 0.8,
  },
  hazards: {
    tram_line: 0.95,
    traffic_merging: 0.85,
    parking: 1,
  },
  // For running, the cost of sealed ground is that it's hard underfoot.
  surfacePhrases: {
    smooth: 'hard asphalt or concrete',
    paved: 'hard sealed surface',
  },
};

/** Stretches with skate suitability below this must be walked. */
const UNSKATEABLE_BELOW = 0.15;
/** Walkable stretches shorter than this are ignored (a kerb, a tiny gap). */
const MIN_WALK_STRETCH_M = 5;
/**
 * Skating is a weakest-link experience: a stretch you have to walk (steps,
 * a gravel link) interrupts the whole route, far beyond its share of the
 * length. So walking costs a fixed amount per interruption plus an amount
 * per metre walked, and caps the rating.
 */
const WALK_SECTION_PENALTY = 10;
const WALK_PENALTY_PER_100M = 5;
const MAX_WALK_PENALTY = 60;
/** Any walking: the route can't be rated "great". */
const WALK_CAP_ANY = 84;
/** Walking at least this far: the route can't be rated better than "fair". */
const LONG_WALK_M = 100;
const WALK_CAP_LONG = 69;

/** A cause is only noted if it cost at least this many score points. */
const NOTE_MIN_POINTS = 1.5;
const MAX_NEGATIVE_NOTES = 4;
/** Positive notes need at least this share of the route. */
const POSITIVE_MIN_SHARE = 0.25;

export function suitability(stretch: RouteStretch, model: ActivityModel): number {
  const surface =
    model.smoothness && stretch.smoothness ? model.smoothness[stretch.smoothness] : model.surface[stretch.surfaceClass];
  let value = surface * model.kind[stretch.kind];
  for (const hazard of stretch.hazards) value *= model.hazards[hazard] ?? 1;
  return value;
}

function rate(score: number): Rating {
  if (score >= 85) return 'great';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

function confidenceOf(stretches: readonly RouteStretch[], total: number): Confidence {
  const known = stretches
    .filter((s) => !s.surfaceInferred && s.surfaceClass !== 'unknown')
    .reduce((sum, s) => sum + s.lengthM, 0);
  const share = total > 0 ? known / total : 0;
  if (share >= 0.8) return 'high';
  if (share >= 0.55) return 'medium';
  return 'low';
}

function formatMetres(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;
}

const SURFACE_PHRASES: Record<SurfaceClass, string> = {
  smooth: 'smooth surface',
  paved: 'coarse or unspecified sealed surface',
  rough_paved: 'pavers, bricks or boardwalk',
  compacted: 'compacted gravel',
  gravel: 'loose gravel',
  unpaved: 'dirt, grass or sand',
  unknown: 'unknown surface',
};

const KIND_PHRASES: Partial<Record<EdgeKind, string>> = {
  footpath: 'on footpaths shared with pedestrians',
  quiet_street: 'on quiet streets',
  road: 'on roads',
  busy_road: 'along busy roads',
  steps: 'of steps',
  painted_lane: 'in painted on-road bike lanes',
  buffered_lane: 'in buffered on-road bike lanes',
  protected_lane: 'in protected on-road bike lanes',
  shared_parking_lane: 'in bike lanes beside parked cars',
  shared_street: 'on streets shared with cars',
  informal: 'on informal on-road routes',
  trail: 'on trails',
  track: 'on tracks',
  connector: 'of road crossings and gaps',
  unknown: 'of unclassified paths',
};

const HAZARD_PHRASES: Record<string, string> = {
  tram_line: 'alongside tram tracks',
  traffic_merging: 'where traffic merges',
  parking: 'beside parked cars',
};

interface Cause {
  key: string;
  phrase: string;
  metres: number;
  loss: number; // length-weighted shortfall attributed to this cause
}

/**
 * Splits each stretch's shortfall (1 − suitability) across the factors that
 * caused it, in proportion to each factor's −ln (suitability is a product,
 * so logs add). A factor of 0 takes all of that stretch's shortfall.
 */
function attributeLoss(stretches: readonly RouteStretch[], model: ActivityModel): Cause[] {
  const causes = new Map<string, Cause>();
  const addCause = (key: string, phrase: string, metres: number, loss: number) => {
    const cause = causes.get(key) ?? { key, phrase, metres: 0, loss: 0 };
    cause.metres += metres;
    cause.loss += loss;
    causes.set(key, cause);
  };

  for (const s of stretches) {
    const usesSmoothness = Boolean(model.smoothness && s.smoothness);
    const factors: { key: string; phrase: string; value: number }[] = [
      usesSmoothness
        ? { key: `smoothness:${s.smoothness}`, phrase: `tagged ${s.smoothness!.replace('_', ' ')} smoothness`, value: model.smoothness![s.smoothness!] }
        : {
            key: `surface:${s.surfaceClass}`,
            phrase: `of ${model.surfacePhrases?.[s.surfaceClass] ?? SURFACE_PHRASES[s.surfaceClass]}`,
            value: model.surface[s.surfaceClass],
          },
      { key: `kind:${s.kind}`, phrase: KIND_PHRASES[s.kind] ?? `on ${s.kind.replace('_', ' ')}`, value: model.kind[s.kind] },
      ...s.hazards.map((h) => ({ key: `hazard:${h}`, phrase: HAZARD_PHRASES[h] ?? `with ${h.replace('_', ' ')}`, value: model.hazards[h] ?? 1 })),
    ].filter((f) => f.value < 1);

    const shortfall = (1 - suitability(s, model)) * s.lengthM;
    if (factors.length === 0 || shortfall <= 0) continue;
    const zeros = factors.filter((f) => f.value <= 0);
    const weighted = zeros.length > 0 ? zeros.map((f) => ({ f, w: 1 })) : factors.map((f) => ({ f, w: -Math.log(f.value) }));
    const totalWeight = weighted.reduce((sum, x) => sum + x.w, 0);
    for (const { f, w } of weighted) addCause(f.key, f.phrase, s.lengthM, (shortfall * w) / totalWeight);
  }
  return [...causes.values()];
}

const sumWhere = (stretches: readonly RouteStretch[], predicate: (s: RouteStretch) => boolean): number =>
  stretches.filter(predicate).reduce((sum, s) => sum + s.lengthM, 0);

const OFF_ROAD: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['shared_use_path', 'separated_path', 'trail', 'track']);

/** Stretches that can't be skated, summarised for scoring and notes. */
interface WalkSummary {
  sections: number;
  metres: number;
  includesSteps: boolean;
  penalty: number;
  /** Highest score the route may have, given the walking. */
  cap: number;
}

function summariseWalking(stretches: readonly RouteStretch[], model: ActivityModel): WalkSummary {
  let sections = 0;
  let metres = 0;
  let includesSteps = false;
  let inWalk = false;
  for (const s of stretches) {
    const unskateable = suitability(s, model) < UNSKATEABLE_BELOW && (s.lengthM >= MIN_WALK_STRETCH_M || s.kind === 'steps');
    if (unskateable) {
      if (!inWalk) sections++;
      metres += s.lengthM;
      includesSteps ||= s.kind === 'steps';
    }
    inWalk = unskateable;
  }
  const penalty = Math.min(MAX_WALK_PENALTY, sections * WALK_SECTION_PENALTY + (metres / 100) * WALK_PENALTY_PER_100M);
  const cap = sections === 0 ? 100 : metres >= LONG_WALK_M ? WALK_CAP_LONG : WALK_CAP_ANY;
  return { sections, metres, includesSteps, penalty, cap };
}

function describeWalking(walk: WalkSummary): string {
  const what =
    walk.metres >= 20
      ? `${formatMetres(walk.metres)} you'd need to walk`
      : `${walk.sections} short ${walk.sections === 1 ? 'stretch' : 'stretches'} you'd need to walk`;
  const across = walk.metres >= 20 && walk.sections > 1 ? ` across ${walk.sections} stretches` : '';
  return `${what}${across}${walk.includesSteps ? ' (including steps)' : ''}`;
}

/** Human-readable reasons behind a score: the biggest point losses, then strengths. */
function notesFor(
  activity: Activity,
  model: ActivityModel,
  stretches: readonly RouteStretch[],
  total: number,
  walk: WalkSummary | null,
  capLoss: number,
): ScoreNote[] {
  const negatives: ScoreNote[] = attributeLoss(stretches, model)
    .map((c) => ({ tone: 'negative' as const, metres: c.metres, points: (c.loss / total) * 100, text: `${formatMetres(c.metres)} ${c.phrase}` }))
    .filter((n) => n.points >= NOTE_MIN_POINTS);
  if (walk && walk.penalty > 0) {
    negatives.push({ tone: 'negative', metres: walk.metres, points: walk.penalty, text: describeWalking(walk) });
  }
  // The cap explains the rating, so it's always shown (not subject to MAX_NEGATIVE_NOTES).
  const capNote: ScoreNote[] =
    walk && capLoss > 0
      ? [
          {
            tone: 'negative',
            metres: walk.metres,
            points: Math.round(capLoss * 10) / 10,
            text: `Having to walk caps the rating at ${walk.cap === WALK_CAP_LONG ? 'fair' : 'good'}`,
          },
        ]
      : [];
  negatives.sort((a, b) => b.points! - a.points!);
  for (const n of negatives) n.points = Math.round(n.points! * 10) / 10;

  const positives: ScoreNote[] = [];
  const addPositive = (metres: number, text: string) => {
    if (total > 0 && metres / total >= POSITIVE_MIN_SHARE) positives.push({ tone: 'positive', metres, text });
  };
  const share = (metres: number) => `${Math.round((metres / total) * 100)}%`;
  if (activity === 'skate') {
    const smooth = sumWhere(stretches, (s) => (s.smoothness ? ['excellent', 'good'].includes(s.smoothness) : s.surfaceClass === 'smooth'));
    addPositive(smooth, `${share(smooth)} smooth asphalt or concrete`);
  } else {
    const offRoad = sumWhere(stretches, (s) => OFF_ROAD.has(s.kind));
    addPositive(offRoad, `${share(offRoad)} off-road paths and trails`);
  }

  return [...negatives.slice(0, MAX_NEGATIVE_NOTES), ...capNote, ...positives];
}

function scoreFor(activity: Activity, stretches: readonly RouteStretch[]): ActivityScore {
  const model = activity === 'skate' ? SKATE_MODEL : RUN_MODEL;
  const total = stretches.reduce((sum, s) => sum + s.lengthM, 0);
  if (total <= 0) return { score: 0, rating: 'poor', confidence: 'low', notes: [] };

  const weighted = stretches.reduce((sum, s) => sum + suitability(s, model) * s.lengthM, 0);
  let score = (weighted / total) * 100;

  // On skates, stretches you have to walk dominate the experience.
  const walk = activity === 'skate' ? summariseWalking(stretches, model) : null;
  let capLoss = 0;
  if (walk) {
    score -= walk.penalty;
    if (score > walk.cap) {
      capLoss = score - walk.cap;
      score = walk.cap;
    }
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: rounded,
    rating: rate(rounded),
    confidence: confidenceOf(stretches, total),
    notes: notesFor(activity, model, stretches, total, walk, capLoss),
  };
}

export function scoreRoute(stretches: readonly RouteStretch[]): RouteScores {
  return { skate: scoreFor('skate', stretches), run: scoreFor('run', stretches) };
}
