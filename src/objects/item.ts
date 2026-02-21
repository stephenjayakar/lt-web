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
  readonly name: string;
  readonly desc: string;
  readonly iconNid: NID;
  readonly iconIndex: [number, number];

  /** Component store keyed by component NID. */
  readonly components: Map<string, any>;

  /** The unit currently holding this item (null if unowned / convoy). */
  owner: UnitObject | null = null;

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

    // Derive uses from the "uses" component if present.
    const usesValue = this.components.get('uses');
    if (usesValue != null) {
      this.maxUses = typeof usesValue === 'number' ? usesValue : Number(usesValue);
      this.uses = this.maxUses;
    } else {
      this.maxUses = 0;
      this.uses = 0;
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

  // ------------------------------------------------------------------
  // Common component accessors
  // ------------------------------------------------------------------

  /** True when the item has a "weapon" component (melee or ranged). */
  isWeapon(): boolean {
    return this.components.has('weapon');
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
    return this.getComponent<number>('min_range') ?? 1;
  }

  getMaxRange(): number {
    return this.getComponent<number>('max_range') ?? 1;
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

  /** Whether this item is a healing consumable (has 'heal' component). */
  isHealing(): boolean {
    return this.components.has('heal');
  }

  /** Whether this item is a stat booster (has 'permanent_stat_change' component). */
  isStatBooster(): boolean {
    return this.components.has('permanent_stat_change');
  }

  /** Whether this item is a consumable (healing or stat booster). */
  isConsumable(): boolean {
    return this.isHealing() || this.isStatBooster();
  }

  /**
   * Get the healing amount for a healing item.
   * The 'heal' component stores the HP to restore.
   */
  getHealAmount(): number {
    return this.getComponent<number>('heal') ?? 0;
  }

  /**
   * Get stat changes from a stat booster item.
   * The 'permanent_stat_change' component is a Record<string, number>.
   */
  getStatChanges(): Record<string, number> {
    return this.getComponent<Record<string, number>>('permanent_stat_change') ?? {};
  }

  /** Whether this item is droppable (set during unit creation from starting_items). */
  droppable: boolean = false;

  // ------------------------------------------------------------------
  // Usage
  // ------------------------------------------------------------------

  /** Decrement uses by 1. Returns true if the item is now broken (0 uses). */
  decrementUses(): boolean {
    if (this.maxUses > 0) {
      this.uses = Math.max(0, this.uses - 1);
      return this.uses <= 0;
    }
    return false;
  }

  /** Whether this item still has uses remaining (or infinite if maxUses is 0). */
  hasUsesRemaining(): boolean {
    return this.maxUses === 0 || this.uses > 0;
  }
}
