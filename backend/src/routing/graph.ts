import type { InfraCategory } from '../domain/infrastructure.js';
import { SURFACE_CLASSES, type SurfaceClass } from '../domain/surface.js';
import { haversineXY, type LngLat } from './geo.js';
import { SegmentGrid, type PieceSource } from './spatialGrid.js';
import { EDGE_KINDS, type EdgeKind } from './weights.js';

export type TravelDirection = 'both' | 'forward' | 'reverse';
const DIRECTIONS: readonly TravelDirection[] = ['both', 'forward', 'reverse'];

/** A path segment as loaded from the database; the graph builder's input. */
export interface PathSegment {
  readonly id: number;
  /** Flat WGS84 coordinates: [lng0, lat0, lng1, lat1, ...]. */
  readonly coordinates: Float64Array;
  readonly category: InfraCategory;
  readonly name: string | null;
  readonly hazards: readonly string[];
  /** Normalised ground type used for costing. */
  readonly surfaceClass: SurfaceClass;
  /** True when `surfaceClass` was assumed rather than tagged. */
  readonly surfaceInferred: boolean;
  /** Permitted bike travel relative to the coordinate order. */
  readonly direction: TravelDirection;
  /**
   * Whether this segment's dangling ends may be bridged to nearby lines with
   * connector edges. True for the DTP data, whose gaps are artefacts of only
   * mapping bike infrastructure; false for OSM, where a dead end is usually
   * a real dead end.
   */
  readonly bridgeGaps: boolean;
}

/** A materialised view of one edge. Build with `getEdge`; don't hold millions. */
export interface GraphEdge {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly kind: EdgeKind;
  /** Source `paths.id`, or null for synthetic connector edges. */
  readonly pathId: number | null;
  readonly name: string | null;
  readonly hazards: readonly string[];
  readonly surfaceClass: SurfaceClass;
  readonly surfaceInferred: boolean;
  readonly direction: TravelDirection;
  readonly lengthM: number;
  /** Geometry from `from` to `to`, inclusive of both node coordinates. */
  readonly coordinates: LngLat[];
}

export interface GraphStats {
  segments: number;
  nodes: number;
  edges: number;
  connectors: number;
  components: number;
  largestComponentNodes: number;
}

/**
 * Routable, undirected graph in struct-of-arrays form.
 *
 * With ~1M nodes and ~1.5M edges, one JS object per edge (plus an array per
 * coordinate) costs gigabytes. Typed arrays hold the same data in a few
 * hundred megabytes and are faster to scan. Use `getEdge`, `edgeCoordinates`
 * and `nodeCoordinate` for convenient access to a few elements; hot loops
 * read the arrays directly.
 */
export interface RoutingGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Node coordinates: [lng0, lat0, lng1, lat1, ...]. */
  readonly nodeCoords: Float64Array;

  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLength: Float64Array;
  /** Index into EDGE_KINDS. */
  readonly edgeKind: Uint8Array;
  /** Index into SURFACE_CLASSES. */
  readonly edgeSurface: Uint8Array;
  /** Bit 0: surface inferred. Bits 1–2: index into DIRECTIONS. */
  readonly edgeFlags: Uint8Array;
  /** Source `paths.id`, or -1 for connectors. */
  readonly edgePathId: Int32Array;
  /** Index into `names`, or -1. */
  readonly edgeName: Int32Array;
  /** Index into `hazardSets` (0 = no hazards). */
  readonly edgeHazards: Uint16Array;
  readonly names: readonly string[];
  readonly hazardSets: readonly (readonly string[])[];

  /** Edge i's geometry is points geomOffset[i] .. geomOffset[i+1]-1. */
  readonly geomOffset: Int32Array;
  /** Edge geometry as fixed-point degrees × 1e7 (OSM's precision): [lng, lat, ...]. */
  readonly geomCoords: Int32Array;

  /** CSR adjacency: node n's incident edges are adjEdges[adjOffset[n] .. adjOffset[n+1]-1]. */
  readonly adjOffset: Int32Array;
  readonly adjEdges: Int32Array;

  /** Connected-component label per node, for fast "no route possible" checks. */
  readonly componentOf: Int32Array;
  /** Label of the component with the most nodes (the main network). */
  readonly largestComponent: number;
  /** Spatial index over edge geometry, for snapping arbitrary points to the network. */
  readonly edgeIndex: SegmentGrid;
  readonly stats: GraphStats;
}

export interface BuildGraphOptions {
  /**
   * Maximum gap (m) bridged by a connector edge from a dangling segment end
   * to the nearest other segment. The DTP dataset only contains cycling
   * infrastructure, so a path often stops at a kerb a few metres short of the
   * lane it visually meets. Only applies to segments with `bridgeGaps`.
   * Set to 0 to disable.
   */
  connectorToleranceM?: number;
}

export const DEFAULT_CONNECTOR_TOLERANCE_M = 15;

const FIXED = 1e7;
const INFERRED_BIT = 1;

/**
 * Rounds a coordinate to the stored fixed-point precision. Lengths are
 * measured on quantised coordinates so that they agree exactly with the
 * stored geometry (otherwise sub-micrometre discrepancies leak into routes).
 */
const quantise = (degrees: number): number => Math.round(degrees * FIXED) / FIXED;

// --- accessors ---------------------------------------------------------------

export function nodeCoordinate(graph: RoutingGraph, node: number): LngLat {
  return [graph.nodeCoords[node * 2]!, graph.nodeCoords[node * 2 + 1]!];
}

export function edgeCoordinates(graph: RoutingGraph, edge: number): LngLat[] {
  const out: LngLat[] = [];
  for (let p = graph.geomOffset[edge]!; p < graph.geomOffset[edge + 1]!; p++) {
    out.push([graph.geomCoords[p * 2]! / FIXED, graph.geomCoords[p * 2 + 1]! / FIXED]);
  }
  return out;
}

export function edgeDirection(graph: RoutingGraph, edge: number): TravelDirection {
  return DIRECTIONS[(graph.edgeFlags[edge]! >> 1) & 3]!;
}

export function getEdge(graph: RoutingGraph, id: number): GraphEdge {
  const pathId = graph.edgePathId[id]!;
  const name = graph.edgeName[id]!;
  return {
    id,
    from: graph.edgeFrom[id]!,
    to: graph.edgeTo[id]!,
    kind: EDGE_KINDS[graph.edgeKind[id]!]!,
    pathId: pathId < 0 ? null : pathId,
    name: name < 0 ? null : graph.names[name]!,
    hazards: graph.hazardSets[graph.edgeHazards[id]!]!,
    surfaceClass: SURFACE_CLASSES[graph.edgeSurface[id]!]!,
    surfaceInferred: (graph.edgeFlags[id]! & INFERRED_BIT) !== 0,
    direction: edgeDirection(graph, id),
    lengthM: graph.edgeLength[id]!,
    coordinates: edgeCoordinates(graph, id),
  };
}

// --- building helpers --------------------------------------------------------

type CoordKey = number | string;

/**
 * Builds a function that maps a coordinate to an exact, hashable key at 1e-7°
 * (~1 cm, the precision OSM stores), so vertices that are the same OSM node
 * compare equal despite float noise. Within a region the size of Victoria
 * the key fits exactly in a JS number (far cheaper than a string key);
 * larger extents fall back to strings.
 */
function makeCoordKeyer(segments: readonly PathSegment[]): (lng: number, lat: number) => CoordKey {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const s of segments) {
    for (let i = 0; i < s.coordinates.length; i += 2) {
      const lng = Math.round(s.coordinates[i]! * FIXED);
      const lat = Math.round(s.coordinates[i + 1]! * FIXED);
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  const latSpan = maxLat - minLat + 1;
  if ((maxLng - minLng + 1) * latSpan < Number.MAX_SAFE_INTEGER) {
    return (lng, lat) => (Math.round(lng * FIXED) - minLng) * latSpan + (Math.round(lat * FIXED) - minLat);
  }
  return (lng, lat) => `${Math.round(lng * FIXED)},${Math.round(lat * FIXED)}`;
}

type NumericArray = Int32Array | Float64Array | Uint8Array | Uint16Array;

/** Append-only typed array that doubles its capacity as needed. */
class Growable<T extends NumericArray> {
  length = 0;
  constructor(
    private data: T,
    private readonly make: (size: number) => T,
  ) {}
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = this.make(Math.max(16, this.data.length * 2));
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }
  /** Returns a right-sized copy. */
  finish(): T {
    return this.data.slice(0, this.length) as T;
  }
}

const growInt32 = (n: number) => new Growable(new Int32Array(n), (size) => new Int32Array(size));
const growFloat64 = (n: number) => new Growable(new Float64Array(n), (size) => new Float64Array(size));
const growUint8 = (n: number) => new Growable(new Uint8Array(n), (size) => new Uint8Array(size));
const growUint16 = (n: number) => new Growable(new Uint16Array(n), (size) => new Uint16Array(size));

/** Deduplicates values (names, hazard sets) into an index table. */
class Interner<T> {
  readonly values: T[] = [];
  private readonly index = new Map<string, number>();
  intern(key: string, value: T): number {
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.values.length;
      this.values.push(value);
      this.index.set(key, id);
    }
    return id;
  }
}

interface EdgeAttributes {
  kind: EdgeKind;
  pathId: number;
  name: string | null;
  hazards: readonly string[];
  surfaceClass: SurfaceClass;
  surfaceInferred: boolean;
  direction: TravelDirection;
}

const CONNECTOR_ATTRIBUTES: EdgeAttributes = {
  kind: 'connector',
  pathId: -1,
  name: null,
  hazards: [],
  surfaceClass: 'unknown',
  surfaceInferred: false,
  direction: 'both',
};

// --- building ------------------------------------------------------------------

/**
 * Converts path segments into a routable, undirected graph.
 *
 * 1. Count how many times each vertex appears across all segments. OSM ways
 *    that meet share a node, so a vertex used more than once is a junction.
 * 2. For each dangling end of a segment with `bridgeGaps`, look for another
 *    segment within `connectorToleranceM`. The closest point on it is
 *    inserted as a new vertex (so it becomes a junction) and a connector edge
 *    is queued between the two.
 * 3. Walk every segment, splitting it into edges at junctions and ends.
 * 4. Add connector edges, build CSR adjacency, and label components.
 */
export function buildGraph(input: readonly PathSegment[], options: BuildGraphOptions = {}): RoutingGraph {
  const tolerance = options.connectorToleranceM ?? DEFAULT_CONNECTOR_TOLERANCE_M;
  const segments = input.filter((s) => s.coordinates.length >= 4);
  // Per-segment coordinates; step 2 may replace a few with spliced copies.
  const coords: Float64Array[] = segments.map((s) => s.coordinates);
  const keyOf = makeCoordKeyer(segments);

  // --- 1. vertex usage counts -------------------------------------------------
  const junctions = new Set<CoordKey>();
  {
    const usage = new Map<CoordKey, number>();
    for (const line of coords) {
      for (let i = 0; i < line.length; i += 2) {
        const key = keyOf(line[i]!, line[i + 1]!);
        usage.set(key, (usage.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of usage) if (count > 1) junctions.add(key);
  }

  // --- 2. bridge small gaps ----------------------------------------------------
  const connectors: number[] = []; // flat [fromLng, fromLat, toLng, toLat, ...]
  if (tolerance > 0 && segments.some((s) => s.bridgeGaps)) {
    const grid = SegmentGrid.build({
      ownerCount: coords.length,
      pieceCount: (owner) => coords[owner]!.length / 2 - 1,
      readPiece: (owner, piece, out) => out.set(coords[owner]!.subarray(piece * 2, piece * 2 + 4)),
    });

    // Found first, applied afterwards, so every search sees the original lines.
    const insertions: { owner: number; piece: number; t: number; lng: number; lat: number }[] = [];
    const seenPairs = new Set<string>();
    segments.forEach((segment, owner) => {
      if (!segment.bridgeGaps) return;
      const line = coords[owner]!;
      for (const at of [0, line.length - 2]) {
        const end: LngLat = [line[at]!, line[at + 1]!];
        const endKey = keyOf(end[0], end[1]);
        if (junctions.has(endKey)) continue; // already connected to something
        const hit = grid.nearest(end, tolerance, (other) => other !== owner);
        if (!hit) continue;

        // Snap to an existing vertex if the projection lands on one.
        const target = coords[hit.owner]!;
        const { t } = hit.projection;
        const vertex = t <= 1e-9 ? hit.piece : t >= 1 - 1e-9 ? hit.piece + 1 : -1;
        const lng = vertex >= 0 ? target[vertex * 2]! : hit.projection.point[0];
        const lat = vertex >= 0 ? target[vertex * 2 + 1]! : hit.projection.point[1];
        const pointKey = keyOf(lng, lat);
        if (pointKey === endKey) continue;

        // Two facing dangling ends would otherwise produce A→B and B→A.
        const pair = endKey < pointKey ? `${endKey}|${pointKey}` : `${pointKey}|${endKey}`;
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);

        if (vertex < 0) insertions.push({ owner: hit.owner, piece: hit.piece, t, lng, lat });
        junctions.add(pointKey);
        junctions.add(endKey);
        connectors.push(end[0], end[1], lng, lat);
      }
    });

    // Splice inserted vertices into copies of the affected lines.
    const byOwner = new Map<number, typeof insertions>();
    for (const ins of insertions) {
      let list = byOwner.get(ins.owner);
      if (!list) byOwner.set(ins.owner, (list = []));
      list.push(ins);
    }
    for (const [owner, list] of byOwner) {
      list.sort((a, b) => a.piece - b.piece || a.t - b.t);
      const line = coords[owner]!;
      const out = new Float64Array(line.length + list.length * 2);
      let o = 0;
      let next = 0;
      for (let v = 0; v < line.length / 2; v++) {
        out[o++] = line[v * 2]!;
        out[o++] = line[v * 2 + 1]!;
        // Insertions on piece v lie between vertex v and v + 1.
        while (next < list.length && list[next]!.piece === v) {
          out[o++] = list[next]!.lng;
          out[o++] = list[next]!.lat;
          next++;
        }
      }
      coords[owner] = out;
    }
  }

  // --- 3. split segments into edges ---------------------------------------------
  const totalPoints = coords.reduce((sum, line) => sum + line.length / 2, 0);
  const nodeIds = new Map<CoordKey, number>();
  const nodeCoords = growFloat64(totalPoints);
  const nodeFor = (lng: number, lat: number, key: CoordKey): number => {
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodeCoords.length / 2;
      nodeCoords.push(lng);
      nodeCoords.push(lat);
      nodeIds.set(key, id);
    }
    return id;
  };

  const edgeFrom = growInt32(totalPoints);
  const edgeTo = growInt32(totalPoints);
  const edgeLength = growFloat64(totalPoints);
  const edgeKind = growUint8(totalPoints);
  const edgeSurface = growUint8(totalPoints);
  const edgeFlags = growUint8(totalPoints);
  const edgePathId = growInt32(totalPoints);
  const edgeName = growInt32(totalPoints);
  const edgeHazards = growUint16(totalPoints);
  const geomOffset = growInt32(totalPoints + 1);
  const geomCoords = growInt32(totalPoints * 2);
  const names = new Interner<string>();
  const hazardSets = new Interner<readonly string[]>();
  hazardSets.intern('', []); // index 0 = no hazards
  geomOffset.push(0);

  const kindIndex = new Map(EDGE_KINDS.map((kind, i) => [kind, i]));
  const surfaceIndex = new Map(SURFACE_CLASSES.map((surface, i) => [surface, i]));

  /** Closes an edge whose geometry is every point pushed since the last edge. */
  const addEdge = (from: number, to: number, lengthM: number, attrs: EdgeAttributes): void => {
    edgeFrom.push(from);
    edgeTo.push(to);
    edgeLength.push(lengthM);
    edgeKind.push(kindIndex.get(attrs.kind)!);
    edgeSurface.push(surfaceIndex.get(attrs.surfaceClass)!);
    edgeFlags.push((attrs.surfaceInferred ? INFERRED_BIT : 0) | (DIRECTIONS.indexOf(attrs.direction) << 1));
    edgePathId.push(attrs.pathId);
    edgeName.push(attrs.name === null ? -1 : names.intern(attrs.name, attrs.name));
    edgeHazards.push(attrs.hazards.length === 0 ? 0 : hazardSets.intern(attrs.hazards.join(','), attrs.hazards));
    geomOffset.push(geomCoords.length / 2);
  };
  const pushPoint = (lng: number, lat: number): void => {
    geomCoords.push(Math.round(lng * FIXED));
    geomCoords.push(Math.round(lat * FIXED));
  };

  segments.forEach((segment, index) => {
    const line = coords[index]!;
    const attrs: EdgeAttributes = {
      kind: segment.category,
      pathId: segment.id,
      name: segment.name,
      hazards: segment.hazards,
      surfaceClass: segment.surfaceClass,
      surfaceInferred: segment.surfaceInferred,
      direction: segment.direction,
    };
    let prevLng = quantise(line[0]!);
    let prevLat = quantise(line[1]!);
    let prevKey = keyOf(prevLng, prevLat);
    let startNode = nodeFor(prevLng, prevLat, prevKey);
    let runPoints = 1;
    let runLength = 0;
    pushPoint(prevLng, prevLat);

    const vertexCount = line.length / 2;
    for (let v = 1; v < vertexCount; v++) {
      const lng = quantise(line[v * 2]!);
      const lat = quantise(line[v * 2 + 1]!);
      const key = keyOf(lng, lat);
      if (key === prevKey) continue; // duplicate consecutive vertex
      runLength += haversineXY(prevLng, prevLat, lng, lat);
      pushPoint(lng, lat);
      runPoints++;
      prevLng = lng;
      prevLat = lat;
      prevKey = key;
      if (v < vertexCount - 1 && junctions.has(key)) {
        // Close the edge at this junction; the next edge starts here.
        const endNode = nodeFor(lng, lat, key);
        addEdge(startNode, endNode, runLength, attrs);
        startNode = endNode;
        runLength = 0;
        runPoints = 1;
        pushPoint(lng, lat);
      }
    }
    if (runPoints >= 2) addEdge(startNode, nodeFor(prevLng, prevLat, prevKey), runLength, attrs);
    else geomCoords.length -= 2; // the run never left its first point: drop it
  });

  // --- 4. connectors, adjacency, components -------------------------------------
  for (let c = 0; c < connectors.length; c += 4) {
    const aLng = quantise(connectors[c]!);
    const aLat = quantise(connectors[c + 1]!);
    const bLng = quantise(connectors[c + 2]!);
    const bLat = quantise(connectors[c + 3]!);
    const from = nodeFor(aLng, aLat, keyOf(aLng, aLat));
    const to = nodeFor(bLng, bLat, keyOf(bLng, bLat));
    pushPoint(aLng, aLat);
    pushPoint(bLng, bLat);
    addEdge(from, to, haversineXY(aLng, aLat, bLng, bLat), CONNECTOR_ATTRIBUTES);
  }
  nodeIds.clear();
  junctions.clear();

  const nodeCount = nodeCoords.length / 2;
  const edgeCount = edgeFrom.length;
  const from = edgeFrom.finish();
  const to = edgeTo.finish();

  // CSR adjacency: count degrees, prefix-sum, then fill.
  const adjOffset = new Int32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    adjOffset[from[e]! + 1]!++;
    if (to[e] !== from[e]) adjOffset[to[e]! + 1]!++;
  }
  for (let n = 0; n < nodeCount; n++) adjOffset[n + 1]! += adjOffset[n]!;
  const adjEdges = new Int32Array(adjOffset[nodeCount]!);
  const fill = adjOffset.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    adjEdges[fill[from[e]!]!++] = e;
    if (to[e] !== from[e]) adjEdges[fill[to[e]!]!++] = e;
  }

  const components = labelComponents(nodeCount, from, to, adjOffset, adjEdges);

  const geomOffsetArr = geomOffset.finish();
  const geomCoordsArr = geomCoords.finish();

  return {
    nodeCount,
    edgeCount,
    nodeCoords: nodeCoords.finish(),
    edgeFrom: from,
    edgeTo: to,
    edgeLength: edgeLength.finish(),
    edgeKind: edgeKind.finish(),
    edgeSurface: edgeSurface.finish(),
    edgeFlags: edgeFlags.finish(),
    edgePathId: edgePathId.finish(),
    edgeName: edgeName.finish(),
    edgeHazards: edgeHazards.finish(),
    names: names.values,
    hazardSets: hazardSets.values,
    geomOffset: geomOffsetArr,
    geomCoords: geomCoordsArr,
    adjOffset,
    adjEdges,
    componentOf: components.componentOf,
    largestComponent: components.largestLabel,
    edgeIndex: SegmentGrid.build(edgePieceSource(edgeCount, geomOffsetArr, geomCoordsArr)),
    stats: {
      segments: segments.length,
      nodes: nodeCount,
      edges: edgeCount,
      connectors: connectors.length / 4,
      components: components.count,
      largestComponentNodes: components.largest,
    },
  };
}

/**
 * Piece source over the final edge geometry, for the long-lived edge index.
 *
 * Deliberately a separate function: V8 closures share their enclosing
 * function's context, so defining these inside `buildGraph` would keep every
 * temporary build buffer alive for as long as the graph exists (~1 GB).
 */
function edgePieceSource(edgeCount: number, geomOffset: Int32Array, geomCoords: Int32Array): PieceSource {
  return {
    ownerCount: edgeCount,
    pieceCount: (edge) => geomOffset[edge + 1]! - geomOffset[edge]! - 1,
    readPiece: (edge, piece, out) => {
      const p = (geomOffset[edge]! + piece) * 2;
      out[0] = geomCoords[p]! / FIXED;
      out[1] = geomCoords[p + 1]! / FIXED;
      out[2] = geomCoords[p + 2]! / FIXED;
      out[3] = geomCoords[p + 3]! / FIXED;
    },
  };
}

/** Iterative flood fill over CSR adjacency (recursion would overflow). */
function labelComponents(
  nodeCount: number,
  from: Int32Array,
  to: Int32Array,
  adjOffset: Int32Array,
  adjEdges: Int32Array,
): { componentOf: Int32Array; count: number; largest: number; largestLabel: number } {
  const componentOf = new Int32Array(nodeCount).fill(-1);
  const stack = new Int32Array(nodeCount);
  let count = 0;
  let largest = 0;
  let largestLabel = -1;
  for (let seed = 0; seed < nodeCount; seed++) {
    if (componentOf[seed] !== -1) continue;
    const label = count++;
    let size = 0;
    let top = 0;
    componentOf[seed] = label;
    stack[top++] = seed;
    while (top > 0) {
      const node = stack[--top]!;
      size++;
      for (let i = adjOffset[node]!; i < adjOffset[node + 1]!; i++) {
        const e = adjEdges[i]!;
        const next = from[e] === node ? to[e]! : from[e]!;
        if (componentOf[next] === -1) {
          componentOf[next] = label;
          stack[top++] = next;
        }
      }
    }
    if (size > largest) {
      largest = size;
      largestLabel = label;
    }
  }
  return { componentOf, count, largest, largestLabel };
}
