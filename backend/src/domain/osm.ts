import type { InfraCategory } from './infrastructure.js';

/** OSM tags as loaded by osm2pgsql (all values are strings). */
export type OsmTags = Readonly<Record<string, string | undefined>>;

export interface ClassifiedOsmWay {
  category: InfraCategory;
  name: string | null;
  surface: string | null;
  smoothness: string | null;
  widthM: number | null;
  direction: 'both' | 'forward' | 'reverse';
  /** A sidewalk: its surface can be assumed sealed when untagged. */
  sealedByDefault: boolean;
}

const YES = new Set(['yes', 'designated', 'permissive', 'official']);
const NO = new Set(['no', 'private', 'use_sidepath']);

/** Service roads that lead nowhere useful for an activity route. */
const EXCLUDED_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);

const QUIET_STREETS = new Set(['living_street', 'residential', 'service', 'unclassified', 'road']);
const ROADS = new Set(['tertiary', 'tertiary_link']);
const BUSY_ROADS = new Set(['secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link']);

/**
 * Whether people on foot or on wheels may legally use the way. General
 * `access=no/private` is overridden by an explicit foot/bicycle permission,
 * following OSM's access tag hierarchy.
 */
function isAccessible(tags: OsmTags): boolean {
  const foot = tags.foot;
  const bicycle = tags.bicycle;
  if (foot && NO.has(foot) && bicycle && NO.has(bicycle)) return false;
  const access = tags.access;
  if (access && NO.has(access)) {
    return Boolean((foot && YES.has(foot)) || (bicycle && YES.has(bicycle)));
  }
  return true;
}

/** Parses OSM width values like "2", "2.5 m", "3m". Returns metres or null. */
export function parseWidth(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(m|metres?|meters?)?\s*$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return value > 0 && value < 100 ? value : null;
}

/** One-way rules as they apply to bicycles; unused by foot-based profiles. */
function bicycleDirection(tags: OsmTags): ClassifiedOsmWay['direction'] {
  if (tags['oneway:bicycle'] === 'no') return 'both';
  const oneway = tags['oneway:bicycle'] ?? tags.oneway;
  if (oneway === 'yes' || oneway === '1' || oneway === 'true') return 'forward';
  if (oneway === '-1' || oneway === 'reverse') return 'reverse';
  return 'both';
}

function categorise(tags: OsmTags): InfraCategory | null {
  const highway = tags.highway;
  if (!highway) return null;
  const bikeDesignated = tags.bicycle === 'designated';

  switch (highway) {
    case 'cycleway':
      return 'shared_use_path';
    case 'footway':
    case 'pedestrian':
      // Footpaths signed for bikes are Victoria's shared paths.
      return bikeDesignated && tags.footway !== 'sidewalk' ? 'shared_use_path' : 'footpath';
    case 'path':
      // `path` is generic in OSM: a designated bike path, a paved park path,
      // or a bush trail. The surface tag is the best discriminator we have.
      if (bikeDesignated) return 'shared_use_path';
      return tags.surface === 'asphalt' || tags.surface === 'concrete' || tags.surface === 'paved' ? 'footpath' : 'trail';
    case 'track':
    case 'bridleway':
      return 'track';
    case 'steps':
      return 'steps';
    default:
      if (QUIET_STREETS.has(highway)) return 'quiet_street';
      if (ROADS.has(highway)) return 'road';
      if (BUSY_ROADS.has(highway)) return 'busy_road';
      return null;
  }
}

/**
 * Decides whether an OSM highway way belongs in the routing network and, if
 * so, how it is classified. Returns null for ways that should be skipped.
 */
export function classifyOsmWay(tags: OsmTags): ClassifiedOsmWay | null {
  if (!isAccessible(tags)) return null;
  if (tags.highway === 'service' && tags.service && EXCLUDED_SERVICE.has(tags.service)) return null;
  if (tags.indoor === 'yes') return null;

  const category = categorise(tags);
  if (!category) return null;

  return {
    category,
    name: tags.name?.trim() || null,
    surface: tags.surface?.trim() || null,
    smoothness: tags.smoothness?.trim() || null,
    widthM: parseWidth(tags.width),
    direction: bicycleDirection(tags),
    sealedByDefault: tags.footway === 'sidewalk',
  };
}
