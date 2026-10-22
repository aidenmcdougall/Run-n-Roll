import { Router } from 'express';
import { z } from 'zod';
import type { SurfaceClass } from '../../domain/surface.js';
import {
  MAX_TARGET_M,
  MIN_TARGET_M,
  planDistanceRoutes,
  ROUTE_SHAPES,
  type DistanceRoute,
} from '../../routing/distanceRoutes.js';
import type { LngLat } from '../../routing/geo.js';
import type { RoutingGraph } from '../../routing/graph.js';
import { planRoute, type PlanErrorCode, type RoutePlan } from '../../routing/planner.js';
import { RUN_MODEL, scoreRoute, SKATE_MODEL } from '../../routing/scoring.js';
import {
  applyPreferences,
  avoidedSurfaces,
  BUSY_ROAD_PENALTY,
  DEFAULT_PREFERENCES,
  STEPS_PENALTY,
  SURFACE_PENALTIES,
  SURFACE_PREFERENCES,
  type RoutePreferences,
} from '../../routing/preferences.js';
import type { RoutingProfile } from '../../routing/weights.js';
import { DEFAULT_PROFILE_ID, ROUTING_PROFILES } from '../../routing/profiles.js';
import type { NetworkStateProvider } from '../../services/networkService.js';
import { HttpError } from '../errors.js';
import { LngLatSchema } from '../validation.js';

const ProfileSchema = z
  .string()
  .refine((id) => id in ROUTING_PROFILES, { message: 'Unknown routing profile' })
  .default(DEFAULT_PROFILE_ID);

// Strict, so a misspelt option is rejected rather than silently ignored.
const PreferencesSchema = z
  .strictObject({
    surface: z.enum(SURFACE_PREFERENCES).default(DEFAULT_PREFERENCES.surface),
    avoidSteps: z.boolean().default(DEFAULT_PREFERENCES.avoidSteps),
    avoidBusyRoads: z.boolean().default(DEFAULT_PREFERENCES.avoidBusyRoads),
  })
  .default(DEFAULT_PREFERENCES);

const RouteRequestSchema = z.object({
  start: LngLatSchema,
  end: LngLatSchema,
  profile: ProfileSchema,
  preferences: PreferencesSchema,
});

const DistanceRouteRequestSchema = z.object({
  start: LngLatSchema,
  distanceM: z.number().min(MIN_TARGET_M).max(MAX_TARGET_M),
  shape: z.enum(ROUTE_SHAPES).default('loop'),
  profile: ProfileSchema,
  preferences: PreferencesSchema,
  alternatives: z.number().int().min(1).max(5).default(3),
});

export type RouteRequest = z.input<typeof RouteRequestSchema>;
export type DistanceRouteRequest = z.input<typeof DistanceRouteRequestSchema>;

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

function readyGraph(network: NetworkStateProvider): RoutingGraph {
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
  return state.graph;
}

/** A planned route as a GeoJSON Feature<LineString>, with its stats and scores. */
function routeFeature(
  route: RoutePlan,
  profile: RoutingProfile,
  preferences: RoutePreferences,
  avoided: readonly SurfaceClass[],
  extra: Record<string, unknown> = {},
) {
  // Distance still on surfaces the profile avoids (when there was no alternative).
  const avoidedSurfaceM = avoided.reduce(
    (sum, surface) => sum + (route.distanceBySurface[surface] ?? 0),
    0,
  );
  return {
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: route.coordinates },
    properties: {
      profile: profile.id,
      preferences,
      avoidedSurfaceM: round(avoidedSurfaceM),
      scores: scoreRoute(route.stretches),
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
      ...extra,
    },
  };
}

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
      scoring: { skate: SKATE_MODEL, run: RUN_MODEL },
    });
  });

  /** Plans a point-to-point route. Responds with a GeoJSON Feature<LineString>. */
  router.post('/', (req, res) => {
    const body = RouteRequestSchema.parse(req.body);
    const graph = readyGraph(network);
    const baseProfile = ROUTING_PROFILES[body.profile]!;
    const profile = applyPreferences(baseProfile, body.preferences);
    const start: LngLat = [body.start.lng, body.start.lat];
    const end: LngLat = [body.end.lng, body.end.lat];
    const avoided = avoidedSurfaces(profile);
    const result = planRoute(graph, start, end, profile, { avoidSurfacesAtEnds: avoided });
    if (!result.ok) throw new HttpError(PLAN_ERROR_STATUS[result.code], result.code, result.message);
    res.json(routeFeature(result.route, baseProfile, body.preferences, avoided));
  });

  /**
   * Plans routes of a target length from a start point: loops back to the
   * start, or one way. Responds with a GeoJSON FeatureCollection of up to
   * `alternatives` distinct routes, best first.
   */
  router.post('/distance', (req, res) => {
    const body = DistanceRouteRequestSchema.parse(req.body);
    const graph = readyGraph(network);
    const baseProfile = ROUTING_PROFILES[body.profile]!;
    const profile = applyPreferences(baseProfile, body.preferences);
    const avoided = avoidedSurfaces(profile);
    const result = planDistanceRoutes(graph, [body.start.lng, body.start.lat], profile, {
      shape: body.shape,
      targetM: body.distanceM,
      avoidSurfaces: avoided,
      maxRoutes: body.alternatives,
    });
    if (!result.ok) throw new HttpError(PLAN_ERROR_STATUS[result.code], result.code, result.message);
    const target = (r: DistanceRoute) => ({
      target: {
        distanceM: body.distanceM,
        shape: body.shape,
        bearingDeg: r.bearingDeg,
        distanceError: round(r.distanceError, 3),
        repeatedM: round(r.repeatedM),
      },
    });
    res.json({
      type: 'FeatureCollection',
      features: result.routes.map((r) => routeFeature(r.route, baseProfile, body.preferences, avoided, target(r))),
    });
  });

  return router;
}
