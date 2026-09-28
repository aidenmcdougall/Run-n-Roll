import { z } from 'zod';

/**
 * Generous bounding box around the State of Victoria. Points outside it are
 * rejected early: the network only covers Victoria, and this catches
 * swapped lat/lng pairs, which is the most common client bug with coordinates.
 */
export const VICTORIA_BOUNDS = { minLng: 140.9, maxLng: 150.1, minLat: -39.3, maxLat: -33.9 } as const;

export const LngLatSchema = z
  .object({
    lng: z.number(),
    lat: z.number(),
  })
  .refine(
    ({ lng, lat }) =>
      lng >= VICTORIA_BOUNDS.minLng &&
      lng <= VICTORIA_BOUNDS.maxLng &&
      lat >= VICTORIA_BOUNDS.minLat &&
      lat <= VICTORIA_BOUNDS.maxLat,
    { message: 'Point must be within Victoria, Australia' },
  );
