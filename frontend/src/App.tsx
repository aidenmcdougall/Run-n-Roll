import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import type { LngLatPoint, NetworkInfo, RoutingProfile } from './api/types';
import { useRoute } from './api/useRoute';
import { Legend } from './components/Legend';
import { RouteSummary } from './components/RouteSummary';
import { MapView, type HoveredPath, type Waypoint } from './map/MapView';

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

  const routeState = useRoute(start, end, profileId);

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

  const selectedProfile = profiles.find((p) => p.id === profileId);

  return (
    <div className="app">
      <MapView
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

        <section>
          <label className="field">
            <span>Routing preference</span>
            <select value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value)} disabled={!profiles.length}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {selectedProfile && <p className="hint">{selectedProfile.description}</p>}
        </section>

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
          {routeState.status === 'success' && <RouteSummary route={routeState.route} />}
          {routeState.status === 'idle' && (
            <p className="hint">Tip: drag the A/B markers to adjust the route.</p>
          )}
        </section>

        <section>
          <h2>Path network</h2>
          <Legend />
          <div className="hover-info">
            {hovered ? (
              <>
                <strong>{hovered.name ?? 'Unnamed path'}</strong>
                <div>
                  {hovered.infraType}
                  {hovered.highwayType ? ` · ${hovered.highwayType}` : ''}
                  {hovered.widthM ? ` · ${hovered.widthM} m wide` : ''}
                  {hovered.hazards ? ` · ⚠ ${hovered.hazards.replaceAll('_', ' ')}` : ''}
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
