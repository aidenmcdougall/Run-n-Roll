import type { ExpressionSpecification } from 'maplibre-gl';
import type { EdgeKind, SurfaceClass } from '../api/types';

interface Swatch {
  label: string;
  color: string;
}

/**
 * Display metadata per edge kind, shared by the map layer and the legend.
 * DTP bike infrastructure uses saturated colours, from green (off-road)
 * through blue/purple (lanes) to orange (mixed traffic). OSM gap-filling
 * paths and streets use muted tones so the bike network still stands out.
 */
export const EDGE_KIND_STYLE: Record<EdgeKind, Swatch> = {
  shared_use_path: { label: 'Shared use path', color: '#1a9850' },
  separated_path: { label: 'Separated path', color: '#66bd63' },
  protected_lane: { label: 'Protected lane', color: '#2c7bb6' },
  buffered_lane: { label: 'Buffered lane', color: '#5e9fd6' },
  painted_lane: { label: 'Painted lane', color: '#8073ac' },
  shared_parking_lane: { label: 'Bike/parking lane', color: '#c2a5cf' },
  shared_street: { label: 'Shared street', color: '#f4a582' },
  informal: { label: 'Informal (on-road)', color: '#d6604d' },
  footpath: { label: 'Footpath', color: '#9aa5b1' },
  trail: { label: 'Trail', color: '#a47148' },
  track: { label: 'Track', color: '#c19a6b' },
  steps: { label: 'Steps', color: '#e11d48' },
  quiet_street: { label: 'Quiet street', color: '#cbd2d9' },
  road: { label: 'Road', color: '#8b96a3' },
  busy_road: { label: 'Busy road', color: '#52606d' },
  unknown: { label: 'Unknown', color: '#999999' },
  connector: { label: 'Gap / crossing', color: '#555555' },
};

export const BIKE_CATEGORIES: EdgeKind[] = [
  'shared_use_path',
  'separated_path',
  'protected_lane',
  'buffered_lane',
  'painted_lane',
  'shared_parking_lane',
  'shared_street',
  'informal',
];

export const OSM_CATEGORIES: EdgeKind[] = ['footpath', 'trail', 'track', 'steps', 'quiet_street', 'road', 'busy_road'];

/** Surface classes from smoothest to roughest (matches the backend). */
export const SURFACE_STYLE: Record<SurfaceClass, Swatch> = {
  smooth: { label: 'Smooth (asphalt, concrete)', color: '#15803d' },
  paved: { label: 'Paved', color: '#65a30d' },
  rough_paved: { label: 'Pavers / bricks / boards', color: '#ca8a04' },
  compacted: { label: 'Compacted gravel', color: '#ea8a0c' },
  gravel: { label: 'Loose gravel', color: '#dc5f14' },
  unpaved: { label: 'Dirt / grass / sand', color: '#8a4b16' },
  unknown: { label: 'Unknown', color: '#a3a3a3' },
};

export const SURFACE_CLASSES = Object.keys(SURFACE_STYLE) as SurfaceClass[];

export type ColorMode = 'type' | 'surface';

/**
 * `['match', input, label1, output1, ..., fallback]`. The style-spec tuple
 * type can't describe a variable number of label/output pairs, hence the cast.
 */
function matchExpression(property: string, table: Record<string, Swatch>, fallback: string): ExpressionSpecification {
  return [
    'match',
    ['get', property],
    ...Object.entries(table).flatMap(([key, swatch]) => [key, swatch.color]),
    fallback,
  ] as unknown as ExpressionSpecification;
}

export function pathColorExpression(mode: ColorMode): ExpressionSpecification {
  return mode === 'type'
    ? matchExpression('infra_category', EDGE_KIND_STYLE, EDGE_KIND_STYLE.unknown.color)
    : matchExpression('surface_class', SURFACE_STYLE, SURFACE_STYLE.unknown.color);
}

const isBikeNetwork: ExpressionSpecification = ['==', ['get', 'source'], 'vic_dtp_bin'];

/** DTP bike infrastructure is drawn wider than OSM gap-filling paths. */
export const pathWidthExpression: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  8,
  0.6,
  12,
  1.6,
  14,
  ['case', isBikeNetwork, 2.4, 1],
  17,
  ['case', isBikeNetwork, 5, 2.5],
];

/** In surface mode, assumed surfaces are drawn fainter than tagged ones. */
export function pathOpacityExpression(mode: ColorMode): ExpressionSpecification | number {
  return mode === 'surface' ? ['case', ['to-boolean', ['get', 'surface_inferred']], 0.45, 0.9] : 0.85;
}

/** Draw the bike network above OSM paths where they overlap. */
export const pathSortKeyExpression: ExpressionSpecification = ['case', isBikeNetwork, 1, 0];
