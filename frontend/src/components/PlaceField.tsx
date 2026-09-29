import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, api } from '../api/client';
import type { LngLatPoint, Place } from '../api/types';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 3;

interface PlaceFieldProps {
  badge: 'A' | 'B';
  label: string;
  point: LngLatPoint | null;
  /** Human-readable name for `point` (from search or reverse geocoding). */
  placeName: string | null;
  /** Bias suggestions towards here (e.g. the other waypoint). */
  near: LngLatPoint | null;
  /** True while the next map click will set this waypoint. */
  picking: boolean;
  onSelect: (point: LngLatPoint, name: string) => void;
  onPickOnMap: () => void;
}

const formatPoint = (point: LngLatPoint): string => `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
/** Label for a chosen place; postcodes are dropped to keep it short (the list shows them). */
const placeLabel = (place: Place): string => {
  const detail = place.detail?.replace(/\s*\d{4}$/, '');
  return detail ? `${place.name}, ${detail}` : place.name;
};

/**
 * A waypoint row: shows the current point, and doubles as an address search
 * box with suggestions. Keyboard: ↑/↓ to move, Enter to choose, Esc to cancel.
 */
export function PlaceField({ badge, label, point, placeName, near, picking, onSelect, onPickOnMap }: PlaceFieldProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle');
  // Enter pressed before results arrived: take the top result when they do.
  const submitPending = useRef(false);

  const display = point ? (placeName ?? formatPoint(point)) : '';

  // Debounced search; stale requests are aborted as the user keeps typing.
  // (`choose` is stable enough for this: it only calls props and setters.)
  useEffect(() => {
    if (!editing || query.trim().length < MIN_QUERY_LENGTH) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus('searching');
      api
        .searchPlaces(query.trim(), near, controller.signal)
        .then((places) => {
          if (submitPending.current && places[0]) {
            submitPending.current = false;
            choose(places[0]);
            return;
          }
          setResults(places);
          setActive(0);
          setStatus('idle');
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setStatus(error instanceof ApiError ? 'error' : 'idle');
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, editing, near]);

  const close = () => {
    submitPending.current = false;
    setEditing(false);
    setQuery('');
    setResults([]);
  };

  const choose = (place: Place) => {
    onSelect({ lng: place.point[0], lat: place.point[1] }, placeLabel(place));
    close();
    inputRef.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results[active]) choose(results[active]);
      else if (query.trim().length >= MIN_QUERY_LENGTH) submitPending.current = true;
    } else if (event.key === 'Escape') {
      close();
      inputRef.current?.blur();
    }
  };

  const showList = editing && (results.length > 0 || status !== 'idle' || query.trim().length >= MIN_QUERY_LENGTH);

  return (
    <div className={`waypoint place-field${picking ? ' is-picking' : ''}`}>
      <span className={`waypoint-badge ${badge === 'A' ? 'waypoint-start' : 'waypoint-end'}`}>{badge}</span>
      <div className="place-field-body">
        <div className="waypoint-label">{label}</div>
        <input
          ref={inputRef}
          className="place-input"
          type="text"
          role="combobox"
          aria-label={`${label}: search for a place`}
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={picking ? 'Click the map to place this point…' : 'Search an address or click the map'}
          value={editing ? query : display}
          onFocus={(e) => {
            setEditing(true);
            setQuery('');
            e.currentTarget.select();
          }}
          onBlur={close}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {showList && (
          <ul className="place-results" id={listId} role="listbox">
            {status === 'error' && <li className="place-status">Address search is unavailable right now.</li>}
            {status !== 'error' && results.length === 0 && (
              <li className="place-status">{status === 'searching' ? 'Searching…' : 'No places found in Victoria.'}</li>
            )}
            {results.map((place, index) => (
              <li
                key={place.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : ''}
                // mousedown (not click) fires before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(place);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="place-name">{place.name}</span>
                {place.detail && <span className="place-detail">{place.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        className={`pick-button${picking ? ' active' : ''}`}
        onClick={onPickOnMap}
        title={picking ? 'Cancel choosing on the map' : `Choose ${label.toLowerCase()} on the map`}
        aria-label={picking ? 'Cancel choosing on the map' : `Choose ${label.toLowerCase()} on the map`}
        aria-pressed={picking}
      >
        ⌖
      </button>
    </div>
  );
}
