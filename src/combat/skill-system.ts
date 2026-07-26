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
  if (!skill.hasComponent('stat_change_at_apply_expression') ||
      skill.data.has('stat_changes')) return;

  const configured = skill.getComponent<unknown>('stat_change_at_apply_expression');
  const changes: Record<string, number> = {};
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const expression = entry[1];
      let value = 0;
      if (typeof expression === 'string') {
        try {
          const evaluated = Number(evaluateExpression(expression, {
            game,
            gameVars: game?.gameVars,
            levelVars: game?.levelVars,
            localArgs: new Map<string, unknown>([['skill', skill]]),
          }));
          if (Number.isFinite(evaluated)) value = Math.trunc(evaluated);
        } catch (error) {
          console.error(
            `Could not initialize stat changes for ${skill.nid}: ${expression}`,
            error,
          );
        }
      }
      changes[entry[0]] = value;
    }
  }
  skill.data.set('stat_changes', changes);
}

/** Python skill_system.additional_tags, including EotF RedirectDamage. */
export function additionalTags(unit: UnitObject, game?: any): Set<string> {
  const tags = new Set<string>();
  for (const skill of unit.skills) {
    if (!skillConditionActive(skill, unit, { game })) continue;
    const configured = skill.getComponent<unknown>('has_tags');
    if (Array.isArray(configured)) {
      for (const tag of configured) {
        if (typeof tag === 'string') tags.add(tag);
      }
    }
    if (skill.hasComponent('redirect_damage')) tags.add('IgnoringDamage');
  }
  return tags;
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
  const parent = skill.data.get('multiSkillSource');
  if (parent instanceof SkillObject) {
    const parentArgs = new Map(context.localArgs ?? []);
    parentArgs.set('skill', parent);
    if (!skillConditionActive(parent, unit, { ...context, localArgs: parentArgs })) {
      return false;
    }
  }
  if (!selfNihilActive(skill, unit)) return false;

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
  return !unit.skills.some((skill) => {
    if (!skill.hasComponent('unselectable')) return false;
    return skillConditionActive(skill, unit, { game });
  });
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
    if (!skillConditionActive(skill, unit, { game, target })) continue;
    const value = typeof raw === 'number'
      ? raw
      : evaluateExpression(String(raw), {
        game,
        unit1: unit,
        unit2: target,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs: new Map([['skill', skill]]),
      });
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
  if (!skillConditionActive(skill, owner, { game, target: other })) return null;
  const value = typeof raw === 'number'
    ? raw
    : evaluateExpression(String(raw), {
      game,
      unit1: owner,
      unit2: other,
      position: owner.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs: new Map([['skill', skill]]),
    });
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
    if (!skillConditionActive(skill, unit, { game })) continue;
    const staticColor = skill.getComponent<[number, number, number]>('unit_tint');
    if (staticColor) result = { color: staticColor, alpha: 1 };
    const flickerColor =
      skill.getComponent<[number, number, number]>('unit_flickering_tint');
    if (flickerColor) {
      // Python's component declares period=900 ms and width=300 ms.
      const phase = ((timeMs % 900) + 900) % 900;
      result = { color: flickerColor, alpha: phase < 300 ? 1 : 0 };
    }
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

/** Unit attacks first regardless of speed. */
export function vantage(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'vantage');
}

/** Unit performs all attacks before enemy retaliates. */
export function desperation(unit: UnitObject): boolean {
  return hasAnySkill(unit, 'desperation');
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
      if (lethal && component === 'TrueMiracle') return { skill, component, value };
      if (lethal && (
        component === 'nine_lives_event' ||
        component === 'true_miracle_event' ||
        component === 'true_miracle_event_after_combat' ||
        (component === 'True_Miracle_Event' &&
          !unit.tags.includes('IgnoringDamage') &&
          !additionalTags(unit, game).has('IgnoringDamage'))
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
    if (skill.hasComponent('canto') ||
        skill.hasComponent('canto_plus') ||
        skill.hasComponent('canto_sharp')) {
      maximum = Math.max(maximum, Math.trunc(unit.movementLeft));
    }
    const canter = skill.getComponent<unknown>('canter');
    if (typeof canter === 'number' && Number.isFinite(canter)) {
      maximum = Math.max(maximum, Math.trunc(canter));
    }
    const expression = skill.getComponent<unknown>('eval_canter');
    if (typeof expression === 'string' && expression.length > 0) {
      try {
        const evaluated = Number(evaluateExpression(expression, {
          game,
          unit1: unit,
          unit2: target ?? undefined,
          position: unit.position ?? undefined,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
        }));
        if (Number.isFinite(evaluated)) {
          maximum = Math.max(
            maximum,
            nullCanto ? Math.min(1, Math.trunc(evaluated)) : Math.trunc(evaluated),
          );
        }
      } catch (error) {
        console.error(`Could not evaluate EvalCanter movement ${expression}`, error);
      }
    }
  }
  return Math.max(0, maximum);
}

// ============================================================
// Stat change hooks
// ============================================================

/**
 * Get the total stat change bonus from all skills for a given stat.
 * Skills with 'stat_change' component store [[statNid, amount], ...].
 */
const evaluatingStatChanges = new WeakMap<UnitObject, Set<string>>();

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
      skill.hasComponent('upkeep_stat_change') ||
      skill.hasComponent('stat_change_expression') ||
      skill.hasComponent('stat_multiplier') ||
      skill.data.has('stat_changes') ||
      skill.data.has('_dynamic_stat_changes');
    if (!contributesToStat) continue;
    // DynamicStatChange freezes only after all condition/combat/charge gates
    // pass. Its prepared map is therefore also the active snapshot needed by
    // subsequent getStatValue calls, which do not carry target context.
    const hasPreparedDynamic = skill.data.has('_dynamic_stat_changes');
    const needsActiveGate =
      skill.hasComponent('condition') ||
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
      for (const entry of expressionChanges) {
        if (!Array.isArray(entry) || entry[0] !== statNid) continue;
        const value = Number(evaluateExpression(String(entry[1] ?? '0'), {
          game,
          unit1: unit,
          position: unit.position ?? undefined,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
          localArgs: new Map<string, unknown>([['skill', skill]]),
        }));
        if (Number.isFinite(value)) total += Math.trunc(value);
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
    const changes = new Map<string, number>();
    for (const entry of configured) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const raw = typeof entry[1] === 'number'
        ? entry[1]
        : typeof entry[1] === 'string'
          ? Number(evaluateExpression(entry[1], {
            game,
            unit1: unit,
            unit2: target,
            item: item ?? undefined,
            position: unit.position ?? undefined,
            gameVars: game?.gameVars,
            levelVars: game?.levelVars,
            localArgs,
          }))
          : 0;
      changes.set(entry[0], Number.isFinite(raw) ? Math.trunc(raw) : 0);
    }
    skill.data.set('_dynamic_stat_changes', changes);
  }
}

export function clearDynamicStatChanges(unit: UnitObject): void {
  for (const skill of unit.skills) skill.data.delete('_dynamic_stat_changes');
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

interface EvaluatedSkillContext {
  game?: any;
  item?: ItemObject | null;
  target?: UnitObject | null;
  item2?: ItemObject | null;
  mode?: string;
  attackInfo?: any;
  baseValue?: number;
  combatCalcs?: Record<string, unknown>;
}

function evaluatedSkillActive(
  skill: SkillObject,
  unit: UnitObject,
  context: EvaluatedSkillContext,
  localArgs: Map<string, unknown>,
): boolean {
  const parent = skill.data.get('multiSkillSource');
  if (parent instanceof SkillObject) {
    const parentArgs = new Map(localArgs);
    parentArgs.set('skill', parent);
    if (!evaluatedSkillActive(parent, unit, context, parentArgs)) return false;
  }
  if (skill.hasComponent('build_charge')) {
    const charge = Number(skill.data.get('charge') ?? 0);
    const maximum = Number(
      skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0,
    );
    if (charge < maximum) return false;
  }
  if (hasDrainingCharge(skill) &&
      Number(skill.data.get('charge') ?? 0) <= 0) return false;
  const combatCondition = skill.getComponent<string>('combat_condition');
  if (combatCondition) {
    const snapshot = skill.data.get('_combat_condition');
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
    if (context.combatCalcs) localArgs.set('combat_calcs', context.combatCalcs);
    if (!evaluatedSkillActive(skill, unit, context, localArgs)) continue;
    const value = typeof expression === 'number'
      ? expression
      : Number(evaluateExpression(expression, {
        game: context.game,
        unit1: unit,
        unit2: context.target ?? undefined,
        item: context.item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: context.game?.gameVars,
        levelVars: context.game?.levelVars,
        localArgs,
      }));
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
    const value = evaluateExpression(expression, {
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
    });
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
    const value = evaluateExpression(expression, {
      game,
      unit1: unit,
      unit2: target,
      item,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs,
    });
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_crit_accuracy', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_crit_avoid', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
  );
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
  let maximum = item.getMaxRange(unit, game);
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
    if (typeof value !== 'string' || !value) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    result = value;
  }
  return result;
}

/** Python UNIQUE alliance hooks: IgnoreAlliances makes only the bearer itself an ally. */
export function checkAlly(unit: UnitObject, target: UnitObject, db: any): boolean {
  if (unit.skills.some((skill) => skill.hasComponent('ignore_alliances'))) {
    return unit === target;
  }
  return db.areAllied(unit.team, target.team);
}

export function checkEnemy(unit: UnitObject, target: UnitObject, db: any): boolean {
  if (unit.skills.some((skill) => skill.hasComponent('ignore_alliances'))) {
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
    if (!skillConditionActive(skill, unit, { game })) continue;
    result *= value;
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
    if (!skillConditionActive(skill, unit, { game, item })) continue;
    result = value;
  }
  return result;
}

/** Project-used Witch Warp expression destinations, deduplicated in unit order. */
export function witchWarpPositions(
  unit: UnitObject,
  board: any,
  db: any,
  game?: any,
): [number, number][] {
  let sourceSkill: SkillObject | null = null;
  let expression: string | null = null;
  for (const skill of unit.skills) {
    const value = skill.getComponent<string>('witch_warp_expression');
    if (typeof value !== 'string' || !value) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    sourceSkill = skill;
    expression = value;
  }
  if (!sourceSkill || !expression) return [];

  const defaultMovement = db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
  const movementGroup = movementType(unit, defaultMovement, game);
  const result: [number, number][] = [];
  const seen = new Set<string>();
  for (const target of board.getAllUnits()) {
    if (!target.position) continue;
    const allowed = evaluateCondition(expression, {
      game,
      unit1: target,
      unit2: unit,
      position: target.position,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
      localArgs: new Map([['skill', sourceSkill]]),
    });
    if (!allowed) continue;
    const [x, y] = target.position;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as [number, number][]) {
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
    if (typeof value === 'number') restored += Math.max(0, value - 1);
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_damage', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_resist', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_accuracy', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_avoid', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_attack_speed', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_defense_speed', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
  );
}

/** Dynamic extra attacks from skills. */
function evaluatedCombatSkillTotal(
  unit: UnitObject,
  component: string,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
  combatCalcs?: Record<string, unknown>,
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
    if (combatCalcs) localArgs.set('combat_calcs', combatCalcs);
    if (!evaluatedSkillActive(
      skill, unit,
      { game, item, target, item2, mode, attackInfo, baseValue, combatCalcs },
      localArgs,
    )) continue;
    const configured = skill.getComponent<unknown>(component);
    const value = typeof configured === 'number'
      ? configured
      : typeof configured === 'string'
        ? Number(evaluateExpression(configured, {
          game,
          unit1: unit,
          unit2: target,
          item: item ?? undefined,
          position: unit.position ?? undefined,
          gameVars: game?.gameVars,
          levelVars: game?.levelVars,
          localArgs,
        }))
        : 0;
    if (Number.isFinite(value)) total += Math.trunc(value);
  }
  return total;
}

export function dynamicMultiattacks(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_multiattacks', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
  );
}

export function dynamicAttacks(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_attacks', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
  );
}

export function dynamicBlitzes(
  unit: UnitObject,
  item: ItemObject | null,
  target: UnitObject,
  item2: ItemObject | null,
  mode: string,
  attackInfo: any,
  baseValue: number,
  game?: any,
  combatCalcs?: Record<string, unknown>,
): number {
  return evaluatedCombatSkillTotal(
    unit, 'dynamic_blitzes', item, target, item2, mode,
    attackInfo, baseValue, game, combatCalcs,
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
      const value = Number(evaluateExpression(expression, {
        game,
        unit1: unit,
        unit2: target,
        item: item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs,
      }));
      // LT's checked-in DynamicDamageMultiplier accidentally int-casts the
      // result even though the component is documented as a fractional
      // multiplier. EotF authors six fractional expressions (0.5, 0.75,
      // 1.25, and stack-scaled values), so retain the evaluated float as the
      // deliberate project-compatible behavior.
      result *= Number.isFinite(value) ? value : 0;
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
    const expression = skill.getComponent<string>('dynamic_resist_multiplier');
    if (expression) {
      const value = Number(evaluateExpression(expression, {
        game,
        unit1: unit,
        unit2: target,
        item: item ?? undefined,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
        localArgs,
      }));
      result *= Number.isFinite(value) ? value : 1;
    }
  }
  return result;
}

// ============================================================
// Formula hooks (UNIQUE — override the default formula name)
// ============================================================

/** Override the damage formula name. Default: null (use standard). */
export function damageFormula(unit: UnitObject): string | undefined {
  return getSkillValue<string>(unit, 'damage_formula') ??
    getSkillValue<string>(unit, 'alternate_damage_formula') ??
    getSkillValue<string>(unit, 'alternate_magic_damage_formula');
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
