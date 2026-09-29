import { Router } from 'express';
import { z } from 'zod';
import type { LngLat } from '../../routing/geo.js';
import { planRoute, type PlanErrorCode } from '../../routing/planner.js';
import {
  applyPreferences,
  avoidedSurfaces,
  BUSY_ROAD_PENALTY,
  DEFAULT_PREFERENCES,
  STEPS_PENALTY,
  SURFACE_PENALTIES,
  SURFACE_PREFERENCES,
} from '../../routing/preferences.js';
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
  // Strict, so a misspelt option is rejected rather than silently ignored.
  preferences: z
    .strictObject({
      surface: z.enum(SURFACE_PREFERENCES).default(DEFAULT_PREFERENCES.surface),
      avoidSteps: z.boolean().default(DEFAULT_PREFERENCES.avoidSteps),
      avoidBusyRoads: z.boolean().default(DEFAULT_PREFERENCES.avoidBusyRoads),
    })
    .default(DEFAULT_PREFERENCES),
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

  /** Lists routing profiles, their weights and the preference penalties, so clients can explain them. */
  router.get('/profiles', (_req, res) => {
    res.json({
      defaultProfile: DEFAULT_PROFILE_ID,
      profiles: Object.values(ROUTING_PROFILES),
      preferences: {
        defaults: DEFAULT_PREFERENCES,
        surfacePenalties: SURFACE_PENALTIES,
        stepsPenalty: STEPS_PENALTY,
        busyRoadPenalty: BUSY_ROAD_PENALTY,
      },
    });
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

    const baseProfile = ROUTING_PROFILES[body.profile]!;
    const profile = applyPreferences(baseProfile, body.preferences);
    const start: LngLat = [body.start.lng, body.start.lat];
    const end: LngLat = [body.end.lng, body.end.lat];
    const avoided = avoidedSurfaces(body.preferences);
    const result = planRoute(state.graph, start, end, profile, { avoidSurfacesAtEnds: avoided });
    if (!result.ok) throw new HttpError(PLAN_ERROR_STATUS[result.code], result.code, result.message);

    const { route } = result;
    // Distance still on surfaces the user asked to avoid (when there was no alternative).
    const avoidedSurfaceM = avoided.reduce(
      (sum, surface) => sum + (route.distanceBySurface[surface] ?? 0),
      0,
    );
    res.json({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coordinates },
      properties: {
        profile: baseProfile.id,
        preferences: body.preferences,
        avoidedSurfaceM: round(avoidedSurfaceM),
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
