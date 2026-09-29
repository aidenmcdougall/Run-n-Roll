/**
 * Generous bounding box around the State of Victoria. It also takes in part
 * of southern NSW, so it's a coarse filter: use a state check where precision
 * matters.
 */
export const VICTORIA_BOUNDS = { minLng: 140.9, maxLng: 150.1, minLat: -39.3, maxLat: -33.9 } as const;

export function isInVictoriaBounds(lng: number, lat: number): boolean {
  return (
    lng >= VICTORIA_BOUNDS.minLng && lng <= VICTORIA_BOUNDS.maxLng && lat >= VICTORIA_BOUNDS.minLat && lat <= VICTORIA_BOUNDS.maxLat
  );
}
