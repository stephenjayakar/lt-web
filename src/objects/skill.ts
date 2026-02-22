import type { NID, SkillPrefab } from '../data/types';

/**
 * Runtime representation of a skill instance.
 *
 * Skills are component-based: behaviour is determined by which named
 * components are present rather than by a class hierarchy.
 */
export class SkillObject {
  readonly nid: NID;
  readonly name: string;
  readonly desc: string;
  readonly iconNid: NID;
  readonly iconIndex: [number, number];

  /** Component store keyed by component NID. */
  readonly components: Map<string, any>;

  /** Runtime data store for skill state (e.g., torch counters). */
  data: Map<string, any>;

  constructor(prefab: SkillPrefab) {
    this.nid = prefab.nid;
    this.name = prefab.name;
    this.desc = prefab.desc;
    this.iconNid = prefab.icon_nid;
    this.iconIndex = prefab.icon_index;

    this.components = new Map<string, any>();
    for (const [compNid, value] of prefab.components) {
      this.components.set(compNid, value);
    }

    this.data = new Map<string, any>();
  }

  // ------------------------------------------------------------------
  // Component access
  // ------------------------------------------------------------------

  hasComponent(name: string): boolean {
    return this.components.has(name);
  }

  getComponent<T = any>(name: string): T | undefined {
    return this.components.get(name) as T | undefined;
  }
}
