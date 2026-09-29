import type { EdgeKind } from '../api/types';
import { BIKE_CATEGORIES, EDGE_KIND_STYLE, OSM_CATEGORIES, SURFACE_CLASSES, SURFACE_STYLE, type ColorMode } from '../map/pathStyle';

function KindList({ kinds }: { kinds: EdgeKind[] }) {
  return (
    <ul className="legend">
      {kinds.map((kind) => (
        <li key={kind}>
          <span className="swatch" style={{ background: EDGE_KIND_STYLE[kind].color }} />
          {EDGE_KIND_STYLE[kind].label}
        </li>
      ))}
    </ul>
  );
}

export function Legend({ mode }: { mode: ColorMode }) {
  if (mode === 'surface') {
    return (
      <>
        <ul className="legend legend-single">
          {SURFACE_CLASSES.map((surface) => (
            <li key={surface}>
              <span className="swatch" style={{ background: SURFACE_STYLE[surface].color }} />
              {SURFACE_STYLE[surface].label}
            </li>
          ))}
        </ul>
        <p className="hint small">Faded lines have no surface tag: untagged streets are assumed sealed.</p>
      </>
    );
  }
  return (
    <>
      <div className="legend-group">Bike infrastructure (DTP)</div>
      <KindList kinds={BIKE_CATEGORIES} />
      <div className="legend-group">Other paths and streets (OpenStreetMap, from zoom 14)</div>
      <KindList kinds={OSM_CATEGORIES} />
    </>
  );
}
