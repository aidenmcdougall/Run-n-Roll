# Run N Roll 🏃🛼

Route planning for exploring Victoria, Australia by running, walking, cycling or roller skating.

The goal is for two people doing different activities (say, one running and one skating) to find a route they'll both enjoy. That means routes that prefer suitable paths and ground, not just the shortest ones.

> **Status: MVP.** The official Victorian bike network is joined with OpenStreetMap footpaths, trails and streets (84,000 km in all), with ground type on every segment where it's known. It's routed with a configurable A\* router that weighs both path type and surface. Activity modes, loops and target-distance routes are planned (see [Roadmap](#roadmap)).

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
- About 2 GB of free disk for the OSM extract and the database

```bash
cp .env.example .env         # defaults work out of the box
npm install

npm run db:up                # PostgreSQL 16 + PostGIS 3.4 in Docker
npm run db:migrate           # create the schema

npm run data:download        # DTP bike network (~31 MB)
npm run data:import          # load it (~40 s)

npm run osm:download         # OpenStreetMap Victoria extract (~230 MB, MD5-verified)
npm run osm:load             # load highways with osm2pgsql in Docker (~1 min)
npm run osm:build            # merge OSM into the network + add surfaces (~8 min on Apple Silicon)

npm run dev                  # API on :3001, web app on http://localhost:5173
```

Open <http://localhost:5173>. Click the map once to set the start (A) and again to set the destination (B), and drag either marker to re-route. Use **Path type / Surface** to recolour the network by ground type. Zoom to street level to see footpaths and streets.

To refresh everything later: `npm run data:refresh`, then restart the API.

## Architecture

```
┌──────────────────────────┐
│ frontend/  React + Vite  │  MapLibre GL JS map, route UI
└────────────┬─────────────┘
             │ REST (JSON) + Mapbox Vector Tiles
┌────────────▼─────────────┐
│ backend/   Express       │  validation (zod), HTTP errors, tile + route endpoints
│   services/NetworkService│  streams paths from PostGIS → builds compact graph in memory
│   routing/  (pure TS)    │  graph builder, A*, weights, snapping (no Express/pg deps)
│   domain/   (pure TS)    │  path categories, OSM classification, surface classes
└────────────┬─────────────┘
             │ SQL
┌────────────▼─────────────┐        ┌──────────────────────────┐
│ PostgreSQL + PostGIS     │ ◄───── │ osm2pgsql (Docker tool)  │
│  paths, coverage_areas,  │        │ Geofabrik .osm.pbf →     │
│  osm.ways (raw staging)  │        │ osm.ways                 │
└──────────────────────────┘        └──────────────────────────┘
```

```
.
├── backend/
│   ├── db/migrations/        # forward-only SQL migrations
│   ├── db/osm/highways.lua   # osm2pgsql flex style (raw highway staging)
│   ├── scripts/              # data:*, osm:*, migrate (run via tsx)
│   ├── src/
│   │   ├── config/           # env parsing/validation
│   │   ├── db/               # pg pool, wait-for-db helper
│   │   ├── domain/           # categories, OSM classifier, surface classes (unit tested)
│   │   ├── http/             # Express app, routers, error handling, validation
│   │   ├── routing/          # ← the routing engine (framework-free, unit tested)
│   │   └── services/         # NetworkService: owns the in-memory graph
│   └── test/                 # vitest unit + HTTP tests
├── docker/osm2pgsql/         # Dockerfile for the osm2pgsql tool
├── frontend/src/             # api/, components/, map/
├── data/raw/                 # downloaded datasets (git-ignored)
└── docker-compose.yml
```

Key decisions:

- **The routing engine is isolated.** `backend/src/routing` and `backend/src/domain` import nothing from Express or `pg`, so they can be tested directly and reused (for example in a worker, CLI or batch job).
- **The graph is compact and lives in memory.** About 603k segments become about 1.03M nodes and 1.52M edges, stored as typed arrays (struct-of-arrays, CSR adjacency, fixed-point coordinates). That's about **170 MB** instead of the ~1.9 GB a JS object per edge needs. Routes take a median of **9 ms** (p95 33 ms).
- **Raw and derived data are kept separate.** osm2pgsql loads every highway way with *all* tags into `osm.ways`. The decisions about what is routable and how it's classified live in TypeScript ([`domain/osm.ts`](backend/src/domain/osm.ts)), not in Lua or SQL, so they're unit tested.
- **PostGIS generates vector tiles** (`ST_AsMVT`) from a pre-projected Web Mercator column. Low zooms get merged, simplified DTP geometry; OSM layers appear from zoom 14.

## Data

Two open datasets are combined: the official bike network, and OpenStreetMap for everything that connects it plus ground types.

### Sources considered

| Source | Footpaths / trails | Surface | Joins to DTP data | Verdict |
| --- | --- | --- | --- | --- |
| **DTP Bicycle Infrastructure Network** | Bike infrastructure only | None | n/a | Core typology of bike infrastructure |
| **OpenStreetMap ([Geofabrik](https://download.geofabrik.de/australia-oceania/australia/victoria.html) Victoria extract)** | Every footway, path, track, steps and street | `surface` + `smoothness` tags | Same way IDs (DTP's `OsmID`) | **Used:** fills gaps and supplies surfaces |
| [Vicmap Transport Road Line](https://discover.data.vic.gov.au/dataset/vicmap-transport-road-line) | Roads and foot tracks, statewide | Sealed/unsealed only | No shared IDs | Future cross-check for rural road surfaces |
| City of Melbourne [footpaths](https://data.melbourne.vic.gov.au/explore/dataset/footpaths/) / [road surfaces](https://data.melbourne.vic.gov.au/explore/dataset/road-segments-with-surface-type/) | City of Melbourne only | Material + condition (1–5) | Polygons | Future skate-quality signal for the CBD |
| Overpass API | Same OSM data | Same | Same | Rate-limited (~1 GB/day), unsuited to bulk loads |

### DTP Bicycle Infrastructure Network

**[Bicycle Infrastructure Network](https://discover.data.vic.gov.au/dataset/bicycle-infrastructure-network)** from the Victorian Department of Transport and Planning (June 2025 release).

- Coverage: Metropolitan Melbourne, Geelong, Ballarat and Bendigo.
- Licence: [ODbL](https://opendatacommons.org/licenses/odbl/).
- GeoJSON, 31 MB, downloaded by `data:download` (URL in `BIN_DATASET_URL`).
- It has 8 infrastructure types (shared use path, separated path, protected/buffered/painted lanes…), plus width, hazards (parking, merging traffic, tram lines), direction and the OSM way ID. It has **no surface information**.

GeoJSON was chosen over the Parquet release because PostGIS parses it natively (`ST_GeomFromGeoJSON`), so no GDAL or Parquet library is needed.

### OpenStreetMap

- **Source:** Geofabrik's daily Victoria extract. `victoria-latest.osm.pbf` redirects to a dated snapshot (e.g. `victoria-260928.osm.pbf`, 230 MB); the downloader records that URL, its SHA-256 and MD5 verification in `data/raw/osm/latest.json` and `dataset_imports`.
- **Licence:** © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). This is attributed on the map.
- **Contents:** Victoria has 948k candidate highway ways (318,000 km). About 49% carry a `surface` tag: 62–93% of roads, 32% of footways, 40% of paths.

Pipeline:

1. **`osm:load`** runs [osm2pgsql](https://osm2pgsql.org/) (in Docker, built from Debian's package, so it runs natively on arm64) with a [flex style](backend/db/osm/highways.lua). It loads all highway ways that could be walked, run, ridden or skated into `osm.ways` (id, highway, all tags as JSONB, geometry). Motorways and construction are skipped. This takes about 1 minute for the whole state.
2. **`osm:build`** ([script](backend/scripts/build-osm-network.ts)) runs in one transaction:
   - **Coverage:** clusters the DTP network with `ST_ClusterDBSCAN` and buffers each cluster's convex hull by 1 km. The 12 resulting areas (Melbourne 7,500 km², Geelong, Bendigo, Ballarat, satellite towns) are stored in `coverage_areas`. OSM is only imported inside them.
   - **Classification:** each way is classified in TypeScript ([`classifyOsmWay`](backend/src/domain/osm.ts)). It skips private/no-access ways, driveways, parking aisles and indoor corridors, and maps `highway` + modifiers to a category:

     | OSM | Category |
     | --- | --- |
     | `cycleway`, or `footway`/`path` + `bicycle=designated` | `shared_use_path` |
     | `footway`, `pedestrian`, sealed `path`, sidewalks | `footpath` |
     | other `path` | `trail` |
     | `track`, `bridleway` | `track` |
     | `steps` | `steps` |
     | `residential`, `living_street`, `service`, `unclassified` | `quiet_street` |
     | `tertiary` | `road` |
     | `secondary`, `primary`, `trunk` | `busy_road` |

   - **De-duplication:** an OSM way is skipped if DTP rows with its ID already cover ≥ 90% of its length. Partially covered ways (e.g. a lane on half a street) are kept, so no gaps open up.
   - **Enrichment:** DTP rows get OSM `surface`, `smoothness` and tags by `osm_id`. 99.3% (55,323 of 55,705) match an OSM way, and **77% (42,689) gain a tagged surface**. Most of the rest are on-road lanes along untagged streets, which fall back to the sealed-street inference below. The DTP importer re-applies this on every re-import.

Result: **547,143 OSM segments (75,900 km) + 55,705 DTP segments (8,246 km).**

### Surface model ([`domain/surface.ts`](backend/src/domain/surface.ts))

OSM's ~40 `surface` values are normalised into 7 classes that routing weights key on:

| Class | OSM values (examples) |
| --- | --- |
| `smooth` | asphalt, concrete, tartan |
| `paved` | paved, chipseal |
| `rough_paved` | paving_stones, bricks, sett, cobblestone, wood/boardwalk |
| `compacted` | compacted, fine_gravel |
| `gravel` | gravel, pebblestone, rock |
| `unpaved` | dirt, ground, earth, grass, sand, mud |
| `unknown` | missing or unrecognised |

Multi-valued tags (`asphalt;gravel`, informal `dirt/sand`) take the worst listed surface. **Inference is explicit:** untagged streets and on-road lanes are assumed `paved`, since virtually all urban Victorian streets are sealed and unsealed ones are usually tagged. So are untagged sidewalks. Untagged *off-road* paths stay `unknown`, since they may well be gravel. Inferred surfaces are flagged through to the API and drawn faded on the map. On random inner-Melbourne routes, 97% of distance has a known or inferred surface, and 7.7% of distance is inferred.

The map's surface colouring is generated from the same TypeScript tables as routing ([`surfaceClassSql`](backend/src/domain/surface.ts)), so the two can't drift.

### Schema

See [`backend/db/migrations/`](backend/db/migrations/):

- `paths` holds one row per segment from either source (`source` = `vic_dtp_bin` | `osm`).
  - `geom geometry(LineString, 4326)`, plus a generated Web Mercator `geom_3857` for tiles, both GiST-indexed.
  - `length_m` is measured on the spheroid.
  - Also stored: `surface`, `smoothness` and `osm_tags` (JSONB).
  - A `CHECK` constraint pins `infra_category` to known slugs.
- `coverage_areas`: the regions OSM is imported for.
- `dataset_imports`: provenance for every import (URL, hash, counts).
- `osm.*`: the raw osm2pgsql staging data, recreated by each `osm:load`.

## Routing

### Graph ([`routing/graph.ts`](backend/src/routing/graph.ts))

1. **Junctions:** OSM ways that meet share a node, so any vertex used by more than one segment becomes a graph node. DTP and OSM geometry both come from OSM nodes, so they join exactly where they meet.
2. **Gap bridging (DTP only):** a DTP path often stops a few metres short of the lane it visually meets. From each dangling DTP endpoint, the builder links to the closest point on any line within 15 m with a `connector` edge. OSM segments don't bridge: in OSM a dead end is usually a real dead end, and bridging every cul-de-sac would invent links through fences.
3. **Components** are labelled up front, so impossible requests fail instantly.

### Costs ([`routing/weights.ts`](backend/src/routing/weights.ts))

```
cost = length_m × kindMultiplier × Π hazardMultiplier × surfaceMultiplier
```

All weights live in `RoutingProfile` data:

| Profile | Behaviour |
| --- | --- |
| `prefer_paths` (default) | **Kind:** shared/separated paths ×1.0, protected lanes ×1.2, trails ×1.3, footpaths / buffered lanes ×1.5, quiet streets ×1.6, painted lanes ×1.8, tracks ×1.8, roads ×2.5, busy roads ×4, steps ×6, gap connectors ×3. **Surface:** smooth ×1.0, paved ×1.05, rough paved ×1.2, compacted ×1.3, gravel ×1.7, unpaved ×2, unknown ×1.1. **Hazards:** tram lines ×1.5, merging traffic ×1.3, parking ×1.1. |
| `shortest` | Every metre costs the same, as a baseline |

### Search ([`routing/astar.ts`](backend/src/routing/astar.ts), [`routing/planner.ts`](backend/src/routing/planner.ts))

- **A\*** with a binary heap. The heuristic is great-circle distance × the profile's cheapest cost per metre, which keeps it admissible, so routes are optimal for the profile. A unit test checks it matches Dijkstra.
- Per-node search state is **reused across requests**, and only the entries each search touched are reset. That saves about 17 MB of allocation per route.
- **Snapping:** start and end snap to the nearest point *on* an edge (within 500 m), joined to the graph through virtual nodes. Snaps within 0.5 m of a junction count as the junction.
- **Reachability-aware snapping:** if the nearest edges are in different components, the planner re-snaps to the closest *mutually reachable* edges.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | DB and network status |
| `GET` | `/api/network` | Latest import provenance and graph statistics |
| `GET` | `/api/tiles/paths/{z}/{x}/{y}.pbf` | Vector tile, layer `paths` (z ≥ 8). Properties include `source`, `infra_category`, `surface`, `surface_class`, `surface_inferred`, `smoothness`, `width_m`, `hazards`. |
| `GET` | `/api/routes/profiles` | Routing profiles and their weights |
| `POST` | `/api/routes` | Plan a route |

```http
POST /api/routes
Content-Type: application/json

{ "start": { "lng": 144.9646, "lat": -37.8207 },
  "end":   { "lng": 144.9745, "lat": -37.8676 },
  "profile": "prefer_paths" }
```

This responds with a GeoJSON `Feature<LineString>`. Its `properties` hold:
- `distanceM` and `cost`
- `legs`: consecutive stretches by kind and name
- `distanceByKind` and `distanceBySurface`
- `inferredSurfaceM`
- `snap` distances

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
| `npm test` | Backend unit + HTTP tests (vitest, 108 tests) |
| `npm run typecheck` | Strict `tsc` for both packages |
| `npm run build` | Compile the API to `backend/dist`, bundle the web app to `frontend/dist` |
| `npm run db:up` / `db:down` | Start or stop the PostGIS container (data persists in a Docker volume) |
| `npm run db:migrate` | Apply pending migrations (idempotent) |
| `npm run data:refresh` | Re-download and re-import both datasets |

Configuration comes from the single repo-root `.env`, shared by Docker Compose, the API and Vite. See [`.env.example`](.env.example).

## Known limitations

- **Snapping range:** 87.5% of random inner-Melbourne click pairs now route (up from 45% with DTP data alone), and none fail for lack of connection. The rest are clicks more than 500 m from any path, which is mostly water in the test area.
- **Coverage** follows the DTP regions: Melbourne, Geelong, Ballarat, Bendigo and nearby towns. OSM is imported only within 1 km of those clusters.
- **Surface gaps:** about 3% of routed distance still has unknown ground, mostly untagged off-road paths. OSM `smoothness` is stored and shown but isn't weighted yet; it's meant for the skate profile.
- **One-way lanes are ignored** by both profiles (`respectOneWay: false`, which suits running and walking); the support is there for a cycling mode.
- **Load time:** the API takes about 14 s to build the graph at startup. Routing returns `503 NETWORK_LOADING` until then.
- **Apple Silicon:** the official `postgis/postgis` image is amd64-only, so it runs under emulation. `osm:build` takes about 8 minutes, and low-zoom tiles take about 0.5 s to generate (cached for an hour).

## Roadmap

1. **Activity profiles:** running, walking, cycling and skating as `RoutingProfile` data. Skating would weight `smoothness` and treat steps and unpaved ground as impassable. **Couples mode** would combine two profiles (e.g. the worse multiplier of the two per edge).
2. **Distance-targeted routes and loops:** "10 km loop from here", and 5/10/15/20 km suggestions.
3. **Elevation:** slope costs from a DEM (e.g. Vicmap Elevation) and steep-hill avoidance.
4. **More surface data:** Vicmap sealed/unsealed for rural roads, and City of Melbourne surface condition for the CBD.
5. Road-crossing penalties, GPX export, saved and shared routes, "Explore near me", and a mobile-first UI.
