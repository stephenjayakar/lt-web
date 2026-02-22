/**
 * overworld-objects.ts - Runtime object types for the overworld map system.
 *
 * These are the live objects created from OverworldPrefab data.
 * Nodes represent locations on the world map, roads connect them,
 * and entities are parties/units that move between nodes.
 */

import type { OverworldNodePrefab } from '../../data/types';

export interface OverworldNodeObject {
  prefab: OverworldNodePrefab;
  nid: string;
  name: string;
  position: [number, number];
}

export interface RoadObject {
  nid: string;
  /** The two node NIDs this road connects. */
  node1: string;
  node2: string;
  /** Waypoints along the road path (pixel/tile positions). */
  points: [number, number][];
  /** Total length of the road in tiles (Manhattan approximation). */
  tileLength: number;
}

export const OVERWORLD_ENTITY_TYPES = {
  PARTY: 'party',
  UNIT: 'unit',
} as const;

export interface OverworldEntityObject {
  nid: string;
  dtype: string;  // 'party' | 'unit'
  dnid: string;   // party or unit NID
  onNode: string | null;  // node NID
  team: string;
  displayPosition: [number, number] | null;
}
