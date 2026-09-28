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
  surface: null,
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

  it('applies surface multipliers, falling back to "unknown"', () => {
    expect(edgeCost(edge({ surface: 'gravel' }), PREFER_PATHS_PROFILE)).toBeCloseTo(180, 9);
    expect(edgeCost(edge({ surface: 'moon_dust' }), PREFER_PATHS_PROFILE)).toBe(100);
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
