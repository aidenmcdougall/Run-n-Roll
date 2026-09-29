import { describe, expect, it } from 'vitest';
import { classifySurface, effectiveSurface, surfaceClassSql } from '../src/domain/surface.js';

describe('classifySurface', () => {
  it.each([
    ['asphalt', 'smooth'],
    ['concrete', 'smooth'],
    ['paved', 'paved'],
    ['paving_stones', 'rough_paved'],
    ['brick', 'rough_paved'],
    ['wood', 'rough_paved'],
    ['compacted', 'compacted'],
    ['fine_gravel', 'compacted'],
    ['gravel', 'gravel'],
    ['dirt', 'unpaved'],
    ['grass', 'unpaved'],
    ['Asphalt', 'smooth'],
  ])('%s → %s', (raw, expected) => expect(classifySurface(raw)).toBe(expected));

  it('returns unknown for missing or unrecognised values', () => {
    expect(classifySurface(null)).toBe('unknown');
    expect(classifySurface('')).toBe('unknown');
    expect(classifySurface('moon_dust')).toBe('unknown');
  });

  it('takes the worst surface of a multi-valued tag', () => {
    expect(classifySurface('asphalt;gravel')).toBe('gravel');
    expect(classifySurface('dirt/sand')).toBe('unpaved');
    expect(classifySurface('asphalt;moon_dust')).toBe('smooth');
  });
});

describe('effectiveSurface', () => {
  it('uses the tagged surface when present', () => {
    expect(effectiveSurface('quiet_street', 'gravel')).toEqual({ surfaceClass: 'gravel', inferred: false });
  });

  it('assumes untagged streets and on-road lanes are sealed, and says so', () => {
    expect(effectiveSurface('quiet_street', null)).toEqual({ surfaceClass: 'paved', inferred: true });
    expect(effectiveSurface('painted_lane', null)).toEqual({ surfaceClass: 'paved', inferred: true });
  });

  it('makes no assumption for untagged off-road paths', () => {
    expect(effectiveSurface('trail', null)).toEqual({ surfaceClass: 'unknown', inferred: false });
    expect(effectiveSurface('shared_use_path', null)).toEqual({ surfaceClass: 'unknown', inferred: false });
  });

  it('assumes sealed for sidewalks when the caller says so', () => {
    expect(effectiveSurface('footpath', null, { sealedByDefault: true })).toEqual({ surfaceClass: 'paved', inferred: true });
  });
});

describe('surfaceClassSql', () => {
  it('generates a CASE covering every mapped value and the sealed-by-default rule', () => {
    const { cls, inferred } = surfaceClassSql('s', 'c', 'w');
    expect(cls).toContain(`WHEN 'asphalt' THEN 'smooth'`);
    expect(cls).toContain(`WHEN 'gravel' THEN 'gravel'`);
    expect(cls).toContain(`'quiet_street'`);
    expect(inferred).toBe(`(s IS NULL AND (c IN (${cls.match(/c IN \(([^)]*)\)/)![1]}) OR w))`);
  });
});
