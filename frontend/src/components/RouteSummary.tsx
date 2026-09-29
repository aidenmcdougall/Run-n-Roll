import type { EdgeKind, RouteFeature, SurfaceClass, SurfacePreference } from '../api/types';
import { EDGE_KIND_STYLE, SURFACE_STYLE } from '../map/pathStyle';
import { ScoreCards } from './ScoreCards';

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

export function RouteSummary({
  route,
  onSurfaceChange,
}: {
  route: RouteFeature;
  onSurfaceChange?: (surface: SurfacePreference) => void;
}) {
  const { distanceM, distanceByKind, distanceBySurface, inferredSurfaceM, avoidedSurfaceM, preferences, snap } =
    route.properties;

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
      <h2>Route</h2>
      <div className="score-card distance-card">
        <div className="score-card-head">
          <span aria-hidden>📏</span> Distance
        </div>
        <div className="score-value">{formatDistance(distanceM)}</div>
        {kindRows[0] && (
          <div className="score-confidence">
            {kindRows[0].metres / distanceM >= 0.99 ? 'All' : 'Mostly'} {kindRows[0].label.toLowerCase()}
          </div>
        )}
      </div>
      <ScoreCards route={route} onSurfaceChange={onSurfaceChange} />
      {avoidedSurfaceM >= 10 && (
        <div className="alert">
          Includes {formatDistance(avoidedSurfaceM)} of{' '}
          {preferences.surface === 'smooth_only' ? 'rough or loose ground' : 'gravel or dirt'}: there was no reasonable way
          around it.
        </div>
      )}
      <Breakdown title="Path type" rows={kindRows} total={distanceM} />
      <Breakdown title="Surface" rows={surfaceRows} total={distanceM} />
      {inferredShare >= 0.05 && (
        <p className="hint small">
          {Math.round(inferredShare * 100)}% of the surface is assumed (untagged streets treated as sealed).
        </p>
      )}
      {(snap.start.distanceM > 25 || snap.end.distanceM > 25) && (
        <p className="hint">
          The route joins the path network {formatDistance(snap.start.distanceM)} from your start and{' '}
          {formatDistance(snap.end.distanceM)} from your destination
          {preferences.surface !== 'any' ? ', at the nearest path matching your surface preference' : ''}.
        </p>
      )}
    </div>
  );
}
