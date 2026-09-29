import type { RoutePreferences, RoutingProfile, SurfacePreference } from '../api/types';

const SURFACE_OPTIONS: { value: SurfacePreference; label: string; hint: string }[] = [
  { value: 'any', label: 'Any', hint: 'No surface preference beyond the route style.' },
  { value: 'avoid_loose', label: 'No gravel', hint: 'Avoids gravel, dirt and grass. Good for road bikes and runners.' },
  { value: 'smooth_only', label: 'Smooth', hint: 'Sticks to asphalt and concrete where it can. Best for skating.' },
];

interface PreferencesProps {
  profiles: RoutingProfile[];
  profileId: string | null;
  onProfileChange: (id: string) => void;
  preferences: RoutePreferences;
  onChange: (preferences: RoutePreferences) => void;
}

export function Preferences({ profiles, profileId, onProfileChange, preferences, onChange }: PreferencesProps) {
  const selectedProfile = profiles.find((p) => p.id === profileId);
  const surface = SURFACE_OPTIONS.find((o) => o.value === preferences.surface)!;
  const set = <K extends keyof RoutePreferences>(key: K, value: RoutePreferences[K]) => onChange({ ...preferences, [key]: value });

  return (
    <section className="preferences">
      <h2>Preferences</h2>

      <label className="field">
        <span>Route style</span>
        <select value={profileId ?? ''} onChange={(e) => onProfileChange(e.target.value)} disabled={!profiles.length}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {selectedProfile && <p className="hint small">{selectedProfile.description}</p>}

      <div className="field">
        <span>Surface</span>
        <div className="segmented segmented-full" role="radiogroup" aria-label="Surface preference">
          {SURFACE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={preferences.surface === option.value}
              className={preferences.surface === option.value ? 'active' : ''}
              onClick={() => set('surface', option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint small">{surface.hint}</p>

      <div className="checkbox-row">
        <label>
          <input type="checkbox" checked={preferences.avoidSteps} onChange={(e) => set('avoidSteps', e.target.checked)} />
          Avoid steps
        </label>
        <label>
          <input
            type="checkbox"
            checked={preferences.avoidBusyRoads}
            onChange={(e) => set('avoidBusyRoads', e.target.checked)}
          />
          Avoid busy roads
        </label>
      </div>
    </section>
  );
}
