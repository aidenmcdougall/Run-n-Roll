import { fileURLToPath } from 'node:url';

/** Identifier stored in `paths.source` for the DTP Bicycle Infrastructure Network. */
export const BIN_SOURCE = 'vic_dtp_bin';

/** Default local location for the downloaded dataset (git-ignored). */
export const BIN_LOCAL_PATH = fileURLToPath(
  new URL('../../data/raw/bicycle_infrastructure_network.geojson', import.meta.url),
);
