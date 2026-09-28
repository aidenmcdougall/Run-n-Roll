import pg from 'pg';
import { env } from '../config/env.js';

// PostgreSQL returns BIGINT (int8) as a string because it can exceed
// Number.MAX_SAFE_INTEGER. OSM IDs are currently ~1.4e9, well within range,
// so parse them to numbers for ergonomic use in TypeScript.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on('error', (error) => {
  // Errors on idle clients (e.g. the DB restarting) must not crash the process.
  console.error('Unexpected PostgreSQL pool error', error);
});
