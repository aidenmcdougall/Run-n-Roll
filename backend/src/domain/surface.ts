import type { InfraCategory } from './infrastructure.js';

/**
 * Normalised ground types. OpenStreetMap's `surface` tag has dozens of values
 * (https://wiki.openstreetmap.org/wiki/Key:surface); routing weights key on
 * these few classes instead, so a new or rare OSM value never silently
 * changes routing behaviour.
 */
export const SURFACE_CLASSES = [
  'smooth', // asphalt, concrete: ideal for skating and road bikes
  'paved', // sealed but unspecified or coarse (e.g. chipseal)
  'rough_paved', // pavers, bricks, cobbles, boardwalk: rideable, bumpy for skates
  'compacted', // compacted/fine gravel: good for running, poor for skating
  'gravel', // loose gravel
  'unpaved', // dirt, grass, sand, mud
  'unknown',
] as const;

export type SurfaceClass = (typeof SURFACE_CLASSES)[number];

export const OSM_SURFACE_TO_CLASS: Readonly<Record<string, SurfaceClass>> = {
  asphalt: 'smooth',
  concrete: 'smooth',
  tartan: 'smooth', // running tracks
  rubber: 'smooth',
  acrylic: 'smooth',
  paved: 'paved',
  chipseal: 'paved',
  'concrete:lanes': 'rough_paved',
  'concrete:plates': 'rough_paved',
  paving_stones: 'rough_paved',
  'paving_stones:lanes': 'rough_paved',
  bricks: 'rough_paved',
  brick: 'rough_paved', // common misspelling of `bricks` in Victorian data
  sett: 'rough_paved',
  cobblestone: 'rough_paved',
  unhewn_cobblestone: 'rough_paved',
  grass_paver: 'rough_paved',
  wood: 'rough_paved',
  boardwalk: 'rough_paved', // not a documented value, but used
  metal: 'rough_paved',
  metal_grid: 'rough_paved',
  compacted: 'compacted',
  fine_gravel: 'compacted',
  gravel: 'gravel',
  pebblestone: 'gravel',
  rock: 'gravel',
  shells: 'gravel',
  unpaved: 'unpaved',
  dirt: 'unpaved',
  earth: 'unpaved',
  ground: 'unpaved',
  soil: 'unpaved',
  mud: 'unpaved',
  sand: 'unpaved',
  grass: 'unpaved',
  woodchips: 'unpaved',
};

/**
 * Categories that are part of the road carriageway. When OSM has no surface
 * tag for these, we infer `paved`: essentially every street in the covered
 * urban areas is sealed, and unsealed ones are usually tagged. Off-road paths
 * get no such assumption, because a trail with no tag may well be gravel.
 */
export const SEALED_BY_DEFAULT: ReadonlySet<InfraCategory> = new Set<InfraCategory>([
  'protected_lane',
  'buffered_lane',
  'painted_lane',
  'shared_parking_lane',
  'shared_street',
  'informal',
  'quiet_street',
  'road',
  'busy_road',
]);

export interface EffectiveSurface {
  surfaceClass: SurfaceClass;
  /** True when the class was assumed rather than read from a tag. */
  inferred: boolean;
}

/** Maps a raw OSM surface value (possibly `a;b` multi-value) to its class. */
export function classifySurface(raw: string | null | undefined): SurfaceClass {
  if (!raw) return 'unknown';
  // Multi-valued tags like "asphalt;gravel" (or the informal "dirt/sand"):
  // the worst listed surface wins.
  const classes = raw
    .toLowerCase()
    .split(/[;/]/)
    .map((value) => OSM_SURFACE_TO_CLASS[value.trim()] ?? 'unknown');
  const known = classes.filter((c) => c !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.reduce((worst, c) => (SURFACE_CLASSES.indexOf(c) > SURFACE_CLASSES.indexOf(worst) ? c : worst));
}

/**
 * The surface class routing should assume for a segment: the tagged surface
 * if recognised, otherwise `paved` for carriageway categories (and sidewalks,
 * flagged by the caller), otherwise `unknown`.
 */
export function effectiveSurface(
  category: InfraCategory,
  rawSurface: string | null | undefined,
  { sealedByDefault = false }: { sealedByDefault?: boolean } = {},
): EffectiveSurface {
  const tagged = classifySurface(rawSurface);
  if (tagged !== 'unknown') return { surfaceClass: tagged, inferred: false };
  if (sealedByDefault || SEALED_BY_DEFAULT.has(category)) return { surfaceClass: 'paved', inferred: true };
  return { surfaceClass: 'unknown', inferred: false };
}

const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * SQL expressions computing a row's surface class and whether it was
 * inferred, generated from the same tables as `effectiveSurface` so map
 * styling can never drift from routing. (Display-only simplification:
 * multi-valued tags such as "asphalt;gravel" show as unknown on the map,
 * while the router takes the worst listed value. They are ~0.1% of ways.)
 */
export function surfaceClassSql(surface: string, category: string, isSidewalk: string): { cls: string; inferred: string } {
  const sealed = `(${category} IN (${[...SEALED_BY_DEFAULT].map(sqlLiteral).join(', ')}) OR ${isSidewalk})`;
  const cases = Object.entries(OSM_SURFACE_TO_CLASS)
    .map(([raw, cls]) => `WHEN ${sqlLiteral(raw)} THEN ${sqlLiteral(cls)}`)
    .join(' ');
  return {
    cls: `CASE WHEN ${surface} IS NULL THEN (CASE WHEN ${sealed} THEN 'paved' ELSE 'unknown' END) ELSE (CASE lower(${surface}) ${cases} ELSE 'unknown' END) END`,
    inferred: `(${surface} IS NULL AND ${sealed})`,
  };
}
