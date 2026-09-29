import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import type { LngLatPoint, NetworkInfo, RoutingProfile } from './api/types';
import { useRoute } from './api/useRoute';
import { Legend } from './components/Legend';
import { Preferences } from './components/Preferences';
import { RouteSummary } from './components/RouteSummary';
import { MapView, type HoveredPath, type Waypoint } from './map/MapView';
import { EDGE_KIND_STYLE, SURFACE_STYLE, type ColorMode } from './map/pathStyle';
import type { EdgeKind, RoutePreferences, SurfaceClass } from './api/types';

const kindLabel = (kind: string): string => EDGE_KIND_STYLE[kind as EdgeKind]?.label ?? kind;
const surfaceLabel = (surface: string): string => SURFACE_STYLE[surface as SurfaceClass]?.label ?? surface;

/** One-line description of a hovered path's ground, e.g. "asphalt · smooth (good)". */
function describeSurface(path: HoveredPath): string {
  if (path.surface) return `${path.surface.replaceAll('_', ' ')}${path.smoothness ? ` · ${path.smoothness} smoothness` : ''}`;
  if (path.surfaceInferred) return 'not tagged (assumed sealed)';
  return 'unknown';
}

const DEFAULT_PREFERENCES: RoutePreferences = { surface: 'any', avoidSteps: false, avoidBusyRoads: false };
const PREFERENCES_STORAGE_KEY = 'runnroll.preferences';

/** Restores saved preferences; storage may be unavailable (private mode) or hold stale data. */
function loadPreferences(): RoutePreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? 'null') as Partial<RoutePreferences> | null;
    if (!saved) return DEFAULT_PREFERENCES;
    return {
      surface: ['any', 'avoid_loose', 'smooth_only'].includes(saved.surface as string)
        ? (saved.surface as RoutePreferences['surface'])
        : DEFAULT_PREFERENCES.surface,
      avoidSteps: saved.avoidSteps === true,
      avoidBusyRoads: saved.avoidBusyRoads === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function formatPoint(point: LngLatPoint | null): string {
  return point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : '—';
}

export default function App() {
  const [start, setStart] = useState<LngLatPoint | null>(null);
  const [end, setEnd] = useState<LngLatPoint | null>(null);
  const [profiles, setProfiles] = useState<RoutingProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<HoveredPath | null>(null);
  const [locating, setLocating] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [preferences, setPreferences] = useState<RoutePreferences>(loadPreferences);

  useEffect(() => {
    try {
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Storage unavailable: preferences just won't persist.
    }
  }, [preferences]);

  const routeState = useRoute(start, end, profileId, preferences);

  useEffect(() => {
    api
      .getProfiles()
      .then(({ profiles: list, defaultProfile }) => {
        setProfiles(list);
        setProfileId(defaultProfile);
      })
      .catch((error: Error) => setApiError(error.message));
  }, []);

  // Poll network status until the backend has finished building the graph.
  useEffect(() => {
    let timer: number | undefined;
    const poll = () => {
      api
        .getNetwork()
        .then((info) => {
          setNetwork(info);
          if (info.status === 'loading') timer = window.setTimeout(poll, 2000);
        })
        .catch((error: Error) => setApiError(error.message));
    };
    poll();
    return () => window.clearTimeout(timer);
  }, []);

  // First click sets the start, subsequent clicks set (or move) the destination.
  const handleMapClick = useCallback(
    (point: LngLatPoint) => {
      if (!start) setStart(point);
      else setEnd(point);
    },
    [start],
  );

  const handleWaypointMoved = useCallback((which: Waypoint, point: LngLatPoint) => {
    (which === 'start' ? setStart : setEnd)(point);
  }, []);

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setStart({ lng: coords.longitude, lat: coords.latitude });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };


  return (
    <div className="app">
      <MapView
        colorMode={colorMode}
        start={start}
        end={end}
        route={routeState.status === 'success' ? routeState.route : null}
        onMapClick={handleMapClick}
        onWaypointMoved={handleWaypointMoved}
        onHoverPath={setHovered}
      />

      <aside className="panel">
        <header>
          <h1>
            Run N Roll <span aria-hidden>🏃🛼</span>
          </h1>
          <p className="tagline">Routes across Victoria that suit how you move.</p>
        </header>

        {apiError && <div className="alert alert-error">{apiError}</div>}
        {network?.status === 'empty' && (
          <div className="alert">No path data imported yet. Run <code>npm run data:import</code>.</div>
        )}
        {network?.status === 'loading' && <div className="alert">Building the routing network…</div>}

        <section>
          <div className="waypoint">
            <span className="waypoint-badge waypoint-start">A</span>
            <div>
              <div className="waypoint-label">Start</div>
              <div className="waypoint-value">{start ? formatPoint(start) : 'Click the map to set'}</div>
            </div>
          </div>
          <div className="waypoint">
            <span className="waypoint-badge waypoint-end">B</span>
            <div>
              <div className="waypoint-label">Destination</div>
              <div className="waypoint-value">
                {end ? formatPoint(end) : start ? 'Click the map to set' : '—'}
              </div>
            </div>
          </div>
          <div className="button-row">
            <button type="button" onClick={useMyLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Start from my location'}
            </button>
            <button
              type="button"
              onClick={() => {
                setStart(end);
                setEnd(start);
              }}
              disabled={!start || !end}
            >
              Swap
            </button>
            <button
              type="button"
              onClick={() => {
                setStart(null);
                setEnd(null);
              }}
              disabled={!start && !end}
            >
              Clear
            </button>
          </div>
        </section>

        <Preferences
          profiles={profiles}
          profileId={profileId}
          onProfileChange={setProfileId}
          preferences={preferences}
          onChange={setPreferences}
        />

        <section aria-live="polite">
          {routeState.status === 'loading' && <p className="hint">Finding a route…</p>}
          {routeState.status === 'error' && (
            <div className="alert alert-error">
              {routeState.message}
              {routeState.code === 'NO_ROUTE' && (
                <p className="alert-hint">
                  The bicycle network has gaps between some paths. Try points on longer connected routes, like the
                  Capital City Trail or Bay Trail.
                </p>
              )}
            </div>
          )}
          {routeState.status === 'success' && <RouteSummary
              route={routeState.route}
              onSurfaceChange={(surface) => setPreferences((current) => ({ ...current, surface }))}
            />}
          {routeState.status === 'idle' && (
            <p className="hint">Tip: drag the A/B markers to adjust the route.</p>
          )}
        </section>

        <section>
          <div className="section-header">
            <h2>Path network</h2>
            <div className="segmented" role="group" aria-label="Colour paths by">
              {(['type', 'surface'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={colorMode === mode ? 'active' : ''}
                  aria-pressed={colorMode === mode}
                  onClick={() => setColorMode(mode)}
                >
                  {mode === 'type' ? 'Path type' : 'Surface'}
                </button>
              ))}
            </div>
          </div>
          <Legend mode={colorMode} />
          <div className="hover-info">
            {hovered ? (
              <>
                <strong>{hovered.name ?? 'Unnamed path'}</strong>
                <div>
                  {kindLabel(hovered.infraCategory)}
                  {hovered.highwayType ? ` · ${hovered.highwayType.replaceAll('_', ' ')}` : ''}
                  {hovered.widthM ? ` · ${hovered.widthM} m wide` : ''}
                </div>
                <div>
                  Surface: {describeSurface(hovered)}
                  {hovered.surfaceClass && hovered.surface ? ` (${surfaceLabel(hovered.surfaceClass).toLowerCase()})` : ''}
                </div>
                {hovered.hazards && <div>⚠ {hovered.hazards.replaceAll('_', ' ').replaceAll(',', ', ')}</div>}
                <div className="hint small">
                  Source: {hovered.source === 'osm' ? 'OpenStreetMap' : 'DTP Bicycle Infrastructure Network'}
                </div>
              </>
            ) : (
              <span className="hint">Hover a path to inspect it.</span>
            )}
          </div>
          {network?.graph && (
            <p className="hint small">
              {network.graph.segments.toLocaleString()} segments · {network.graph.nodes.toLocaleString()} junctions
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
