import { useEffect, useState } from 'react';
import { ApiError, api } from './client';
import type { LngLatPoint, RouteFeature } from './types';

export type RouteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; route: RouteFeature }
  | { status: 'error'; message: string; code: string };

/** Fetches a route whenever both waypoints and a profile are set; cancels stale requests. */
export function useRoute(start: LngLatPoint | null, end: LngLatPoint | null, profile: string | null): RouteState {
  const [state, setState] = useState<RouteState>({ status: 'idle' });

  useEffect(() => {
    if (!start || !end || !profile) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    api
      .planRoute(start, end, profile, controller.signal)
      .then((route) => setState({ status: 'success', route }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError) setState({ status: 'error', message: error.message, code: error.code });
        else setState({ status: 'error', message: 'Failed to plan route.', code: 'UNKNOWN' });
      });
    return () => controller.abort();
  }, [start, end, profile]);

  return state;
}
