import { z } from 'zod';
import { isInVictoriaBounds } from '../domain/region.js';

export { VICTORIA_BOUNDS } from '../domain/region.js';

const IN_VICTORIA = { message: 'Point must be within Victoria, Australia' } as const;

/**
 * A point in a JSON body. Points outside Victoria are rejected early: the
 * network only covers Victoria, and this catches swapped lat/lng pairs, the
 * most common client bug with coordinates.
 */
export const LngLatSchema = z
  .object({
    lng: z.number(),
    lat: z.number(),
  })
  .refine(({ lng, lat }) => isInVictoriaBounds(lng, lat), IN_VICTORIA);

/** The same, from query-string parameters (`?lat=…&lng=…`). */
export const LngLatQuerySchema = z
  .object({
    lng: z.coerce.number(),
    lat: z.coerce.number(),
  })
  .refine(({ lng, lat }) => isInVictoriaBounds(lng, lat), IN_VICTORIA);
