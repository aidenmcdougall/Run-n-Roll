import { describe, expect, it } from 'vitest';
import { classifyOsmWay, parseWidth } from '../src/domain/osm.js';

const category = (tags: Record<string, string>) => classifyOsmWay(tags)?.category ?? null;

describe('classifyOsmWay categories', () => {
  it.each([
    [{ highway: 'cycleway' }, 'shared_use_path'],
    [{ highway: 'footway', bicycle: 'designated' }, 'shared_use_path'],
    [{ highway: 'path', bicycle: 'designated' }, 'shared_use_path'],
    [{ highway: 'footway' }, 'footpath'],
    [{ highway: 'footway', footway: 'sidewalk', bicycle: 'designated' }, 'footpath'],
    [{ highway: 'pedestrian' }, 'footpath'],
    [{ highway: 'path', surface: 'asphalt' }, 'footpath'],
    [{ highway: 'path', surface: 'dirt' }, 'trail'],
    [{ highway: 'path' }, 'trail'],
    [{ highway: 'track' }, 'track'],
    [{ highway: 'bridleway' }, 'track'],
    [{ highway: 'steps' }, 'steps'],
    [{ highway: 'residential' }, 'quiet_street'],
    [{ highway: 'living_street' }, 'quiet_street'],
    [{ highway: 'service' }, 'quiet_street'],
    [{ highway: 'tertiary' }, 'road'],
    [{ highway: 'secondary' }, 'busy_road'],
    [{ highway: 'primary_link' }, 'busy_road'],
    [{ highway: 'trunk' }, 'busy_road'],
  ])('%o → %s', (tags, expected) => {
    expect(category(tags)).toBe(expected);
  });

  it('skips highway types that are never routable', () => {
    expect(category({ highway: 'motorway' })).toBeNull();
    expect(category({ highway: 'proposed' })).toBeNull();
  });
});

describe('classifyOsmWay access', () => {
  it('skips private and no-access ways', () => {
    expect(category({ highway: 'service', access: 'private' })).toBeNull();
    expect(category({ highway: 'footway', access: 'no' })).toBeNull();
  });

  it('lets an explicit foot or bicycle permission override general access', () => {
    expect(category({ highway: 'service', access: 'private', foot: 'yes' })).toBe('quiet_street');
    expect(category({ highway: 'track', access: 'no', bicycle: 'designated' })).toBe('track');
  });

  it('skips ways closed to both walkers and cyclists', () => {
    expect(category({ highway: 'trunk', foot: 'no', bicycle: 'no' })).toBeNull();
    expect(category({ highway: 'trunk', foot: 'no' })).toBe('busy_road'); // still rideable
  });

  it('skips driveways, parking aisles and indoor corridors', () => {
    expect(category({ highway: 'service', service: 'driveway' })).toBeNull();
    expect(category({ highway: 'service', service: 'parking_aisle' })).toBeNull();
    expect(category({ highway: 'footway', indoor: 'yes' })).toBeNull();
    expect(category({ highway: 'service', service: 'alley' })).toBe('quiet_street');
  });
});

describe('classifyOsmWay attributes', () => {
  it('extracts name, surface, smoothness and width', () => {
    expect(
      classifyOsmWay({ highway: 'cycleway', name: ' Capital City Trail ', surface: 'asphalt', smoothness: 'good', width: '3 m' }),
    ).toMatchObject({ name: 'Capital City Trail', surface: 'asphalt', smoothness: 'good', widthM: 3 });
  });

  it('derives bicycle direction from oneway tags', () => {
    const direction = (tags: Record<string, string>) => classifyOsmWay({ highway: 'residential', ...tags })?.direction;
    expect(direction({})).toBe('both');
    expect(direction({ oneway: 'yes' })).toBe('forward');
    expect(direction({ oneway: '-1' })).toBe('reverse');
    expect(direction({ oneway: 'yes', 'oneway:bicycle': 'no' })).toBe('both'); // contraflow allowed
  });

  it('flags sidewalks so their surface can be assumed sealed', () => {
    expect(classifyOsmWay({ highway: 'footway', footway: 'sidewalk' })?.sealedByDefault).toBe(true);
    expect(classifyOsmWay({ highway: 'footway' })?.sealedByDefault).toBe(false);
  });
});

describe('parseWidth', () => {
  it.each([
    ['2', 2],
    ['2.5', 2.5],
    ['3 m', 3],
    ['3m', 3],
    ['1.5 metres', 1.5],
  ])('parses %s', (raw, expected) => expect(parseWidth(raw)).toBe(expected));

  it.each(['narrow', '6\'', '0', '', '250'])('rejects %s', (raw) => expect(parseWidth(raw)).toBeNull());
});
