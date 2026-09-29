import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Walks up from this file to find the nearest `.env` (the repo root's, in practice). */
function findEnvFile(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Load the repo-root .env (if present) using Node's built-in loader, so that
// the backend and docker-compose share a single source of configuration.
// Variables already set in the real environment take precedence. Searching
// upwards keeps this working from both src/ (tsx) and dist/ (compiled).
const envFile = findEnvFile();
if (envFile) process.loadEnvFile(envFile);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.url().default('postgres://runnroll:runnroll@localhost:5432/runnroll'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  BIN_DATASET_URL: z
    .url()
    .default(
      'https://opendata.transport.vic.gov.au/dataset/6cb739f0-ccf1-47a2-b215-192daf1e501a/resource/93e3301d-c559-44df-9435-01dfcad10794/download/bicycle_infrastructure_network.geojson',
    ),
  // Photon-compatible geocoder for address search (https://github.com/komoot/photon).
  GEOCODER_URL: z.url().default('https://photon.komoot.io'),
  GEOCODER_USER_AGENT: z.string().min(1).default('RunNRoll/0.1 (+https://github.com/aidenmcdougall/Run-n-Roll)'),
  OSM_EXTRACT_URL: z.url().default('https://download.geofabrik.de/australia-oceania/australia/victoria-latest.osm.pbf'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
