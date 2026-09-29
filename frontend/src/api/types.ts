/**
 * Types for the backend REST API. These mirror the response shapes produced
 * by backend/src/http/routers/*; keep them in sync when the API changes.
 */

export type InfraCategory =
  | 'shared_use_path'
  | 'separated_path'
  | 'protected_lane'
  | 'buffered_lane'
  | 'painted_lane'
  | 'shared_parking_lane'
  | 'shared_street'
  | 'informal'
  | 'footpath'
  | 'trail'
  | 'track'
  | 'steps'
  | 'quiet_street'
  | 'road'
  | 'busy_road'
  | 'unknown';

export type EdgeKind = InfraCategory | 'connector';

export type SurfaceClass = 'smooth' | 'paved' | 'rough_paved' | 'compacted' | 'gravel' | 'unpaved' | 'unknown';

export type LngLatTuple = [lng: number, lat: number];

export interface LngLatPoint {
  lng: number;
  lat: number;
}

export interface RoutingProfile {
  id: string;
  label: string;
  description: string;
  kindMultipliers: Record<EdgeKind, number>;
  hazardMultipliers: Record<string, number>;
  surfaceMultipliers: Record<SurfaceClass, number>;
  respectOneWay: boolean;
}

export type SurfacePreference = 'any' | 'avoid_loose' | 'smooth_only';

/** Modifiers layered on the base routing profile (see backend routing/preferences.ts). */
export interface RoutePreferences {
  surface: SurfacePreference;
  avoidSteps: boolean;
  avoidBusyRoads: boolean;
}

export interface ProfilesResponse {
  defaultProfile: string;
  profiles: RoutingProfile[];
}

export interface RouteLeg {
  kind: EdgeKind;
  name: string | null;
  lengthM: number;
}

export type Rating = 'great' | 'good' | 'fair' | 'poor';

export interface ScoreNote {
  tone: 'positive' | 'negative';
  text: string;
  metres: number;
  /** Score points this cause cost (negative notes). */
  points?: number;
}

export interface ActivityScore {
  score: number;
  rating: Rating;
  /** How much of the surface along the route is tagged rather than assumed. */
  confidence: 'high' | 'medium' | 'low';
  notes: ScoreNote[];
}

export interface RouteFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: LngLatTuple[] };
  properties: {
    profile: string;
    preferences: RoutePreferences;
    /** Metres still on surfaces the preferences avoid (there was no alternative). */
    avoidedSurfaceM: number;
    scores: { skate: ActivityScore; run: ActivityScore };
    distanceM: number;
    cost: number;
    legs: RouteLeg[];
    distanceByKind: Partial<Record<EdgeKind, number>>;
    distanceBySurface: Partial<Record<SurfaceClass, number>>;
    /** Metres whose surface was assumed (e.g. untagged streets) rather than tagged. */
    inferredSurfaceM: number;
    snap: {
      start: { point: LngLatTuple; distanceM: number };
      end: { point: LngLatTuple; distanceM: number };
    };
  };
}

export interface NetworkInfo {
  status: 'loading' | 'empty' | 'ready' | 'error';
  latestImport: { id: number; path_count: number; imported_at: string } | null;
  graph: { segments: number; nodes: number; edges: number; connectors: number; components: number } | null;
  error?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
