import { fileURLToPath } from 'node:url';

export { BIN_SOURCE, OSM_SOURCE } from '../src/domain/sources.js';

/** Default local location for the downloaded dataset (git-ignored). */
export const BIN_LOCAL_PATH = fileURLToPath(
  new URL('../../data/raw/bicycle_infrastructure_network.geojson', import.meta.url),
);

/** Directory for OpenStreetMap extracts (git-ignored). */
export const OSM_DIR = fileURLToPath(new URL('../../data/raw/osm/', import.meta.url));
