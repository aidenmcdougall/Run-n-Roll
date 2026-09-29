-- OpenStreetMap integration: fill gaps in the bicycle network with footpaths,
-- trails and streets, and add surface information.

-- Raw OSM staging tables are created by osm2pgsql (backend/db/osm/highways.lua)
-- in their own schema, separate from the application tables.
CREATE SCHEMA IF NOT EXISTS osm;

ALTER TABLE paths
  ADD COLUMN smoothness text,  -- OSM smoothness, e.g. 'excellent', 'intermediate', 'bad'
  ADD COLUMN osm_tags   jsonb; -- OSM tags for this way (for DTP rows, joined by osm_id)

-- New categories for OSM-derived edges, beyond the DTP bicycle typology.
ALTER TABLE paths DROP CONSTRAINT paths_infra_category_check;
ALTER TABLE paths ADD CONSTRAINT paths_infra_category_check CHECK (infra_category IN (
  -- DTP Bicycle Infrastructure Network
  'shared_use_path', 'separated_path', 'protected_lane', 'buffered_lane',
  'painted_lane', 'shared_parking_lane', 'shared_street', 'informal',
  -- OpenStreetMap
  'footpath', 'trail', 'track', 'steps', 'quiet_street', 'road', 'busy_road',
  'unknown'
));

-- Areas the routing network covers (clusters of DTP data, buffered).
-- Recomputed by `npm run osm:build`; OSM ways are clipped to these.
CREATE TABLE coverage_areas (
  id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  geom geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX coverage_areas_geom_gix ON coverage_areas USING gist (geom);
