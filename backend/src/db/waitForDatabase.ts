import type { Pool } from 'pg';

/**
 * Retries a trivial query until the database accepts connections.
 *
 * On first start the postgis/postgis image runs its init scripts on a
 * temporary server and then restarts, so the container can report healthy
 * and then briefly refuse connections. Scripts run straight after
 * `docker compose up` would otherwise fail intermittently.
 */
export async function waitForDatabase(pool: Pool, { attempts = 15, delayMs = 2000 } = {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`Database not reachable after ${attempts} attempts: ${(error as Error).message}`);
      }
      console.log(`Waiting for database (attempt ${attempt}/${attempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
