/** Runtime configuration from Vite env vars (see the repo-root .env.example). */
export const config = {
  /**
   * API origin. Empty in development: requests go to the Vite dev server,
   * which proxies /api to the backend (see vite.config.ts).
   */
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
  mapStyleUrl:
    (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ||
    'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  /** Melbourne CBD. */
  initialCenter: [144.9631, -37.8136] as [number, number],
  initialZoom: 12,
  /** Keep the camera around Victoria, where the data is. */
  maxBounds: [
    [139.5, -40.0],
    [151.5, -33.0],
  ] as [[number, number], [number, number]],
} as const;

/**
 * Absolute URL for an API path (MapLibre tile URLs must be absolute).
 * Built by string concatenation rather than `new URL()`, which would
 * percent-encode tile template placeholders like `{z}`.
 */
export function apiUrl(path: string): string {
  const base = config.apiBaseUrl || window.location.origin;
  return `${base.replace(/\/$/, '')}${path}`;
}
