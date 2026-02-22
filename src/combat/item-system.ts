/**
 * item_system.ts — Dispatch layer for item component hooks.
 *
 * Mirrors LT's generated item_system.py. For each hook, iterates the
 * item's components and resolves the result via the appropriate policy
 * (UNIQUE, ALL_DEFAULT_FALSE, NUMERIC_ACCUM, etc.).
 *
 * Components are stored as Map<string, any> on ItemObject. The component
 * NID determines behaviour; the value is the stored data.
 */

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';

// ============================================================
// Value hooks (UNIQUE — return the first/only defined value)
// ============================================================

/** Get the weapon type NID, or undefined. */
export function weaponType(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('weapon_type');
}

/** Get base damage value from the weapon. */
export function damage(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('damage') ?? null;
}

/** Get base hit value from the weapon. */
export function hit(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('hit') ?? null;
}

/** Get base crit value from the weapon. */
export function crit(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('crit') ?? null;
}

/** Get the minimum range. */
export function minimumRange(_unit: UnitObject, item: ItemObject): number {
  return item.getComponent<number>('min_range') ?? 0;
}

/** Get the maximum range. */
export function maximumRange(_unit: UnitObject, item: ItemObject): number {
  return item.getComponent<number>('max_range') ?? 0;
}

/** Get the weapon rank requirement. */
export function weaponRank(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('weapon_rank');
}

/** Get the weight of the item. */
export function weight(_unit: UnitObject, item: ItemObject): number {
  return item.getComponent<number>('weight') ?? 0;
}

// ============================================================
// Boolean hooks (ALL_DEFAULT_FALSE)
// ============================================================

/** Is this a weapon? */
export function isWeapon(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('weapon');
}

/** Is this a spell/magic weapon? */
export function isSpell(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('spell') || item.hasComponent('magic');
}

/** Can this item counter? */
export function canCounter(_unit: UnitObject, item: ItemObject): boolean {
  // Default true for weapons unless 'no_counter' is set
  if (!item.hasComponent('weapon')) return false;
  if (item.hasComponent('no_counter')) return false;
  return true;
}

/** Can this item be countered? */
export function canBeCountered(_unit: UnitObject, item: ItemObject): boolean {
  if (item.hasComponent('cannot_be_countered')) return false;
  return true;
}

/** Can this weapon double? */
export function canDouble(_unit: UnitObject, item: ItemObject): boolean {
  if (item.hasComponent('cannot_double')) return false;
  return true;
}

/** Does this item ignore weapon advantage? */
export function ignoreWeaponAdvantage(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('ignore_weapon_advantage');
}

// ============================================================
// Static modifier hooks (NUMERIC_ACCUM — sum all contributions)
// ============================================================

/** Bonus damage from item components. */
export function modifyDamage(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  // 'modify_damage' component on the item itself
  const mod = item.getComponent<number>('modify_damage');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus resist/defense from item components. */
export function modifyResist(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_resist');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus accuracy from item components. */
export function modifyAccuracy(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_accuracy');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus avoid from item components. */
export function modifyAvoid(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_avoid');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus crit accuracy from item components. */
export function modifyCritAccuracy(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_crit_accuracy');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus crit damage from item components. */
export function modifyCritDamage(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_crit_damage');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Attack speed modifier from item components (e.g., from weight). */
export function modifyAttackSpeed(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_attack_speed');
  if (typeof mod === 'number') total += mod;
  return total;
}

// ============================================================
// Dynamic modifier hooks (NUMERIC_ACCUM with combat context)
// ============================================================

/**
 * Dynamic damage modifier — effective damage, situational bonuses, etc.
 * Called during combat with full attacker/defender context.
 */
export function dynamicDamage(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;

  // Effective damage: check if the weapon is effective against the target
  const effectiveComp = item.getComponent<any>('effective');
  if (effectiveComp) {
    const tags: string[] = effectiveComp.effective_tags ?? effectiveComp ?? [];
    const multiplier: number = effectiveComp.effective_multiplier ?? 3;
    const bonusDamage: number = effectiveComp.effective_bonus_damage ?? 0;

    // Check if target has any of the effective tags
    const targetTags = target.tags ?? [];
    const isEffective = (Array.isArray(tags) ? tags : []).some(
      (tag: string) => targetTags.includes(tag),
    );

    if (isEffective) {
      if (effectiveComp.weapon_effectiveness_multiplied) {
        // Multiply the weapon's base damage
        const weaponDmg = item.getDamage();
        total += weaponDmg * (multiplier - 1); // -1 because base is already counted
      }
      total += bonusDamage;
    }
  }

  // Brave component: handled via dynamicMultiattacks instead
  return total;
}

/**
 * Dynamic extra attacks (e.g., brave weapons).
 * Returns the number of additional multi-attacks (0 = normal).
 */
export function dynamicMultiattacks(
  _unit: UnitObject,
  item: ItemObject,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  // Brave: weapon hits twice per attack
  if (item.hasComponent('brave')) return 1;
  return 0;
}

/** Dynamic accuracy modifier. */
export function dynamicAccuracy(
  _unit: UnitObject,
  _item: ItemObject,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return 0;
}

/** Dynamic attack speed modifier. */
export function dynamicAttackSpeed(
  _unit: UnitObject,
  _item: ItemObject,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return 0;
}
