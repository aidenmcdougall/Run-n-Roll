import type { InfraCategory } from '../domain/infrastructure.js';
import { haversineMeters, type LngLat } from './geo.js';
import { SegmentGrid } from './spatialGrid.js';
import type { EdgeKind } from './weights.js';

export type TravelDirection = 'both' | 'forward' | 'reverse';

/** A path segment as loaded from the database; the graph builder's input. */
export interface PathSegment {
  readonly id: number;
  readonly coordinates: readonly LngLat[];
  readonly category: InfraCategory;
  readonly name: string | null;
  readonly hazards: readonly string[];
  readonly surface: string | null;
  /** Permitted bike travel relative to the coordinate order. */
  readonly direction: TravelDirection;
}

export interface GraphEdge {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly kind: EdgeKind;
  /** Source `paths.id`, or null for synthetic connector edges. */
  readonly pathId: number | null;
  readonly name: string | null;
  readonly hazards: readonly string[];
  readonly surface: string | null;
  readonly direction: TravelDirection;
  readonly lengthM: number;
  /** Geometry from `from` to `to`, inclusive of both node coordinates. */
  readonly coordinates: readonly LngLat[];
}

export interface GraphStats {
  segments: number;
  nodes: number;
  edges: number;
  connectors: number;
  components: number;
  largestComponentNodes: number;
}

export interface RoutingGraph {
  readonly nodes: readonly LngLat[];
  readonly edges: readonly GraphEdge[];
  /** Edge IDs incident to each node (edges are stored once, traversable both ways). */
  readonly adjacency: readonly (readonly number[])[];
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
   * to the nearest other segment. The dataset only contains cycling
   * infrastructure, so a path often stops at a kerb a few metres short of the
   * lane it visually meets; without connectors the network fragments into
   * thousands of islands. Set to 0 to disable.
   */
  connectorToleranceM?: number;
}

export const DEFAULT_CONNECTOR_TOLERANCE_M = 15;

/**
 * Coordinates are keyed at 1e-7° (~1 cm) — the precision OSM stores — so
 * vertices that are the same OSM node compare equal despite float noise.
 */
function coordKey(c: LngLat): string {
  return `${Math.round(c[0] * 1e7)},${Math.round(c[1] * 1e7)}`;
}

function polylineLength(coords: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1]!, coords[i]!);
  return total;
}

interface PendingConnector {
  from: LngLat;
  to: LngLat;
}

/**
 * Converts path segments into a routable, undirected graph.
 *
 * 1. Count how many times each vertex appears across all segments. OSM ways
 *    that meet share a node, so a vertex used more than once is a junction.
 * 2. For each dangling segment end (a vertex nobody else uses), look for
 *    another segment within `connectorToleranceM`. The closest point on it is
 *    inserted as a new vertex (so it becomes a junction) and a connector edge
 *    is queued between the two.
 * 3. Walk every segment, splitting it into edges at junctions and ends.
 * 4. Add connector edges and label connected components.
 */
export function buildGraph(input: readonly PathSegment[], options: BuildGraphOptions = {}): RoutingGraph {
  const tolerance = options.connectorToleranceM ?? DEFAULT_CONNECTOR_TOLERANCE_M;
  const segments = input.filter((s) => s.coordinates.length >= 2);
  // Mutable copies: step 2 may splice extra vertices into them.
  const coords: LngLat[][] = segments.map((s) => [...s.coordinates]);

  // --- 1. vertex usage counts -------------------------------------------------
  const usage = new Map<string, number>();
  for (const line of coords) {
    for (const c of line) {
      const key = coordKey(c);
      usage.set(key, (usage.get(key) ?? 0) + 1);
    }
  }
  const junctions = new Set<string>();
  for (const [key, count] of usage) if (count > 1) junctions.add(key);

  // --- 2. bridge small gaps ----------------------------------------------------
  const connectors: PendingConnector[] = [];
  if (tolerance > 0) {
    const grid = new SegmentGrid((owner, piece) => [coords[owner]![piece]!, coords[owner]![piece + 1]!]);
    coords.forEach((line, owner) => {
      for (let piece = 0; piece < line.length - 1; piece++) grid.insert(owner, piece);
    });

    // Found first, applied afterwards, so every search sees the original lines.
    const insertions: { owner: number; piece: number; t: number; point: LngLat }[] = [];
    const seenPairs = new Set<string>();
    coords.forEach((line, owner) => {
      for (const end of [line[0]!, line[line.length - 1]!]) {
        const endKey = coordKey(end);
        if (junctions.has(endKey)) continue; // already connected to something
        const hit = grid.nearest(end, tolerance, (other) => other !== owner);
        if (!hit) continue;

        // Snap to an existing vertex if the projection lands on one.
        const target = coords[hit.owner]!;
        const { t } = hit.projection;
        const point = t <= 1e-9 ? target[hit.piece]! : t >= 1 - 1e-9 ? target[hit.piece + 1]! : hit.projection.point;
        const pointKey = coordKey(point);
        if (pointKey === endKey) continue;

        // Two facing dangling ends would otherwise produce A→B and B→A.
        const pair = endKey < pointKey ? `${endKey}|${pointKey}` : `${pointKey}|${endKey}`;
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);

        if (point === hit.projection.point) insertions.push({ owner: hit.owner, piece: hit.piece, t, point });
        junctions.add(pointKey);
        junctions.add(endKey);
        connectors.push({ from: end, to: point });
      }
    });

    // Splice from the back of each line so earlier indices stay valid.
    insertions.sort((a, b) => a.owner - b.owner || b.piece - a.piece || b.t - a.t);
    for (const { owner, piece, point } of insertions) coords[owner]!.splice(piece + 1, 0, point);
  }

  // --- 3. split segments into edges ---------------------------------------------
  const nodes: LngLat[] = [];
  const nodeIds = new Map<string, number>();
  const nodeFor = (c: LngLat): number => {
    const key = coordKey(c);
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodes.push(c);
      nodeIds.set(key, id);
    }
    return id;
  };

  const edges: GraphEdge[] = [];
  const addEdge = (edge: Omit<GraphEdge, 'id'>): void => {
    edges.push({ ...edge, id: edges.length });
  };

  segments.forEach((segment, index) => {
    const line = coords[index]!;
    let startNode = nodeFor(line[0]!);
    let run: LngLat[] = [line[0]!];
    for (let i = 1; i < line.length; i++) {
      const c = line[i]!;
      if (coordKey(c) === coordKey(run[run.length - 1]!)) continue; // duplicate vertex
      run.push(c);
      const isLast = i === line.length - 1;
      if (!isLast && !junctions.has(coordKey(c))) continue;
      const endNode = nodeFor(c);
      addEdge({
        from: startNode,
        to: endNode,
        kind: segment.category,
        pathId: segment.id,
        name: segment.name,
        hazards: segment.hazards,
        surface: segment.surface,
        direction: segment.direction,
        lengthM: polylineLength(run),
        coordinates: run,
      });
      startNode = endNode;
      run = [c];
    }
  });

  // --- 4. connectors, adjacency, components -------------------------------------
  for (const { from, to } of connectors) {
    addEdge({
      from: nodeFor(from),
      to: nodeFor(to),
      kind: 'connector',
      pathId: null,
      name: null,
      hazards: [],
      surface: null,
      direction: 'both',
      lengthM: haversineMeters(from, to),
      coordinates: [from, to],
    });
  }

  const adjacency: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    adjacency[edge.from]!.push(edge.id);
    if (edge.to !== edge.from) adjacency[edge.to]!.push(edge.id);
  }

  const { componentOf, componentCount, largest, largestLabel } = labelComponents(nodes.length, edges, adjacency);

  const edgeIndex = new SegmentGrid((owner, piece) => {
    const c = edges[owner]!.coordinates;
    return [c[piece]!, c[piece + 1]!];
  });
  for (const edge of edges) {
    for (let piece = 0; piece < edge.coordinates.length - 1; piece++) edgeIndex.insert(edge.id, piece);
  }

  return {
    nodes,
    edges,
    adjacency,
    componentOf,
    largestComponent: largestLabel,
    edgeIndex,
    stats: {
      segments: segments.length,
      nodes: nodes.length,
      edges: edges.length,
      connectors: connectors.length,
      components: componentCount,
      largestComponentNodes: largest,
    },
  };
}

/** Iterative flood fill (recursion would overflow on long chains of nodes). */
function labelComponents(
  nodeCount: number,
  edges: readonly GraphEdge[],
  adjacency: readonly (readonly number[])[],
): { componentOf: Int32Array; componentCount: number; largest: number; largestLabel: number } {
  const componentOf = new Int32Array(nodeCount).fill(-1);
  let componentCount = 0;
  let largest = 0;
  let largestLabel = -1;
  const stack: number[] = [];
  for (let seed = 0; seed < nodeCount; seed++) {
    if (componentOf[seed] !== -1) continue;
    const label = componentCount++;
    let size = 0;
    componentOf[seed] = label;
    stack.push(seed);
    while (stack.length > 0) {
      const node = stack.pop()!;
      size++;
      for (const edgeId of adjacency[node]!) {
        const edge = edges[edgeId]!;
        const next = edge.from === node ? edge.to : edge.from;
        if (componentOf[next] === -1) {
          componentOf[next] = label;
          stack.push(next);
        }
      }
    }
    if (size > largest) {
      largest = size;
      largestLabel = label;
    }
  }
  return { componentOf, componentCount, largest, largestLabel };
}
