/**
 * Downloads the Geofabrik OpenStreetMap extract for Victoria into
 * data/raw/osm/. Geofabrik's `-latest` URL redirects to a dated snapshot
 * (e.g. victoria-260928.osm.pbf); we record that URL so every import can be
 * traced to an exact snapshot.
 *
 * Usage: npm run osm:download
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../src/config/env.js';
import { OSM_DIR } from './dataset.js';
import { writeOsmMetadata } from './osm-metadata.js';

async function resolveSnapshotUrl(latestUrl: string): Promise<string> {
  const response = await fetch(latestUrl, { method: 'HEAD', redirect: 'manual' });
  const location = response.headers.get('location');
  return location ? new URL(location, latestUrl).toString() : latestUrl;
}

async function fileHash(filePath: string, algorithm: 'sha256' | 'md5'): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** Geofabrik publishes `<file>.md5`; its first token is the hex digest. */
async function fetchPublishedMd5(url: string): Promise<string | null> {
  try {
    const response = await fetch(`${url}.md5`);
    if (!response.ok) return null;
    const token = (await response.text()).trim().split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{32}$/i.test(token) ? token.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Removes older snapshots so refreshes don't accumulate ~230 MB files. */
async function removeOldSnapshots(keep: string): Promise<void> {
  for (const name of await readdir(OSM_DIR)) {
    if (name.endsWith('.osm.pbf') && name !== keep) {
      await rm(path.join(OSM_DIR, name));
      console.log(`Removed old snapshot ${name}`);
    }
  }
}

async function download(): Promise<void> {
  await mkdir(OSM_DIR, { recursive: true });
  const url = await resolveSnapshotUrl(env.OSM_EXTRACT_URL);
  const file = path.basename(new URL(url).pathname);
  const outputPath = path.join(OSM_DIR, file);

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const expectedBytes = Number(response.headers.get('content-length') ?? NaN);
  const existing = await stat(outputPath).catch(() => null);

  if (existing && existing.size === expectedBytes) {
    console.log(`${file} is already downloaded.`);
    await response.body.cancel();
  } else {
    console.log(`Downloading ${url} (${(expectedBytes / 1024 / 1024).toFixed(0)} MB)`);
    // Write to a temp file and rename on success, so a failed download
    // never leaves a truncated extract where the loader expects a good one.
    const tempPath = `${outputPath}.part`;
    let received = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(0)} MB`);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(tempPath));
    process.stdout.write('\n');
    await rename(tempPath, outputPath);
  }

  const publishedMd5 = await fetchPublishedMd5(url);
  if (publishedMd5) {
    const md5 = await fileHash(outputPath, 'md5');
    if (publishedMd5 !== md5) {
      throw new Error(`MD5 mismatch for ${file}: expected ${publishedMd5}, got ${md5}. Delete it and retry.`);
    }
  } else {
    console.warn('Could not fetch the published MD5; skipping checksum verification.');
  }

  const sha256 = await fileHash(outputPath, 'sha256');
  await writeOsmMetadata({
    url,
    file,
    sha256,
    md5Verified: Boolean(publishedMd5),
    lastModified: response.headers.get('last-modified'),
    downloadedAt: new Date().toISOString(),
  });
  await removeOldSnapshots(file);
  console.log(`Saved ${outputPath}\n  sha256: ${sha256}${publishedMd5 ? '\n  md5 verified' : ''}`);
}

download().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
