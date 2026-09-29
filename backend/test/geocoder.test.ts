import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/http/errors.js';
import { geocodeRouter } from '../src/http/routers/geocode.js';
import { GeocoderError, PhotonGeocoder, placeFromPhoton, type Geocoder, type PhotonFeature } from '../src/services/geocoder.js';

const feature = (properties: PhotonFeature['properties'], coordinates: [number, number] = [144.97, -37.85]): PhotonFeature => ({
  properties: { state: 'Victoria', osm_type: 'N', osm_id: 1, osm_key: 'amenity', osm_value: 'cafe', ...properties },
  geometry: { type: 'Point', coordinates },
});

describe('placeFromPhoton', () => {
  it('labels a named place with its address and suburb', () => {
    expect(
      placeFromPhoton(feature({ name: 'Flinders Street Station Pharmacy', street: 'Flinders Walk', district: 'Melbourne', postcode: '3000' })),
    ).toMatchObject({ name: 'Flinders Street Station Pharmacy', detail: 'Flinders Walk, Melbourne 3000', point: [144.97, -37.85] });
  });

  it('labels an address by house number and street', () => {
    expect(placeFromPhoton(feature({ housenumber: '12', street: 'Smith Street', locality: 'Fitzroy', postcode: '3065' }))).toMatchObject({
      name: '12 Smith Street',
      detail: 'Fitzroy 3065',
    });
  });

  it('labels a street from reverse geocoding', () => {
    expect(placeFromPhoton(feature({ name: 'Barassi Way', locality: 'Jolimont', postcode: '3002' }))).toMatchObject({
      name: 'Barassi Way',
      detail: 'Jolimont 3002',
    });
  });

  it('drops results outside Victoria (the bounding box also covers southern NSW)', () => {
    expect(placeFromPhoton(feature({ name: 'Lake Albert Park', state: 'New South Wales' }))).toBeNull();
  });

  it('drops results with nothing to call them', () => {
    expect(placeFromPhoton(feature({}))).toBeNull();
  });
});

/** A fake fetch that records requested URLs and replies with canned features. */
function fakeFetch(features: PhotonFeature[] | Error) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    if (features instanceof Error) throw features;
    return new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

describe('PhotonGeocoder', () => {
  const make = (fetchImpl: typeof fetch) => new PhotonGeocoder({ baseUrl: 'https://photon.test/', userAgent: 'test', fetchImpl });

  it('restricts searches to Victoria, excludes transit stops, and biases towards a point', async () => {
    const { impl, urls } = fakeFetch([]);
    await make(impl).search('albert park', { near: [144.9631, -37.8136] });
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe('https://photon.test/api/');
    expect(url.searchParams.get('q')).toBe('albert park');
    expect(url.searchParams.get('bbox')).toBe('140.9,-39.3,150.1,-33.9');
    expect(url.searchParams.getAll('osm_tag')).toContain('!highway:bus_stop');
    expect(url.searchParams.get('lat')).toBe('-37.8136');
  });

  it('filters, de-duplicates and limits results', async () => {
    const { impl } = fakeFetch([
      feature({ name: 'Albert Park Lake', locality: 'Albert Park' }),
      feature({ name: 'Albert Park Lake', locality: 'Albert Park', osm_id: 2 }), // same place, another OSM object
      feature({ name: 'Lake Albert Park', state: 'New South Wales' }),
      feature({ name: 'Albert Park', locality: 'Albert Park' }),
    ]);
    const places = await make(impl).search('albert park');
    expect(places.map((p) => p.name)).toEqual(['Albert Park Lake', 'Albert Park']);
  });

  it('caches identical requests', async () => {
    const { impl, urls } = fakeFetch([feature({ name: 'St Kilda Beach' })]);
    const geocoder = make(impl);
    await geocoder.search('st kilda beach');
    await geocoder.search('st kilda beach');
    expect(urls).toHaveLength(1);
  });

  it('reverse geocodes to street level', async () => {
    const { impl, urls } = fakeFetch([feature({ name: 'Barassi Way', locality: 'Jolimont' })]);
    const place = await make(impl).reverse([144.9815, -37.8199]);
    expect(new URL(urls[0]!).searchParams.get('layer')).toBe('street');
    expect(place?.name).toBe('Barassi Way');
  });

  it('wraps network failures in GeocoderError', async () => {
    const { impl } = fakeFetch(new Error('ECONNRESET'));
    await expect(make(impl).search('anything')).rejects.toBeInstanceOf(GeocoderError);
  });
});

describe('GET /api/geocode', () => {
  let baseUrl: string;
  let close: () => void;
  let behaviour: 'ok' | 'fail' = 'ok';
  const calls: { query?: string; near?: unknown }[] = [];

  const geocoder: Geocoder = {
    async search(query, options) {
      calls.push({ query, near: options?.near });
      if (behaviour === 'fail') throw new GeocoderError('down');
      return [{ id: 'osm:N:1', name: 'St Kilda Beach', detail: 'St Kilda 3182', point: [144.97, -37.86], category: 'natural=beach' }];
    },
    async reverse() {
      return { id: 'osm:W:2', name: 'Barassi Way', detail: 'Jolimont', point: [144.98, -37.82], category: 'highway=primary' };
    },
  };

  beforeAll(async () => {
    const app = express();
    app.use('/api/geocode', geocodeRouter(geocoder));
    app.use(errorHandler);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const get = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`);
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };

  it('searches, passing a valid bias point through', async () => {
    behaviour = 'ok';
    const { status, json } = await get('/api/geocode/search?q=st%20kilda&lat=-37.81&lng=144.96');
    expect(status).toBe(200);
    expect(json.places[0].name).toBe('St Kilda Beach');
    expect(calls.at(-1)).toEqual({ query: 'st kilda', near: [144.96, -37.81] });
  });

  it('ignores a bias point outside Victoria rather than failing', async () => {
    const { status } = await get('/api/geocode/search?q=st%20kilda&lat=51.5&lng=-0.1');
    expect(status).toBe(200);
    expect(calls.at(-1)?.near).toBeUndefined();
  });

  it.each(['/api/geocode/search', '/api/geocode/search?q=a', `/api/geocode/search?q=${'x'.repeat(121)}`])(
    'rejects an invalid query: %s',
    async (path) => {
      const { status, json } = await get(path);
      expect(status).toBe(400);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('reverse geocodes a point in Victoria, and rejects one outside', async () => {
    expect((await get('/api/geocode/reverse?lat=-37.82&lng=144.98')).json.place.name).toBe('Barassi Way');
    expect((await get('/api/geocode/reverse?lat=51.5&lng=-0.1')).status).toBe(400);
  });

  it('reports provider outages as 502', async () => {
    behaviour = 'fail';
    const { status, json } = await get('/api/geocode/search?q=anything');
    expect(status).toBe(502);
    expect(json.error.code).toBe('GEOCODER_UNAVAILABLE');
  });
});
