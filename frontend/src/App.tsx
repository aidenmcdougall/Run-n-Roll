import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import type { LngLatPoint, NetworkInfo, Place, RoutingProfile } from './api/types';
import { useRoute } from './api/useRoute';
import { Legend } from './components/Legend';
import { PlaceField } from './components/PlaceField';
import { Preferences } from './components/Preferences';
import { RouteSummary } from './components/RouteSummary';
import { MapView, type FocusRequest, type HoveredPath, type Waypoint } from './map/MapView';
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

/** Short label for a reverse-geocoded pin, e.g. "Near Barassi Way, Jolimont". */
function nearLabel(place: Place): string {
  const suburb = place.detail?.split(', ').pop()?.replace(/\s*\d{4}$/, '');
  return `Near ${place.name}${suburb && suburb !== place.name ? `, ${suburb}` : ''}`;
}

export default function App() {
  const [start, setStart] = useState<LngLatPoint | null>(null);
  const [end, setEnd] = useState<LngLatPoint | null>(null);
  const [startName, setStartName] = useState<string | null>(null);
  const [endName, setEndName] = useState<string | null>(null);
  // While set, the next map click places this waypoint.
  const [picking, setPicking] = useState<Waypoint | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  // Guards against a slow reverse lookup labelling a pin that has since moved.
  const labelRequest = useRef<Record<Waypoint, number>>({ start: 0, end: 0 });
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

  /**
   * Sets a waypoint. Without a name (map click, drag, geolocation), it's
   * labelled by reverse geocoding; until that returns, coordinates show.
   */
  const placeWaypoint = useCallback((which: Waypoint, point: LngLatPoint | null, name: string | null = null) => {
    (which === 'start' ? setStart : setEnd)(point);
    const setName = which === 'start' ? setStartName : setEndName;
    setName(name);
    const request = ++labelRequest.current[which];
    if (!point || name) return;
    api
      .reversePlace(point)
      .then((place) => {
        if (place && labelRequest.current[which] === request) setName(nearLabel(place));
      })
      .catch(() => undefined); // coordinates remain as the label
  }, []);

  // A pending "choose on map" wins; otherwise the first click sets the start
  // and later clicks set (or move) the destination.
  const handleMapClick = useCallback(
    (point: LngLatPoint) => {
      const which: Waypoint = picking ?? (start ? 'end' : 'start');
      placeWaypoint(which, point);
      setPicking(null);
    },
    [picking, start, placeWaypoint],
  );

  const handleWaypointMoved = useCallback(
    (which: Waypoint, point: LngLatPoint) => placeWaypoint(which, point),
    [placeWaypoint],
  );

  /** A search result was chosen: set it and bring it (and the other point) into view. */
  const handlePlaceSelected = (which: Waypoint, point: LngLatPoint, name: string) => {
    placeWaypoint(which, point, name);
    setPicking(null);
    const other = which === 'start' ? end : start;
    setFocus({ points: other ? [point, other] : [point], id: Date.now() });
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const point = { lng: coords.longitude, lat: coords.latitude };
        placeWaypoint('start', point);
        setFocus({ points: end ? [point, end] : [point], id: Date.now() });
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
        picking={picking !== null}
        focus={focus}
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
          <PlaceField
            badge="A"
            label="Start"
            point={start}
            placeName={startName}
            near={end}
            picking={picking === 'start'}
            onSelect={(point, name) => handlePlaceSelected('start', point, name)}
            onPickOnMap={() => setPicking(picking === 'start' ? null : 'start')}
          />
          <PlaceField
            badge="B"
            label="Destination"
            point={end}
            placeName={endName}
            near={start}
            picking={picking === 'end'}
            onSelect={(point, name) => handlePlaceSelected('end', point, name)}
            onPickOnMap={() => setPicking(picking === 'end' ? null : 'end')}
          />
          <div className="button-row">
            <button type="button" onClick={useMyLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Start from my location'}
            </button>
            <button
              type="button"
              onClick={() => {
                setStart(end);
                setEnd(start);
                setStartName(endName);
                setEndName(startName);
              }}
              disabled={!start || !end}
            >
              Swap
            </button>
            <button
              type="button"
              onClick={() => {
                placeWaypoint('start', null);
                placeWaypoint('end', null);
                setPicking(null);
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
