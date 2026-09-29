import { describe, expect, it } from 'vitest';
import {
  edgeCost,
  minCostPerMeter,
  PREFER_PATHS_PROFILE,
  SHORTEST_PROFILE,
  validateProfile,
  type CostableEdge,
  type RoutingProfile,
} from '../src/routing/weights.js';

const edge = (overrides: Partial<CostableEdge> = {}): CostableEdge => ({
  lengthM: 100,
  kind: 'shared_use_path',
  hazards: [],
  surfaceClass: 'smooth',
  ...overrides,
});

describe('edgeCost', () => {
  it('equals length under the shortest profile regardless of attributes', () => {
    expect(edgeCost(edge({ kind: 'painted_lane', hazards: ['tram_line'] }), SHORTEST_PROFILE)).toBe(100);
  });

  it('orders infrastructure by preference under prefer_paths', () => {
    const cost = (kind: CostableEdge['kind']): number => edgeCost(edge({ kind }), PREFER_PATHS_PROFILE);
    expect(cost('shared_use_path')).toBeLessThan(cost('protected_lane'));
    expect(cost('protected_lane')).toBeLessThan(cost('painted_lane'));
    expect(cost('painted_lane')).toBeLessThan(cost('connector'));
  });

  it('compounds hazard multipliers and ignores unknown hazards', () => {
    const base = edgeCost(edge({ kind: 'painted_lane' }), PREFER_PATHS_PROFILE);
    const hazardous = edgeCost(edge({ kind: 'painted_lane', hazards: ['tram_line', 'parking', 'meteors'] }), PREFER_PATHS_PROFILE);
    expect(hazardous).toBeCloseTo(base * 1.5 * 1.1, 9);
  });

  it('applies surface multipliers, preferring smoother ground', () => {
    const cost = (surfaceClass: CostableEdge['surfaceClass']): number =>
      edgeCost(edge({ surfaceClass }), PREFER_PATHS_PROFILE);
    expect(cost('smooth')).toBe(100);
    expect(cost('gravel')).toBeCloseTo(170, 9);
    expect(cost('smooth')).toBeLessThan(cost('rough_paved'));
    expect(cost('compacted')).toBeLessThan(cost('gravel'));
    expect(cost('gravel')).toBeLessThan(cost('unpaved'));
  });

  it('makes a smooth quiet street cheaper than a gravel trail of equal length', () => {
    const street = edgeCost(edge({ kind: 'quiet_street', surfaceClass: 'smooth' }), PREFER_PATHS_PROFILE);
    const gravelTrail = edgeCost(edge({ kind: 'trail', surfaceClass: 'gravel' }), PREFER_PATHS_PROFILE);
    expect(street).toBeLessThan(gravelTrail);
  });
});

describe('minCostPerMeter', () => {
  it('is the smallest possible multiplier', () => {
    expect(minCostPerMeter(PREFER_PATHS_PROFILE)).toBe(1);
  });

  it('accounts for discounting hazards so the A* heuristic stays admissible', () => {
    const profile: RoutingProfile = { ...SHORTEST_PROFILE, hazardMultipliers: { a: 0.5, b: 0.8, c: 2 } };
    expect(minCostPerMeter(profile)).toBeCloseTo(0.4, 9);
  });
});

describe('validateProfile', () => {
  it('rejects non-positive multipliers', () => {
    const broken: RoutingProfile = {
      ...SHORTEST_PROFILE,
      kindMultipliers: { ...SHORTEST_PROFILE.kindMultipliers, painted_lane: 0 },
    };
    expect(() => validateProfile(broken)).toThrow(/non-positive/);
  });
});
