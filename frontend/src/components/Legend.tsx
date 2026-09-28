import { EDGE_KIND_STYLE, PATH_CATEGORIES } from '../map/pathStyle';

export function Legend() {
  return (
    <ul className="legend">
      {PATH_CATEGORIES.filter((kind) => kind !== 'unknown').map((kind) => (
        <li key={kind}>
          <span className="swatch" style={{ background: EDGE_KIND_STYLE[kind].color }} />
          {EDGE_KIND_STYLE[kind].label}
        </li>
      ))}
    </ul>
  );
}
