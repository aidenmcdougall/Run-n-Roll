import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/routing/graph.js';
import { planRoute, type RouteStretch } from '../src/routing/planner.js';
import { scoreRoute, SKATE_MODEL, suitability } from '../src/routing/scoring.js';
import { PREFER_PATHS_PROFILE } from '../src/routing/weights.js';
import { at, segment } from './helpers.js';

const stretch = (overrides: Partial<RouteStretch> = {}): RouteStretch => ({
  kind: 'shared_use_path',
  surfaceClass: 'smooth',
  surfaceInferred: false,
  smoothness: null,
  hazards: [],
  lengthM: 1000,
  ...overrides,
});

describe('scoreRoute', () => {
  it('rates a smooth shared path as great for both activities', () => {
    const { skate, run } = scoreRoute([stretch()]);
    expect(skate).toMatchObject({ score: 100, rating: 'great', confidence: 'high' });
    expect(run.score).toBeGreaterThanOrEqual(85);
  });

  it('disagrees on a gravel trail: poor to skate, great to run', () => {
    const { skate, run } = scoreRoute([stretch({ kind: 'trail', surfaceClass: 'compacted' })]);
    expect(skate.rating).toBe('poor');
    expect(run.rating).toBe('great');
  });

  it('rates a busy-road route poorly for running regardless of smooth asphalt', () => {
    const { run } = scoreRoute([stretch({ kind: 'busy_road' })]);
    expect(run.rating).toBe('poor');
  });

  it('weights by length', () => {
    const mostlySmooth = scoreRoute([stretch({ lengthM: 900 }), stretch({ surfaceClass: 'rough_paved', lengthM: 100 })]);
    const mostlyRough = scoreRoute([stretch({ lengthM: 100 }), stretch({ surfaceClass: 'rough_paved', lengthM: 900 })]);
    expect(mostlySmooth.skate.score).toBeGreaterThan(mostlyRough.skate.score);
  });

  it('penalises even a short stretch you would have to walk, and bars a "great" rating', () => {
    const noWalk = scoreRoute([stretch({ lengthM: 2000 })]).skate;
    const withSteps = scoreRoute([
      stretch({ lengthM: 1000 }),
      stretch({ kind: 'steps', lengthM: 4 }), // short, but you still stop
      stretch({ lengthM: 1000 }),
    ]).skate;
    expect(noWalk.rating).toBe('great');
    expect(withSteps.rating).toBe('good');
    expect(withSteps.notes[0]!.text).toBe("1 short stretch you'd need to walk (including steps)");
  });

  it('rates a mostly smooth route with 230 m of gravel to walk as fair at best', () => {
    // The Southbank → St Kilda case: 6.5 km of lovely path, 230 m you can't skate.
    const { skate } = scoreRoute([
      stretch({ lengthM: 3000 }),
      stretch({ kind: 'footpath', surfaceClass: 'compacted', lengthM: 230 }),
      stretch({ lengthM: 3500 }),
    ]);
    expect(skate.score).toBeLessThanOrEqual(69);
    expect(skate.rating).toBe('fair');
    expect(skate.notes.map((n) => n.text)).toContain("230 m you'd need to walk");
  });

  it('scales the walking penalty with distance walked', () => {
    const route = (walkM: number) =>
      scoreRoute([stretch({ lengthM: 10_000 }), stretch({ kind: 'trail', surfaceClass: 'gravel', lengthM: walkM })]).skate.score;
    expect(route(50)).toBeGreaterThan(route(300));
    expect(route(300)).toBeGreaterThan(route(1000));
  });

  it("doesn't apply walking penalties to running", () => {
    const run = scoreRoute([stretch({ lengthM: 3000 }), stretch({ kind: 'trail', surfaceClass: 'gravel', lengthM: 300 })]).run;
    expect(run.rating).toBe('great');
  });

  it('treats tram tracks as a skating hazard', () => {
    expect(scoreRoute([stretch({ kind: 'painted_lane', hazards: ['tram_line'] })]).skate.score).toBeLessThan(
      scoreRoute([stretch({ kind: 'painted_lane' })]).skate.score,
    );
  });

  it('uses OSM smoothness in place of surface when tagged', () => {
    const tagged = stretch({ surfaceClass: 'smooth', smoothness: 'bad' });
    expect(suitability(tagged, SKATE_MODEL)).toBeLessThan(suitability(stretch(), SKATE_MODEL));
    expect(suitability(stretch({ surfaceClass: 'paved', smoothness: 'excellent' }), SKATE_MODEL)).toBe(1);
  });

  it('lowers confidence when surfaces are assumed or unknown', () => {
    expect(scoreRoute([stretch({ surfaceInferred: true, surfaceClass: 'paved' })]).skate.confidence).toBe('low');
    expect(
      scoreRoute([stretch({ lengthM: 700 }), stretch({ surfaceClass: 'unknown', lengthM: 300 })]).run.confidence,
    ).toBe('medium');
  });

  it('explains the score with notes, strongest first', () => {
    const { skate, run } = scoreRoute([
      stretch({ lengthM: 3000 }),
      stretch({ kind: 'trail', surfaceClass: 'gravel', lengthM: 800 }),
      stretch({ kind: 'busy_road', lengthM: 400 }),
    ]);
    const skateTexts = skate.notes.map((n) => n.text);
    expect(skateTexts).toContain('800 m of loose gravel');
    expect(skateTexts).toContain('400 m along busy roads');
    expect(skate.notes.find((n) => n.text.includes('gravel'))!.tone).toBe('negative');
    expect(run.notes.some((n) => n.tone === 'positive' && n.text.includes('off-road'))).toBe(true);
  });

  it('attributes lost points to causes so they add up to the shortfall', () => {
    const stretches = [
      stretch({ kind: 'footpath', surfaceClass: 'rough_paved', lengthM: 1000 }),
      stretch({ kind: 'painted_lane', hazards: ['tram_line'], lengthM: 1000 }),
    ];
    const { skate } = scoreRoute(stretches);
    const lost = skate.notes.filter((n) => n.tone === 'negative').reduce((sum, n) => sum + n.points!, 0);
    expect(lost).toBeCloseTo(100 - skate.score, 0);
    // Holds with walking penalties and the rating cap too (on a score that isn't clamped at 0).
    const walked = scoreRoute([
      stretch({ lengthM: 3000 }),
      stretch({ kind: 'footpath', surfaceClass: 'rough_paved', lengthM: 500 }),
      stretch({ kind: 'trail', surfaceClass: 'gravel', lengthM: 120 }),
    ]).skate;
    expect(walked.score).toBeGreaterThan(0);
    expect(walked.notes.some((n) => n.text.startsWith('Having to walk caps'))).toBe(true);
    // Every cause is shown here (fewer than the note limit), so the points must add up exactly.
    expect(walked.notes.filter((n) => n.tone === 'negative').length).toBeLessThanOrEqual(5);
    const walkedLost = walked.notes.filter((n) => n.tone === 'negative').reduce((sum, n) => sum + n.points!, 0);
    expect(walkedLost).toBeCloseTo(100 - walked.score, 0);
    // Pavers hurt skating more than footpath traffic does.
    const points = (fragment: string) => skate.notes.find((n) => n.text.includes(fragment))!.points!;
    expect(points('pavers')).toBeGreaterThan(points('footpaths'));
    expect(points('tram tracks')).toBeGreaterThan(0);
  });

  it('gives a zero factor all of its stretch\'s shortfall', () => {
    const { skate } = scoreRoute([stretch({ lengthM: 1000 }), stretch({ kind: 'trail', surfaceClass: 'gravel', lengthM: 1000 })]);
    const gravel = skate.notes.find((n) => n.text.includes('loose gravel'))!;
    expect(gravel.points).toBeCloseTo(50, 0);
    expect(skate.notes.some((n) => n.text.includes('on trails'))).toBe(false);
  });

  it('omits insignificant details from the notes', () => {
    const { skate } = scoreRoute([stretch({ lengthM: 5000 }), stretch({ surfaceClass: 'rough_paved', lengthM: 20 })]);
    expect(skate.notes.some((n) => n.text.includes('pavers'))).toBe(false);
  });

  it('handles an empty route', () => {
    expect(scoreRoute([]).skate).toEqual({ score: 0, rating: 'poor', confidence: 'low', notes: [] });
  });
});

describe('planRoute stretches', () => {
  it('merges consecutive edges with identical attributes', () => {
    const graph = buildGraph([
      segment([[0, 0], [500, 0]], 'shared_use_path'),
      segment([[500, 0], [1000, 0]], 'shared_use_path'),
      segment([[1000, 0], [1500, 0]], 'trail', { surfaceClass: 'gravel', smoothness: 'bad' }),
    ]);
    const result = planRoute(graph, at(0, 0), at(1500, 0), PREFER_PATHS_PROFILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.stretches.map((s) => [s.kind, s.surfaceClass, s.smoothness, Math.round(s.lengthM)])).toEqual([
      ['shared_use_path', 'smooth', null, 1000],
      ['trail', 'gravel', 'bad', 500],
    ]);
  });
});
