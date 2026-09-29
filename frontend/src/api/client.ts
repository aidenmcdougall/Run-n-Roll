import { apiUrl } from '../config';
import type {
  ApiErrorBody,
  LngLatPoint,
  NetworkInfo,
  Place,
  ProfilesResponse,
  RouteFeature,
  RoutePreferences,
} from './types';

/** An error returned by the API, carrying its machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the Run N Roll API. Is the backend running?');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export const api = {
  getNetwork: (): Promise<NetworkInfo> => request('/api/network'),
  getProfiles: (): Promise<ProfilesResponse> => request('/api/routes/profiles'),
  planRoute: (
    start: LngLatPoint,
    end: LngLatPoint,
    profile: string,
    preferences: RoutePreferences,
    signal?: AbortSignal,
  ): Promise<RouteFeature> =>
    request('/api/routes', { method: 'POST', body: JSON.stringify({ start, end, profile, preferences }), signal }),
  searchPlaces: async (query: string, near: LngLatPoint | null, signal?: AbortSignal): Promise<Place[]> => {
    const params = new URLSearchParams({ q: query });
    if (near) {
      params.set('lat', near.lat.toFixed(4));
      params.set('lng', near.lng.toFixed(4));
    }
    return (await request<{ places: Place[] }>(`/api/geocode/search?${params}`, { signal })).places;
  },
  reversePlace: async (point: LngLatPoint, signal?: AbortSignal): Promise<Place | null> => {
    const params = new URLSearchParams({ lat: point.lat.toFixed(5), lng: point.lng.toFixed(5) });
    return (await request<{ place: Place | null }>(`/api/geocode/reverse?${params}`, { signal })).place;
  },
  pathTilesUrl: (): string => apiUrl('/api/tiles/paths/{z}/{x}/{y}.pbf'),
};
