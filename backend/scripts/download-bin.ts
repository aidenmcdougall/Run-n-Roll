/**
 * Downloads the official Victorian Department of Transport and Planning
 * "Bicycle Infrastructure Network" GeoJSON into data/raw/.
 *
 * Usage: npm run data:download [-- <output-path>]
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../src/config/env.js';
import { BIN_LOCAL_PATH } from './dataset.js';

async function download(url: string, outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  console.log(`Downloading ${url}`);

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  // Write to a temp file and rename on success so a failed download never
  // leaves a truncated dataset where the importer expects a good one.
  const tempPath = `${outputPath}.part`;
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(tempPath));
  await rename(tempPath, outputPath);

  const { size } = await stat(outputPath);
  console.log(`Saved ${outputPath}`);
  console.log(`  size:   ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  sha256: ${hash.digest('hex')}`);
}

const outputPath = path.resolve(process.argv[2] ?? BIN_LOCAL_PATH);
download(env.BIN_DATASET_URL, outputPath).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
