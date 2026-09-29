import { Router } from 'express';
import { z } from 'zod';
import { GeocoderError, type Geocoder } from '../../services/geocoder.js';
import { HttpError } from '../errors.js';
import { LngLatQuerySchema } from '../validation.js';

const SearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Search for at least 2 characters').max(120),
  // Optional bias point, typically the map centre.
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
});

async function callGeocoder<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GeocoderError) {
      throw new HttpError(502, 'GEOCODER_UNAVAILABLE', 'Address search is unavailable right now. Try again shortly.');
    }
    throw error;
  }
}

/** Address search and reverse geocoding, proxied so the provider is swappable in one place. */
export function geocodeRouter(geocoder: Geocoder): Router {
  const router = Router();

  router.get('/search', async (req, res) => {
    const { q, lat, lng } = SearchQuerySchema.parse(req.query);
    const near = lat !== undefined && lng !== undefined ? LngLatQuerySchema.safeParse({ lat, lng }) : null;
    const places = await callGeocoder(() =>
      geocoder.search(q, near?.success ? { near: [near.data.lng, near.data.lat] } : {}),
    );
    res.set('Cache-Control', 'public, max-age=3600').json({ places });
  });

  router.get('/reverse', async (req, res) => {
    const { lat, lng } = LngLatQuerySchema.parse(req.query);
    const place = await callGeocoder(() => geocoder.reverse([lng, lat]));
    res.set('Cache-Control', 'public, max-age=86400').json({ place });
  });

  return router;
}
