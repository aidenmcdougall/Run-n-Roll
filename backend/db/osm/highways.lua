-- osm2pgsql flex style: load OpenStreetMap highway ways into `osm.ways`.
--
-- This is a raw staging layer. It keeps every tag, so that decisions about
-- what is routable and how it is classified live in TypeScript
-- (backend/src/domain/osm.ts), where they are unit tested, rather than here.
-- Run via `npm run osm:load`, which recreates the table on each run.

local ways = osm2pgsql.define_way_table('ways', {
  { column = 'highway', type = 'text', not_null = true },
  { column = 'tags', type = 'jsonb', not_null = true },
  { column = 'geom', type = 'linestring', projection = 4326, not_null = true },
}, { schema = 'osm' })

-- Highway values that could ever be walked, run, ridden or skated.
-- Motorways, construction, proposals, platforms, etc. are skipped at load.
local candidate_highways = {
  footway = true, path = true, cycleway = true, pedestrian = true,
  steps = true, track = true, bridleway = true,
  living_street = true, residential = true, service = true, unclassified = true, road = true,
  tertiary = true, tertiary_link = true, secondary = true, secondary_link = true,
  primary = true, primary_link = true, trunk = true, trunk_link = true,
}

function osm2pgsql.process_way(object)
  local highway = object.tags.highway
  if not highway or not candidate_highways[highway] then return end
  -- Closed pedestrian areas (plazas) are polygons, not lines to walk along.
  if object.tags.area == 'yes' then return end
  ways:insert({
    highway = highway,
    tags = object.tags,
    geom = object:as_linestring(),
  })
end
