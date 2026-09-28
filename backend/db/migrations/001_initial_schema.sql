-- Initial schema: path network storage for Run N Roll.

CREATE EXTENSION IF NOT EXISTS postgis;

-- One row per dataset import, for provenance and repeatable refreshes.
CREATE TABLE dataset_imports (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source           text        NOT NULL,          -- e.g. 'vic_dtp_bin'
  source_url       text,
  file_sha256      text        NOT NULL,
  feature_count    integer     NOT NULL,
  path_count       integer     NOT NULL,
  imported_at      timestamptz NOT NULL DEFAULT now()
);

-- Path segments. Geometry is stored as WGS84 (EPSG:4326) LineStrings, matching
-- the source data and web maps. Metric lengths are precomputed on the
-- spheroid (via geography) so routing never works in degrees.
CREATE TABLE paths (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source             text    NOT NULL,
  import_id          integer NOT NULL REFERENCES dataset_imports (id),
  osm_id             bigint,                        -- OpenStreetMap way ID, if known
  name               text,
  infra_type         text    NOT NULL,              -- raw label from the source dataset
  infra_category     text    NOT NULL,              -- normalised slug (see src/domain/infrastructure.ts)
  highway_type       text,                          -- OSM highway class, e.g. 'cycleway', 'residential'
  surface            text,                          -- e.g. 'asphalt', 'gravel'; NULL when unknown
  width_m            real CHECK (width_m IS NULL OR width_m > 0),
  hazards            text[]  NOT NULL DEFAULT '{}', -- e.g. {parking,tram_line}
  direction          text    NOT NULL DEFAULT 'both'
                     CHECK (direction IN ('both', 'forward', 'reverse')),
  direction_cardinal text,
  properties         jsonb   NOT NULL DEFAULT '{}', -- untouched source attributes
  geom               geometry(LineString, 4326) NOT NULL,
  length_m           double precision NOT NULL CHECK (length_m >= 0),
  CONSTRAINT paths_infra_category_check CHECK (infra_category IN (
    'shared_use_path', 'separated_path', 'protected_lane', 'buffered_lane',
    'painted_lane', 'shared_parking_lane', 'shared_street', 'informal', 'unknown'
  ))
);

CREATE INDEX paths_geom_gix ON paths USING gist (geom);
CREATE INDEX paths_osm_id_idx ON paths (osm_id);
CREATE INDEX paths_infra_category_idx ON paths (infra_category);
CREATE INDEX paths_source_idx ON paths (source);
