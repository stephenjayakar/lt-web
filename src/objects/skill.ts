import type { NID, SkillPrefab } from '../data/types';

/**
 * Module-level per-instance uid counter, mirroring Python's
 * `SkillObject.next_uid`. Seeded to 100 (Python's starting value) and bumped
 * on every construction. GameState persists/restores the counter via
 * `setNextSkillUid` / `getNextSkillUid` so uids stay stable across save/load.
 */
let nextSkillUid = 100;

/** Seed the skill uid counter (used by save restoration). */
export function setNextSkillUid(n: number): void {
  nextSkillUid = Math.max(n, 100);
}

/** Current skill uid counter value (next constructed skill takes this). */
export function getNextSkillUid(): number {
  return nextSkillUid;
}

/**
 * Runtime representation of a skill instance.
 *
 * Skills are component-based: behaviour is determined by which named
 * components are present rather than by a class hierarchy. Each instance
 * carries a stable per-instance `uid` (Python `SkillObject.uid`) so distinct
 * same-NID skills on one or more units retain identity through save/load.
 */
export class SkillObject {
  /** Per-instance identity, stable across save/load (Python `uid`). */
  uid: number;
  readonly nid: NID;
  readonly name: string;
  readonly desc: string;
  readonly iconNid: NID;
  readonly iconIndex: [number, number];

  /** Component store keyed by component NID. */
  components: Map<string, any>;

  /** NID of the unit that initiated/granted this skill (Python `initiator_nid`). */
  initiatorNid: string | null = null;

  /** Runtime data store for skill state (e.g., torch counters). */
  data: Map<string, any>;

  constructor(prefab: SkillPrefab) {
    this.uid = nextSkillUid++;
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

    // Python runs each component's init hook when a skill instance is created.
    // Charge components are stateful and must have their counters before their
    // condition or proc hook is queried.
    const buildCharge = this.components.get('build_charge');
    const drainCharge = this.components.get('drain_charge') ??
      this.components.get('charges_per_turn');
    if (typeof buildCharge === 'number') {
      this.data.set('charge', 0);
      this.data.set('total_charge', buildCharge);
    } else if (typeof drainCharge === 'number') {
      this.data.set('charge', drainCharge);
      this.data.set('total_charge', drainCharge);
    }

    for (const [component, value] of this.components) {
      if ((component === 'time' || component === 'end_time') && typeof value === 'number') {
        this.data.set('turns', value);
        this.data.set('starting_turns', value);
      } else if (component === 'combined_time' && typeof value === 'number') {
        this.data.set('turns', value * 2);
        this.data.set('starting_turns', value * 2);
      }
    }
    if (this.components.has('upkeep_stat_change')) {
      this.data.set('counter', 0);
    }
    const combatExpiry = this.components.get('lost_on_end_next_combat');
    if (Array.isArray(combatExpiry)) {
      const configured = combatExpiry.find((entry: unknown) =>
        Array.isArray(entry) && entry[0] === 'NumberOfCombats (X)');
      this.data.set('combats', String(configured?.[1] ?? '2'));
    }
  }

  /**
   * Override the per-instance uid. Used only by save restoration to restore
   * the exact identity recorded in the save (Python `self.uid = dat['uid']`).
   * Also bumps the module counter so subsequent constructions stay monotonic.
   */
  restoreUid(uid: number): void {
    this.uid = uid;
    if (uid >= nextSkillUid) nextSkillUid = uid + 1;
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
