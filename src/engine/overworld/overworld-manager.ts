/**
 * OverworldManager - Manages the overworld map state.
 *
 * Handles nodes, roads, entities, and graph operations for the
 * Fire Emblem 8-style world map. Uses an adjacency list for the
 * node/road graph and Dijkstra for shortest-path queries.
 *
 * Port of: lt-maker/app/engine/overworld/overworld_manager.py
 */

import type { OverworldPrefab } from '../../data/types';
import type {
  OverworldNodeObject,
  RoadObject,
  OverworldEntityObject,
} from './overworld-objects';

export class OverworldManager {
  prefab: OverworldPrefab;
  nodes: Map<string, OverworldNodeObject>;
  roads: Map<string, RoadObject>;
  entities: Map<string, OverworldEntityObject>;
  enabledNodes: Set<string>;
  enabledRoads: Set<string>;
  enabledMenuOptions: Map<string, Map<string, boolean>>;
  visibleMenuOptions: Map<string, Map<string, boolean>>;
  selectedPartyNid: string | null;
  nodeProperties: Map<string, Set<string>>;
  nextLevel: string | null;

  /** Adjacency list: node NID -> Set of road NIDs connected to it */
  private adjacency: Map<string, Set<string>>;

  constructor(prefab: OverworldPrefab) {
    this.prefab = prefab;
    this.nodes = new Map();
    this.roads = new Map();
    this.entities = new Map();
    this.enabledNodes = new Set();
    this.enabledRoads = new Set();
    this.enabledMenuOptions = new Map();
    this.visibleMenuOptions = new Map();
    this.selectedPartyNid = null;
    this.nodeProperties = new Map();
    this.nextLevel = null;
    this.adjacency = new Map();

    this.initializeObjects();
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  /**
   * Build nodes and roads from prefab data.
   */
  initializeObjects(): void {
    // Create nodes
    for (const nodePrefab of this.prefab.overworld_nodes) {
      const node: OverworldNodeObject = {
        prefab: nodePrefab,
        nid: nodePrefab.nid,
        name: nodePrefab.name,
        position: [nodePrefab.pos[0], nodePrefab.pos[1]],
      };
      this.nodes.set(node.nid, node);
      this.adjacency.set(node.nid, new Set());

      // Initialize menu option maps from prefab
      const enabledMap = new Map<string, boolean>();
      const visibleMap = new Map<string, boolean>();
      for (const opt of nodePrefab.menu_options) {
        enabledMap.set(opt.nid, opt.enabled);
        visibleMap.set(opt.nid, opt.visible);
      }
      this.enabledMenuOptions.set(node.nid, enabledMap);
      this.visibleMenuOptions.set(node.nid, visibleMap);
    }

    // Create roads from map_paths
    // Key format: "nodeA-nodeB", value: array of [x, y] waypoints
    for (const [key, points] of Object.entries(this.prefab.map_paths)) {
      const parts = key.split('-');
      if (parts.length < 2) continue;
      const node1 = parts[0];
      const node2 = parts.slice(1).join('-'); // Handle NIDs with dashes

      // Compute total tile length
      let tileLength = 0;
      for (let i = 1; i < points.length; i++) {
        const dx = Math.abs(points[i][0] - points[i - 1][0]);
        const dy = Math.abs(points[i][1] - points[i - 1][1]);
        tileLength += Math.sqrt(dx * dx + dy * dy);
      }

      const road: RoadObject = {
        nid: key,
        node1,
        node2,
        points: points.map(p => [p[0], p[1]] as [number, number]),
        tileLength: Math.max(1, Math.round(tileLength)),
      };
      this.roads.set(key, road);

      // Build adjacency
      if (this.adjacency.has(node1)) {
        this.adjacency.get(node1)!.add(key);
      }
      if (this.adjacency.has(node2)) {
        this.adjacency.get(node2)!.add(key);
      }
    }
  }

  // ========================================================================
  // Graph operations
  // ========================================================================

  /**
   * Enable a node (make it visible/accessible on the map).
   */
  enableNode(nodeNid: string): void {
    this.enabledNodes.add(nodeNid);
  }

  /**
   * Enable a road (make it visible/traversable on the map).
   */
  enableRoad(roadNid: string): void {
    this.enabledRoads.add(roadNid);
  }

  /**
   * Get the other node connected by a road.
   */
  private getOtherNode(road: RoadObject, fromNode: string): string {
    return road.node1 === fromNode ? road.node2 : road.node1;
  }

  /**
   * Get all nodes directly connected to a given node via enabled roads.
   * If force=true, uses all roads regardless of enabled state.
   */
  connectedNodes(nodeNid: string, force: boolean = false): string[] {
    const roadNids = this.adjacency.get(nodeNid);
    if (!roadNids) return [];

    const connected: string[] = [];
    for (const roadNid of roadNids) {
      if (!force && !this.enabledRoads.has(roadNid)) continue;
      const road = this.roads.get(roadNid);
      if (!road) continue;
      const otherNid = this.getOtherNode(road, nodeNid);
      if (!force && !this.enabledNodes.has(otherNid)) continue;
      connected.push(otherNid);
    }
    return connected;
  }

  /**
   * Check if any path exists between two nodes.
   * Uses BFS on the graph of enabled nodes/roads.
   */
  anyPath(n1: string, n2: string, force: boolean = false): boolean {
    if (n1 === n2) return true;
    const visited = new Set<string>();
    const queue = [n1];
    visited.add(n1);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of this.connectedNodes(current, force)) {
        if (neighbor === n2) return true;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    return false;
  }

  /**
   * Find the shortest path between two nodes using Dijkstra.
   * Returns the sequence of RoadObjects to traverse, or null if unreachable.
   */
  shortestPath(n1: string, n2: string, force: boolean = false): RoadObject[] | null {
    if (n1 === n2) return [];

    // Dijkstra
    const dist = new Map<string, number>();
    const prev = new Map<string, { node: string; road: RoadObject } | null>();
    const visited = new Set<string>();

    dist.set(n1, 0);
    prev.set(n1, null);

    // Simple priority queue using array (good enough for small graphs)
    const pq: { node: string; cost: number }[] = [{ node: n1, cost: 0 }];

    while (pq.length > 0) {
      // Extract min
      pq.sort((a, b) => a.cost - b.cost);
      const { node: current, cost: currentCost } = pq.shift()!;

      if (visited.has(current)) continue;
      visited.add(current);

      if (current === n2) break;

      const roadNids = this.adjacency.get(current);
      if (!roadNids) continue;

      for (const roadNid of roadNids) {
        if (!force && !this.enabledRoads.has(roadNid)) continue;
        const road = this.roads.get(roadNid);
        if (!road) continue;

        const neighbor = this.getOtherNode(road, current);
        if (!force && !this.enabledNodes.has(neighbor)) continue;
        if (visited.has(neighbor)) continue;

        const newCost = currentCost + road.tileLength;
        const oldCost = dist.get(neighbor);
        if (oldCost === undefined || newCost < oldCost) {
          dist.set(neighbor, newCost);
          prev.set(neighbor, { node: current, road });
          pq.push({ node: neighbor, cost: newCost });
        }
      }
    }

    // Reconstruct path
    if (!prev.has(n2)) return null;

    const path: RoadObject[] = [];
    let current: string | undefined = n2;
    while (current && current !== n1) {
      const entry = prev.get(current);
      if (!entry) break;
      path.unshift(entry.road);
      current = entry.node;
    }

    return path.length > 0 ? path : null;
  }

  /**
   * Build a flat list of waypoints from n1 to n2 following the shortest path.
   * Returns the full point list concatenated from all roads, or null if no path.
   */
  getPathPoints(n1: string, n2: string, force: boolean = false): [number, number][] | null {
    const roads = this.shortestPath(n1, n2, force);
    if (!roads) return null;
    if (roads.length === 0) {
      const node = this.nodes.get(n1);
      return node ? [node.position] : null;
    }

    const allPoints: [number, number][] = [];
    let currentNode = n1;

    for (const road of roads) {
      const isForward = road.node1 === currentNode;
      const points = isForward ? road.points : [...road.points].reverse();

      // Skip the first point if it duplicates the last point added
      const startIdx = allPoints.length > 0 ? 1 : 0;
      for (let i = startIdx; i < points.length; i++) {
        allPoints.push([points[i][0], points[i][1]]);
      }

      currentNode = isForward ? road.node2 : road.node1;
    }

    return allPoints;
  }

  // ========================================================================
  // Entity operations
  // ========================================================================

  /**
   * Create a new entity on the overworld.
   */
  createEntity(
    nid: string,
    dtype: string,
    dnid: string,
    team: string,
    nodeNid: string | null,
  ): OverworldEntityObject {
    const node = nodeNid ? this.nodes.get(nodeNid) : null;
    const entity: OverworldEntityObject = {
      nid,
      dtype,
      dnid,
      onNode: nodeNid,
      team,
      displayPosition: node ? [node.position[0], node.position[1]] : null,
    };
    this.entities.set(nid, entity);
    return entity;
  }

  /**
   * Move an entity to a specific node (instant).
   */
  movePartyToNode(entityNid: string, nodeNid: string): void {
    const entity = this.entities.get(entityNid);
    if (!entity) return;
    const node = this.nodes.get(nodeNid);
    if (!node) return;
    entity.onNode = nodeNid;
    entity.displayPosition = [node.position[0], node.position[1]];
  }

  /**
   * Remove (disable) an entity from the overworld.
   */
  removeEntity(entityNid: string): void {
    this.entities.delete(entityNid);
    if (this.selectedPartyNid === entityNid) {
      this.selectedPartyNid = null;
    }
  }

  /**
   * Select an entity as the active party.
   */
  selectEntity(entityNid: string): void {
    this.selectedPartyNid = entityNid;
  }

  // ========================================================================
  // Node properties
  // ========================================================================

  setNodeProperty(nodeNid: string, prop: string): void {
    if (!this.nodeProperties.has(nodeNid)) {
      this.nodeProperties.set(nodeNid, new Set());
    }
    this.nodeProperties.get(nodeNid)!.add(prop);
  }

  removeNodeProperty(nodeNid: string, prop: string): void {
    this.nodeProperties.get(nodeNid)?.delete(prop);
  }

  hasNodeProperty(nodeNid: string, prop: string): boolean {
    return this.nodeProperties.get(nodeNid)?.has(prop) ?? false;
  }

  // ========================================================================
  // Menu options
  // ========================================================================

  toggleMenuOptionEnabled(nodeNid: string, optionNid: string, enabled: boolean): void {
    const map = this.enabledMenuOptions.get(nodeNid);
    if (map) map.set(optionNid, enabled);
  }

  toggleMenuOptionVisible(nodeNid: string, optionNid: string, visible: boolean): void {
    const map = this.visibleMenuOptions.get(nodeNid);
    if (map) map.set(optionNid, visible);
  }

  // ========================================================================
  // Queries
  // ========================================================================

  getNode(nid: string): OverworldNodeObject | undefined {
    return this.nodes.get(nid);
  }

  /**
   * Find a node at the given tile position.
   */
  nodeAt(pos: [number, number]): OverworldNodeObject | undefined {
    for (const node of this.nodes.values()) {
      if (node.position[0] === pos[0] && node.position[1] === pos[1]) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Find a node that references a specific level NID.
   */
  nodeByLevel(levelNid: string): OverworldNodeObject | undefined {
    for (const node of this.nodes.values()) {
      if (node.prefab.level === levelNid) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Find an entity at the given position.
   */
  entityAt(pos: [number, number]): OverworldEntityObject | undefined {
    for (const entity of this.entities.values()) {
      if (
        entity.displayPosition &&
        entity.displayPosition[0] === pos[0] &&
        entity.displayPosition[1] === pos[1]
      ) {
        return entity;
      }
    }
    return undefined;
  }

  /**
   * Get the selected party entity, if any.
   */
  getSelectedEntity(): OverworldEntityObject | undefined {
    if (!this.selectedPartyNid) return undefined;
    return this.entities.get(this.selectedPartyNid);
  }

  /**
   * Get the map size in pixels based on the tilemap reference.
   * Falls back to computing bounds from node positions.
   */
  mapSize(): [number, number] {
    let maxX = 0;
    let maxY = 0;
    for (const node of this.nodes.values()) {
      maxX = Math.max(maxX, node.position[0] + 1);
      maxY = Math.max(maxY, node.position[1] + 1);
    }
    // Also check road waypoints
    for (const road of this.roads.values()) {
      for (const p of road.points) {
        maxX = Math.max(maxX, p[0] + 1);
        maxY = Math.max(maxY, p[1] + 1);
      }
    }
    // Add border
    const border = this.prefab.border_tile_width ?? 0;
    return [maxX + border * 2, maxY + border * 2];
  }

  /**
   * Get the bounding box of all nodes.
   */
  mapBounds(): { x: number; y: number; w: number; h: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes.values()) {
      minX = Math.min(minX, node.position[0]);
      minY = Math.min(minY, node.position[1]);
      maxX = Math.max(maxX, node.position[0]);
      maxY = Math.max(maxY, node.position[1]);
    }
    if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
}
