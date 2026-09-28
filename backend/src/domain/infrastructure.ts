/**
 * Normalised infrastructure categories.
 *
 * The DTP Bicycle Infrastructure Network labels each segment with a
 * human-readable `InfraType`. We map those onto stable slugs so that routing
 * weights, map styling and the database CHECK constraint don't depend on the
 * exact wording of the source dataset.
 */
export const INFRA_CATEGORIES = [
  'shared_use_path',
  'separated_path',
  'protected_lane',
  'buffered_lane',
  'painted_lane',
  'shared_parking_lane',
  'shared_street',
  'informal',
  'unknown',
] as const;

export type InfraCategory = (typeof INFRA_CATEGORIES)[number];

/** Exact `InfraType` labels observed in the 2025 DTP release. */
const INFRA_TYPE_TO_CATEGORY: Readonly<Record<string, InfraCategory>> = {
  'Shared use path (off-road)': 'shared_use_path',
  'Separated path (off-road)': 'separated_path',
  'Protected bike lane (on-road)': 'protected_lane',
  'Buffered painted lane': 'buffered_lane',
  'Basic painted lane': 'painted_lane',
  'Shared bike/parking lane': 'shared_parking_lane',
  'Shared street (sharrows)': 'shared_street',
  'Intermittent/informal (on-road)': 'informal',
};

export function categoriseInfraType(infraType: string): InfraCategory {
  return INFRA_TYPE_TO_CATEGORY[infraType.trim()] ?? 'unknown';
}

export function isInfraCategory(value: string): value is InfraCategory {
  return (INFRA_CATEGORIES as readonly string[]).includes(value);
}

export type Hazard = 'parking' | 'traffic_merging' | 'tram_line';

const HAZARD_LABELS: Readonly<Record<string, Hazard>> = {
  parking: 'parking',
  'traffic merging': 'traffic_merging',
  'tram line': 'tram_line',
};

/**
 * Parses the dataset's comma-separated `Hazards` field,
 * e.g. "Tram line, Parking" -> ['tram_line', 'parking'].
 * Unrecognised labels are returned slugified rather than silently dropped.
 */
export function parseHazards(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((label) => HAZARD_LABELS[label] ?? label.replace(/[^a-z0-9]+/g, '_'));
}
