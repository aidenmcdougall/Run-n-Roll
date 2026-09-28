# Run N Roll 🏃🛼

Route planning for exploring Victoria, Australia by running, walking, cycling or roller skating.

The goal is for two people doing different activities (say, one running and one skating) to find a route they'll both enjoy. That means routes that prefer suitable paths, not just the shortest ones.

> **Status: MVP vertical slice.** Real Victorian path data is imported into PostGIS, displayed on an interactive map, and routed with a configurable, preference-aware A\* router. Activity modes, loops and target-distance routes are planned but not built yet (see [Roadmap](#roadmap)).

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Data](#data)
- [Routing](#routing)
- [API](#api)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)

## Quick start

**Prerequisites**

- Node.js **22.12+** (see `.nvmrc`)
- Docker with Compose: Docker Desktop, or on macOS [Colima](https://github.com/abiosoft/colima) (`brew install colima docker docker-compose && colima start`)

```bash
cp .env.example .env         # defaults work out of the box
npm install

npm run db:up                # PostgreSQL 16 + PostGIS 3.4 in Docker
npm run db:migrate           # create the schema
npm run data:download        # fetch the official DTP dataset (~31 MB) into data/raw/
npm run data:import          # load it into PostGIS (~30–60 s)

npm run dev                  # API on :3001, web app on http://localhost:5173
```

Open <http://localhost:5173>. Click the map once to set the start (A) and again to set the destination (B). Drag either marker to re-route.

To refresh the data later, run `npm run data:download && npm run data:import`, then restart the API.

## Architecture

```
┌──────────────────────────┐
│ frontend/  React + Vite  │  MapLibre GL JS map, route UI
└────────────┬─────────────┘
             │ REST (JSON) + Mapbox Vector Tiles
┌────────────▼─────────────┐
│ backend/   Express       │  validation (zod), HTTP errors, tile + route endpoints
│   services/NetworkService│  loads paths from PostGIS → builds graph once, in memory
│   routing/  (pure TS)    │  graph builder, A*, weights, snapping (no Express/pg deps)
└────────────┬─────────────┘
             │ SQL
┌────────────▼─────────────┐
│ PostgreSQL + PostGIS     │  paths table, GiST indexes, ST_AsMVT tile generation
└──────────────────────────┘
```

```
.
├── backend/
│   ├── db/migrations/        # forward-only SQL migrations
│   ├── scripts/              # migrate, data:download, data:import (run via tsx)
│   ├── src/
│   │   ├── config/           # env parsing/validation
│   │   ├── db/               # pg pool, wait-for-db helper
│   │   ├── domain/           # infrastructure categories, hazard parsing
│   │   ├── http/             # Express app, routers, error handling, validation
│   │   ├── routing/          # ← the routing engine (framework-free, unit tested)
│   │   └── services/         # NetworkService: owns the in-memory graph
│   └── test/                 # vitest unit + HTTP tests
├── frontend/
│   └── src/
│       ├── api/              # typed API client + route hook
│       ├── components/       # panel pieces (legend, route summary)
│       └── map/              # MapLibre map, layer styles
├── data/raw/                 # downloaded datasets (git-ignored)
└── docker-compose.yml
```

Key decisions:

- **The routing engine is isolated.** `backend/src/routing` imports nothing from Express or `pg`. It takes plain `PathSegment[]` and returns plain results, so it can be tested directly and reused (for example in a worker, CLI or batch job).
- **The graph lives in memory.** About 55k segments become about 96k nodes and 137k edges, built in about 2 s at startup. A\* then answers in milliseconds (median about 2 ms on random metro trips). pgRouting would add an extension dependency and a DB round-trip per query without being faster at this scale.
- **PostGIS generates vector tiles.** Paths are served as Mapbox Vector Tiles built by `ST_AsMVT`, instead of shipping 30 MB of GeoJSON to the browser. Low zooms get merged, simplified geometry.

## Data

### Source

**[Bicycle Infrastructure Network](https://discover.data.vic.gov.au/dataset/bicycle-infrastructure-network)** from the Victorian Department of Transport and Planning (DTP), last updated June 2025.

- **Coverage:** Metropolitan Melbourne, Geelong, Ballarat and Bendigo (not all of Victoria).
- **Licence:** [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). It's derived from OpenStreetMap and enhanced by DTP. Attribution to DTP and © OpenStreetMap contributors is shown on the map.
- **Download:** the URL is configured as `BIN_DATASET_URL` in `.env.example`.

The file is about 31 MB, so it's **not committed**. `npm run data:download` fetches it reproducibly into `data/raw/` and prints its SHA-256. The importer records the hash of every import in `dataset_imports`.

### Why GeoJSON (not Parquet)

DTP publishes GeoJSON, (Geo)Parquet and a PDF of documentation. GeoJSON was chosen because:

- PostGIS parses it natively (`ST_GeomFromGeoJSON`), so the importer needs no GDAL/`ogr2ogr` install and no Parquet library.
- It uses the same WGS84 coordinates (`CRS84`) we store and display.
- At 31 MB it parses in well under a second.

Parquet would become worthwhile if the dataset grew by an order of magnitude.

### What's in it

Every feature is a single-part `MultiLineString` with these attributes (profiled from the June 2025 release):

| Source field | Stored as | Notes |
| --- | --- | --- |
| `OsmID` | `osm_id` | OpenStreetMap way ID. Some ways appear twice (e.g. a lane on each side of a road). |
| `InfraType` | `infra_type` (raw) + `infra_category` (slug) | 8 values, mapped in [`domain/infrastructure.ts`](backend/src/domain/infrastructure.ts) |
| `Name` | `name` | Street or trail name |
| `HwyType` | `highway_type` | OSM highway class (`cycleway`, `residential`, `primary`…) |
| `Width` | `width_m` | About 55% populated, mostly on-road lanes |
| `Hazards` | `hazards text[]` | `parking`, `traffic_merging`, `tram_line` |
| `DirRelToWay` | `direction` | `both` / `forward` / `reverse` |
| `DirCardinal` | `direction_cardinal` | e.g. `Northbound` |
| *(all)* | `properties jsonb` | Untouched source attributes, for provenance |

| Category | Segments | Length |
| --- | ---: | ---: |
| Shared use path (off-road) | 23,809 | 4,546 km |
| Basic painted lane | 19,692 | 2,049 km |
| Shared bike/parking lane | 3,052 | 619 km |
| Shared street (sharrows) | 4,566 | 511 km |
| Intermittent/informal (on-road) | 1,095 | 176 km |
| Separated path (off-road) | 961 | 150 km |
| Buffered painted lane | 975 | 111 km |
| Protected bike lane (on-road) | 1,555 | 85 km |

**The dataset has no surface information**, so `paths.surface` exists but is `NULL` for now. It can be enriched from OSM `surface` tags via `osm_id` (see [Roadmap](#roadmap)). DTP also notes that bus lanes which permit cycling are not included.

### Schema

See [`001_initial_schema.sql`](backend/db/migrations/001_initial_schema.sql) and [`002_paths_web_mercator.sql`](backend/db/migrations/002_paths_web_mercator.sql).

- `geom geometry(LineString, 4326)` stores WGS84, matching the source and web maps, with a GiST index.
- `length_m` is precomputed on the spheroid (`ST_Length(geom::geography)`), so nothing downstream measures in degrees.
- `geom_3857` is a generated, GiST-indexed Web Mercator copy for tile generation. It can't drift from `geom`.
- A `CHECK` constraint pins `infra_category` to known slugs. Unknown source values import as `unknown`, with a warning.

### Import process

`npm run data:import [-- path/to/file.geojson]`:

1. Validates the FeatureCollection and each feature's shape with zod.
2. Normalises values (empty strings and the literal `"null"` become `NULL`, hazards are parsed, categories mapped).
3. In **one transaction**: records a `dataset_imports` row, deletes the previous import of this source, and bulk-inserts in batches with `ST_Dump` (multi-part geometries become one row per line).

Re-running is safe and readers never see a half-loaded table.

## Routing

### Building the graph ([`routing/graph.ts`](backend/src/routing/graph.ts))

1. **Junctions:** OSM ways that meet share a vertex, so any vertex used by more than one segment becomes a graph node. Segment endpoints are always nodes. Lines are split into edges at nodes.
2. **Gap bridging:** the dataset contains *only* cycling infrastructure. A shared path often stops a few metres short of the painted lane it visually meets, because the kerb crossing isn't in the data. For each dangling endpoint, the builder finds the closest point on any other segment within **15 m**, inserts a vertex there, and adds a `connector` edge. That raises the main connected network from 25% to 41% of all nodes. Connectors are costed like any other edge kind, which gives future road-crossing penalties a natural home.
3. **Components:** connected components are labelled up front, so impossible requests fail instantly instead of exhausting the search.

### Costs ([`routing/weights.ts`](backend/src/routing/weights.ts))

```
cost = length_m × kindMultiplier × Π hazardMultiplier × surfaceMultiplier
```

All weights live in `RoutingProfile` objects, not scattered through the code. Two profiles ship now:

| Profile | Behaviour |
| --- | --- |
| `prefer_paths` (default) | Off-road paths ×1.0, protected ×1.2, buffered ×1.5, painted ×1.8, sharrows/parking lanes ×2, informal ×2.5, gap connectors ×3; tram lines ×1.5, merging traffic ×1.3, parking ×1.1 |
| `shortest` | Every metre costs the same, as a baseline |

Surface multipliers (asphalt 1.0 … gravel 1.8 … grass 2.5) are already defined, ready for surface data. On random 1–15 km metro trips, `prefer_paths` averages only **1.6% longer** than `shortest` but raises the off-road share by **8 percentage points**.

### Search ([`routing/astar.ts`](backend/src/routing/astar.ts), [`routing/planner.ts`](backend/src/routing/planner.ts))

- **A\*** with a binary heap. The heuristic is great-circle distance × the profile's cheapest cost per metre, which keeps it admissible, so routes are optimal for the profile. With a zero heuristic it is exactly Dijkstra (a unit test checks the two agree).
- **Snapping:** start and end snap to the nearest point *on* an edge (within 500 m), not the nearest junction. Virtual start and end nodes join the ends of their edges with partial-cost arcs, so routes begin and end exactly where you clicked.
- **Reachability-aware snapping:** if the nearest edges are in different components, the planner re-snaps to the closest *mutually reachable* edges and picks the option that moves the points least.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | DB and network status |
| `GET` | `/api/network` | Latest import provenance and graph statistics |
| `GET` | `/api/tiles/paths/{z}/{x}/{y}.pbf` | Mapbox Vector Tile of paths, layer `paths` (z ≥ 8) |
| `GET` | `/api/routes/profiles` | Routing profiles and their weights |
| `POST` | `/api/routes` | Plan a route |

```http
POST /api/routes
Content-Type: application/json

{ "start": { "lng": 144.9646, "lat": -37.8207 },
  "end":   { "lng": 144.9745, "lat": -37.8676 },
  "profile": "prefer_paths" }
```

This responds with a GeoJSON `Feature<LineString>`. Its `properties` hold `distanceM`, `cost`, `legs` (consecutive stretches by kind and name), `distanceByKind`, and `snap` distances.

Errors share one shape, `{ "error": { "code", "message", "details?" } }`:

| Status | Codes |
| --- | --- |
| 400 | `VALIDATION_ERROR` (including points outside Victoria, which catches swapped lat/lng), `INVALID_JSON`, `ZOOM_TOO_LOW` |
| 422 | `START_NOT_NEAR_NETWORK`, `END_NOT_NEAR_NETWORK`, `NO_ROUTE` |
| 503 | `NETWORK_LOADING`, `NETWORK_EMPTY`, `NETWORK_UNAVAILABLE` |

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) and web app (Vite) together |
| `npm run dev:backend` / `dev:frontend` | Either one alone |
| `npm test` | Backend unit + HTTP tests (vitest) |
| `npm run typecheck` | Strict `tsc` for both packages |
| `npm run build` | Compile the API to `backend/dist`, bundle the web app to `frontend/dist` |
| `npm run db:up` / `db:down` | Start or stop the PostGIS container (data persists in a Docker volume) |
| `npm run db:migrate` | Apply pending migrations (idempotent) |

Configuration comes from the single repo-root `.env`, shared by Docker Compose, the API and Vite. See [`.env.example`](.env.example).

**Tests** cover geometry helpers, the priority queue, weighting and profile validation, graph building (junction splitting, gap bridging, T-junctions, degenerate input), the planner (profile preference, mid-edge snapping, one-way handling, reachability-aware snapping, error codes), A\* vs Dijkstra agreement, and HTTP validation and error mapping.

## Known limitations

- **Network connectivity is the biggest one.** The dataset maps cycling infrastructure, not the streets and footpaths that join it. Even after gap bridging there are about 4,300 disconnected islands. For random clicks across inner Melbourne, about 45% of pairs route successfully: about 20% of clicks land more than 500 m from any path, and most of the rest land on isolated fragments. Long trails such as the Capital City, Yarra and Bay trails route well. The fix is on the roadmap.
- **Coverage** is limited to Melbourne, Geelong, Ballarat and Bendigo.
- **No surface data yet**, so smoothness and gravel preferences can't take effect until the data is enriched.
- **One-way lanes are ignored** (both profiles set `respectOneWay: false`, which suits running and walking). The graph and planner already support one-way restrictions for a future cycling mode.
- **Apple Silicon:** the official `postgis/postgis` image is amd64-only, so it runs under emulation. It works, but low-zoom (z8–10) tiles take about 0.5–0.6 s to generate. They're cached for an hour.

## Roadmap

Planned, roughly in order. The current structure is designed to take these without rewrites:

1. **Connect the network:** import OSM footways and quiet residential streets for the covered regions as low-preference edges. This fixes connectivity and is needed for running and walking anyway.
2. **Surface enrichment:** join OSM `surface` and `smoothness` tags by `osm_id`, which enables skateability scoring and gravel avoidance.
3. **Activity profiles:** running, walking, cycling and skating as `RoutingProfile` data, plus **couples mode** combining two profiles (e.g. taking the worse multiplier of the two per edge).
4. **Distance-targeted routes and loops:** "10 km loop from here", and 5/10/15/20 km suggestions.
5. **Elevation:** slope costs from a DEM (e.g. Vicmap Elevation) and steep-hill avoidance.
6. Road-crossing penalties, GPX export, saved and shared routes, "Explore near me", and a mobile-first UI.
