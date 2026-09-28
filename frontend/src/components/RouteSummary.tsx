import type { EdgeKind, RouteFeature } from '../api/types';
import { EDGE_KIND_STYLE } from '../map/pathStyle';

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}

export function RouteSummary({ route }: { route: RouteFeature }) {
  const { distanceM, distanceByKind, snap } = route.properties;
  const breakdown = (Object.entries(distanceByKind) as [EdgeKind, number][]).sort((a, b) => b[1] - a[1]);

  return (
    <div className="route-summary">
      <div className="route-distance">{formatDistance(distanceM)}</div>

      {/* Proportional bar showing how the route splits across path types. */}
      <div className="breakdown-bar" aria-hidden>
        {breakdown.map(([kind, metres]) => (
          <span
            key={kind}
            style={{ width: `${(metres / distanceM) * 100}%`, background: EDGE_KIND_STYLE[kind].color }}
            title={EDGE_KIND_STYLE[kind].label}
          />
        ))}
      </div>
      <ul className="breakdown-list">
        {breakdown.map(([kind, metres]) => (
          <li key={kind}>
            <span className="swatch" style={{ background: EDGE_KIND_STYLE[kind].color }} />
            <span className="breakdown-label">{EDGE_KIND_STYLE[kind].label}</span>
            <span className="breakdown-value">
              {formatDistance(metres)} · {Math.round((metres / distanceM) * 100)}%
            </span>
          </li>
        ))}
      </ul>

      {(snap.start.distanceM > 25 || snap.end.distanceM > 25) && (
        <p className="hint">
          Snapped to the nearest path: start {formatDistance(snap.start.distanceM)} away, end{' '}
          {formatDistance(snap.end.distanceM)} away.
        </p>
      )}
    </div>
  );
}
