import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/http/errors.js';
import { routesRouter } from '../src/http/routers/routes.js';
import { buildGraph } from '../src/routing/graph.js';
import type { NetworkState } from '../src/services/networkService.js';
import { at, grid, segment } from './helpers.js';

// HTTP-level tests for POST /api/routes against an in-memory network, so
// validation and error mapping are covered without a database.
let state: NetworkState;
let baseUrl: string;
let close: () => void;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/routes', routesRouter({ getState: () => state }));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const ready = (): NetworkState => ({
  status: 'ready',
  graph: buildGraph([segment([[0, 0], [1000, 0]], 'shared_use_path', { name: 'Test Trail' })]),
  builtAt: new Date(),
  buildMs: 0,
});

const toPoint = ([lng, lat]: readonly [number, number]) => ({ lng, lat });

/** Loose view of either a route Feature or an error body; enough for assertions. */
interface ResponseJson {
  type?: string;
  geometry?: { type: string };
  properties?: {
    profile: string;
    distanceM: number;
    legs: unknown[];
    distanceBySurface: Record<string, number>;
    inferredSurfaceM: number;
    preferences: Record<string, unknown>;
    avoidedSurfaceM: number;
    scores: Record<'skate' | 'run', { score: number; rating: string; confidence: string; notes: unknown[] }>;
  };
  error?: { code: string };
}

async function post(body: unknown, path = ''): Promise<{ status: number; json: ResponseJson }> {
  const response = await fetch(`${baseUrl}/api/routes${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as ResponseJson };
}

describe('POST /api/routes', () => {
  it('returns a GeoJSON LineString route', async () => {
    state = ready();
    const { status, json } = await post({ start: toPoint(at(100, 0)), end: toPoint(at(900, 0)) });
    expect(status).toBe(200);
    expect(json.type).toBe('Feature');
    expect(json.geometry?.type).toBe('LineString');
    expect(json.properties?.profile).toBe('prefer_paths');
    expect(json.properties?.distanceM).toBeCloseTo(800, 0);
    expect(json.properties?.legs).toEqual([{ kind: 'shared_use_path', name: 'Test Trail', lengthM: expect.any(Number) }]);
    expect(json.properties?.distanceBySurface).toEqual({ smooth: expect.any(Number) });
    expect(json.properties?.scores.skate).toMatchObject({ score: 100, rating: 'great', confidence: 'high' });
    expect(json.properties?.scores.run.rating).toBe('great');
    expect(json.properties?.inferredSurfaceM).toBe(0);
  });

  it.each([
    ['missing end', { start: toPoint(at(0, 0)) }],
    ['non-numeric coordinate', { start: { lng: 'x', lat: -37.8 }, end: toPoint(at(0, 0)) }],
    ['point outside Victoria (e.g. swapped lat/lng)', { start: { lng: -37.8, lat: 145 }, end: toPoint(at(0, 0)) }],
    ['unknown profile', { start: toPoint(at(0, 0)), end: toPoint(at(900, 0)), profile: 'rocket' }],
  ])('rejects %s with 400', async (_label, body) => {
    state = ready();
    const { status, json } = await post(body);
    expect(status).toBe(400);
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  it('applies default preferences when none are given', async () => {
    state = ready();
    const { json } = await post({ start: toPoint(at(100, 0)), end: toPoint(at(900, 0)) });
    expect(json.properties?.preferences).toEqual({ surface: 'any', avoidSteps: false, avoidBusyRoads: false });
    expect(json.properties?.avoidedSurfaceM).toBe(0);
  });

  it('accepts preferences and reports distance on avoided surfaces', async () => {
    state = {
      status: 'ready',
      graph: buildGraph([segment([[0, 0], [1000, 0]], 'trail', { surfaceClass: 'gravel' })]),
      builtAt: new Date(),
      buildMs: 0,
    };
    const { status, json } = await post({
      start: toPoint(at(100, 0)),
      end: toPoint(at(900, 0)),
      preferences: { surface: 'avoid_loose', avoidSteps: true },
    });
    expect(status).toBe(200);
    expect(json.properties?.preferences).toEqual({ surface: 'avoid_loose', avoidSteps: true, avoidBusyRoads: false });
    expect(json.properties?.avoidedSurfaceM).toBeCloseTo(800, 0); // no alternative, so reported
  });

  it.each([
    ['unknown surface option', { surface: 'lava' }],
    ['misspelt preference', { avoidStairs: true }],
    ['non-boolean flag', { avoidSteps: 'yes' }],
  ])('rejects %s with 400', async (_label, preferences) => {
    state = ready();
    const { status, json } = await post({ start: toPoint(at(0, 0)), end: toPoint(at(900, 0)), preferences });
    expect(status).toBe(400);
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed JSON with 400', async () => {
    const { status, json } = await post('{"start":');
    expect(status).toBe(400);
    expect(json.error?.code).toBe('INVALID_JSON');
  });

  it('maps routing failures to 422 with a stable code', async () => {
    state = ready();
    const { status, json } = await post({ start: toPoint(at(0, 5000)), end: toPoint(at(900, 0)) });
    expect(status).toBe(422);
    expect(json.error?.code).toBe('START_NOT_NEAR_NETWORK');
  });

  it('returns 503 until the network is ready', async () => {
    state = { status: 'loading' };
    expect((await post({ start: toPoint(at(0, 0)), end: toPoint(at(900, 0)) })).status).toBe(503);
    state = { status: 'empty' };
    const { status, json } = await post({ start: toPoint(at(0, 0)), end: toPoint(at(900, 0)) });
    expect(status).toBe(503);
    expect(json.error?.code).toBe('NETWORK_EMPTY');
  });
});

describe('POST /api/routes with an activity profile', () => {
  it.each(['run', 'skate', 'run_skate'])('accepts %s', async (profile) => {
    state = ready();
    const { status, json } = await post({ start: toPoint(at(100, 0)), end: toPoint(at(900, 0)), profile });
    expect(status).toBe(200);
    expect(json.properties?.profile).toBe(profile);
  });
});

interface CollectionJson {
  type?: string;
  features?: {
    geometry: { coordinates: [number, number][] };
    properties: { profile: string; distanceM: number; target: { distanceM: number; shape: string; distanceError: number } };
  }[];
  error?: { code: string };
}

describe('POST /api/routes/distance', () => {
  const gridState = (): NetworkState => ({ status: 'ready', graph: buildGraph(grid()), builtAt: new Date(), buildMs: 0 });
  const postDistance = async (body: unknown) => {
    const { status, json } = await post(body, '/distance');
    return { status, json: json as CollectionJson };
  };

  it('returns a FeatureCollection of loops near the target distance', async () => {
    state = gridState();
    const { status, json } = await postDistance({ start: toPoint(at(30, 10)), distanceM: 3000, shape: 'loop', profile: 'run_skate' });
    expect(status).toBe(200);
    expect(json.type).toBe('FeatureCollection');
    expect(json.features?.length).toBeGreaterThan(1);
    const [best] = json.features!;
    expect(best!.properties.profile).toBe('run_skate');
    expect(best!.properties.target).toMatchObject({ distanceM: 3000, shape: 'loop' });
    expect(Math.abs(best!.properties.distanceM - 3000)).toBeLessThan(300);
    const coords = best!.geometry.coordinates;
    expect(coords[0]).toEqual(coords[coords.length - 1]);
  });

  it('defaults to a loop and honours the number of alternatives', async () => {
    state = gridState();
    const { json } = await postDistance({ start: toPoint(at(30, 10)), distanceM: 3000, alternatives: 1 });
    expect(json.features).toHaveLength(1);
    expect(json.features![0]!.properties.target.shape).toBe('loop');
  });

  it.each([
    ['too short a distance', { distanceM: 100 }],
    ['too long a distance', { distanceM: 500_000 }],
    ['an unknown shape', { distanceM: 3000, shape: 'figure_eight' }],
    ['a missing distance', {}],
  ])('rejects %s with 400', async (_label, extra) => {
    state = gridState();
    const { status, json } = await postDistance({ start: toPoint(at(0, 0)), ...extra });
    expect(status).toBe(400);
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  it('maps planning failures to 422', async () => {
    state = gridState();
    const { status, json } = await postDistance({ start: toPoint(at(0, 9000)), distanceM: 3000 });
    expect(status).toBe(422);
    expect(json.error?.code).toBe('START_NOT_NEAR_NETWORK');
  });
});
