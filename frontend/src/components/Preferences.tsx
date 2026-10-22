import type { Activity, RoutePreferences, RoutingProfile, SurfacePreference } from '../api/types';

export const ACTIVITY_OPTIONS: { value: Activity; label: string; icon: string }[] = [
  { value: 'run', label: 'Run', icon: '🏃' },
  { value: 'skate', label: 'Skate', icon: '🛼' },
  { value: 'run_skate', label: 'Both', icon: '🏃🛼' },
];

const SURFACE_OPTIONS: { value: SurfacePreference; label: string; hint: string }[] = [
  { value: 'any', label: 'Any', hint: 'No extra surface preference beyond the activity.' },
  { value: 'avoid_loose', label: 'No gravel', hint: 'Avoids gravel, dirt and grass. Good for road bikes and runners.' },
  { value: 'smooth_only', label: 'Smooth', hint: 'Sticks to asphalt and concrete where it can. Best for skating.' },
];

interface PreferencesProps {
  /** Profiles from the API, for the selected activity's description. */
  profiles: RoutingProfile[];
  activity: Activity;
  onActivityChange: (activity: Activity) => void;
  preferences: RoutePreferences;
  onChange: (preferences: RoutePreferences) => void;
}

export function Preferences({ profiles, activity, onActivityChange, preferences, onChange }: PreferencesProps) {
  const selectedProfile = profiles.find((p) => p.id === activity);
  const surface = SURFACE_OPTIONS.find((o) => o.value === preferences.surface)!;
  const set = <K extends keyof RoutePreferences>(key: K, value: RoutePreferences[K]) => onChange({ ...preferences, [key]: value });

  return (
    <section className="preferences">
      <h2>Preferences</h2>

      <div className="field">
        <span>Activity</span>
        <div className="segmented segmented-full" role="radiogroup" aria-label="Activity">
          {ACTIVITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={activity === option.value}
              className={activity === option.value ? 'active' : ''}
              onClick={() => onActivityChange(option.value)}
            >
              <span aria-hidden>{option.icon}</span> {option.label}
            </button>
          ))}
        </div>
      </div>
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
