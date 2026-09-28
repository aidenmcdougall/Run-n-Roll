import type { ExpressionSpecification } from 'maplibre-gl';
import type { EdgeKind } from '../api/types';

/**
 * Display metadata per edge kind: shared by the map layer and the legend.
 * Colours run from green (off-road) through blue/purple (protected / painted
 * lanes) to orange/grey (mixed traffic), roughly matching preference order.
 */
export const EDGE_KIND_STYLE: Record<EdgeKind, { label: string; color: string }> = {
  shared_use_path: { label: 'Shared use path', color: '#1a9850' },
  separated_path: { label: 'Separated path', color: '#66bd63' },
  protected_lane: { label: 'Protected lane', color: '#2c7bb6' },
  buffered_lane: { label: 'Buffered lane', color: '#5e9fd6' },
  painted_lane: { label: 'Painted lane', color: '#8073ac' },
  shared_parking_lane: { label: 'Bike/parking lane', color: '#c2a5cf' },
  shared_street: { label: 'Shared street', color: '#f4a582' },
  informal: { label: 'Informal (on-road)', color: '#d6604d' },
  unknown: { label: 'Unknown', color: '#999999' },
  connector: { label: 'Gap / crossing', color: '#555555' },
};

/** Categories that appear in the dataset (connector is routing-only). */
export const PATH_CATEGORIES = (Object.keys(EDGE_KIND_STYLE) as EdgeKind[]).filter((k) => k !== 'connector');

/**
 * `['match', input, label1, output1, ..., fallback]` colouring each path by
 * category. The style-spec tuple type can't describe a variable number of
 * label/output pairs, hence the cast.
 */
export const pathColorExpression = [
  'match',
  ['get', 'infra_category'],
  ...PATH_CATEGORIES.flatMap((kind) => [kind, EDGE_KIND_STYLE[kind].color]),
  EDGE_KIND_STYLE.unknown.color,
] as unknown as ExpressionSpecification;
