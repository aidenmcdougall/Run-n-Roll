import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import type { Activity, DistanceRouteFeature, LngLatPoint, NetworkInfo, Place, RouteShape, RoutingProfile } from './api/types';
import { useDistanceRoutes } from './api/useDistanceRoutes';
import { useRoute } from './api/useRoute';
import { DistanceControls, parseDistanceKm } from './components/DistanceControls';
import { Legend } from './components/Legend';
import { PlaceField } from './components/PlaceField';
import { Preferences } from './components/Preferences';
import { formatDistance, RouteSummary } from './components/RouteSummary';
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

/** Plan a route of a target distance from a start, or between two points. */
type PlanMode = 'distance' | 'a_to_b';

interface PlanSettings {
  mode: PlanMode;
  activity: Activity;
  /** As typed in the distance field, in km. */
  distanceText: string;
  shape: RouteShape;
}

const DEFAULT_PLAN: PlanSettings = { mode: 'distance', activity: 'run_skate', distanceText: '5', shape: 'loop' };
const PLAN_STORAGE_KEY = 'runnroll.plan';

/** Restores saved plan settings, falling back per field when storage is unavailable or stale. */
function loadPlan(): PlanSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAN_STORAGE_KEY) ?? 'null') as Partial<PlanSettings> | null;
    if (!saved) return DEFAULT_PLAN;
    const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
      options.includes(value as T) ? (value as T) : fallback;
    return {
      mode: oneOf(saved.mode, ['distance', 'a_to_b'], DEFAULT_PLAN.mode),
      activity: oneOf(saved.activity, ['run', 'skate', 'run_skate'], DEFAULT_PLAN.activity),
      distanceText: typeof saved.distanceText === 'string' ? saved.distanceText : DEFAULT_PLAN.distanceText,
      shape: oneOf(saved.shape, ['loop', 'one_way'], DEFAULT_PLAN.shape),
    };
  } catch {
    return DEFAULT_PLAN;
  }
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compassName = (bearingDeg: number): string => COMPASS[Math.round(bearingDeg / 45) % 8]!;

const toPoint = ([lng, lat]: readonly [number, number]): LngLatPoint => ({ lng, lat });

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
  const [plan, setPlan] = useState<PlanSettings>(loadPlan);
  const updatePlan = (changes: Partial<PlanSettings>) => setPlan((current) => ({ ...current, ...changes }));
  const { mode, activity, shape } = plan;
  const distanceKm = parseDistanceKm(plan.distanceText);
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

  useEffect(() => {
    try {
      localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plan));
    } catch {
      // Storage unavailable: settings just won't persist.
    }
  }, [plan]);

  // Only the active mode plans anything.
  const routeState = useRoute(mode === 'a_to_b' ? start : null, end, activity, preferences);
  const distanceState = useDistanceRoutes(
    mode === 'distance' ? start : null,
    distanceKm === null ? null : distanceKm * 1000,
    shape,
    activity,
    preferences,
  );
  const distanceRoutes = distanceState.status === 'success' ? distanceState.routes : [];
  // The chosen alternative belongs to one set of results; new results start at the best.
  const [picked, setPicked] = useState<{ routes: DistanceRouteFeature[] | null; index: number }>({ routes: null, index: 0 });
  const routeIndex = picked.routes === distanceRoutes ? picked.index : 0;
  const stepRoute = (step: number) =>
    setPicked({ routes: distanceRoutes, index: (routeIndex + step + distanceRoutes.length) % distanceRoutes.length });
  const distanceRoute: DistanceRouteFeature | null = distanceRoutes[routeIndex] ?? null;
  const mapRoute = mode === 'distance' ? distanceRoute : routeState.status === 'success' ? routeState.route : null;
  // A one-way route's finish is wherever it ends up; mark it, but it isn't draggable.
  const finish =
    distanceRoute && distanceRoute.properties.target.shape === 'one_way'
      ? toPoint(distanceRoute.geometry.coordinates[distanceRoute.geometry.coordinates.length - 1]!)
      : null;

  // Bring each new distance route into view: it can head well off screen.
  useEffect(() => {
    if (distanceRoute) setFocus({ points: distanceRoute.geometry.coordinates.map(toPoint), id: Date.now() });
  }, [distanceRoute]);

  useEffect(() => {
    api
      .getProfiles()
      .then(({ profiles: list }) => setProfiles(list))
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

  // A pending "choose on map" wins. Otherwise, planning by distance, a click
  // moves the start; planning A → B, the first click sets the start and later
  // clicks set (or move) the destination.
  const handleMapClick = useCallback(
    (point: LngLatPoint) => {
      const which: Waypoint = picking ?? (mode === 'distance' || !start ? 'start' : 'end');
      placeWaypoint(which, point);
      setPicking(null);
    },
    [picking, mode, start, placeWaypoint],
  );

  const handleWaypointMoved = useCallback(
    (which: Waypoint, point: LngLatPoint) => placeWaypoint(which, point),
    [placeWaypoint],
  );

  /** A search result was chosen: set it and bring it (and the other point) into view. */
  const handlePlaceSelected = (which: Waypoint, point: LngLatPoint, name: string) => {
    placeWaypoint(which, point, name);
    setPicking(null);
    const other = mode === 'distance' ? null : which === 'start' ? end : start;
    setFocus({ points: other ? [point, other] : [point], id: Date.now() });
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const point = { lng: coords.longitude, lat: coords.latitude };
        placeWaypoint('start', point);
        setFocus({ points: end && mode === 'a_to_b' ? [point, end] : [point], id: Date.now() });
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
        end={mode === 'distance' ? finish : end}
        endDraggable={mode === 'a_to_b'}
        route={mapRoute}
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
          <div className="segmented segmented-full" role="radiogroup" aria-label="How to plan">
            {(
              [
                ['distance', 'Distance'],
                ['a_to_b', 'A → B'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                className={mode === value ? 'active' : ''}
                onClick={() => {
                  updatePlan({ mode: value });
                  setPicking(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <PlaceField
            badge="A"
            label="Start"
            point={start}
            placeName={startName}
            near={mode === 'a_to_b' ? end : null}
            picking={picking === 'start'}
            onSelect={(point, name) => handlePlaceSelected('start', point, name)}
            onPickOnMap={() => setPicking(picking === 'start' ? null : 'start')}
          />
          {mode === 'a_to_b' ? (
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
          ) : (
            <DistanceControls
              distanceText={plan.distanceText}
              onDistanceTextChange={(distanceText) => updatePlan({ distanceText })}
              shape={shape}
              onShapeChange={(value) => updatePlan({ shape: value })}
            />
          )}
          <div className="button-row">
            <button type="button" onClick={useMyLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Start from my location'}
            </button>
            {mode === 'a_to_b' && (
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
            )}
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
          activity={activity}
          onActivityChange={(value) => updatePlan({ activity: value })}
          preferences={preferences}
          onChange={setPreferences}
        />

        <section aria-live="polite">
          {mode === 'distance' ? (
            <>
              {distanceState.status === 'loading' && <p className="hint">Finding routes…</p>}
              {distanceState.status === 'error' && <div className="alert alert-error">{distanceState.message}</div>}
              {distanceRoute && (
                <>
                  {distanceRoutes.length > 1 && (
                    <div className="alternatives">
                      <button
                        type="button"
                        aria-label="Previous route"
                        onClick={() => stepRoute(-1)}
                      >
                        ‹
                      </button>
                      <span>
                        Option {routeIndex + 1} of {distanceRoutes.length} · heads{' '}
                        {compassName(distanceRoute.properties.target.bearingDeg)}
                      </span>
                      <button
                        type="button"
                        aria-label="Next route"
                        onClick={() => stepRoute(1)}
                      >
                        ›
                      </button>
                    </div>
                  )}
                  {Math.abs(distanceRoute.properties.target.distanceError) > 0.05 && (
                    <p className="hint small">
                      The closest to {formatDistance(distanceRoute.properties.target.distanceM)} the paths here allow.
                    </p>
                  )}
                  <RouteSummary
                    route={distanceRoute}
                    onSurfaceChange={(surface) => setPreferences((current) => ({ ...current, surface }))}
                  />
                </>
              )}
              {distanceState.status === 'idle' && (
                <p className="hint">
                  {start
                    ? 'Enter a distance to plan a route.'
                    : 'Set a start: search for a place, click the map, or use your location.'}
                </p>
              )}
            </>
          ) : (
            <>
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
              {routeState.status === 'success' && (
                <RouteSummary
                  route={routeState.route}
                  onSurfaceChange={(surface) => setPreferences((current) => ({ ...current, surface }))}
                />
              )}
              {routeState.status === 'idle' && <p className="hint">Tip: drag the A/B markers to adjust the route.</p>}
            </>
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
