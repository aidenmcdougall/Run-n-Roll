import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OSM_DIR } from './dataset.js';

/** Describes the OSM extract on disk, written by `osm:download`. */
export interface OsmMetadata {
  /** Dated snapshot URL the file was downloaded from. */
  url: string;
  /** File name within data/raw/osm/. */
  file: string;
  sha256: string;
  /** Whether Geofabrik's published MD5 was available and matched. */
  md5Verified: boolean;
  lastModified: string | null;
  downloadedAt: string;
}

const METADATA_PATH = path.join(OSM_DIR, 'latest.json');

export async function readOsmMetadata(): Promise<OsmMetadata | null> {
  try {
    return JSON.parse(await readFile(METADATA_PATH, 'utf8')) as OsmMetadata;
  } catch {
    return null;
  }
}

export async function writeOsmMetadata(metadata: OsmMetadata): Promise<void> {
  await writeFile(METADATA_PATH, JSON.stringify(metadata, null, 2) + '\n');
}
