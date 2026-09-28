-- Pre-projected Web Mercator geometry for vector tile generation.
--
-- Map tiles are defined in EPSG:3857. Reprojecting every path on every tile
-- request dominated tile latency at low zooms, so we store the projected
-- geometry once. As a generated column it can never drift from `geom`.
ALTER TABLE paths
  ADD COLUMN geom_3857 geometry(LineString, 3857)
  GENERATED ALWAYS AS (ST_Transform(geom, 3857)) STORED;

CREATE INDEX paths_geom_3857_gix ON paths USING gist (geom_3857);
