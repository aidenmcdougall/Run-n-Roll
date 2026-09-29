import type { LngLat } from '../routing/geo.js';
import { VICTORIA_BOUNDS } from '../domain/region.js';

/** A searchable place: an address, street, park, landmark… */
export interface Place {
  /** Stable id from the provider, e.g. "osm:N:706916776". */
  id: string;
  /** Primary label, e.g. "Albert Park Lake" or "12 Smith Street". */
  name: string;
  /** Secondary context, e.g. "Albert Park 3206". */
  detail: string | null;
  point: LngLat;
  /** Provider category, e.g. "natural=beach", for icons or ranking later. */
  category: string;
}

export interface Geocoder {
  /** Forward search, optionally biased towards a point (e.g. the map centre). */
  search(query: string, options?: { near?: LngLat }): Promise<Place[]>;
  /** The nearest street to a point, for labelling dropped pins. */
  reverse(point: LngLat): Promise<Place | null>;
}

/** The geocoding provider failed or timed out. */
export class GeocoderError extends Error {
  override name = 'GeocoderError';
}

interface PhotonProperties {
  osm_type?: string;
  osm_id?: number;
  osm_key?: string;
  osm_value?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  postcode?: string;
  state?: string;
}

export interface PhotonFeature {
  properties: PhotonProperties;
  geometry: { type: string; coordinates: [number, number] };
}

/**
 * Converts a Photon feature to a Place, or null if it's outside Victoria.
 * (Photon's bbox filter isn't enough on its own: Victoria's bounding
 * rectangle also covers part of southern NSW.)
 */
export function placeFromPhoton(feature: PhotonFeature): Place | null {
  const p = feature.properties;
  if (p.state !== 'Victoria') return null;
  const [lng, lat] = feature.geometry.coordinates;
  const address = p.street ? [p.housenumber, p.street].filter(Boolean).join(' ') : null;
  const suburb = p.locality ?? p.district ?? p.city ?? null;
  const name = p.name ?? address ?? suburb;
  if (!name || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const detailParts = [
    p.name && address ? address : null, // a named place: show its address
    suburb && suburb !== name ? suburb : null,
  ].filter(Boolean);
  const detail = [detailParts.join(', '), p.postcode].filter(Boolean).join(' ') || null;

  return {
    id: `osm:${p.osm_type ?? '?'}:${p.osm_id ?? `${lng},${lat}`}`,
    name,
    detail,
    point: [lng, lat],
    category: `${p.osm_key ?? '?'}=${p.osm_value ?? '?'}`,
  };
}

/** Small LRU cache with expiry, so repeated keystrokes/lookups don't hit the provider. */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires < Date.now()) return undefined;
    this.entries.set(key, entry); // mark as recently used
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** Results that clutter address search: transit stops and platforms. */
const EXCLUDED_TAGS = [
  'highway:bus_stop',
  'public_transport',
  'railway:tram_stop',
  'railway:platform',
];

export interface PhotonOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Geocoder backed by Photon (https://photon.komoot.io), an OpenStreetMap
 * search engine designed for search-as-you-type. The public instance is
 * free under fair use; point `GEOCODER_URL` at a self-hosted Photon for
 * heavier use.
 */
export class PhotonGeocoder implements Geocoder {
  private readonly cache = new TtlCache<PhotonFeature[]>(1000, 24 * 60 * 60 * 1000);
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PhotonOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, params: URLSearchParams): Promise<PhotonFeature[]> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}?${params}`;
    const cached = this.cache.get(url);
    if (cached) return cached;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw new GeocoderError(`Geocoder request failed: ${(error as Error).message}`);
    }
    if (!response.ok) throw new GeocoderError(`Geocoder responded ${response.status}`);
    const body = (await response.json()) as { features?: PhotonFeature[] };
    const features = body.features ?? [];
    this.cache.set(url, features);
    return features;
  }

  async search(query: string, { near }: { near?: LngLat } = {}): Promise<Place[]> {
    const limit = this.options.limit ?? 6;
    const params = new URLSearchParams({
      q: query,
      lang: 'en',
      // Over-fetch: some results are dropped by the Victoria filter.
      limit: String(limit * 2),
      bbox: [VICTORIA_BOUNDS.minLng, VICTORIA_BOUNDS.minLat, VICTORIA_BOUNDS.maxLng, VICTORIA_BOUNDS.maxLat].join(','),
    });
    if (near) {
      params.set('lon', near[0].toFixed(4));
      params.set('lat', near[1].toFixed(4));
    }
    for (const tag of EXCLUDED_TAGS) params.append('osm_tag', `!${tag}`);

    const places = (await this.request('/api/', params)).map(placeFromPhoton).filter((p): p is Place => p !== null);
    // Collapse duplicates (e.g. a street split into several OSM ways).
    const seen = new Set<string>();
    return places
      .filter((p) => {
        const key = `${p.name}|${p.detail}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  async reverse(point: LngLat): Promise<Place | null> {
    // Street level gives "Barassi Way, Jolimont" rather than the nearest statue.
    const params = new URLSearchParams({
      lon: point[0].toFixed(5),
      lat: point[1].toFixed(5),
      lang: 'en',
      limit: '1',
      layer: 'street',
    });
    const [feature] = await this.request('/reverse', params);
    return feature ? placeFromPhoton(feature) : null;
  }
}
