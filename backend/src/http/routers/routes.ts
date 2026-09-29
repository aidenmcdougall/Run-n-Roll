import { Router } from 'express';
import { z } from 'zod';
import type { LngLat } from '../../routing/geo.js';
import { planRoute, type PlanErrorCode } from '../../routing/planner.js';
import { DEFAULT_PROFILE_ID, ROUTING_PROFILES } from '../../routing/weights.js';
import type { NetworkStateProvider } from '../../services/networkService.js';
import { HttpError } from '../errors.js';
import { LngLatSchema } from '../validation.js';

const RouteRequestSchema = z.object({
  start: LngLatSchema,
  end: LngLatSchema,
  profile: z
    .string()
    .refine((id) => id in ROUTING_PROFILES, { message: 'Unknown routing profile' })
    .default(DEFAULT_PROFILE_ID),
});

export type RouteRequest = z.input<typeof RouteRequestSchema>;

const PLAN_ERROR_STATUS: Record<PlanErrorCode, number> = {
  START_NOT_NEAR_NETWORK: 422,
  END_NOT_NEAR_NETWORK: 422,
  NO_ROUTE: 422,
};

const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

const roundValues = <K extends string>(record: Partial<Record<K, number>>): Partial<Record<K, number>> =>
  Object.fromEntries(Object.entries<number | undefined>(record).map(([key, metres]) => [key, round(metres ?? 0)])) as Partial<
    Record<K, number>
  >;

export function routesRouter(network: NetworkStateProvider): Router {
  const router = Router();

  /** Lists routing profiles and their weights, so clients can show what each one favours. */
  router.get('/profiles', (_req, res) => {
    res.json({ defaultProfile: DEFAULT_PROFILE_ID, profiles: Object.values(ROUTING_PROFILES) });
  });

  /** Plans a point-to-point route. Responds with a GeoJSON Feature<LineString>. */
  router.post('/', (req, res) => {
    const body = RouteRequestSchema.parse(req.body);
    const state = network.getState();
    if (state.status === 'loading') {
      throw new HttpError(503, 'NETWORK_LOADING', 'The path network is still loading. Try again shortly.');
    }
    if (state.status === 'empty') {
      throw new HttpError(503, 'NETWORK_EMPTY', 'No path data has been imported. Run `npm run data:import`.');
    }
    if (state.status === 'error') {
      throw new HttpError(503, 'NETWORK_UNAVAILABLE', 'The path network failed to load.');
    }

    const profile = ROUTING_PROFILES[body.profile]!;
    const start: LngLat = [body.start.lng, body.start.lat];
    const end: LngLat = [body.end.lng, body.end.lat];
    const result = planRoute(state.graph, start, end, profile);
    if (!result.ok) throw new HttpError(PLAN_ERROR_STATUS[result.code], result.code, result.message);

    const { route } = result;
    res.json({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coordinates },
      properties: {
        profile: profile.id,
        distanceM: round(route.distanceM),
        cost: round(route.cost),
        legs: route.legs.map((leg) => ({ ...leg, lengthM: round(leg.lengthM) })),
        distanceByKind: roundValues(route.distanceByKind),
        distanceBySurface: roundValues(route.distanceBySurface),
        inferredSurfaceM: round(route.inferredSurfaceM),
        snap: {
          start: { point: route.start.point, distanceM: round(route.start.distanceM) },
          end: { point: route.end.point, distanceM: round(route.end.distanceM) },
        },
      },
    });
  });

  return router;
}
