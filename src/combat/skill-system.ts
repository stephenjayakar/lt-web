/**
 * skill_system.ts — Dispatch layer for skill component hooks.
 *
 * Mirrors LT's generated skill_system.py. For each hook, iterates all
 * skills on a unit and resolves results via the appropriate policy.
 *
 * Skills are stored as SkillObject[] on UnitObject. Each SkillObject
 * has a components: Map<string, any>.
 */
import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import { evaluateCondition, evaluateExpression } from '../events/event-manager';

export type SkillFactory = (nid: string) => SkillObject | null;

/** Apply traveler skill hooks, including source-aware pairup_bonus grants. */
export function onPairup(unit: UnitObject, leader: UnitObject, createSkill?: SkillFactory): SkillObject[] {
  const added: SkillObject[] = [];
  for (const skill of unit.skills) {
    const childNid = skill.getComponent<string>('pairup_bonus');
    if (!childNid || !createSkill) continue;
    const exists = leader.skills.some(candidate =>
      candidate.nid === childNid &&
      candidate.data.get('pairupSource') === unit.nid &&
      candidate.data.get('pairupSourceType') === 'traveler');
    if (exists) continue;
    const child = createSkill(childNid);
    if (!child) continue;
    child.data.set('pairupSource', unit.nid);
    child.data.set('pairupSourceType', 'traveler');
    leader.skills.push(child);
    added.push(child);
  }
  return added;
}

/** Remove only traveler-sourced pairup grants; natural same-NID skills survive. */
export function onSeparate(unit: UnitObject, leader: UnitObject): SkillObject[] {
  const removed: SkillObject[] = [];
  for (let index = leader.skills.length - 1; index >= 0; index--) {
    const skill = leader.skills[index];
    if (skill.data.get('pairupSource') === unit.nid && skill.data.get('pairupSourceType') === 'traveler') {
      leader.skills.splice(index, 1);
      removed.push(skill);
    }
  }
  return removed;
}

/** Python's ignore_rescue_penalty ALL_DEFAULT_FALSE skill hook. */
export function ignoreRescuePenalty(unit: UnitObject): boolean {
  return unit.skills.some(skill => skill.hasComponent('ignore_rescue_penalty'));
}

/** Install the source-specific hidden Rescue penalty skill. */
export function onRescue(
  rescuer: UnitObject,
  rescuee: UnitObject,
  createSkill?: SkillFactory,
): SkillObject[] {
  if (!createSkill || ignoreRescuePenalty(rescuer)) return [];
  const exists = rescuer.skills.some(skill =>
    skill.nid === 'Rescue' &&
    skill.data.get('rescueSource') === rescuee.nid &&
    skill.data.get('rescueSourceType') === 'traveler');
  if (exists) return [];
  const penalty = createSkill('Rescue');
  if (!penalty) return [];
  penalty.data.set('rescueSource', rescuee.nid);
  penalty.data.set('rescueSourceType', 'traveler');
  rescuer.skills.push(penalty);
  return [penalty];
}

/** Remove only the Rescue penalty sourced from this traveler. */
export function onRemoveRescue(rescuer: UnitObject, rescuee: UnitObject): SkillObject[] {
  const removed: SkillObject[] = [];
  for (let index = rescuer.skills.length - 1; index >= 0; index--) {
    const skill = rescuer.skills[index];
    if (skill.nid === 'Rescue' &&
        skill.data.get('rescueSource') === rescuee.nid &&
        skill.data.get('rescueSourceType') === 'traveler') {
      rescuer.skills.splice(index, 1);
      removed.unshift(skill);
    }
  }
  return removed;
}

// ============================================================
// Helper: iterate all skill components that define a given hook
// ============================================================

/**
 * Python `utils.unique(vals)` returns `vals[-1]` — the LAST component (in
 * skill iteration order) that defines the hook wins, not the first. The
 * generated skill_system dispatchers append to `values` while walking
 * `unit.skills[:]` in order, so a later skill's value always overrides an
 * earlier one. Must iterate skills in order and keep overwriting, not
 * short-circuit on the first match.
 */
function getSkillValue<T>(unit: UnitObject, componentNid: string): T | undefined {
  let result: T | undefined;
  for (const skill of unit.skills) {
    if (skill.hasComponent(componentNid)) {
      result = skill.getComponent<T>(componentNid);
    }
  }
  return result;
}

function hasAnySkill(unit: UnitObject, componentNid: string): boolean {
  return unit.skills.some(s => s.hasComponent(componentNid));
}

/** Python can_select: any active Unselectable component vetoes player control. */
export function canSelect(unit: UnitObject, game?: any): boolean {
  return !unit.skills.some((skill) => {
    if (!skill.hasComponent('unselectable')) return false;
    const condition = skill.getComponent<string>('condition');
    return !condition || evaluateCondition(condition, {
      game,
      unit1: unit,
      item: unit.equippedWeapon ?? undefined,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
    });
  });
}

/** Skill-component nids that grant some form of Canto (movement_components.py). */
const CANTO_COMPONENTS = ['canto', 'canto_plus', 'canto_sharp', 'canter'];

/** Does this single skill grant canto (any variant)? Used when (de)equipping a skill. */
export function isCantoSkill(skill: { hasComponent: (nid: string) => boolean }): boolean {
  return CANTO_COMPONENTS.some((nid) => skill.hasComponent(nid));
}

/** Sum all numeric values for a component across all skills. */
function sumSkillValues(unit: UnitObject, componentNid: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>(componentNid);
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Product of all numeric values for a component across all skills. */
function productSkillValues(unit: UnitObject, componentNid: string, defaultVal: number = 1): number {
  let result = defaultVal;
  let found = false;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>(componentNid);
    if (typeof val === 'number') {
      result *= val;
      found = true;
    }
  }
  return found ? result : defaultVal;
}

/** Item-component shape supplied by an alternate-splash skill. */
export type AlternateSplash = 'blast' | 'enemy_blast' | 'smart_blast' | 'enemy_cleave';

/**
 * Extra AOE range granted by Oversplash-family skills.
 *
 * Python resolves empower_splash with NUMERIC_ACCUM, and the derived enemy
 * and smart variants inherit the same hook.
 */
export function empowerSplash(unit: UnitObject): number {
  return sumSkillValues(unit, 'oversplash') +
    sumSkillValues(unit, 'enemy_oversplash') +
    sumSkillValues(unit, 'smart_oversplash');
}

/**
 * Replacement splash component for otherwise single-target items.
 *
 * Python `alternate_splash` is a UNIQUE hook: `utils.unique(vals)` returns
 * `vals[-1]`, the LAST component (in skill order, then per-skill component
 * order) that defines it — not the first. Must scan every skill and keep
 * overwriting the result rather than returning on the first hit.
 */
export function alternateSplash(unit: UnitObject): AlternateSplash | null {
  let result: AlternateSplash | null = null;
  for (const skill of unit.skills) {
    for (const componentNid of skill.components.keys()) {
      if (componentNid === 'oversplash') result = 'blast';
      else if (componentNid === 'enemy_oversplash') result = 'enemy_blast';
      else if (componentNid === 'smart_oversplash') result = 'smart_blast';
      else if (componentNid === 'Cleave') result = 'enemy_cleave';
    }
  }
  return result;
}

// ============================================================
// Boolean hooks (ALL_DEFAULT_FALSE)
// ============================================================

/** Unit attacks first regardless of speed. */
export function vantage(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'vantage');
}

/** Unit performs all attacks before enemy retaliates. */
export function desperation(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'desperation');
}

/** Unit cannot double. */
export function noDouble(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'no_double');
}

/** Defender can double (even though normally only attackers can). */
export function defDouble(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'def_double');
}

/** Can always crit, even if crit is disabled globally. */
export function critAnyway(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'crit_anyway');
}

/** Unit ignores terrain costs. */
export function ignoreTerrain(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'ignore_terrain');
}

/** Unit can counter at any range. */
export function distantCounter(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'distant_counter');
}

/** Unit can counter at range 1 even with ranged weapon. */
export function closeCounter(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'close_counter');
}

/** Unit should not move after attacking (no canto override). */
export function noAttackAfterMove(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'no_attack_after_move');
}

/** Pass through terrain (flying). */
export function passThrough(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'pass_through');
}

/** Attacker goes second (opposite of vantage). */
export function disvantage(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'disvantage');
}

/** Unit persists at 0 HP during combat (miracle-like). */
export function ignoreDyingInCombat(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'ignore_dying_in_combat');
}

/**
 * Find an available 'miracle' skill on the unit (Python Miracle component,
 * cleanup_combat hook): "Unit will not die after combat, but will instead be
 * resurrected with 1 hp." Unlike ignoreDyingInCombat, this only saves the
 * unit at the very end of combat resolution (cleanup), not mid-combat, and
 * respects charge components (build_charge/drain_charge/charges_per_turn)
 * the same way attack/defense procs do.
 */
export function miracleSkill(unit: UnitObject): SkillObject | null {
  for (const skill of unit.skills) {
    if (!skill.hasComponent('miracle')) continue;
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
      if (charge < total) continue;
    }
    if (skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
      if (Number(skill.data.get('charge') ?? 0) <= 0) continue;
    }
    return skill;
  }
  return null;
}

/** Consume the charge (if any) on a triggered miracle skill (Python TriggerCharge). */
export function consumeMiracleCharge(skill: SkillObject): void {
  if (skill.hasComponent('build_charge')) {
    skill.data.set('charge', 0);
  } else if (skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
    skill.data.set('charge', Number(skill.data.get('charge') ?? 0) - 1);
  }
}

export type CustomSurvivalComponent =
  | 'nine_lives_event'
  | 'true_miracle_event'
  | 'true_miracle_event_after_combat'
  | 'TrueMiracle'
  | 'ignore_damage';

export interface CustomSurvivalSkill {
  skill: SkillObject;
  component: CustomSurvivalComponent;
  value: unknown;
}

/** First active Rekka after_take_strike survival hook in skill/component order. */
export function customSurvivalSkill(
  unit: UnitObject,
  alreadyTriggered: ReadonlySet<SkillObject> = new Set(),
): CustomSurvivalSkill | null {
  for (const skill of unit.skills) {
    if (alreadyTriggered.has(skill)) continue;
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
      if (charge < total) continue;
    }
    if ((skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) &&
        Number(skill.data.get('charge') ?? 0) <= 0) continue;
    for (const [component, value] of skill.components) {
      if (component === 'nine_lives_event' ||
          component === 'true_miracle_event' ||
          component === 'true_miracle_event_after_combat') {
        return { skill, component, value };
      }
    }
  }
  return null;
}

/** First charged damage-prevention hook in skill/component order. */
export function damagePreventionSkill(
  unit: UnitObject,
  lethal: boolean,
  alreadyTriggered: ReadonlySet<SkillObject> = new Set(),
  game?: any,
): CustomSurvivalSkill | null {
  for (const skill of unit.skills) {
    if (alreadyTriggered.has(skill)) continue;
    const condition = skill.getComponent<string>('condition');
    if (condition && !evaluateCondition(condition, {
      game,
      unit1: unit,
      item: unit.equippedWeapon ?? undefined,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
    })) continue;
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
      if (charge < total) continue;
    }
    if ((skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) &&
        Number(skill.data.get('charge') ?? 0) <= 0) continue;
    for (const [component, value] of skill.components) {
      if (component === 'ignore_damage') return { skill, component, value };
      if (lethal && component === 'TrueMiracle') return { skill, component, value };
      if (lethal && (
        component === 'nine_lives_event' ||
        component === 'true_miracle_event' ||
        component === 'true_miracle_event_after_combat'
      )) return { skill, component, value };
    }
  }
  return null;
}

/** Unit cannot be displaced by shove, swap, warp, rescue, or related item hooks. */
export function ignoreForcedMovement(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'ignore_forced_movement');
}

// ============================================================
// Boolean hooks (ALL_DEFAULT_TRUE)
// ============================================================

/** Can this unit counter? (Default true unless a skill disables it.) */
export function canCounter(unit: UnitObject): boolean {
  for (const skill of unit.skills) {
    if (skill.hasComponent('cannot_counter')) return false;
  }
  return true;
}

// ============================================================
// Boolean hooks (ANY_DEFAULT_FALSE)
// ============================================================

/**
 * Does the unit have canto (can move again after acting)?
 * Python recognizes several canto skill-component variants that all expose
 * `has_canto`/`canto_movement` (movement_components.py): `canto`, `canto_plus`
 * (canto even after attacking), `canto_sharp`, and `canter` (fixed-distance
 * canto). We don't yet distinguish their differing `has_canto` gating (e.g.
 * base Canto denies a re-move after attacking an enemy other than self) --
 * only CantoPlus's "always true" semantics are effectively applied here. That
 * gap is filed as out of scope for this movement-parity slice since no
 * shipped skill data uses these variants yet.
 */
export function hasCanto(unit: UnitObject): boolean {
  return unit.skills.some(isCantoSkill);
}

// ============================================================
// Stat change hooks
// ============================================================

/**
 * Get the total stat change bonus from all skills for a given stat.
 * Skills with 'stat_change' component store [[statNid, amount], ...].
 */
export function statChange(unit: UnitObject, statNid: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const changes = skill.getComponent<any>('stat_change');
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1];
        }
      }
    }
    const upkeepChanges = skill.getComponent<any>('upkeep_stat_change');
    const counter = Number(skill.data.get('counter') ?? 0);
    if (Array.isArray(upkeepChanges) && Number.isFinite(counter)) {
      for (const entry of upkeepChanges) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1] * counter;
        }
      }
    }
  }
  return total;
}

/**
 * Get the total growth change bonus from all skills for a given stat.
 */
export function growthChange(unit: UnitObject, statNid: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const changes = skill.getComponent<any>('growth_change');
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1];
        }
      }
    }
  }
  return total;
}

// ============================================================
// Static modifier hooks (NUMERIC_ACCUM)
// ============================================================

/** Bonus damage from skills. */
export function modifyDamage(unit: UnitObject, _item: ItemObject | null): number {
  let total = sumSkillValues(unit, 'modify_damage') + sumSkillValues(unit, 'damage');
  // Rekka GiveBacker: each active copy adds the bearer's missing HP.
  // Custom components participate in NUMERIC_ACCUM just like built-ins.
  for (const skill of unit.skills) {
    if (skill.hasComponent('givebacker')) {
      total += Math.max(0, unit.getMaxHP() - unit.currentHp);
    }
  }
  return total;
}

/** Bonus resist from skills. */
export function modifyResist(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_resist') + sumSkillValues(unit, 'resist');
}

/** Bonus accuracy from skills. */
export function modifyAccuracy(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_accuracy') + sumSkillValues(unit, 'hit');
}

/** Bonus avoid from skills. */
export function modifyAvoid(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_avoid') + sumSkillValues(unit, 'avoid');
}

/** Bonus crit accuracy from skills. */
export function modifyCritAccuracy(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_crit_accuracy') + sumSkillValues(unit, 'crit');
}

/** Bonus crit avoid from skills. */
export function modifyCritAvoid(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_crit_avoid') + sumSkillValues(unit, 'crit_avoid');
}

/** Bonus crit damage from skills. */
export function modifyCritDamage(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_crit_damage');
}

/** Dynamic crit bonus evaluated with the full Python combat local context. */
export function dynamicCritAccuracy(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: [number, number],
  baseValue: number,
  game?: any,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const expression = skill.getComponent<string>('dynamic_crit_accuracy');
    if (!expression) continue;
    const value = evaluateExpression(expression, {
      game,
      unit1: unit,
      unit2: target,
      item,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs: new Map<string, unknown>([
        ['item', item],
        ['item2', item2],
        ['mode', mode],
        ['skill', skill],
        ['attack_info', attackInfo],
        ['base_value', baseValue],
      ]),
    });
    const numeric = Number(value);
    if (Number.isFinite(numeric)) total += Math.trunc(numeric);
  }
  return total;
}

/** Last alternate critical multiplier equation, matching Python UNIQUE. */
export function criticalMultiplierFormula(unit: UnitObject): string | null {
  return getSkillValue<string>(unit, 'alternate_critical_multiplier_formula') ?? null;
}

/** Base item maximum range after skill additions and the optional hard cap. */
export function modifiedMaximumRange(
  unit: UnitObject,
  item: ItemObject,
  game?: any,
): number {
  let maximum = item.getMaxRange();
  for (const skill of unit.skills) {
    const flat = skill.getComponent<number>('modify_maximum_range');
    if (typeof flat === 'number') maximum += flat;
    const expression = skill.getComponent<string>('eval_max_range');
    if (expression) {
      const value = evaluateExpression(expression, {
        game,
        unit1: unit,
        item,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs: new Map<string, unknown>([['item', item], ['skill', skill]]),
      });
      if (Number.isFinite(Number(value))) maximum += Math.trunc(Number(value));
    }
  }
  const limit = getSkillValue<number>(unit, 'limit_maximum_range');
  return Math.max(0, Math.min(maximum, typeof limit === 'number' ? limit : 99));
}

/** Last active movement-type override, falling back to the unit's class group. */
export function movementType(unit: UnitObject, defaultType: string, game?: any): string {
  let result = defaultType;
  for (const skill of unit.skills) {
    const value = skill.getComponent<string>('movement_type');
    if (!value) continue;
    const condition = skill.getComponent<string>('condition');
    if (condition && !evaluateCondition(condition, {
      game,
      unit1: unit,
      item: unit.equippedWeapon ?? undefined,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
    })) continue;
    result = value;
  }
  return result;
}

/** Uses restored per qualifying strike by project Armsthrift skills. */
export function armsthriftRestoration(unit: UnitObject, item: ItemObject): number {
  if (item.hasComponent('unrepairable')) return 0;
  let restored = 0;
  for (const skill of unit.skills) {
    const value = skill.getComponent<number>('armsthrift');
    if (typeof value === 'number') restored += Math.max(0, value - 1);
  }
  return restored;
}

/** Attack speed modifier from skills. */
export function modifyAttackSpeed(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_attack_speed') + sumSkillValues(unit, 'attack_speed');
}

/** Defense speed modifier from skills. */
export function modifyDefenseSpeed(unit: UnitObject, _item: ItemObject | null): number {
  return sumSkillValues(unit, 'modify_defense_speed') + sumSkillValues(unit, 'defense_speed');
}

// ============================================================
// Dynamic modifier hooks (NUMERIC_ACCUM with combat context)
// ============================================================

/** Dynamic damage modifier (situational bonuses). */
export function dynamicDamage(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_damage');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic resist modifier. */
export function dynamicResist(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_resist');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic accuracy modifier. */
export function dynamicAccuracy(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_accuracy');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic avoid modifier. */
export function dynamicAvoid(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_avoid');
    if (typeof val === 'number') total += val;
  }
  return total;
}

/** Dynamic extra attacks from skills. */
export function dynamicMultiattacks(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;
  for (const skill of unit.skills) {
    const val = skill.getComponent<number>('dynamic_multiattacks');
    if (typeof val === 'number') total += val;
  }
  return total;
}

// ============================================================
// Multiplier hooks (NUMERIC_MULTIPLY)
// ============================================================

/** Final damage multiplier (product of all). */
export function damageMultiplier(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return productSkillValues(unit, 'damage_multiplier');
}

/** Final resist multiplier (product of all). */
export function resistMultiplier(
  unit: UnitObject,
  _item: ItemObject | null,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return productSkillValues(unit, 'resist_multiplier');
}

// ============================================================
// Formula hooks (UNIQUE — override the default formula name)
// ============================================================

/** Override the damage formula name. Default: null (use standard). */
export function damageFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'damage_formula') ??
    getSkillValue<string>(unit, 'alternate_damage_formula');
}

export function damageFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'damage_formula_override');
}

/** Override the resist formula name. */
export function resistFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'resist_formula') ??
    getSkillValue<string>(unit, 'alternate_resist_formula');
}

export function resistFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'resist_formula_override');
}

/** Override the accuracy formula name. */
export function accuracyFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'accuracy_formula') ??
    getSkillValue<string>(unit, 'alternate_accuracy_formula');
}

export function accuracyFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'accuracy_formula_override');
}

/** Override the avoid formula name. */
export function avoidFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'avoid_formula') ??
    getSkillValue<string>(unit, 'alternate_avoid_formula');
}

export function avoidFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'avoid_formula_override');
}

export function critAccuracyFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'crit_accuracy_formula') ??
    getSkillValue<string>(unit, 'alternate_crit_accuracy_formula');
}

export function critAccuracyFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'crit_accuracy_formula_override');
}

export function critAvoidFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'crit_avoid_formula') ??
    getSkillValue<string>(unit, 'alternate_crit_avoid_formula');
}

export function critAvoidFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'crit_avoid_formula_override');
}

/** Override the attack speed formula name. */
export function attackSpeedFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'attack_speed_formula') ??
    getSkillValue<string>(unit, 'alternate_attack_speed_formula');
}

export function attackSpeedFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'attack_speed_formula_override');
}

/** Override the defense speed formula name. */
export function defenseSpeedFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'defense_speed_formula') ??
    getSkillValue<string>(unit, 'alternate_defense_speed_formula');
}

export function defenseSpeedFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'defense_speed_formula_override');
}

// ============================================================
// Exp / WExp multipliers (UNIQUE, default 1)
// ============================================================

export function expMultiplier(unit: UnitObject, _target: UnitObject | null): number {
  return getSkillValue<number>(unit, 'exp_multiplier') ?? 1;
}

export function enemyExpMultiplier(unit: UnitObject, _target: UnitObject | null): number {
  return getSkillValue<number>(unit, 'enemy_exp_multiplier') ?? 1;
}

export function wexpMultiplier(unit: UnitObject, _target: UnitObject | null): number {
  return getSkillValue<number>(unit, 'wexp_multiplier') ?? 1;
}

export function enemyWexpMultiplier(unit: UnitObject, _target: UnitObject | null): number {
  return getSkillValue<number>(unit, 'enemy_wexp_multiplier') ?? 1;
}

// ============================================================
// Fog of War — Sight Range
// ============================================================

/**
 * Get the total sight range bonus from all skills on a unit.
 *
 * Checks for 'sight_range_bonus' (flat bonus) and
 * 'decreasing_sight_range_bonus' (bonus that decreases by 1 each turn,
 * tracked via skill data 'torch_counter').
 *
 * Port of LT's sight_range hook in skill_components/base_components.py.
 */
export function sightRange(unit: UnitObject): number {
  let total = 0;
  for (const skill of unit.skills) {
    // Flat sight range bonus
    const flatBonus = skill.getComponent<number>('sight_range_bonus');
    if (typeof flatBonus === 'number') {
      total += flatBonus;
    }

    // Decreasing sight range bonus (torch effect)
    const decBonus = skill.getComponent<number>('decreasing_sight_range_bonus');
    if (typeof decBonus === 'number') {
      const counter = (skill.data.get('torch_counter') as number) ?? 0;
      total += Math.max(0, decBonus - counter);
    }
  }
  return total;
}
