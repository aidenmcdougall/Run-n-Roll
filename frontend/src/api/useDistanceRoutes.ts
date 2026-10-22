import { useEffect, useState } from 'react';
import { ApiError, api } from './client';
import type { DistanceRouteFeature, LngLatPoint, RoutePreferences, RouteShape } from './types';

export type DistanceRoutesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; routes: DistanceRouteFeature[] }
  | { status: 'error'; message: string; code: string };

/** Waits this long after the last change before asking, so typing "10" doesn't plan a 1 km route first. */
const DEBOUNCE_MS = 350;

/**
 * Fetches routes of a target distance from `start` whenever the inputs
 * change (debounced); cancels stale requests.
 */
export function useDistanceRoutes(
  start: LngLatPoint | null,
  distanceM: number | null,
  shape: RouteShape,
  profile: string | null,
  preferences: RoutePreferences,
): DistanceRoutesState {
  const [state, setState] = useState<DistanceRoutesState>({ status: 'idle' });
  // Depend on the preference *values*, so a new-but-equal object doesn't refetch.
  const preferencesKey = JSON.stringify(preferences);

  useEffect(() => {
    if (!start || !distanceM || !profile) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    const timer = window.setTimeout(() => {
      api
        .planDistanceRoutes(start, distanceM, shape, profile, JSON.parse(preferencesKey) as RoutePreferences, controller.signal)
        .then(({ features }) => setState({ status: 'success', routes: features }))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError) setState({ status: 'error', message: error.message, code: error.code });
          else setState({ status: 'error', message: 'Failed to plan a route.', code: 'UNKNOWN' });
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [start, distanceM, shape, profile, preferencesKey]);

  return state;
}
