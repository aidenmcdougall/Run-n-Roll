import { useState } from 'react';
import type { ActivityScore, RouteFeature, SurfacePreference } from '../api/types';

const ACTIVITIES = [
  { key: 'skate', label: 'Skate', emoji: '🛼' },
  { key: 'run', label: 'Run', emoji: '🏃' },
] as const;

const RATING_LABEL: Record<ActivityScore['rating'], string> = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

const CONFIDENCE_HINT: Record<ActivityScore['confidence'], string> = {
  high: 'Surface known for most of the route',
  medium: 'Surface assumed or unknown for part of the route',
  low: 'Surface assumed or unknown for much of the route',
};

function ScoreCard({ label, emoji, score }: { label: string; emoji: string; score: ActivityScore }) {
  return (
    <div className={`score-card rating-${score.rating}`}>
      <div className="score-card-head">
        <span aria-hidden>{emoji}</span> {label}
      </div>
      <div className="score-value">
        {score.score}
        <span className="score-max">/100</span>
      </div>
      <div className="score-rating">{RATING_LABEL[score.rating]}</div>
      <div className={`score-confidence confidence-${score.confidence}`} title={CONFIDENCE_HINT[score.confidence]}>
        {score.confidence} confidence
      </div>
    </div>
  );
}

function NoteList({ score }: { score: ActivityScore }) {
  if (score.notes.length === 0) return <p className="hint small">Nothing notable: consistently good all the way.</p>;
  return (
    <ul className="score-notes">
      {score.notes.map((note) => (
        <li key={note.text} className={`note-${note.tone}`}>
          <span className="note-icon" aria-hidden>
            {note.tone === 'positive' ? '✓' : '−'}
          </span>
          <span className="note-text">{note.text}</span>
          {note.points !== undefined && <span className="note-points">−{Math.round(note.points)}</span>}
        </li>
      ))}
    </ul>
  );
}

const needsWalking = (score: ActivityScore): boolean => score.notes.some((n) => n.text.includes("you'd need to walk"));

/** Skate and run scores for the planned route, with the reasons behind them. */
export function ScoreCards({
  route,
  onSurfaceChange,
}: {
  route: RouteFeature;
  onSurfaceChange?: (surface: SurfacePreference) => void;
}) {
  const [open, setOpen] = useState<'skate' | 'run' | null>(null);
  const { scores, preferences } = route.properties;
  const suggestSmooth = onSurfaceChange && preferences.surface === 'any' && needsWalking(scores.skate);
  return (
    <div className="scores">
      <div className="score-cards">
        {ACTIVITIES.map((a) => (
          <button
            key={a.key}
            type="button"
            className="score-card-button"
            aria-expanded={open === a.key}
            onClick={() => setOpen(open === a.key ? null : a.key)}
          >
            <ScoreCard label={a.label} emoji={a.emoji} score={scores[a.key]} />
          </button>
        ))}
      </div>
      {suggestSmooth && (
        <div className="alert score-suggestion">
          <span>This route has stretches you'd have to walk on skates.</span>
          <button type="button" onClick={() => onSurfaceChange('smooth_only')}>
            Try Smooth surfaces
          </button>
        </div>
      )}
      {open ? (
        <div className="score-details">
          <div className="breakdown-title">Why this {open} score</div>
          <NoteList score={scores[open]} />
        </div>
      ) : (
        <p className="hint small">Tap a score to see what's behind it.</p>
      )}
    </div>
  );
}
