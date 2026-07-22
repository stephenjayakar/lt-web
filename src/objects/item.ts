import type { NID, ItemPrefab } from '../data/types';
import type { UnitObject } from './unit';

/**
 * Runtime representation of an item instance.
 *
 * Items in Lex Talionis are component-based — all behaviour is expressed
 * through named components rather than a type hierarchy.  Common component
 * names include: "weapon", "damage", "hit", "weight", "min_range",
 * "max_range", "weapon_type", "weapon_rank", "value", "uses", etc.
 */
export class ItemObject {
  readonly nid: NID;
  name: string;
  desc: string;
  readonly iconNid: NID;
  readonly iconIndex: [number, number];

  /** Component store keyed by component NID. */
  readonly components: Map<string, any>;

  /** Mutable runtime data populated by item components (uses, counters, event fields). */
  readonly data: Map<string, any>;

  private _owner: UnitObject | null = null;
  /** Child instances for multi_item/sequence_item components. */
  subitems: ItemObject[] = [];
  parentItem: ItemObject | null = null;

  /** Ownership propagates through the complete subitem tree like LT change_owner(). */
  get owner(): UnitObject | null { return this._owner; }
  set owner(value: UnitObject | null) {
    this._owner = value;
    for (const subitem of this.subitems) subitem.owner = value;
  }

  uses: number;
  maxUses: number;

  constructor(prefab: ItemPrefab) {
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

    // Derive uses from the "uses" component if present.
    const usesValue = this.components.get('uses');
    if (usesValue != null) {
      this.maxUses = typeof usesValue === 'number' ? usesValue : Number(usesValue);
      this.uses = this.maxUses;
      this.data.set('starting_uses', this.maxUses);
      this.data.set('uses', this.uses);
    } else {
      const cUsesValue = this.components.get('c_uses');
      if (cUsesValue != null) {
        this.maxUses = typeof cUsesValue === 'number' ? cUsesValue : Number(cUsesValue);
        this.uses = this.maxUses;
        this.data.set('starting_c_uses', this.maxUses);
        this.data.set('c_uses', this.uses);
      } else {
        this.maxUses = 0;
        this.uses = 0;
      }
    }

    const cooldown = this.components.get('cooldown');
    if (typeof cooldown === 'number') {
      this.data.set('cooldown', 0);
      this.data.set('starting_cooldown', cooldown);
    }
  }

  // ------------------------------------------------------------------
  // Generic component access
  // ------------------------------------------------------------------

  hasComponent(name: string): boolean {
    return this.components.has(name);
  }

  getComponent<T = any>(name: string): T | undefined {
    return this.components.get(name) as T | undefined;
  }

  /** Update runtime data while keeping the web uses fields synchronized. */
  setData(key: string, value: any): void {
    this.data.set(key, value);
    if (key === 'uses' || key === 'c_uses') this.uses = Number(value);
    if (key === 'starting_uses' || key === 'starting_c_uses') this.maxUses = Number(value);
  }

  setUses(value: number): void {
    this.uses = value;
    if (this.data.has('uses')) this.data.set('uses', value);
    if (this.data.has('c_uses')) this.data.set('c_uses', value);
  }

  // ------------------------------------------------------------------
  // Common component accessors
  // ------------------------------------------------------------------

  /** True when the item has a "weapon" component (melee or ranged). */
  isWeapon(): boolean {
    return this.components.has('weapon') || this.components.has('siege_weapon');
  }

  getDamage(): number {
    return this.getComponent<number>('damage') ?? 0;
  }

  getHit(): number {
    return this.getComponent<number>('hit') ?? 0;
  }

  getWeight(): number {
    return this.getComponent<number>('weight') ?? 0;
  }

  getMinRange(): number {
    return this.getComponent<number>('min_range') ?? 0;
  }

  getMaxRange(): number {
    return this.getComponent<number>('max_range') ?? 0;
  }

  getWeaponType(): NID | undefined {
    return this.getComponent<NID>('weapon_type');
  }

  getWeaponRank(): string | undefined {
    return this.getComponent<string>('weapon_rank');
  }

  getValue(): number {
    return this.getComponent<number>('value') ?? 0;
  }

  // ------------------------------------------------------------------
  // Type queries
  // ------------------------------------------------------------------

  /** Whether this item has a 'heal' component (consumable heal like Vulnerary). */
  isHealing(): boolean {
    return this.components.has('heal');
  }

  /** Whether this item is a spell (staff or magic). */
  isSpell(): boolean {
    return this.components.has('spell') || this.components.has('magic');
  }

  /** Whether this item is a 'usable' consumable (non-weapon, non-spell). */
  isUsable(): boolean {
    return this.components.has('usable');
  }

  /** Whether this item targets allies (heal staves, Vulneraries). */
  targetsAllies(): boolean {
    return this.components.has('target_ally');
  }

  /** Whether this item has the 'no_ai' flag (AI should not use). */
  hasNoAI(): boolean {
    return this.components.has('no_ai');
  }

  /** Whether this item can heal (has 'heal' or 'equation_heal' component). */
  canHeal(): boolean {
    return this.components.has('heal') || this.components.has('equation_heal');
  }

  /** Whether this item is a stat booster (has 'permanent_stat_change' component). */
  isStatBooster(): boolean {
    return this.components.has('permanent_stat_change');
  }

  /** True for any item that permanently modifies a unit progression record. */
  isPermanentBooster(): boolean {
    return this.hasComponent('permanent_stat_change') ||
      this.hasComponent('permanent_growth_change') ||
      this.hasComponent('permanent_statcap_change') ||
      this.hasComponent('wexp_change');
  }

  /** Whether this item is a consumable (healing or stat booster). */
  isConsumable(): boolean {
    return this.isHealing() || this.isPermanentBooster();
  }

  /** Core targeted effects currently supported by the web item-use lifecycle. */
  hasCoreUseEffect(): boolean {
    const deterministicStatus = !this.hasComponent('hit') &&
      (this.hasComponent('status_on_hit') || this.hasComponent('status_after_combat_on_hit'));
    const directEffect = this.hasComponent('heal') || this.hasComponent('equation_heal') ||
      this.isPermanentBooster() || deterministicStatus || this.hasComponent('restore') ||
      this.hasComponent('restore_specific') || this.hasComponent('refresh') || this.hasComponent('repair') ||
      this.hasComponent('store_unit') || this.hasComponent('unload_unit') ||
      this.hasComponent('promote') || this.hasComponent('force_promote') ||
      this.hasComponent('force_class_change');
    return directEffect || this.subitems.some((subitem) => subitem.hasCoreUseEffect());
  }

  /** Effects that enter combat solely to resolve hit/miss (for example status staves). */
  hasCombatUseEffect(): boolean {
    const hitResolvedStatus = this.hasComponent('hit') &&
      (this.hasComponent('status_on_hit') || this.hasComponent('status_after_combat_on_hit'));
    const steal = this.hasComponent('steal') || this.hasComponent('gba_steal');
    return hitResolvedStatus || steal || this.subitems.some((subitem) => subitem.hasCombatUseEffect());
  }

  /**
   * Get the healing amount for a healing item.
   * The 'heal' component stores the HP to restore.
   * For equation_heal items, returns a default estimate (staff heal = MAG + value).
   */
  getHealAmount(casterMag?: number): number {
    const directHeal = this.getComponent<number>('heal');
    if (directHeal != null) return directHeal;

    // equation_heal staves: estimate heal amount from equation name
    const eqHeal = this.getComponent<string>('equation_heal');
    if (eqHeal && casterMag != null) {
      // Common LT heal equations: HEAL = MAG + some base
      // Return a rough estimate: MAG + 10 for basic, MAG + 20 for Recover
      return casterMag + 10;
    }

    return 0;
  }

  /** Normalize LT Dict components, which serialize as arrays of key/value pairs. */
  getNumericComponentMap(componentNid: string): Record<string, number> {
    const raw = this.getComponent<unknown>(componentNid);
    const entries = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, unknown>)
        : [];
    const result: Record<string, number> = {};
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const value = Number(entry[1]);
      if (Number.isFinite(value)) result[String(entry[0])] = value;
    }
    return result;
  }

  /** Get the normalized stat changes from a permanent stat booster. */
  getStatChanges(): Record<string, number> {
    return this.getNumericComponentMap('permanent_stat_change');
  }

  /** Whether this item is droppable (set during unit creation from starting_items). */
  droppable: boolean = false;

  // ------------------------------------------------------------------
  // Usage
  // ------------------------------------------------------------------

  /** Decrement uses by 1. Returns true if the item is now broken (0 uses). */
  decrementUses(): boolean {
    if (this.maxUses > 0) {
      this.setUses(Math.max(0, this.uses - 1));
      return this.uses <= 0;
    }
    return false;
  }

  /** Whether this item still has uses remaining (or infinite if maxUses is 0). */
  hasUsesRemaining(): boolean {
    return this.maxUses === 0 || this.uses > 0;
  }
}

/** Instantiate a prefab and its recursive multi/sequence children. */
export function createItemTree(
  prefab: ItemPrefab,
  resolvePrefab: (nid: NID) => ItemPrefab | undefined,
  ancestry: Set<NID> = new Set(),
): ItemObject {
  const item = new ItemObject(prefab);
  if (ancestry.has(prefab.nid)) return item;
  const childNids = item.getComponent<NID[]>('multi_item')
    ?? item.getComponent<NID[]>('sequence_item')
    ?? [];
  const nextAncestry = new Set(ancestry).add(prefab.nid);
  for (const childNid of childNids) {
    const childPrefab = resolvePrefab(childNid);
    if (!childPrefab) continue;
    const child = createItemTree(childPrefab, resolvePrefab, nextAncestry);
    child.parentItem = item;
    item.subitems.push(child);
  }
  return item;
}
