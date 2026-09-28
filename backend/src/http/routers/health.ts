import { Router } from 'express';
import type { Pool } from 'pg';
import type { NetworkService } from '../../services/networkService.js';

export function healthRouter(pool: Pool, network: NetworkService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    let database: 'ok' | 'unavailable' = 'ok';
    try {
      await pool.query('SELECT 1');
    } catch {
      database = 'unavailable';
    }
    const status = database === 'ok' ? 200 : 503;
    res.status(status).json({ status: status === 200 ? 'ok' : 'degraded', database, network: network.getState().status });
  });

  return router;
}
