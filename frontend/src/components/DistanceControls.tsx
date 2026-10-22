import type { RouteShape } from '../api/types';

export const MIN_DISTANCE_KM = 0.5;
export const MAX_DISTANCE_KM = 50;
const QUICK_DISTANCES_KM = [3, 5, 10, 21.1];

const SHAPE_OPTIONS: { value: RouteShape; label: string; hint: string }[] = [
  { value: 'loop', label: 'Loop', hint: 'Finishes back where you started.' },
  { value: 'one_way', label: 'One way', hint: 'Finishes somewhere else, about that far along the paths.' },
];

/** The distance as a number of km, or null while the field holds something unusable. */
export function parseDistanceKm(text: string): number | null {
  const km = Number(text.replace(',', '.'));
  return Number.isFinite(km) && km >= MIN_DISTANCE_KM && km <= MAX_DISTANCE_KM ? km : null;
}

interface DistanceControlsProps {
  /** The field's text, kept as typed so partial input like "1." isn't rewritten. */
  distanceText: string;
  onDistanceTextChange: (text: string) => void;
  shape: RouteShape;
  onShapeChange: (shape: RouteShape) => void;
}

export function DistanceControls({ distanceText, onDistanceTextChange, shape, onShapeChange }: DistanceControlsProps) {
  const valid = parseDistanceKm(distanceText) !== null;
  const hint = SHAPE_OPTIONS.find((o) => o.value === shape)!.hint;

  return (
    <div className="distance-controls">
      <div className="field">
        <label htmlFor="distance-km">Distance</label>
        <div className="distance-row">
          <div className={`distance-input${valid ? '' : ' invalid'}`}>
            <input
              id="distance-km"
              type="number"
              inputMode="decimal"
              min={MIN_DISTANCE_KM}
              max={MAX_DISTANCE_KM}
              step={0.5}
              value={distanceText}
              onChange={(e) => onDistanceTextChange(e.target.value)}
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : 'distance-error'}
            />
            <span aria-hidden>km</span>
          </div>
          <div className="button-row" role="group" aria-label="Common distances">
            {QUICK_DISTANCES_KM.map((km) => (
              <button
                key={km}
                type="button"
                className={`chip${parseDistanceKm(distanceText) === km ? ' active' : ''}`}
                onClick={() => onDistanceTextChange(String(km))}
              >
                {km === 21.1 ? 'Half' : `${km}k`}
              </button>
            ))}
          </div>
        </div>
        {!valid && (
          <span id="distance-error" className="field-error">
            Enter a distance from {MIN_DISTANCE_KM} to {MAX_DISTANCE_KM} km.
          </span>
        )}
      </div>

      <div className="field">
        <span>Shape</span>
        <div className="segmented segmented-full" role="radiogroup" aria-label="Route shape">
          {SHAPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={shape === option.value}
              className={shape === option.value ? 'active' : ''}
              onClick={() => onShapeChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint small">{hint}</p>
    </div>
  );
}
