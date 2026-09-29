import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { createApp } from './http/app.js';
import { PhotonGeocoder } from './services/geocoder.js';
import { NetworkService } from './services/networkService.js';

const network = new NetworkService(pool);
const geocoder = new PhotonGeocoder({ baseUrl: env.GEOCODER_URL, userAgent: env.GEOCODER_USER_AGENT });
const app = createApp({ pool, network, geocoder, corsOrigins: env.CORS_ORIGINS });

const server = app.listen(env.PORT, () => {
  console.log(`Run N Roll API listening on http://localhost:${env.PORT}`);
});

// Build the routing graph in the background; routing returns 503 until ready.
void network.reload();

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
