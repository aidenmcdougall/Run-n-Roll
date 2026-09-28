import { Router } from 'express';
import type { Pool } from 'pg';
import type { NetworkService } from '../../services/networkService.js';

interface ImportRow {
  id: number;
  source: string;
  source_url: string | null;
  file_sha256: string;
  path_count: number;
  imported_at: Date;
}

/** Metadata about the loaded network: dataset provenance and graph statistics. */
export function networkRouter(pool: Pool, network: NetworkService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const { rows } = await pool.query<ImportRow>(
      `SELECT id, source, source_url, file_sha256, path_count, imported_at
       FROM dataset_imports ORDER BY id DESC LIMIT 1`,
    );
    const state = network.getState();
    res.json({
      status: state.status,
      latestImport: rows[0] ?? null,
      graph: state.status === 'ready' ? { ...state.graph.stats, builtAt: state.builtAt, buildMs: state.buildMs } : null,
      error: state.status === 'error' ? state.error : undefined,
    });
  });

  return router;
}
