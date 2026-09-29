import cors from 'cors';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { Geocoder } from '../services/geocoder.js';
import type { NetworkService } from '../services/networkService.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { geocodeRouter } from './routers/geocode.js';
import { healthRouter } from './routers/health.js';
import { networkRouter } from './routers/network.js';
import { routesRouter } from './routers/routes.js';
import { tilesRouter } from './routers/tiles.js';

export interface AppDependencies {
  pool: Pool;
  network: NetworkService;
  geocoder: Geocoder;
  corsOrigins: string[];
}

/** Builds the Express app. Dependencies are injected so the app can be tested without globals. */
export function createApp({ pool, network, geocoder, corsOrigins }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter(pool, network));
  app.use('/api/network', networkRouter(pool, network));
  app.use('/api/tiles', tilesRouter(pool));
  app.use('/api/routes', routesRouter(network));
  app.use('/api/geocode', geocodeRouter(geocoder));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
