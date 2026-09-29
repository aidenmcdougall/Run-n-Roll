import type { EdgeKind, RouteFeature, SurfaceClass } from '../api/types';
import { EDGE_KIND_STYLE, SURFACE_STYLE } from '../map/pathStyle';

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}

interface Row {
  key: string;
  label: string;
  color: string;
  metres: number;
}

/** A proportional bar plus a list, for one way of slicing the route. */
function Breakdown({ title, rows, total }: { title: string; rows: Row[]; total: number }) {
  return (
    <div className="breakdown">
      <div className="breakdown-title">{title}</div>
      <div className="breakdown-bar" aria-hidden>
        {rows.map((row) => (
          <span key={row.key} style={{ width: `${(row.metres / total) * 100}%`, background: row.color }} title={row.label} />
        ))}
      </div>
      <ul className="breakdown-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span className="swatch" style={{ background: row.color }} />
            <span className="breakdown-label">{row.label}</span>
            <span className="breakdown-value">
              {formatDistance(row.metres)} · {Math.round((row.metres / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const byLength = (a: Row, b: Row): number => b.metres - a.metres;

export function RouteSummary({ route }: { route: RouteFeature }) {
  const { distanceM, distanceByKind, distanceBySurface, inferredSurfaceM, snap } = route.properties;

  const kindRows = (Object.entries(distanceByKind) as [EdgeKind, number][])
    .map(([kind, metres]) => ({ key: kind, label: EDGE_KIND_STYLE[kind].label, color: EDGE_KIND_STYLE[kind].color, metres }))
    .sort(byLength);
  const surfaceRows = (Object.entries(distanceBySurface) as [SurfaceClass, number][])
    .map(([surface, metres]) => ({
      key: surface,
      label: SURFACE_STYLE[surface].label,
      color: SURFACE_STYLE[surface].color,
      metres,
    }))
    .sort(byLength);
  const inferredShare = distanceM > 0 ? inferredSurfaceM / distanceM : 0;

  return (
    <div className="route-summary">
      <div className="route-distance">{formatDistance(distanceM)}</div>
      <Breakdown title="Path type" rows={kindRows} total={distanceM} />
      <Breakdown title="Surface" rows={surfaceRows} total={distanceM} />
      {inferredShare >= 0.05 && (
        <p className="hint small">
          {Math.round(inferredShare * 100)}% of the surface is assumed (untagged streets treated as sealed).
        </p>
      )}
      {(snap.start.distanceM > 25 || snap.end.distanceM > 25) && (
        <p className="hint">
          Snapped to the nearest path: start {formatDistance(snap.start.distanceM)} away, end{' '}
          {formatDistance(snap.end.distanceM)} away.
        </p>
      )}
    </div>
  );
}
