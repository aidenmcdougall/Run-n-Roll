/**
 * Loads the downloaded OSM extract into the `osm` schema with osm2pgsql,
 * which runs in Docker (see docker-compose.yml, profile "tools"), so it
 * needn't be installed locally. The table is recreated on each run.
 *
 * Usage: npm run osm:load
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOsmMetadata } from './osm-metadata.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function load(): Promise<void> {
  const metadata = await readOsmMetadata();
  if (!metadata) throw new Error('No OSM extract found. Run `npm run osm:download` first.');
  console.log(`Loading ${metadata.file} with osm2pgsql...`);

  const args = [
    'compose', '--profile', 'tools', 'run', '--rm', '--build', 'osm2pgsql',
    '--create',
    '--output=flex',
    '--style=/style/highways.lua',
    '--schema=osm', // keep osm2pgsql's own tables out of the app schema
    '--cache=1500', // MB of RAM for node locations
    `/data/${metadata.file}`,
  ];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('docker', args, { cwd: repoRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`osm2pgsql exited with code ${code}`);
  console.log('Loaded. Next: `npm run osm:build`.');
}

load().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
