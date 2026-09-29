import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/routing/graph.js';
import { cachedProfileCount, MAX_CACHED_PROFILES, planRoute } from '../src/routing/planner.js';
import {
  applyPreferences,
  avoidedSurfaces,
  DEFAULT_PREFERENCES,
  preferencesKey,
  type RoutePreferences,
} from '../src/routing/preferences.js';
import { edgeCost, minCostPerMeter, PREFER_PATHS_PROFILE, type CostableEdge } from '../src/routing/weights.js';
import { at, segment } from './helpers.js';

const prefs = (overrides: Partial<RoutePreferences>): RoutePreferences => ({ ...DEFAULT_PREFERENCES, ...overrides });
const edge = (overrides: Partial<CostableEdge>): CostableEdge => ({
  lengthM: 100,
  kind: 'shared_use_path',
  hazards: [],
  surfaceClass: 'smooth',
  ...overrides,
});

describe('applyPreferences', () => {
  it('returns the base profile unchanged for default preferences', () => {
    expect(applyPreferences(PREFER_PATHS_PROFILE, DEFAULT_PREFERENCES)).toBe(PREFER_PATHS_PROFILE);
  });

  it('gives each combination a distinct, stable id', () => {
    const a = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'avoid_loose' }));
    const b = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'avoid_loose', avoidSteps: true }));
    expect(a.id).toBe('prefer_paths+surface=avoid_loose');
    expect(b.id).toBe('prefer_paths+surface=avoid_loose,steps');
    expect(applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'avoid_loose' })).id).toBe(a.id);
  });

  it('multiplies penalties on top of the base weights without mutating the base', () => {
    const before = structuredClone(PREFER_PATHS_PROFILE);
    const profile = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'avoid_loose' }));
    expect(profile.surfaceMultipliers.gravel).toBeCloseTo(PREFER_PATHS_PROFILE.surfaceMultipliers.gravel * 10, 9);
    expect(profile.surfaceMultipliers.smooth).toBe(PREFER_PATHS_PROFILE.surfaceMultipliers.smooth);
    expect(PREFER_PATHS_PROFILE).toEqual(before);
  });

  it('makes gravel much costlier under avoid_loose, and pavers costlier under smooth_only', () => {
    const cost = (p: Partial<RoutePreferences>, e: Partial<CostableEdge>) =>
      edgeCost(edge(e), applyPreferences(PREFER_PATHS_PROFILE, prefs(p)));
    expect(cost({ surface: 'avoid_loose' }, { surfaceClass: 'gravel' })).toBeGreaterThan(
      5 * cost({}, { surfaceClass: 'gravel' }),
    );
    expect(cost({ surface: 'avoid_loose' }, { surfaceClass: 'rough_paved' })).toBe(cost({}, { surfaceClass: 'rough_paved' }));
    expect(cost({ surface: 'smooth_only' }, { surfaceClass: 'rough_paved' })).toBeGreaterThan(
      cost({}, { surfaceClass: 'rough_paved' }),
    );
  });

  it('penalises steps and busy roads only when asked', () => {
    const steps = edge({ kind: 'steps' });
    const busy = edge({ kind: 'busy_road' });
    expect(edgeCost(steps, applyPreferences(PREFER_PATHS_PROFILE, prefs({ avoidSteps: true })))).toBe(
      edgeCost(steps, PREFER_PATHS_PROFILE) * 20,
    );
    expect(edgeCost(busy, applyPreferences(PREFER_PATHS_PROFILE, prefs({ avoidSteps: true })))).toBe(
      edgeCost(busy, PREFER_PATHS_PROFILE),
    );
    expect(edgeCost(busy, applyPreferences(PREFER_PATHS_PROFILE, prefs({ avoidBusyRoads: true })))).toBe(
      edgeCost(busy, PREFER_PATHS_PROFILE) * 3,
    );
  });

  it('never lowers the A* lower bound (penalties only increase costs)', () => {
    for (const surface of ['any', 'avoid_loose', 'smooth_only'] as const) {
      const profile = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface, avoidSteps: true, avoidBusyRoads: true }));
      expect(minCostPerMeter(profile)).toBeGreaterThanOrEqual(minCostPerMeter(PREFER_PATHS_PROFILE));
    }
  });
});

describe('avoidedSurfaces', () => {
  it('lists the surfaces a preference steers away from', () => {
    expect(avoidedSurfaces(prefs({}))).toEqual([]);
    expect(avoidedSurfaces(prefs({ surface: 'avoid_loose' })).sort()).toEqual(['compacted', 'gravel', 'unpaved']);
    expect(avoidedSurfaces(prefs({ surface: 'smooth_only' }))).toContain('rough_paved');
  });

  it('keys preferences deterministically', () => {
    expect(preferencesKey(prefs({ avoidBusyRoads: true, avoidSteps: true }))).toBe('surface=any,steps,busy_roads');
  });
});

describe('planRoute with preferences', () => {
  /**
   * Direct 1 km shared path, but gravel; or a 1.6 km sealed detour on quiet
   * streets. Plain "prefer paths" still takes the gravel path (it is a
   * shared path); "avoid gravel" should take the detour.
   */
  const network = () =>
    buildGraph([
      segment([[0, 0], [1000, 0]], 'shared_use_path', { surfaceClass: 'gravel' }),
      segment([[0, 0], [0, 300], [1000, 300], [1000, 0]], 'quiet_street', { surfaceClass: 'smooth' }),
    ]);

  it('takes the gravel path under plain prefer_paths', () => {
    const result = planRoute(network(), at(0, 0), at(1000, 0), PREFER_PATHS_PROFILE);
    expect(result.ok && Object.keys(result.route.distanceBySurface)).toEqual(['gravel']);
  });

  it('detours onto sealed streets when avoiding gravel', () => {
    const profile = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'avoid_loose' }));
    const result = planRoute(network(), at(0, 0), at(1000, 0), profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.route.distanceBySurface)).toEqual(['smooth']);
    expect(result.route.distanceM).toBeCloseTo(1600, -1);
  });

  it('still routes over gravel when there is no alternative', () => {
    const graph = buildGraph([segment([[0, 0], [1000, 0]], 'trail', { surfaceClass: 'gravel' })]);
    const profile = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'smooth_only' }));
    const result = planRoute(graph, at(0, 0), at(1000, 0), profile);
    expect(result.ok && result.route.distanceBySurface.gravel).toBeCloseTo(1000, 0);
  });

  it('bounds the per-profile cost cache', () => {
    const graph = network();
    const combos: RoutePreferences[] = [];
    for (const surface of ['any', 'avoid_loose', 'smooth_only'] as const) {
      for (const avoidSteps of [false, true]) for (const avoidBusyRoads of [false, true]) combos.push({ surface, avoidSteps, avoidBusyRoads });
    }
    for (const p of combos) planRoute(graph, at(0, 0), at(1000, 0), applyPreferences(PREFER_PATHS_PROFILE, p));
    expect(combos.length).toBeGreaterThan(MAX_CACHED_PROFILES);
    expect(cachedProfileCount(graph)).toBe(MAX_CACHED_PROFILES);
  });
});

describe('preference-aware snapping', () => {
  // A gravel trail right beside the click, and a smooth path 40 m away.
  const network = () =>
    buildGraph([
      segment([[0, 5], [1000, 5]], 'trail', { surfaceClass: 'gravel' }),
      segment([[0, -40], [1000, -40]], 'shared_use_path', { surfaceClass: 'smooth' }),
    ]);

  it('snaps to the nearest edge by default', () => {
    const result = planRoute(network(), at(100, 0), at(900, 0), PREFER_PATHS_PROFILE);
    expect(result.ok && result.route.distanceBySurface).toEqual({ gravel: expect.any(Number) });
  });

  it('steps onto a nearby acceptable surface when avoiding gravel', () => {
    const profile = applyPreferences(PREFER_PATHS_PROFILE, prefs({ surface: 'avoid_loose' }));
    const result = planRoute(network(), at(100, 0), at(900, 0), profile, { avoidSurfacesAtEnds: ['gravel'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceBySurface).toEqual({ smooth: expect.any(Number) });
    expect(result.route.start.distanceM).toBeCloseTo(40, 0);
  });

  it('stays on the avoided surface when nothing acceptable is close enough', () => {
    const graph = buildGraph([
      segment([[0, 5], [1000, 5]], 'trail', { surfaceClass: 'gravel' }),
      segment([[0, -300], [1000, -300]], 'shared_use_path', { surfaceClass: 'smooth' }),
    ]);
    const result = planRoute(graph, at(100, 0), at(900, 0), PREFER_PATHS_PROFILE, { avoidSurfacesAtEnds: ['gravel'] });
    expect(result.ok && result.route.start.distanceM).toBeCloseTo(5, 0);
  });
});

describe('preference-aware snapping trade-off', () => {
  it('snaps further to escape a long avoided edge, when that beats travelling along it', () => {
    // Click in the middle of a 2 km dirt track (1 km to either end); a smooth
    // path runs 150 m away: beyond the 75 m minimum, but far less than 1 km.
    const graph = buildGraph([
      segment([[0, 5], [2000, 5]], 'trail', { surfaceClass: 'unpaved' }),
      segment([[0, -150], [2000, -150]], 'shared_use_path', { surfaceClass: 'smooth' }),
    ]);
    const result = planRoute(graph, at(1000, 0), at(1900, -150), PREFER_PATHS_PROFILE, {
      avoidSurfacesAtEnds: ['unpaved'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.distanceBySurface).toEqual({ smooth: expect.any(Number) });
    expect(result.route.start.distanceM).toBeCloseTo(150, 0);
  });

  it('does not jump far when the avoided edge is short to exit', () => {
    // Near the end of the dirt track (20 m to exit): a smooth path 150 m away isn't worth it.
    const graph = buildGraph([
      segment([[0, 5], [2000, 5]], 'trail', { surfaceClass: 'unpaved' }),
      segment([[0, -150], [2000, -150]], 'shared_use_path', { surfaceClass: 'smooth' }),
    ]);
    const result = planRoute(graph, at(1980, 0), at(0, 5), PREFER_PATHS_PROFILE, { avoidSurfacesAtEnds: ['unpaved'] });
    expect(result.ok && result.route.start.distanceM).toBeCloseTo(5, 0);
  });
});
