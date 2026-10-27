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
import { isForkEngine } from '../engine/engine-flavor';
import {
  evaluateCondition,
  evaluateExpression,
  evaluateFloat,
  evaluateInt,
  evaluateIntPairs,
  evaluatePythonInContext,
  pythonTruthy,
  setSkillConditionEvaluator,
} from '../events/event-manager';

export type SkillFactory = (nid: string) => SkillObject | null;

let skillGameRef: (() => any) | null = null;

export function setSkillSystemGameRef(getter: () => any): void {
  skillGameRef = getter;
}

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
export function ignoreRescuePenalty(unit: UnitObject, game?: any): boolean {
  return hasActiveSkillComponent(unit, 'ignore_rescue_penalty', game);
}

/** Install the source-specific hidden Rescue penalty skill. */
export function onRescue(
  rescuer: UnitObject,
  rescuee: UnitObject,
  createSkill?: SkillFactory,
  game?: any,
): SkillObject[] {
  if (!createSkill) return [];
  const added: SkillObject[] = [];
  if (!ignoreRescuePenalty(rescuer, game)) {
    const exists = rescuer.skills.some(skill =>
      skill.nid === 'Rescue' &&
      skill.data.get('rescueSource') === rescuee.nid &&
      skill.data.get('rescueSourceType') === 'traveler');
    if (!exists) {
      const penalty = createSkill('Rescue');
      if (penalty) {
        penalty.data.set('rescueSource', rescuee.nid);
        penalty.data.set('rescueSourceType', 'traveler');
        penalty.ownerNid = rescuer.nid;
        rescuer.skills.push(penalty);
        added.push(penalty);
      }
    }
  }
  for (const source of rescuee.skills) {
    const bonusNid = source.getComponent<unknown>('rescue_bonus');
    if (typeof bonusNid !== 'string' ||
        !skillConditionActive(source, rescuee, { game }) ||
        rescuer.skills.some((skill) => skill.nid === bonusNid)) continue;
    const bonus = createSkill(bonusNid);
    if (!bonus) continue;
    bonus.initiatorNid = rescuee.nid;
    bonus.data.set('rescueBonusSource', rescuee.nid);
    bonus.ownerNid = rescuer.nid;
    rescuer.skills.push(bonus);
    added.push(bonus);
  }
  return added;
}

/** Remove only the Rescue penalty sourced from this traveler. */
export function onRemoveRescue(rescuer: UnitObject, rescuee: UnitObject): SkillObject[] {
  const removed: SkillObject[] = [];
  for (let index = rescuer.skills.length - 1; index >= 0; index--) {
    const skill = rescuer.skills[index];
    const isPenalty = skill.nid === 'Rescue' &&
        skill.data.get('rescueSource') === rescuee.nid &&
        skill.data.get('rescueSourceType') === 'traveler';
    const isBonus = rescuee.skills.some((source) =>
      source.getComponent<unknown>('rescue_bonus') === skill.nid);
    if (isPenalty || isBonus) {
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

/**
 * Resolve several component NIDs that implement one Python UNIQUE hook.
 * Component aliases must compete in skill/component iteration order rather
 * than one alias receiving permanent precedence over another.
 */
function getActiveSkillHookValue<T>(
  unit: UnitObject,
  componentNids: readonly string[],
  context: SkillConditionContext = {},
): T | undefined {
  const accepted = new Set(componentNids);
  let result: T | undefined;
  for (const skill of unit.skills) {
    const combatCondition = skill.getComponent<string>('combat_condition');
    if (combatCondition && skill.data.get('_combat_condition') !== true) continue;
    if (!skillConditionActive(skill, unit, context)) continue;
    for (const [componentNid, value] of skill.components) {
      if (accepted.has(componentNid)) result = value as T;
    }
  }
  return result;
}

function hasAnySkill(unit: UnitObject, componentNid: string): boolean {
  return unit.skills.some(s => s.hasComponent(componentNid));
}

export interface SkillConditionContext {
  game?: any;
  item?: ItemObject | null;
  target?: UnitObject | null;
  localArgs?: Map<string, unknown>;
}

/**
 * Run EotF skill init hooks that depend on the fully constructed runtime
 * instance. Python AddSkill assigns initiator_nid before skill_system.init,
 * then freezes StatChangeAtApplyExpression into skill.data.
 */
export function initializeSkillData(
  skill: SkillObject,
  owner: UnitObject,
  game?: any,
): void {
  skill.ownerNid = owner.nid;
  if ((skill.hasComponent('redirect_damage') ||
      skill.hasComponent('redirect_partial_damage')) &&
      !skill.data.has('cover')) {
    const auraOwner = skill.data.get('auraOwnerNid');
    skill.data.set(
      'cover',
      skill.initiatorNid ??
        (typeof auraOwner === 'string' ? auraOwner : null),
    );
  }
  // EOtF's engine: WitchWarpExpression.init seeds data['arbitrary'] with ''
  // (Covetous Love's expression reads it before an event fills it in).
  if (isForkEngine() && skill.hasComponent('witch_warp_expression') && !skill.data.has('arbitrary')) {
    skill.data.set('arbitrary', '');
  }
  // Python CombatArt.init: a combat art starts inactive.
  if (skill.hasComponent('combat_art') && !skill.data.has('active')) {
    skill.data.set('active', false);
  }
  if (!skill.hasComponent('stat_change_at_apply_expression') ||
      skill.data.has('stat_changes')) return;

  // EOtF StatChangeAtApplyExpression.init: no unit, local skill only; one
  // failing entry zeroes every stat.
  const changes = evaluateIntPairs(skill.getComponent<unknown>('stat_change_at_apply_expression'), {
    game,
    gameVars: game?.gameVars,
    levelVars: game?.levelVars,
    localArgs: new Map<string, unknown>([['skill', skill]]),
  });
  skill.data.set('stat_changes', changes);
}

/**
 * Python UnitObject.remove_skill: a RemoveSkill with no source (an expiring
 * status, the remove_skill event command) only removes an instance whose source type is removable
 * (class, personal, fatigue, default). One granted by an item, terrain,
 * region, aura, rescue or the game stays on (at 0 turns) until its own
 * source takes it away.
 */
export function sourceAllowsPlainRemoval(skill: SkillObject): boolean {
  const data = skill.data;
  const types = [
    data.get('sourceType'), data.get('itemSourceType'), data.get('positionStatusSourceType'),
    data.get('auraSourceType'), data.get('rescueSourceType'),
  ];
  return !types.some((type) => typeof type === 'string' &&
    ['item', 'terrain', 'region', 'aura', 'traveler', 'global'].includes(type));
}

/** Python skill_system.additional_tags, including EotF RedirectDamage. */
export function additionalTags(unit: UnitObject, game?: any): Set<string> {
  const tags = new Set<string>();
  for (const skill of unit.skills) {
    // Python only evaluates the condition of skills that define
    // additional_tags, so unrelated conditions never run here.
    const configured = skill.getComponent<unknown>('has_tags');
    const redirect = skill.hasComponent('redirect_damage');
    const ignoring = skill.hasComponent('ignore_damage') && isForkEngine();
    if (!Array.isArray(configured) && !redirect && !ignoring) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    if (Array.isArray(configured)) {
      for (const tag of configured) {
        if (typeof tag === 'string') tags.add(tag);
      }
    }
    // EOtF fork IgnoreDamage.additional_tags returns ['IgnoringDamage'].
    if (redirect || ignoring) tags.add('IgnoringDamage');
  }
  return tags;
}

const resolvingUnitTags = new Set<UnitObject>();

/**
 * Python `UnitObject.tags`: the unit's own tags, its class tags, and the
 * tags its active skills add (skill_system.additional_tags). `unit.tags`
 * in the web holds only the unit's own (mutable, saved) tags.
 */
export function unitTags(unit: UnitObject, game: any = skillGameRef?.()): Set<string> {
  const tags = new Set<string>(unit.tags ?? []);
  const classTags = game?.db?.classes?.get?.(unit.klass)?.tags;
  if (Array.isArray(classTags)) {
    for (const tag of classTags) tags.add(tag);
  }
  // A skill condition that reads unit.tags would otherwise recurse forever.
  if (resolvingUnitTags.has(unit)) return tags;
  resolvingUnitTags.add(unit);
  try {
    for (const tag of additionalTags(unit, game)) tags.add(tag);
  } finally {
    resolvingUnitTags.delete(unit);
  }
  return tags;
}

/** `tag in unit.tags` with Python's union semantics (see unitTags). */
export function unitHasTag(unit: UnitObject, tag: string, game: any = skillGameRef?.()): boolean {
  if (unit.tags?.includes(tag)) return true;
  const classTags = game?.db?.classes?.get?.(unit.klass)?.tags;
  if (Array.isArray(classTags) && classTags.includes(tag)) return true;
  if (!unit.skills?.length || resolvingUnitTags.has(unit)) return false;
  resolvingUnitTags.add(unit);
  try {
    return additionalTags(unit, game).has(tag);
  } finally {
    resolvingUnitTags.delete(unit);
  }
}

/** EotF SelfNihil condition hook, including inherited multi-skill gates. */
export function selfNihilActive(skill: SkillObject, unit: UnitObject): boolean {
  const parent = skill.data.get('multiSkillSource');
  if (parent instanceof SkillObject && !selfNihilActive(parent, unit)) return false;
  const blockedNids = skill.getComponent<unknown>('self_nihil');
  return !Array.isArray(blockedNids) || !unit.skills.some((candidate) =>
    blockedNids.includes(candidate.nid));
}

/**
 * Python `skill_system.condition`: a multi-skill child inherits its parent's
 * gate, every Conditional expression must pass, and EotF's `self_nihil`
 * component disables the owning skill when any listed skill is present.
 *
 * `self_nihil` declares `ignore_conditional = True`, so it must be evaluated
 * independently of (and before) the ordinary Conditional component.
 */
export function skillConditionActive(
  skill: SkillObject,
  unit: UnitObject,
  context: SkillConditionContext = {},
): boolean {
  const parent = skill.data?.get?.('multiSkillSource');
  if (parent instanceof SkillObject) {
    const parentArgs = new Map(context.localArgs ?? []);
    parentArgs.set('skill', parent);
    if (!skillConditionActive(parent, unit, { ...context, localArgs: parentArgs })) {
      return false;
    }
  }
  if (!selfNihilActive(skill, unit)) return false;
  // Upstream IsTerrain turns terrain skills off for Flying units; EOtF's fork
  // comments that condition out, so terrain skills also apply to fliers.
  if (skill.hasComponent('is_terrain') && !isForkEngine()) {
    const classTags = context.game?.db?.classes?.get?.(unit.klass)?.tags;
    if (unit.tags.includes('Flying') ||
        (Array.isArray(classTags) && classTags.includes('Flying'))) {
      return false;
    }
  }

  const condition = skill.getComponent<string>('condition');
  if (!condition) return true;
  const localArgs = new Map(context.localArgs ?? []);
  if (!localArgs.has('skill')) localArgs.set('skill', skill);
  return evaluateCondition(condition, {
    game: context.game,
    unit1: unit,
    unit2: context.target ?? undefined,
    item: context.item ?? unit.equippedWeapon ?? undefined,
    position: unit.position ?? undefined,
    gameVars: context.game?.gameVars,
    levelVars: context.game?.levelVars,
    localArgs,
  });
}

/** Python can_select: any active Unselectable component vetoes player control. */
export function canSelect(unit: UnitObject, game?: any): boolean {
  return !hasActiveSkillComponent(unit, 'unselectable', game);
}

/** Whether any condition/charge-active skill on this unit owns a component. */
export function hasActiveSkillComponent(
  unit: UnitObject,
  component: string,
  game: any = skillGameRef?.(),
): boolean {
  return unit.skills.some((skill) => {
    if (!skill.hasComponent(component)) return false;
    return evaluatedSkillActive(skill, unit, { game }, new Map([
      ['skill', skill],
    ]));
  });
}

/** Full condition/combat-condition/charge activity for one concrete skill. */
export function isSkillActive(
  skill: SkillObject,
  unit: UnitObject,
  game: any = skillGameRef?.(),
): boolean {
  return evaluatedSkillActive(skill, unit, { game }, new Map([
    ['skill', skill],
  ]));
}

/** Python no_trade ALL_DEFAULT_FALSE skill hook. */
export function noTrade(unit: UnitObject, game?: any): boolean {
  return hasActiveSkillComponent(unit, 'cannot_trade', game);
}

/** Python can_trade default, including both participants' no_trade hooks. */
export function canTradeWith(
  unit: UnitObject,
  target: UnitObject,
  db: any,
  game: any = skillGameRef?.(),
): boolean {
  return unit.team === target.team &&
    checkAlly(unit, target, db, game) &&
    !noTrade(unit, game) &&
    !noTrade(target, game);
}

/** Python can_unlock ANY_DEFAULT_FALSE skill hook. */
export function canUnlock(unit: UnitObject, _region?: any, game?: any): boolean {
  return hasActiveSkillComponent(unit, 'locktouch', game);
}

/** Skill-component nids that grant some form of Canto (movement_components.py). */
const CANTO_COMPONENTS = [
  'canto',
  'canto_plus',
  'canto_sharp',
  'canter',
  'eval_canter',
];

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

/** Python EmpowerHeal NUMERIC_ACCUM hook, including per-skill expressions. */
export function empowerHeal(unit: UnitObject, target: UnitObject, game: any): number {
  let total = 0;
  for (const skill of unit.skills) {
    const raw = skill.getComponent<unknown>('empower_heal');
    if (raw === undefined) continue;
    const localArgs = new Map<string, unknown>([['skill', skill]]);
    if (!evaluatedSkillActive(skill, unit, { game, target }, localArgs)) continue;
    // Python EmpowerHeal: int(evaluate(...)), 0 when it raises.
    const value = typeof raw === 'number'
      ? raw
      : evaluateInt(String(raw), {
        game,
        unit1: unit,
        unit2: target,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs,
      }, 0);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) total += Math.trunc(numeric);
  }
  return total;
}

function healingSkillValue(
  skill: SkillObject,
  component: string,
  owner: UnitObject,
  other: UnitObject,
  game: any,
): number | null {
  const raw = skill.getComponent<unknown>(component);
  if (raw === undefined) return null;
  const localArgs = new Map<string, unknown>([['skill', skill]]);
  if (!evaluatedSkillActive(
    skill,
    owner,
    { game, target: other },
    localArgs,
  )) return null;
  // Python int(evaluate(...)), 0 when it raises.
  const value = typeof raw === 'number'
    ? raw
    : evaluateInt(String(raw), {
      game,
      unit1: owner,
      unit2: other,
      position: owner.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs,
    }, 0);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Standard Heal/EquationHeal additive modifiers, without EotF multipliers. */
export function additiveHealAmount(
  baseAmount: number,
  target: UnitObject,
  healer: UnitObject | null,
  game: any,
): number {
  let additive = 0;
  if (healer) {
    additive += empowerHeal(healer, target, game);
  }
  for (const skill of target.skills) {
    const received = healingSkillValue(
      skill,
      'empower_heal_received',
      target,
      healer ?? target,
      game,
    );
    if (received !== null) additive += received;
  }
  return baseAmount + additive;
}

/** EotF EvalHeal's shared `_get_heal_amount`, including multiplier hooks. */
export function modifiedHealAmount(
  baseAmount: number,
  target: UnitObject,
  healer: UnitObject | null,
  game: any,
): number {
  let multiplier = 1;
  if (healer) {
    for (const skill of healer.skills) {
      const value = healingSkillValue(
        skill,
        'empower_heal_multiplier',
        healer,
        target,
        game,
      );
      if (value !== null) multiplier *= value;
    }
  }
  for (const skill of target.skills) {
    const receivedMultiplier = healingSkillValue(
      skill,
      'empower_heal_received_multiplier',
      target,
      healer ?? target,
      game,
    );
    if (receivedMultiplier !== null) multiplier *= receivedMultiplier;
  }
  return Math.trunc(multiplier * additiveHealAmount(baseAmount, target, healer, game));
}

/**
 * EotF `permanent_damage`: reconcile temporary Undying Will stacks, then
 * collapse maximum HP to the unit's post-strike HP with a floor of one.
 * Called from combat result walks so each later strike observes the new cap.
 */
export function applyPermanentDamage(
  unit: UnitObject,
  currentHp: number,
  game: any,
): number {
  if (!unit.skills.some((skill) =>
    skill.hasComponent('permanent_damage') &&
    skillConditionActive(skill, unit, { game }))) {
    return currentHp;
  }
  const trackedRaw = Number(unit.fields.get('Undeath_Current_HP'));
  const tracked = Number.isFinite(trackedRaw) ? trackedRaw : unit.maxHp;
  let currentMax = unit.maxHp;
  const willPrefab = game?.db?.skills.get('Undying_Will');
  if (currentMax > tracked && willPrefab) {
    for (let index = 0; index < currentMax - tracked; index++) {
      unit.skills.push(new SkillObject(willPrefab));
    }
  } else if (currentMax < tracked) {
    let count = Math.trunc(tracked - currentMax);
    for (let index = unit.skills.length - 1; index >= 0 && count > 0; index--) {
      if (unit.skills[index].nid !== 'Undying_Will') continue;
      unit.skills.splice(index, 1);
      count--;
    }
  }
  const reconcile = Math.trunc(tracked - currentMax);
  unit.stats.HP = Math.max(
    0,
    Math.min(unit.getStatCap('HP'), (unit.stats.HP ?? 0) + reconcile),
  );
  currentMax = unit.maxHp;
  const collapse = Math.max(currentHp - currentMax, 1 - currentMax);
  unit.stats.HP = Math.max(
    0,
    Math.min(unit.getStatCap('HP'), (unit.stats.HP ?? 0) + collapse),
  );
  const nextHp = Math.max(0, Math.min(currentHp, unit.maxHp));
  unit.fields.set('Undeath_Current_HP', unit.maxHp);
  return nextHp;
}

export interface UnitSpriteTint {
  color: [number, number, number];
  alpha: number;
}

/** Python unit_sprite_flicker_tint UNIQUE hook used by map rendering. */
export function unitSpriteTint(
  unit: UnitObject,
  game: any,
  timeMs: number,
): UnitSpriteTint | null {
  let result: UnitSpriteTint | null = null;
  for (const skill of unit.skills) {
    // Test for the component before testing whether the skill is active.
    // `isSkillActive` evaluates the skill's condition expression, and this
    // runs for every visible unit on every drawn frame — checking activity
    // first meant a 56-unit map evaluated thousands of conditions per frame
    // to decide a tint that almost no skill defines.
    const staticColor = skill.getComponent<[number, number, number]>('unit_tint');
    const flickerColor =
      skill.getComponent<[number, number, number]>('unit_flickering_tint');
    if (!staticColor && !flickerColor) continue;
    if (!isSkillActive(skill, unit, game)) continue;
    if (staticColor) result = { color: staticColor, alpha: 1 };
    if (flickerColor) {
      // Python's component declares period=900 ms and width=300 ms.
      const phase = ((timeMs % 900) + 900) % 900;
      result = { color: flickerColor, alpha: phase < 300 ? 1 : 0 };
    }
  }
  return result;
}

/** Active looping map-animation overlays authored by UnitAnim skills. */
export function activeUnitAnimations(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): { key: string; nid: string }[] {
  const result: { key: string; nid: string }[] = [];
  for (const skill of unit.skills) {
    const nid = skill.getComponent<unknown>('unit_anim');
    if (typeof nid !== 'string' || !nid || !isSkillActive(skill, unit, game)) continue;
    result.push({
      key: `${unit.nid}:${skill.uid}:${nid}`,
      nid,
    });
  }
  return result;
}

/** Python UNIQUE ChangeVariant hook, falling back to the unit prefab variant. */
export function changeVariant(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): string | null {
  let result = unit.variant;
  for (const skill of unit.skills) {
    const variant = skill.getComponent<unknown>('change_variant');
    if (typeof variant !== 'string' || !isSkillActive(skill, unit, game)) continue;
    result = variant || null;
  }
  return result;
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

function activeBooleanSkill(
  unit: UnitObject,
  componentNid: string,
  context: EvaluatedSkillContext = {},
): boolean {
  const resolvedContext = {
    ...context,
    game: context.game ?? skillGameRef?.(),
  };
  return unit.skills.some((skill) => {
    if (!skill.hasComponent(componentNid)) return false;
    const localArgs = new Map<string, unknown>([
      ['item', resolvedContext.item ?? null],
      ['item2', resolvedContext.item2 ?? null],
      ['mode', resolvedContext.mode ?? null],
      ['skill', skill],
      ['attack_info', resolvedContext.attackInfo ?? null],
    ]);
    return evaluatedSkillActive(skill, unit, resolvedContext, localArgs);
  });
}

/** Unit attacks first regardless of speed. */
export function vantage(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'vantage', context);
}

/** Unit performs all attacks before enemy retaliates. */
export function desperation(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'desperation', context);
}

/** Unit cannot double. */
export function noDouble(
  unit: UnitObject,
  game?: any,
  item?: ItemObject | null,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): boolean {
  game ??= skillGameRef?.();
  return unit.skills.some((skill) => {
    if (!skill.hasComponent('no_double') && !skill.hasComponent('cannot_double')) {
      return false;
    }
    const localArgs = new Map<string, unknown>([
      ['item', item ?? null],
      ['item2', item2 ?? null],
      ['mode', mode ?? null],
      ['skill', skill],
      ['attack_info', attackInfo ?? null],
    ]);
    return evaluatedSkillActive(
      skill, unit, { game, item, target, item2, mode, attackInfo }, localArgs,
    );
  });
}

/** Defender can double (even though normally only attackers can). */
export function defDouble(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'def_double');
}

/** Can always crit, even if crit is disabled globally. */
export function critAnyway(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'crit_anyway');
}

/**
 * Python ALL_DEFAULT_FALSE terrain hook. `gain_terrain` contributes False,
 * so one active override defeats any number of IgnoreTerrain skills.
 */
export function ignoreTerrain(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): boolean {
  const values: boolean[] = [];
  for (const skill of unit.skills) {
    if (!skill.hasComponent('ignore_terrain') &&
        !skill.hasComponent('gain_terrain')) continue;
    if (!evaluatedSkillActive(skill, unit, { game }, new Map([
      ['skill', skill],
    ]))) continue;
    if (skill.hasComponent('ignore_terrain')) values.push(true);
    if (skill.hasComponent('gain_terrain')) values.push(false);
  }
  return values.length > 0 && values.every(Boolean);
}

/** Python's matching status-region suppression hook. */
export function ignoreRegionStatus(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): boolean {
  const values: boolean[] = [];
  for (const skill of unit.skills) {
    if (!skill.hasComponent('ignore_region_status') &&
        !skill.hasComponent('ignore_terrain') &&
        !skill.hasComponent('gain_terrain')) continue;
    if (!evaluatedSkillActive(skill, unit, { game }, new Map([
      ['skill', skill],
    ]))) continue;
    if (skill.hasComponent('ignore_region_status') ||
        skill.hasComponent('ignore_terrain')) values.push(true);
    if (skill.hasComponent('gain_terrain')) values.push(false);
  }
  return values.length > 0 && values.every(Boolean);
}

/** Unit can counter at any range. */
export function distantCounter(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'distant_counter', context);
}

/** Unit can counter at range 1 even with ranged weapon. */
export function closeCounter(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'close_counter', context);
}

/** Unit should not move after attacking (no canto override). */
export function noAttackAfterMove(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'no_attack_after_move', context);
}

/** Pass through terrain (flying). */
export function passThrough(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'pass', context) ||
    activeBooleanSkill(unit, 'pass_through', context);
}

/** Attacker goes second (opposite of vantage). */
export function disvantage(
  unit: UnitObject,
  context: EvaluatedSkillContext = {},
): boolean {
  return activeBooleanSkill(unit, 'disvantage', context);
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
export function miracleSkill(
  unit: UnitObject,
): { skill: SkillObject; full: boolean } | null {
  for (const skill of unit.skills) {
    const full = skill.hasComponent('full_miracle');
    if (!skill.hasComponent('miracle') && !full) continue;
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
      if (charge < total) continue;
    }
    if (hasDrainingCharge(skill)) {
      if (Number(skill.data.get('charge') ?? 0) <= 0) continue;
    }
    return { skill, full };
  }
  return null;
}

export function hasDrainingCharge(skill: SkillObject): boolean {
  return skill.hasComponent('drain_charge') ||
    skill.hasComponent('charges_per_turn') ||
    skill.hasComponent('drain_charge_all') ||
    skill.hasComponent('limited_charge') ||
    skill.hasComponent('lost_on_charges_depleted');
}

/** Consume the charge (if any) on a triggered miracle skill (Python TriggerCharge). */
export function consumeMiracleCharge(
  skill: SkillObject,
  owner?: UnitObject,
  game?: any,
): void {
  if (skill.hasComponent('build_charge')) {
    skill.data.set('charge', 0);
  } else if (hasDrainingCharge(skill)) {
    const next = Number(skill.data.get('charge') ?? 0) - 1;
    skill.data.set('charge', next);
    if (skill.hasComponent('drain_charge_all') && owner && game?.units) {
      for (const candidate of game.units.values()) {
        const sharesCharge = owner.team === 'player'
          ? candidate.team === 'player' &&
            (candidate.party === game.currentParty || candidate.party === 'Flex')
          : (owner.team === 'enemy' || owner.team === 'enemy2') &&
            (candidate.team === 'enemy' || candidate.team === 'enemy2');
        if (candidate.nid === owner.nid || !sharesCharge) continue;
        const shared = candidate.skills.find(
          (candidateSkill: SkillObject) => candidateSkill.nid === skill.nid,
        );
        if (shared) shared.data.set('charge', next);
      }
    }
    if (skill.hasComponent('lost_on_charges_depleted') &&
        next <= 0 && owner?.skills.includes(skill)) {
      owner.skills.splice(owner.skills.indexOf(skill), 1);
    }
  }
}

export type CustomSurvivalComponent =
  | 'nine_lives_event'
  | 'true_miracle_event'
  | 'true_miracle_event_after_combat'
  | 'True_Miracle_Event'
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
    if (hasDrainingCharge(skill) &&
        Number(skill.data.get('charge') ?? 0) <= 0) continue;
    for (const [component, value] of skill.components) {
      if (component === 'nine_lives_event' ||
          component === 'true_miracle_event' ||
          component === 'true_miracle_event_after_combat' ||
          component === 'True_Miracle_Event') {
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
  // Python runs every after_take_strike hook: IgnoreDamage deletes the HP
  // loss whichever order it runs in, so it wins over TrueMiracle-style 1 HP
  // survival. The EOtF fork's TrueMiracle also skips IgnoringDamage units.
  let survival: CustomSurvivalSkill | null = null;
  const ignoringDamage = (): boolean => unit.tags.includes('IgnoringDamage') ||
    additionalTags(unit, game).has('IgnoringDamage');
  for (const skill of unit.skills) {
    if (alreadyTriggered.has(skill)) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
      if (charge < total) continue;
    }
    if (hasDrainingCharge(skill) &&
        Number(skill.data.get('charge') ?? 0) <= 0) continue;
    for (const [component, value] of skill.components) {
      if (component === 'ignore_damage') return { skill, component, value };
      if (survival) continue;
      if (lethal && component === 'TrueMiracle' &&
          !(isForkEngine() && ignoringDamage())) {
        survival = { skill, component, value };
        continue;
      }
      if (lethal && (
        component === 'nine_lives_event' ||
        component === 'true_miracle_event' ||
        component === 'true_miracle_event_after_combat' ||
        (component === 'True_Miracle_Event' &&
          !ignoringDamage())
      )) survival = { skill, component, value };
    }
  }
  return survival;
}

/** Unit cannot be displaced by shove, swap, warp, rescue, or related item hooks. */
export function ignoreForcedMovement(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): boolean {
  return activeBooleanSkill(unit, 'grounded', { game }) ||
    activeBooleanSkill(unit, 'ignore_forced_movement', { game });
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

/** Is one Canto-family skill currently eligible to contribute its hooks? */
function cantoSkillActive(
  skill: SkillObject,
  unit: UnitObject,
  target: UnitObject | null,
  game: any,
): boolean {
  if (!skillConditionActive(skill, unit, { game, target })) return false;
  if (skill.hasComponent('build_charge') &&
      Number(skill.data.get('charge') ?? 0) <
        Number(skill.data.get('total_charge') ?? 0)) return false;
  return !hasDrainingCharge(skill) ||
    Number(skill.data.get('charge') ?? 0) > 0;
}

/**
 * Python `skill_system.has_canto` (ANY_DEFAULT_FALSE), preserving each
 * movement component's distinct post-action gate.
 */
export function hasCanto(
  unit: UnitObject,
  target: UnitObject | null = null,
  game: any = skillGameRef?.(),
): boolean {
  for (const skill of unit.skills) {
    if (!isCantoSkill(skill) || !cantoSkillActive(skill, unit, target, game)) continue;
    if (skill.hasComponent('canto_plus') ||
        skill.hasComponent('canter') ||
        skill.hasComponent('eval_canter')) return true;
    if (skill.hasComponent('canto') &&
        (!unit.hasAttacked || unit === target)) return true;
    if (skill.hasComponent('canto_sharp') &&
        (!unit.hasAttacked || unit.movementLeft >= unit.getStatValue('MOV'))) return true;
  }
  return false;
}

/**
 * Python `skill_system.canto_movement` (MAXIMUM). Ordinary Canto variants
 * preserve the remaining budget, Canter supplies a fixed budget, and EOtF's
 * EvalCanter evaluates its expression with the acting unit and action target.
 */
export function cantoMovement(
  unit: UnitObject,
  target: UnitObject | null = null,
  game: any = skillGameRef?.(),
): number {
  let maximum = 0;
  const classTags = game?.db?.classes?.get(unit.klass)?.tags ?? [];
  const nullCanto = unit.tags.includes('NullCanto') ||
    classTags.includes('NullCanto') ||
    additionalTags(unit, game).has('NullCanto');
  for (const skill of unit.skills) {
    if (!isCantoSkill(skill) || !cantoSkillActive(skill, unit, target, game)) continue;
    // EOtF fork: every built-in canto variant returns min(1, movement) for
    // NullCanto units (upstream has no NullCanto check).
    const capBuiltIn = (value: number): number =>
      nullCanto && isForkEngine() ? Math.min(1, value) : value;
    if (skill.hasComponent('canto') ||
        skill.hasComponent('canto_plus') ||
        skill.hasComponent('canto_sharp')) {
      maximum = Math.max(maximum, capBuiltIn(Math.trunc(unit.movementLeft)));
    }
    const canter = skill.getComponent<unknown>('canter');
    if (typeof canter === 'number' && Number.isFinite(canter)) {
      maximum = Math.max(maximum, capBuiltIn(Math.trunc(canter)));
    }
    const expression = skill.getComponent<unknown>('eval_canter');
    if (typeof expression === 'string' && expression.length > 0) {
      // EOtF EvalCanter: int(evaluate(value, unit, unit2)), 0 when it raises.
      const evaluated = evaluateInt(expression, {
        game,
        unit1: unit,
        unit2: target ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
      }, 0);
      maximum = Math.max(maximum, nullCanto ? Math.min(1, evaluated) : evaluated);
    }
  }
  return Math.max(0, maximum);
}

// ============================================================
// Stat change hooks
// ============================================================

/**
 * Get the total stat change bonus from all skills for a given stat.
 * Standard and subtle stat components store [[statNid, amount], ...].
 */
const evaluatingStatChanges = new WeakMap<UnitObject, Set<string>>();

function statEntriesMention(entries: unknown, statNid: string): boolean {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (Array.isArray(entry) && entry[0] === statNid) return true;
  }
  return false;
}

function statMapMentions(changes: unknown, statNid: string): boolean {
  if (changes instanceof Map) return changes.has(statNid);
  return !!changes && typeof changes === 'object' &&
    Object.prototype.hasOwnProperty.call(changes, statNid);
}

/**
 * Whether any of a skill's stat sources is keyed by `statNid`. Every
 * contribution statChange adds is looked up by stat nid, so a skill that
 * mentions no entry for the stat adds 0 whether or not it is active; its
 * (side-effect-free) condition need not be evaluated. This matters because
 * maxHp is read for every drawn unit every frame.
 */
function skillMayChangeStat(skill: SkillObject, statNid: string): boolean {
  return statEntriesMention(skill.getComponent<unknown>('stat_change'), statNid) ||
    statEntriesMention(skill.getComponent<unknown>('subtle_stat_change'), statNid) ||
    statEntriesMention(skill.getComponent<unknown>('upkeep_stat_change'), statNid) ||
    statEntriesMention(skill.getComponent<unknown>('stat_change_expression'), statNid) ||
    statEntriesMention(skill.getComponent<unknown>('stat_multiplier'), statNid) ||
    statMapMentions(skill.data.get('stat_changes'), statNid) ||
    statMapMentions(skill.data.get('_dynamic_stat_changes'), statNid);
}

export function statChange(unit: UnitObject, statNid: string, game?: any): number {
  game ??= skillGameRef?.();
  const activeStats = evaluatingStatChanges.get(unit) ?? new Set<string>();
  const reentrant = activeStats.has(statNid);
  if (!reentrant) {
    activeStats.add(statNid);
    evaluatingStatChanges.set(unit, activeStats);
  }
  let total = 0;
  for (const skill of unit.skills) {
    const contributesToStat =
      skill.hasComponent('stat_change') ||
      skill.hasComponent('subtle_stat_change') ||
      skill.hasComponent('upkeep_stat_change') ||
      skill.hasComponent('stat_change_expression') ||
      skill.hasComponent('stat_multiplier') ||
      skill.data.has('stat_changes') ||
      skill.data.has('_dynamic_stat_changes');
    if (!contributesToStat || !skillMayChangeStat(skill, statNid)) continue;
    // DynamicStatChange freezes only after all condition/combat/charge gates
    // pass. Its prepared map is therefore also the active snapshot needed by
    // subsequent getStatValue calls, which do not carry target context.
    const hasPreparedDynamic = skill.data.has('_dynamic_stat_changes');
    const needsActiveGate =
      skill.hasComponent('condition') ||
      skill.hasComponent('is_terrain') ||
      skill.hasComponent('combat_condition') ||
      skill.hasComponent('build_charge') ||
      hasDrainingCharge(skill) ||
      skill.hasComponent('self_nihil') ||
      skill.data.get('multiSkillSource') instanceof SkillObject;
    const active = reentrant || hasPreparedDynamic || !needsActiveGate || evaluatedSkillActive(
      skill,
      unit,
      { game, item: unit.equippedWeapon },
      new Map<string, unknown>([
        ['item', unit.equippedWeapon ?? null],
        ['skill', skill],
      ]),
    );
    if (!active) continue;
    const changes = skill.getComponent<any>('stat_change');
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1];
        }
      }
    }
    const subtleChanges = skill.getComponent<any>('subtle_stat_change');
    if (Array.isArray(subtleChanges)) {
      for (const entry of subtleChanges) {
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
    const frozenChanges = skill.data.get('stat_changes');
    if (frozenChanges instanceof Map) {
      const value = Number(frozenChanges.get(statNid) ?? 0);
      if (Number.isFinite(value)) total += value;
    } else if (frozenChanges && typeof frozenChanges === 'object') {
      const value = Number((frozenChanges as Record<string, unknown>)[statNid] ?? 0);
      if (Number.isFinite(value)) total += value;
    }
    const dynamicChanges = skill.data.get('_dynamic_stat_changes');
    if (dynamicChanges instanceof Map) {
      const value = Number(dynamicChanges.get(statNid) ?? 0);
      if (Number.isFinite(value)) total += value;
    } else if (dynamicChanges && typeof dynamicChanges === 'object') {
      const value = Number(
        (dynamicChanges as Record<string, unknown>)[statNid] ?? 0,
      );
      if (Number.isFinite(value)) total += value;
    }
    const expressionChanges = skill.getComponent<unknown>('stat_change_expression');
    if (!reentrant && Array.isArray(expressionChanges) &&
        skillConditionActive(skill, unit, { game })) {
      // Python StatChangeExpression.stat_change: every entry is evaluated
      // as evaluate(expr, unit) inside one try; any failure zeroes all.
      if (expressionChanges.some((entry) => Array.isArray(entry) && entry[0] === statNid)) {
        const changes = evaluateIntPairs(expressionChanges, {
          game,
          unit1: unit,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
        });
        total += changes[statNid] ?? 0;
      }
    }
    const multipliers = skill.getComponent<unknown>('stat_multiplier');
    if (!reentrant && Array.isArray(multipliers) &&
        skillConditionActive(skill, unit, { game })) {
      for (const entry of multipliers) {
        if (!Array.isArray(entry) || entry[0] !== statNid) continue;
        const multiplier = Number(entry[1]);
        if (Number.isFinite(multiplier)) {
          total += Math.trunc((multiplier - 1) * Number(unit.stats[statNid] ?? 0));
        }
      }
    }
  }
  if (!reentrant) {
    activeStats.delete(statNid);
    if (activeStats.size === 0) evaluatingStatChanges.delete(unit);
  }
  return total;
}

/** Freeze EotF DynamicStatChange expressions for one combat encounter. */
export function prepareDynamicStatChanges(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: 'attack' | 'defense',
  game?: any,
): void {
  for (const skill of unit.skills) {
    const configured = skill.getComponent<unknown>('dynamic_stat_change');
    if (!Array.isArray(configured)) continue;
    const localArgs = new Map<string, unknown>([
      ['item', item], ['item2', item2], ['mode', mode], ['skill', skill],
      ['playback', []],
    ]);
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const maximum = Number(
        skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0,
      );
      if (charge < maximum) continue;
    }
    if (hasDrainingCharge(skill) &&
        Number(skill.data.get('charge') ?? 0) <= 0) continue;
    const combatCondition = skill.getComponent<string>('combat_condition');
    if (combatCondition) {
      const snapshot = skill.data.get('_combat_condition');
      const enabled = typeof snapshot === 'boolean'
        ? snapshot
        : evaluateCondition(combatCondition, {
          game,
          unit1: unit,
          unit2: target,
          item: item ?? undefined,
          position: unit.position ?? undefined,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
          localArgs,
        });
      if (!enabled) continue;
    }
    if (!skillConditionActive(skill, unit, { game, item, target, localArgs })) continue;
    // EOtF DynamicStatChange: evaluate(expr, unit, target, local_args=...)
    // for every entry in one try; any failure zeroes all stats.
    const changes = new Map<string, number>(Object.entries(evaluateIntPairs(configured, {
      game,
      unit1: unit,
      unit2: target,
      item: item ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs,
    })));
    skill.data.set('_dynamic_stat_changes', changes);
  }
}

export function clearDynamicStatChanges(unit: UnitObject): void {
  for (const skill of unit.skills) skill.data.delete('_dynamic_stat_changes');
}

/**
 * Get the total growth change bonus from all skills for a given stat.
 */
export function growthChange(
  unit: UnitObject,
  statNid: string,
  game: any = skillGameRef?.(),
): number {
  let total = 0;
  for (const skill of unit.skills) {
    if (!evaluatedSkillActive(skill, unit, { game }, new Map([
      ['skill', skill],
    ]))) continue;
    const changes = skill.getComponent<any>('growth_change');
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
          total += entry[1];
        }
      }
    }
    const expressions = skill.getComponent<unknown>('growth_change_expression');
    if (!Array.isArray(expressions)) continue;
    // EOtF GrowthChangeExpression: {stat: int(evaluate(expr, unit))} in one
    // try; any failure zeroes all.
    if (expressions.some((entry) => Array.isArray(entry) && entry[0] === statNid)) {
      total += evaluateIntPairs(expressions, {
        game,
        unit1: unit,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
      })[statNid] ?? 0;
    }
  }
  return total;
}

// ============================================================
// Static modifier hooks (NUMERIC_ACCUM)
// ============================================================

interface EvaluatedSkillContext {
  game?: any;
  item?: ItemObject | null;
  target?: UnitObject | null;
  item2?: ItemObject | null;
  mode?: string;
  attackInfo?: any;
  baseValue?: number;
}

function evaluatedSkillActive(
  skill: SkillObject,
  unit: UnitObject,
  context: EvaluatedSkillContext,
  localArgs: Map<string, unknown>,
): boolean {
  const parent = skill.data?.get?.('multiSkillSource');
  if (parent instanceof SkillObject) {
    const parentArgs = new Map(localArgs);
    parentArgs.set('skill', parent);
    if (!evaluatedSkillActive(parent, unit, context, parentArgs)) return false;
  }
  if (skill.hasComponent('build_charge')) {
    const charge = Number(skill.data?.get?.('charge') ?? 0);
    const maximum = Number(
      skill.data?.get?.('total_charge') ?? skill.getComponent('build_charge') ?? 0,
    );
    if (charge < maximum) return false;
  }
  if (hasDrainingCharge(skill) &&
      Number(skill.data?.get?.('charge') ?? 0) <= 0) return false;
  const combatCondition = skill.getComponent<string>('combat_condition');
  if (combatCondition) {
    const snapshot = skill.data?.get?.('_combat_condition');
    if (typeof snapshot !== 'boolean' && !context.target) return false;
    const enabled = typeof snapshot === 'boolean' ? snapshot : evaluateCondition(
      combatCondition,
      {
        game: context.game,
        unit1: unit,
        unit2: context.target ?? undefined,
        item: context.item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: context.game?.gameVars,
        levelVars: context.game?.levelVars,
        localArgs,
      },
    );
    if (!enabled) return false;
  }
  return skillConditionActive(skill, unit, {
    game: context.game,
    item: context.item,
    target: context.target,
    localArgs,
  });
}

function evaluatedStaticSkillTotal(
  unit: UnitObject,
  component: string,
  context: EvaluatedSkillContext = {},
): number {
  context.game ??= skillGameRef?.();
  let total = 0;
  for (const skill of unit.skills) {
    const expression = skill.getComponent<unknown>(component);
    if (typeof expression !== 'string' && typeof expression !== 'number') continue;
    const localArgs = new Map<string, unknown>([
      ['item', context.item ?? null],
      ['item2', context.item2 ?? null],
      ['mode', context.mode ?? null],
      ['skill', skill],
      ['attack_info', context.attackInfo ?? null],
      ['base_value', context.baseValue ?? 0],
    ]);
    if (!evaluatedSkillActive(skill, unit, context, localArgs)) continue;
    // Python eval_* components: int(evaluate(...)), 0 when it raises.
    const value = typeof expression === 'number'
      ? expression
      : evaluateInt(expression, {
        game: context.game,
        unit1: unit,
        unit2: context.target ?? undefined,
        item: context.item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: context.game?.gameVars,
        levelVars: context.game?.levelVars,
        localArgs,
      }, 0);
    if (Number.isFinite(value)) total += Math.trunc(value);
  }
  return total;
}

/** Bonus damage from skills. */
export function modifyDamage(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  let total = evaluatedStaticSkillTotal(unit, 'modify_damage', context) +
    evaluatedStaticSkillTotal(unit, 'damage', context);
  total += evaluatedStaticSkillTotal(unit, 'eval_damage', {
    game, item, target, item2, mode, attackInfo,
  });
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
export function modifyResist(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_resist', context) +
    evaluatedStaticSkillTotal(unit, 'resist', context);
}

/** Bonus accuracy from skills. */
export function modifyAccuracy(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_accuracy', context) +
    evaluatedStaticSkillTotal(unit, 'hit', context) +
    evaluatedStaticSkillTotal(unit, 'eval_hit', {
      game, item, target, item2, mode, attackInfo,
    });
}

/** Bonus avoid from skills. */
export function modifyAvoid(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_avoid', context) +
    evaluatedStaticSkillTotal(unit, 'avoid', context) +
    evaluatedStaticSkillTotal(unit, 'eval_avoid', {
      game, item, target, item2, mode, attackInfo,
    });
}

/** Bonus crit accuracy from skills. */
export function modifyCritAccuracy(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_crit_accuracy', context) +
    evaluatedStaticSkillTotal(unit, 'crit', context) +
    evaluatedStaticSkillTotal(unit, 'eval_crit', {
      game, item, target, item2, mode, attackInfo,
    });
}

/** Bonus crit avoid from skills. */
export function modifyCritAvoid(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_crit_avoid', context) +
    evaluatedStaticSkillTotal(unit, 'crit_avoid', context);
}

/**
 * Bonus crit damage from skills.
 *
 * EotF's `eval_crit_additional` component names its Python hook
 * `modify_crit_addition`, while LT's generated dispatch surface calls
 * `modify_crit_damage`. The shipped Python build therefore leaves these
 * authored values dormant. Treat the component as the intended additive
 * crit-damage hook so the project's definitions function in the port.
 */
export function modifyCritDamage(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
): number {
  let total = sumSkillValues(unit, 'modify_crit_damage');
  for (const skill of unit.skills) {
    const expression = skill.getComponent<string>('eval_crit_additional');
    if (!expression || !skillConditionActive(skill, unit, { game, item })) continue;
    const value = evaluateInt(expression, {
      game,
      unit1: unit,
      item: item ?? undefined,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs: new Map<string, unknown>([
        ['item', item],
        ['skill', skill],
      ]),
    }, 0);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) total += Math.trunc(numeric);
  }
  return total;
}

/**
 * EotF's target-aware additive critical-damage expression.
 *
 * Like `eval_crit_additional`, this custom hook is absent from LT's generated
 * hook registry. Invoke it at the intended critical-addition stage and pass
 * the running critical damage as `base_value`.
 */
export function dynamicCritDamageAddition(
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
    const expression = skill.getComponent<string>('dynamic_crit_additional');
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['item2', item2],
      ['mode', mode],
      ['skill', skill],
      ['attack_info', attackInfo],
      ['base_value', baseValue],
    ]);
    if (!expression || !skillConditionActive(skill, unit, {
      game,
      item,
      target,
      localArgs,
    })) continue;
    const value = evaluateInt(expression, {
      game,
      unit1: unit,
      unit2: target,
      item,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs,
    }, 0);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) total += Math.trunc(numeric);
  }
  return total;
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
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_crit_accuracy', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

export function dynamicCritAvoid(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_crit_avoid', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

/** Python NUMERIC_MULTIPLY crit_multiplier hook, including PCC/PCCStatic. */
export function critMultiplier(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: [number, number],
  baseValue: number,
  game?: any,
): number {
  let multiplier = 1;
  for (const skill of unit.skills) {
    if (!skill.hasComponent('pcc_static') && !skill.hasComponent('pcc')) continue;
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['item2', item2],
      ['mode', mode],
      ['skill', skill],
      ['attack_info', attackInfo],
      ['base_value', baseValue],
    ]);
    if (!evaluatedSkillActive(
      skill,
      unit,
      { game, item, target, item2, mode, attackInfo, baseValue },
      localArgs,
    )) continue;
    const staticValue = skill.getComponent<unknown>('pcc_static');
    if (typeof staticValue === 'number' && attackInfo[0] > 0) {
      multiplier *= staticValue;
    }
    const statNid = skill.getComponent<unknown>('pcc');
    if (typeof statNid === 'string' && attackInfo[0] > 0) {
      multiplier *= unit.getStatValue(statNid);
    }
  }
  return multiplier;
}

/** Last active alternate critical multiplier equation, matching Python UNIQUE. */
export function criticalMultiplierFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | null {
  return getActiveSkillHookValue<string>(
    unit,
    ['alternate_critical_multiplier_formula'],
    context,
  ) ?? null;
}

/** Last active alternate additive critical-damage equation. */
export function criticalAdditionFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | null {
  return getActiveSkillHookValue<string>(
    unit,
    ['alternate_critical_addition_formula'],
    context,
  ) ?? null;
}

/** Base item maximum range after skill additions and the optional hard cap. */
export function modifiedMaximumRange(
  unit: UnitObject,
  item: ItemObject,
  game?: any,
): number {
  let maximum = Math.max(0, item.getMaxRange(unit, game));
  let limit = 1000;
  for (const skill of unit.skills) {
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['skill', skill],
    ]);
    if (!evaluatedSkillActive(skill, unit, { game, item }, localArgs)) continue;
    const flat = skill.getComponent<number>('modify_maximum_range');
    if (typeof flat === 'number') maximum += flat;
    for (const componentNid of ['eval_max_range', 'eval_range']) {
      const expression = skill.getComponent<string>(componentNid);
      if (typeof expression !== 'string' || !expression) continue;
      const value = evaluateInt(expression, {
        game,
        unit1: unit,
        item,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs,
      }, 0);
      if (Number.isFinite(Number(value))) maximum += Math.trunc(Number(value));
    }
    const configuredLimit = skill.getComponent<number>('limit_maximum_range');
    if (typeof configuredLimit === 'number') limit = configuredLimit;
  }
  return Math.max(0, Math.min(maximum, limit));
}

/** Base item minimum range after active flat/evaluated skill additions. */
export function modifiedMinimumRange(
  unit: UnitObject,
  item: ItemObject,
  game?: any,
): number {
  let minimum = Math.max(0, item.getMinRange(unit, game));
  for (const skill of unit.skills) {
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['skill', skill],
    ]);
    if (!evaluatedSkillActive(skill, unit, { game, item }, localArgs)) continue;
    const flat = skill.getComponent<number>('modify_minimum_range');
    if (typeof flat === 'number') minimum += flat;
    const expression = skill.getComponent<string>('eval_min_range');
    if (typeof expression !== 'string' || !expression) continue;
    const value = evaluateInt(expression, {
      game,
      unit1: unit,
      item,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs,
    }, 0);
    if (Number.isFinite(Number(value))) minimum += Math.trunc(Number(value));
  }
  return minimum;
}

/** Last active movement-type override, falling back to the unit's class group. */
export function movementType(unit: UnitObject, defaultType: string, game?: any): string {
  let result = defaultType;
  for (const skill of unit.skills) {
    const value = skill.getComponent<string>('movement_type');
    if (typeof value !== 'string' || !value) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    result = value;
  }
  return result;
}

/** Python UNIQUE alliance hooks: IgnoreAlliances makes only the bearer itself an ally. */
export function checkAlly(
  unit: UnitObject,
  target: UnitObject,
  db: any,
  game: any = skillGameRef?.(),
): boolean {
  if (hasActiveSkillComponent(unit, 'ignore_alliances', game)) {
    return unit === target;
  }
  return db.areAllied(unit.team, target.team);
}

export function checkEnemy(
  unit: UnitObject,
  target: UnitObject,
  db: any,
  game: any = skillGameRef?.(),
): boolean {
  if (hasActiveSkillComponent(unit, 'ignore_alliances', game)) {
    return unit !== target;
  }
  return !db.areAllied(unit.team, target.team);
}

/**
 * Python `num_items_offset`/`num_accessories_offset` UNIQUE hooks.
 * Each hook resolves independently to the last active component value.
 */
export function inventoryCapacityOffsets(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): {
  items: number;
  accessories: number;
} {
  let items = 0;
  let accessories = 0;
  for (const skill of unit.skills) {
    if (!evaluatedSkillActive(skill, unit, { game }, new Map([
      ['skill', skill],
    ]))) continue;
    for (const [component, raw] of skill.components) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const value = Math.trunc(raw);
      if (component === 'additional_accessories') {
        items = -value;
        accessories = value;
      } else if (component === 'additional_inventory') {
        items = value;
        accessories = -value;
      } else if (component === 'change_item_slots') {
        items = value;
      }
    }
  }
  return { items, accessories };
}

/** Product of active target-priority modifiers. */
export function aiPriorityMultiplier(unit: UnitObject, game?: any): number {
  let result = 1;
  for (const skill of unit.skills) {
    const value = skill.getComponent<number>('modify_ai_priority');
    if (typeof value !== 'number') continue;
    const localArgs = new Map<string, unknown>([['skill', skill]]);
    if (!evaluatedSkillActive(skill, unit, { game }, localArgs)) continue;
    result *= value;
  }
  return result;
}

/** Last active AI override, matching Python UNIQUE dispatch. */
export function changeAi(unit: UnitObject, defaultAi: string, game?: any): string {
  let result = defaultAi;
  for (const skill of unit.skills) {
    const value = skill.getComponent<string>('change_ai');
    if (typeof value !== 'string' || !value) continue;
    const localArgs = new Map<string, unknown>([['skill', skill]]);
    if (!evaluatedSkillActive(skill, unit, { game }, localArgs)) continue;
    result = value;
  }
  return result;
}

/** Last active shop price multiplier, matching Python UNIQUE dispatch. */
export function priceSkillMultiplier(
  unit: UnitObject,
  item: ItemObject,
  componentNid: 'change_buy_price' | 'change_sell_price',
  game?: any,
): number {
  let result = 1;
  for (const skill of unit.skills) {
    const value = skill.getComponent<number>(componentNid);
    if (typeof value !== 'number') continue;
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['skill', skill],
    ]);
    if (!evaluatedSkillActive(skill, unit, { game, item }, localArgs)) continue;
    result = value;
  }
  return result;
}

/** Python UNIQUE Witch Warp destinations across generic, specific, and expression forms. */
export function witchWarpPositions(
  unit: UnitObject,
  board: any,
  db: any,
  game?: any,
): [number, number][] {
  let source: {
    skill: SkillObject;
    component: 'witch_warp' | 'specific_witch_warp' | 'witch_warp_expression';
    value: unknown;
  } | null = null;
  for (const skill of unit.skills) {
    for (const [component, value] of skill.components) {
      if (component !== 'witch_warp' &&
          component !== 'specific_witch_warp' &&
          component !== 'witch_warp_expression') continue;
      if (!evaluatedSkillActive(skill, unit, { game }, new Map([
        ['skill', skill],
      ]))) continue;
      source = { skill, component, value };
    }
  }
  if (!source) return [];
  // EOtF's engine: every witch warp form offers no tiles while the unit's
  // Spotlight skill (a global skill) is active.
  if (isForkEngine()) {
    const spotlight = unit.skills.find((skill) => skill.nid === 'Spotlight');
    if (spotlight && skillConditionActive(spotlight, unit, { game })) return [];
  }

  const defaultMovement = db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
  const movementGroup = movementType(unit, defaultMovement, game);
  const result: [number, number][] = [];
  const seen = new Set<string>();
  let candidates: UnitObject[];
  if (source.component === 'specific_witch_warp') {
    const nids = Array.isArray(source.value)
      ? source.value.filter((value): value is string => typeof value === 'string')
      : [];
    const units = board.getAllUnits() as UnitObject[];
    candidates = nids.flatMap((nid) => {
      const target = game?.units?.get?.(nid) ??
        units.find((candidate) => candidate.nid === nid);
      return target ? [target] : [];
    });
  } else {
    candidates = board.getAllUnits();
  }
  for (const target of candidates) {
    if (!target.position) continue;
    if (source.component === 'witch_warp' && target.team !== unit.team) continue;
    if (source.component === 'witch_warp_expression') {
      if (typeof source.value !== 'string' || !source.value) continue;
      // Python WitchWarpExpression: an exception logs and returns the
      // positions collected so far.
      const outcome = evaluatePythonInContext(source.value, {
        game,
        unit1: target,
        unit2: unit,
        position: target.position,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs: new Map([['skill', source.skill]]),
      });
      if (!outcome.ok) {
        console.error(`witch_warp_expression failed for "${source.value}"`, outcome.error);
        return result;
      }
      if (!pythonTruthy(outcome.value)) continue;
    }
    const [x, y] = target.position;
    const directions: [number, number][] = source.component === 'witch_warp'
      ? [[0, -1], [0, 1], [-1, 0], [1, 0]]
      : [[0, -1], [-1, 0], [1, 0], [0, 1]];
    for (const [dx, dy] of directions) {
      const position: [number, number] = [x + dx, y + dy];
      const key = `${position[0]},${position[1]}`;
      if (seen.has(key) || !board.checkBounds(position[0], position[1]) ||
          board.getUnit(position[0], position[1]) ||
          board.getMovementCost(position[0], position[1], movementGroup, db) >= 99) {
        continue;
      }
      seen.add(key);
      result.push(position);
    }
  }
  return result;
}

/** Uses restored per qualifying strike by project Armsthrift skills. */
export function armsthriftRestoration(unit: UnitObject, item: ItemObject): number {
  if (item.hasComponent('unrepairable')) return 0;
  let restored = 0;
  for (const skill of unit.skills) {
    const value = skill.getComponent<number>('armsthrift');
    // Python writes `min(curr_uses + value - 1, max_uses)` after each
    // ordinary one-point use loss. At the max-uses boundary any positive
    // value cancels that strike's loss, but cannot restore more than one.
    if (typeof value === 'number') restored += Math.min(1, Math.max(0, value));
  }
  return restored;
}

/** Attack speed modifier from skills. */
export function modifyAttackSpeed(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_attack_speed', context) +
    evaluatedStaticSkillTotal(unit, 'attack_speed', context);
}

/** Defense speed modifier from skills. */
export function modifyDefenseSpeed(
  unit: UnitObject,
  item: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode?: string,
  attackInfo?: any,
): number {
  const context = { game, item, target, item2, mode, attackInfo };
  return evaluatedStaticSkillTotal(unit, 'modify_defense_speed', context) +
    evaluatedStaticSkillTotal(unit, 'defense_speed', context);
}

// ============================================================
// Dynamic modifier hooks (NUMERIC_ACCUM with combat context)
// ============================================================

/** Dynamic damage modifier (situational bonuses). */
export function dynamicDamage(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_damage', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

/** Dynamic resist modifier. */
export function dynamicResist(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_resist', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

/** Dynamic accuracy modifier. */
export function dynamicAccuracy(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_accuracy', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

/** Dynamic avoid modifier. */
export function dynamicAvoid(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_avoid', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

export function dynamicAttackSpeed(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_attack_speed', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

export function dynamicDefenseSpeed(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_defense_speed', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

/** Dynamic extra attacks from skills. */
function evaluatedCombatSkillTotal(
  unit: UnitObject,
  component: string,
  item: ItemObject | null,
  target: UnitObject | null,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
  markerValue: number = 0,
): number {
  game ??= skillGameRef?.();
  let total = 0;
  for (const skill of unit.skills) {
    if (!skill.hasComponent(component)) continue;
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['item2', item2],
      ['mode', mode],
      ['skill', skill],
      ['attack_info', attackInfo],
      ['base_value', baseValue],
    ]);
    if (!evaluatedSkillActive(
      skill, unit,
      { game, item, target, item2, mode, attackInfo, baseValue },
      localArgs,
    )) continue;
    const configured = skill.getComponent<unknown>(component);
    const value = typeof configured === 'number'
      ? configured
      : typeof configured === 'string'
        // Python dynamic_*: int(evaluate(...)), 0 when it raises.
        ? evaluateInt(configured, {
          game,
          unit1: unit,
          unit2: target ?? undefined,
          item: item ?? undefined,
          position: unit.position ?? undefined,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
          localArgs,
        }, 0)
        : markerValue;
    if (Number.isFinite(value)) total += Math.trunc(value);
  }
  return total;
}

/**
 * EOtF fork `brave`, `brave_on_attack` and `dynamic_multiattacks` return 0
 * when the item carries the `NoMulti` item tag or the target has the
 * `BlockMulti` unit tag (`all_brave` has no such check). Upstream has neither.
 */
export function multiattacksBlocked(
  item: ItemObject | null,
  target: UnitObject | null,
  game?: any,
): boolean {
  if (!isForkEngine()) return false;
  if (item?.tags.includes('NoMulti')) return true;
  if (!target) return false;
  const classTags = game?.db?.classes?.get?.(target.klass)?.tags;
  return target.tags.includes('BlockMulti') ||
    (Array.isArray(classTags) && classTags.includes('BlockMulti')) ||
    additionalTags(target, game).has('BlockMulti');
}

export function dynamicMultiattacks(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject | null,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  const dynamic = multiattacksBlocked(item, target, game) ? 0 : evaluatedCombatSkillTotal(
    unit, 'dynamic_multiattacks', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
  return dynamic + evaluatedCombatSkillTotal(
    unit, 'all_brave', item, target, item2, mode,
    attackInfo, baseValue, game, 1,
  );
}

export function dynamicAttacks(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject | null,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_attacks', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

export function dynamicBlitzes(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject | null,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_blitzes', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

export function evaluatedExtraDamage(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'eval_extra_damage', item, target, item2, mode,
    attackInfo, baseValue, game,
  );
}

// ============================================================
// Multiplier hooks (NUMERIC_MULTIPLY)
// ============================================================

/** Final damage multiplier (product of all). */
export function damageMultiplier(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
): number {
  game ??= skillGameRef?.();
  let result = 1;
  for (const skill of unit.skills) {
    if (!skill.hasComponent('damage_multiplier') &&
        !skill.hasComponent('dynamic_damage_multiplier')) continue;
    const localArgs = new Map<string, unknown>([
      ['item', item], ['item2', item2], ['mode', mode], ['skill', skill],
      ['attack_info', attackInfo], ['base_value', baseValue],
    ]);
    if (!evaluatedSkillActive(
      skill, unit, { game, item, target, item2, mode, attackInfo, baseValue },
      localArgs,
    )) continue;
    const fixed = skill.getComponent<number>('damage_multiplier');
    if (typeof fixed === 'number') result *= fixed;
    const expression = skill.getComponent<string>('dynamic_damage_multiplier');
    if (expression) {
      // EOtF's fork DynamicDamageMultiplier: float(evaluate(...)), 1 when it
      // raises (upstream LT int-casts; the fork keeps the fraction).
      const value = evaluateFloat(expression, {
        game,
        unit1: unit,
        unit2: target,
        item: item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs,
      }, 1);
      result *= value;
    }
  }
  return result;
}

/** Final resist multiplier (product of all). */
export function resistMultiplier(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: [number, number],
  baseValue: number,
  game?: any,
): number {
  let result = 1;
  for (const skill of unit.skills) {
    const localArgs = new Map<string, unknown>([
      ['item', item],
      ['item2', item2],
      ['mode', mode],
      ['skill', skill],
      ['attack_info', attackInfo],
      ['base_value', baseValue],
    ]);
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(
        skill.data.get('total_charge') ??
        skill.getComponent('build_charge') ??
        0,
      );
      if (charge < total) continue;
    }
    if (hasDrainingCharge(skill) &&
        Number(skill.data.get('charge') ?? 0) <= 0) continue;
    const combatCondition = skill.getComponent<string>('combat_condition');
    if (combatCondition) {
      const snapshot = skill.data.get('_combat_condition');
      const enabled = typeof snapshot === 'boolean'
        ? snapshot
        : evaluateCondition(combatCondition, {
          game,
          unit1: unit,
          unit2: target,
          item: item ?? undefined,
          position: unit.position ?? undefined,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
          localArgs,
        });
      if (!enabled) continue;
    }
    if (!skillConditionActive(skill, unit, { game, item, target, localArgs })) {
      continue;
    }
    const fixed = skill.getComponent<number>('resist_multiplier');
    if (typeof fixed === 'number') result *= fixed;
    const followUp = skill.getComponent<number>('resist_follow_up');
    if (typeof followUp === 'number' && attackInfo[0] > 0) result *= followUp;
    const expression = skill.getComponent<string>('dynamic_resist_multiplier');
    if (expression) {
      // EOtF DynamicResistMultiplier: float(evaluate(...)), 1 when it raises.
      const value = evaluateFloat(expression, {
        game,
        unit1: unit,
        unit2: target,
        item: item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs,
      }, 1);
      result *= value;
    }
  }
  return result;
}

// ============================================================
// Formula hooks (UNIQUE — override the default formula name)
// ============================================================

/** Override the damage formula name. Default: null (use standard). */
export function damageFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | undefined {
  return getActiveSkillHookValue<string>(
    unit,
    ['damage_formula', 'alternate_damage_formula', 'alternate_magic_damage_formula'],
    context,
  );
}

export function damageFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'damage_formula_override');
}

/** Override the resist formula name. */
export function resistFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | undefined {
  return getActiveSkillHookValue<string>(
    unit,
    ['resist_formula', 'alternate_resist_formula'],
    context,
  );
}

export function resistFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'resist_formula_override');
}

/** Override the accuracy formula name. */
export function accuracyFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | undefined {
  return getActiveSkillHookValue<string>(
    unit,
    ['accuracy_formula', 'alternate_accuracy_formula'],
    context,
  );
}

export function accuracyFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'accuracy_formula_override');
}

/** Override the avoid formula name. */
export function avoidFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | undefined {
  return getActiveSkillHookValue<string>(
    unit,
    ['avoid_formula', 'alternate_avoid_formula'],
    context,
  );
}

export function avoidFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'avoid_formula_override');
}

export function critAccuracyFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | undefined {
  return getActiveSkillHookValue<string>(
    unit,
    ['crit_accuracy_formula', 'alternate_crit_accuracy_formula'],
    context,
  );
}

export function critAccuracyFormulaOverride(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'crit_accuracy_formula_override');
}

export function critAvoidFormula(
  unit: UnitObject,
  context: SkillConditionContext = {},
): string | undefined {
  return getActiveSkillHookValue<string>(
    unit,
    ['crit_avoid_formula', 'alternate_crit_avoid_formula'],
    context,
  );
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

export function expMultiplier(unit: UnitObject, target: UnitObject | null): number {
  return getActiveSkillHookValue<number>(
    unit,
    ['exp_multiplier'],
    { game: skillGameRef?.(), target },
  ) ?? 1;
}

export function enemyExpMultiplier(unit: UnitObject, target: UnitObject | null): number {
  return getActiveSkillHookValue<number>(
    unit,
    ['enemy_exp_multiplier'],
    { game: skillGameRef?.(), target },
  ) ?? 1;
}

export function wexpMultiplier(unit: UnitObject, target: UnitObject | null): number {
  return getActiveSkillHookValue<number>(
    unit,
    ['wexp_multiplier'],
    { game: skillGameRef?.(), target },
  ) ?? 1;
}

export function enemyWexpMultiplier(unit: UnitObject, target: UnitObject | null): number {
  return getActiveSkillHookValue<number>(
    unit,
    ['enemy_wexp_multiplier'],
    { game: skillGameRef?.(), target },
  ) ?? 1;
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
export function sightRange(
  unit: UnitObject,
  game: any = skillGameRef?.(),
): number {
  // Upstream sums (NUMERIC_ACCUM); EOtF's engine fork resolves the hook as
  // UNIQUE, so the last active value (skill then component order) wins.
  const values: number[] = [];
  for (const skill of unit.skills) {
    const flatBonus = skill.getComponent<number>('sight_range_bonus');
    const decBonus = skill.getComponent<number>('decreasing_sight_range_bonus');
    if (typeof flatBonus !== 'number' && typeof decBonus !== 'number') continue;
    if (!evaluatedSkillActive(skill, unit, { game }, new Map([
      ['skill', skill],
    ]))) continue;
    for (const nid of skill.components.keys()) {
      if (nid === 'sight_range_bonus' && typeof flatBonus === 'number') {
        values.push(flatBonus);
      } else if (nid === 'decreasing_sight_range_bonus' && typeof decBonus === 'number') {
        // Torch effect: the bonus decreases by 1 each turn.
        const counter = (skill.data.get('torch_counter') as number) ?? 0;
        values.push(Math.max(0, decBonus - counter));
      }
    }
  }
  if (isForkEngine()) return values.length > 0 ? values[values.length - 1] : 0;
  return values.reduce((total, value) => total + value, 0);
}

// Python skill_system.condition, exposed to evaluated expressions.
setSkillConditionEvaluator((skill, unit, item, game) =>
  skillConditionActive(skill, unit, { game, item: item ?? unit.equippedWeapon ?? null }));
