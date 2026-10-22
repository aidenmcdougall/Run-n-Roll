import { describe, expect, it } from 'vitest';
import { SMOOTHNESS_LEVELS, SURFACE_CLASSES } from '../src/domain/surface.js';
import { MIN_ROUTING_SUITABILITY, RUN_PROFILE, RUN_SKATE_PROFILE, SKATE_PROFILE } from '../src/routing/activities.js';
import { buildGraph } from '../src/routing/graph.js';
import { planRoute } from '../src/routing/planner.js';
import { applyPreferences, avoidedSurfaces, DEFAULT_PREFERENCES } from '../src/routing/preferences.js';
import { DEFAULT_PROFILE_ID, ROUTING_PROFILES } from '../src/routing/profiles.js';
import { RUN_MODEL, SKATE_MODEL } from '../src/routing/scoring.js';
import { EDGE_KINDS, edgeCost, minCostPerMeter, type CostableEdge } from '../src/routing/weights.js';
import { at, segment } from './helpers.js';

const edge = (overrides: Partial<CostableEdge> = {}): CostableEdge => ({
  lengthM: 100,
  kind: 'shared_use_path',
  hazards: [],
  surfaceClass: 'smooth',
  ...overrides,
});

describe('activity profiles', () => {
  it('turns each scoring factor into its reciprocal cost multiplier', () => {
    expect(SKATE_PROFILE.surfaceMultipliers.paved).toBeCloseTo(1 / SKATE_MODEL.surface.paved, 9);
    expect(SKATE_PROFILE.kindMultipliers.footpath).toBeCloseTo(1 / SKATE_MODEL.kind.footpath, 9);
    expect(SKATE_PROFILE.hazardMultipliers.tram_line).toBeCloseTo(1 / SKATE_MODEL.hazards.tram_line!, 9);
    expect(RUN_PROFILE.surfaceMultipliers.gravel).toBeCloseTo(1 / RUN_MODEL.surface.gravel, 9);
    expect(RUN_PROFILE.smoothnessMultipliers).toBeUndefined();
  });

  it('floors unusable ground to a strong penalty rather than infinity', () => {
    expect(SKATE_PROFILE.surfaceMultipliers.gravel).toBeCloseTo(1 / MIN_ROUTING_SUITABILITY, 9);
    expect(SKATE_PROFILE.kindMultipliers.steps).toBeCloseTo(1 / MIN_ROUTING_SUITABILITY, 9);
    expect(SKATE_PROFILE.smoothnessMultipliers?.horrible).toBeCloseTo(1 / MIN_ROUTING_SUITABILITY, 9);
  });

  it('takes the worse factor of each activity for run + skate', () => {
    expect(RUN_SKATE_PROFILE.surfaceMultipliers.compacted).toBe(SKATE_PROFILE.surfaceMultipliers.compacted);
    expect(RUN_SKATE_PROFILE.surfaceMultipliers.smooth).toBe(RUN_PROFILE.surfaceMultipliers.smooth);
    expect(RUN_SKATE_PROFILE.kindMultipliers.painted_lane).toBe(RUN_PROFILE.kindMultipliers.painted_lane);
    expect(RUN_SKATE_PROFILE.kindMultipliers.steps).toBe(SKATE_PROFILE.kindMultipliers.steps);
    expect(RUN_SKATE_PROFILE.smoothnessMultipliers).toEqual(SKATE_PROFILE.smoothnessMultipliers);
  });

  it('keeps the A* lower bound admissible for every kind, surface and smoothness', () => {
    for (const profile of [RUN_PROFILE, SKATE_PROFILE, RUN_SKATE_PROFILE]) {
      const bound = minCostPerMeter(profile);
      for (const kind of EDGE_KINDS) {
        for (const surfaceClass of SURFACE_CLASSES) {
          for (const smoothness of [null, ...SMOOTHNESS_LEVELS]) {
            expect(edgeCost(edge({ kind, surfaceClass, smoothness }), profile) / 100).toBeGreaterThanOrEqual(bound - 1e-12);
          }
        }
      }
    }
    // Running rates asphalt 0.9, so run + skate has no metre that is ideal for both.
    expect(minCostPerMeter(RUN_SKATE_PROFILE)).toBeCloseTo(1 / 0.9, 9);
  });

  it('registers the activities alongside the existing profiles', () => {
    expect(Object.keys(ROUTING_PROFILES)).toEqual(expect.arrayContaining(['prefer_paths', 'shortest', 'run', 'skate', 'run_skate']));
    expect(DEFAULT_PROFILE_ID).toBe('prefer_paths');
  });

  it('avoids loose ground at route ends when skating, but not when running', () => {
    expect(avoidedSurfaces(applyPreferences(SKATE_PROFILE, DEFAULT_PREFERENCES)).sort()).toEqual(['compacted', 'gravel', 'unpaved']);
    expect(avoidedSurfaces(RUN_PROFILE)).toEqual([]);
  });
});

describe('smoothness costing', () => {
  it('costs broken asphalt by its smoothness', () => {
    expect(edgeCost(edge({ smoothness: 'bad' }), SKATE_PROFILE)).toBeCloseTo(100 / SKATE_MODEL.smoothness!.bad, 9);
    expect(edgeCost(edge({ smoothness: 'excellent' }), SKATE_PROFILE)).toBeCloseTo(100, 9);
  });

  it('never lets a good smoothness tag make poor ground cheaper', () => {
    expect(edgeCost(edge({ surfaceClass: 'gravel', smoothness: 'good' }), SKATE_PROFILE)).toBe(
      edgeCost(edge({ surfaceClass: 'gravel' }), SKATE_PROFILE),
    );
  });

  it('is ignored by profiles without smoothness multipliers', () => {
    expect(edgeCost(edge({ smoothness: 'horrible' }), RUN_PROFILE)).toBe(edgeCost(edge(), RUN_PROFILE));
  });
});

describe('routing by activity', () => {
  // A 1 km gravel trail, or a 1.3 km sealed shared path around it.
  const graph = buildGraph([
    segment([[0, 0], [1000, 0]], 'trail', { surfaceClass: 'gravel', name: 'Gravel Trail' }),
    segment([[0, 0], [500, 415], [1000, 0]], 'shared_use_path', { name: 'Sealed Path' }),
  ]);

  it('skates the sealed detour', () => {
    const result = planRoute(graph, at(0, 0), at(1000, 0), SKATE_PROFILE);
    expect(result.ok && result.route.legs.map((l) => l.name)).toEqual(['Sealed Path']);
  });

  it('runs the shorter gravel trail', () => {
    const result = planRoute(graph, at(0, 0), at(1000, 0), RUN_PROFILE);
    expect(result.ok && result.route.legs.map((l) => l.name)).toEqual(['Gravel Trail']);
  });

  it('suits both by taking the sealed detour', () => {
    const result = planRoute(graph, at(0, 0), at(1000, 0), RUN_SKATE_PROFILE);
    expect(result.ok && result.route.legs.map((l) => l.name)).toEqual(['Sealed Path']);
  });
});
