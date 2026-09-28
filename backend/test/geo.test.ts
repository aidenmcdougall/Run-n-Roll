import { describe, expect, it } from 'vitest';
import { cumulativeLengths, haversineMeters, pointAtDistance, projectOntoSegment, slicePolyline } from '../src/routing/geo.js';
import { at } from './helpers.js';

describe('haversineMeters', () => {
  it('measures one degree of latitude as ~111.2 km', () => {
    expect(haversineMeters([145, -38], [145, -37])).toBeCloseTo(111_195, -1);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineMeters(at(0, 0), at(0, 0))).toBe(0);
    expect(haversineMeters(at(0, 0), at(300, 400))).toBeCloseTo(haversineMeters(at(300, 400), at(0, 0)), 9);
  });

  it('agrees with the local metre grid used in tests', () => {
    expect(haversineMeters(at(0, 0), at(300, 400))).toBeCloseTo(500, 0);
  });
});

describe('projectOntoSegment', () => {
  it('projects onto the interior of a segment', () => {
    const result = projectOntoSegment(at(50, 10), at(0, 0), at(100, 0));
    expect(result.t).toBeCloseTo(0.5, 3);
    expect(result.distanceM).toBeCloseTo(10, 0);
  });

  it('clamps to the nearest endpoint', () => {
    const result = projectOntoSegment(at(-30, 40), at(0, 0), at(100, 0));
    expect(result.t).toBe(0);
    expect(result.distanceM).toBeCloseTo(50, 0);
  });
});

describe('slicePolyline', () => {
  const line = [at(0, 0), at(100, 0), at(100, 100)];
  const cumulative = cumulativeLengths(line);

  it('interpolates points by distance', () => {
    const p = pointAtDistance(line, cumulative, 150);
    expect(haversineMeters(p, at(100, 50))).toBeLessThan(0.5);
  });

  it('returns the sub-line between two distances, including interior vertices', () => {
    const slice = slicePolyline(line, cumulative, 50, 150);
    expect(slice).toHaveLength(3);
    expect(haversineMeters(slice[1]!, at(100, 0))).toBeLessThan(0.01);
  });

  it('reverses when travelling backwards', () => {
    const slice = slicePolyline(line, cumulative, 150, 50);
    expect(haversineMeters(slice[0]!, at(100, 50))).toBeLessThan(0.5);
    expect(haversineMeters(slice[2]!, at(50, 0))).toBeLessThan(0.5);
  });
});
