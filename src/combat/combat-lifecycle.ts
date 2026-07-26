import {
  evaluateCondition,
  evaluateExpression,
  type EventManager,
  type EventTrigger,
} from '../events/event-manager';
import type { ItemObject } from '../objects/item';
import { createItemTree } from '../objects/item';
import type { UnitObject } from '../objects/unit';
import { SkillObject } from '../objects/skill';
import type { CombatStrike } from './combat-solver';
import type { CombatProcMark } from './combat-skill-lifecycle';
import type { CombatResults } from './map-combat';
import type { ActionLog } from '../engine/action';
import {
  ChangeManaAction,
  ChangeFatigueAction,
  SetItemDroppableAction,
  MoveItemBetweenUnitsAction,
  RemoveSkillAction,
  RemoveItemFromUnitAction,
  WarpUnitAction,
  SwapUnitsAction,
  AddSkillAction,
  SetSkillDataAction,
  GiveItemAction,
  RegisterItemTreeAction,
  ResetAction,
  SetItemUsesAction,
  SetCurrentHpAction,
  UpdateRecordsAction,
} from '../engine/action';
import {
  applyItemEndResourceHooks,
  applyItemStartResourceHooks,
} from './item-resource-lifecycle';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import {
  drawBackDestinations,
  eotfDrawBackDestinations,
  eotfPivotDestination,
  eotfShoveDestination,
  advanceDestinations,
  pivotDestination,
  rekkaMovementEndpoints,
  shoveDestination,
  healAmount as itemHealAmount,
  inventoryFull,
} from './item-system';
import {
  checkAlly,
  checkEnemy,
  hasDrainingCharge,
  ignoreForcedMovement,
  modifiedHealAmount,
  movementType,
  skillConditionActive,
} from './skill-system';
import { evaluateEquation } from './combat-calcs';

interface CombatLifecycleGame {
  eventManager: EventManager | null;
  currentLevel?: { nid: string } | null;
  gameVars?: Map<string, unknown>;
  levelVars?: Map<string, unknown>;
  actionLog?: Pick<ActionLog, 'doAction'>;
  board?: GameBoard | null;
  db?: Database;
  currentParty?: string;
  units?: Map<string, UnitObject>;
  getMoney?: () => number;
  items?: Map<string, ItemObject>;
  memory?: Map<string, unknown>;
}

function nearestOpenTile(
  game: CombatLifecycleGame,
  unit: UnitObject,
  origin: [number, number],
): [number, number] | null {
  if (!game.board || !game.db) return null;
  const defaultMovement = game.db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
  const movementGroup = movementType(unit, defaultMovement, game);
  for (let radius = 0; radius < 10; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dy = radius - Math.abs(dx);
      for (const candidate of [
        [origin[0] + dx, origin[1] + dy],
        [origin[0] + dx, origin[1] - dy],
      ] as [number, number][]) {
        if (!game.board.checkBounds(candidate[0], candidate[1])) continue;
        const occupant = game.board.getUnit(candidate[0], candidate[1]);
        if ((!occupant || occupant === unit) &&
            game.board.getMovementCost(
              candidate[0], candidate[1], movementGroup, game.db,
            ) <= Math.max(5, unit.getMovement())) {
          return candidate;
        }
      }
    }
  }
  return null;
}

interface DroppableGame {
  getConstant: (nid: string, fallback?: any) => any;
}

/** Resolve Python Trade.end_combat's successful user/target pair. */
export function combatTradePair(
  strikes: CombatStrike[],
): { unit: UnitObject; partner: UnitObject } | null {
  const hit = strikes.find((strike) =>
    strike.hit && strike.item.hasComponent('trade') && !strike.attacker.isDead() &&
    !strike.defender.isDead());
  return hit ? { unit: hit.attacker, partner: hit.defender } : null;
}

function combatSkillEnabled(
  game: CombatLifecycleGame,
  unit: UnitObject,
  skill: SkillObject,
  target: UnitObject,
  item: ItemObject,
  item2: ItemObject | null = null,
  mode: string = 'attack',
): boolean {
  const parent = skill.data.get('multiSkillSource');
  if (parent instanceof SkillObject &&
      !combatSkillEnabled(game, unit, parent, target, item, item2, mode)) return false;
  const total = Number(skill.data.get('total_charge'));
  const charge = Number(skill.data.get('charge'));
  if (skill.hasComponent('build_charge') && Number.isFinite(total) && charge < total) return false;
  if (hasDrainingCharge(skill) &&
      Number.isFinite(charge) && charge <= 0) return false;
  const combatCondition = skill.getComponent<string>('combat_condition');
  if (combatCondition) {
    const snapshot = skill.data.get('_combat_condition');
    if (typeof snapshot === 'boolean') {
      if (!snapshot) return false;
    } else if (!evaluateCondition(combatCondition, {
      game,
      unit1: unit,
      unit2: target,
      position: unit.position ?? undefined,
      item,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
      localArgs: new Map<string, unknown>([
        ['item2', item2],
        ['mode', mode],
        ['skill', skill],
      ]),
    })) return false;
  }
  return skillConditionActive(skill, unit, { game, target, item });
}

export function triggerSkillCharge(
  game: CombatLifecycleGame,
  skill: SkillObject,
  owner?: UnitObject,
): void {
  if (!game.actionLog) return;
  owner ??= [...(game.units?.values?.() ?? [])].find((unit) =>
    unit.skills.includes(skill));
  if (skill.hasComponent('build_charge')) {
    game.actionLog.doAction(new SetSkillDataAction(skill, 'charge', 0));
  } else if (hasDrainingCharge(skill)) {
    const charge = Number(skill.data.get('charge') ?? 0);
    const next = charge - 1;
    game.actionLog.doAction(new SetSkillDataAction(skill, 'charge', next));
    if (skill.hasComponent('drain_charge_all') && owner) {
      for (const candidate of game.units?.values?.() ?? []) {
        const sharesCharge = owner.team === 'player'
          ? candidate.team === 'player' &&
            (candidate.party === game.currentParty || candidate.party === 'Flex')
          : (owner.team === 'enemy' || owner.team === 'enemy2') &&
            (candidate.team === 'enemy' || candidate.team === 'enemy2');
        if (candidate.nid === owner.nid || !sharesCharge) continue;
        const shared = candidate.skills.find((candidateSkill) =>
          candidateSkill.nid === skill.nid);
        if (shared) {
          game.actionLog.doAction(new SetSkillDataAction(shared, 'charge', next));
        }
      }
    }
    if (skill.hasComponent('lost_on_charges_depleted') &&
        next <= 0 && owner?.skills.includes(skill)) {
      game.actionLog.doAction(new RemoveSkillAction(owner, skill));
    }
  }
}

function rootItem(item: ItemObject): ItemObject {
  let root = item;
  while (root.parentItem) root = root.parentItem;
  return root;
}

/**
 * Python Ability.end_combat_unconditional and EotF's charged variants.
 * Returns the number of charge-bearing skill instances triggered.
 */
export function triggerAbilityItemCharge(
  game: CombatLifecycleGame,
  unit: UnitObject,
  item: ItemObject,
  mode: string,
): number {
  const usedNid = rootItem(item).nid;
  let triggered = 0;
  for (const skill of [...unit.skills]) {
    const ability = skill.getComponent<string>('ability');
    if (ability === usedNid) {
      triggerSkillCharge(game, skill, unit);
      triggered++;
    }
    const attackAbility = skill.getComponent<string>('ability_attack_charge');
    if (attackAbility === usedNid && mode === 'attack') {
      triggerSkillCharge(game, skill, unit);
      triggered++;
    }
    const parentAbility = skill.getComponent<string>('ability_parent');
    if (parentAbility !== usedNid) continue;
    const ownerNid = skill.data.get('auraOwnerNid');
    const parentUid = skill.data.get('auraParentSkillUid');
    const owner = typeof ownerNid === 'string' ? game.units?.get(ownerNid) : null;
    const parent = owner?.skills.find((candidate) => candidate.uid === parentUid);
    if (owner && parent) {
      triggerSkillCharge(game, parent, owner);
      triggered++;
    }
  }
  return triggered;
}

function triggerSkillEvent(
  game: CombatLifecycleGame,
  nid: unknown,
  type: string,
  unit: UnitObject,
  target: UnitObject,
  item: ItemObject | null,
  item2: ItemObject | null,
  mode: string | null,
  extraLocalArgs: Iterable<readonly [string, unknown]> = [],
): boolean {
  if (typeof nid !== 'string' || !nid || !game.eventManager) return false;
  return game.eventManager.triggerSpecific(nid, {
    type,
    unit1: unit,
    unit2: target,
    unitNid: unit.nid,
    position: unit.position ? [...unit.position] as [number, number] : undefined,
    item,
    localArgs: new Map<string, unknown>([
      ['item', item],
      ['item2', item2],
      ['mode', mode],
      ...extraLocalArgs,
    ]),
  });
}

function equippedWeapon(unit: UnitObject): ItemObject | null {
  return unit.items.find((candidate) => candidate.isWeapon()) ?? null;
}

/**
 * Queue Rekka's project-local start_combat skill events in Python participant
 * order: initiator, attack partner, defense partner, primary defender.
 */
export function queueCombatSkillStartEvents(
  game: CombatLifecycleGame,
  initiator: UnitObject,
  target: UnitObject,
  attackItem: ItemObject,
  defenseItem: ItemObject | null,
): number {
  let queued = 0;
  const participants: Array<{
    unit: UnitObject;
    target: UnitObject;
    item: ItemObject | null;
    item2: ItemObject | null;
    mode: string;
  }> = [
    { unit: initiator, target, item: attackItem, item2: defenseItem, mode: 'attack' },
  ];
  if (initiator.strikePartner) {
    participants.push({
      unit: initiator.strikePartner,
      target,
      item: equippedWeapon(initiator.strikePartner),
      item2: defenseItem,
      mode: 'attack',
    });
  }
  if (target.strikePartner) {
    participants.push({
      unit: target.strikePartner,
      target: initiator,
      item: equippedWeapon(target.strikePartner),
      item2: attackItem,
      mode: 'defense',
    });
  }
  if (target !== initiator) {
    participants.push({
      unit: target,
      target: initiator,
      item: defenseItem,
      item2: attackItem,
      mode: 'defense',
    });
  }

  for (const participant of participants) {
    for (const skill of [...participant.unit.skills]) {
      if (participant.item && !combatSkillEnabled(
        game, participant.unit, skill, participant.target, participant.item,
        participant.item2, participant.mode,
      )) continue;
      const beforeCombat = skill.getComponent<unknown>('skill_before_combat');
      if (beforeCombat && typeof beforeCombat === 'object') {
        const options = beforeCombat as Record<string, unknown>;
        const skillNid = typeof options.skill === 'string' ? options.skill : null;
        const recipient = String(options.recipient ?? 'target');
        const allegiance = String(options.allegiance ?? 'enemy');
        const allied = game.db ? checkAlly(participant.unit, participant.target, game.db) : false;
        let recipients: UnitObject[] = [];
        if (recipient === 'self') recipients = [participant.unit];
        else if (recipient === 'both') recipients = [participant.unit, participant.target];
        else if ((allegiance === 'both') ||
            (allegiance === 'ally' && allied) ||
            (allegiance === 'enemy' && !allied)) recipients = [participant.target];
        const prefab = skillNid ? game.db?.skills.get(skillNid) : null;
        if (prefab && recipients.length > 0) {
          for (const recipientUnit of recipients) {
            game.actionLog?.doAction(new AddSkillAction(recipientUnit, new SkillObject(prefab)));
          }
          triggerSkillCharge(game, skill);
        }
      }
      if (triggerSkillEvent(
        game,
        skill.getComponent('event_before_combat'),
        'event_before_combat',
        participant.unit,
        participant.target,
        participant.item,
        participant.item2,
        participant.mode,
      )) queued++;
    }
  }
  return queued;
}

/**
 * Queue Rekka's after_strike/after_take_strike and end_combat skill events.
 * Strike events preserve solver order; within a unit they preserve skill and
 * component order, matching the generated Python dispatchers.
 */
export function queueCombatSkillEvents(
  game: CombatLifecycleGame,
  strikes: CombatStrike[],
  initiator: UnitObject,
  primaryTarget: UnitObject,
  attackItem: ItemObject,
  defenseItem: ItemObject | null,
): number {
  let queued = 0;
  const playback = strikes.map((strike) => {
    let mainAttacker = strike.attacker;
    if (strike.assist) {
      if (strike.attacker === initiator.strikePartner) mainAttacker = initiator;
      else if (strike.attacker === primaryTarget.strikePartner) {
        mainAttacker = primaryTarget;
      }
    }
    return {
      nid: strike.crit ? 'mark_crit' : strike.hit ? 'mark_hit' : 'mark_miss',
      attacker: strike.attacker,
      defender: strike.defender,
      main_attacker: mainAttacker,
    };
  });
  for (const strike of strikes) {
    const mode = strike.mode ?? (strike.isCounter ? 'defense' : 'attack');
    const defenderItem = equippedWeapon(strike.defender);
    const attackerSkills = [...(strike.attackHookSkills ?? strike.attacker.skills)];
    for (const mark of strike.attackProcs ?? []) {
      if (!attackerSkills.includes(mark.procSkill)) attackerSkills.push(mark.procSkill);
    }
    for (const skill of attackerSkills) {
      if (!combatSkillEnabled(
        game,
        strike.attacker,
        skill,
        strike.defender,
        strike.item,
        defenderItem,
        mode,
      )) continue;
      for (const [component, value] of skill.components) {
        const fires = component === 'event_after_strike' ||
          component === 'event_on_strike' ||
          (component === 'event_after_hit' && strike.hit) ||
          (component === 'event_after_crit' && strike.crit);
        if (fires && triggerSkillEvent(
          game, value, component, strike.attacker, strike.defender,
          component === 'event_on_strike' ? null : strike.item,
          component === 'event_on_strike' ? null : defenderItem,
          component === 'event_on_strike' ? null : mode,
        )) queued++;
      }
    }
    const defenderSkills = [...(strike.defenseHookSkills ?? strike.defender.skills)];
    for (const mark of strike.defenseProcs ?? []) {
      if (!defenderSkills.includes(mark.procSkill)) defenderSkills.push(mark.procSkill);
    }
    for (const skill of defenderSkills) {
      const defenderMode = mode === 'attack'
        ? 'defense'
        : mode === 'defense'
          ? 'attack'
          : 'splash';
      if (!combatSkillEnabled(
        game,
        strike.defender,
        skill,
        strike.attacker,
        defenderItem ?? strike.item,
        strike.item,
        defenderMode,
      )) {
        continue;
      }
      for (const [component, value] of skill.components) {
        const fires = (component === 'event_when_hit' && strike.hit) ||
          (component === 'event_when_dodging' && !strike.hit) ||
          (component === 'event_stack_on_take_hit' &&
            strike.hit &&
            !strike.guarded &&
            !!game.db &&
            checkEnemy(strike.defender, strike.attacker, game.db));
        if (fires && triggerSkillEvent(
          game, value, component, strike.defender, strike.attacker,
          component === 'event_stack_on_take_hit' ? null : defenderItem,
          component === 'event_stack_on_take_hit' ? null : strike.item,
          component === 'event_stack_on_take_hit' ? null : mode,
        )) queued++;
      }
    }
    const survival = strike.survivalProc;
    if ((survival?.component === 'true_miracle_event' ||
        survival?.component === 'True_Miracle_Event') && triggerSkillEvent(
      game,
      survival.value,
      survival.component,
      strike.defender,
      strike.attacker,
      defenderItem,
      strike.item,
      mode,
    )) queued++;
  }

  const participants: Array<{
    unit: UnitObject;
    target: UnitObject;
    item: ItemObject | null;
    item2: ItemObject | null;
    mode: string;
  }> = [
    { unit: initiator, target: primaryTarget, item: attackItem, item2: defenseItem, mode: 'attack' },
  ];
  if (initiator.strikePartner) {
    participants.push({
      unit: initiator.strikePartner,
      target: primaryTarget,
      item: equippedWeapon(initiator.strikePartner),
      item2: defenseItem,
      mode: 'attack',
    });
  }
  if (primaryTarget.strikePartner) {
    participants.push({
      unit: primaryTarget.strikePartner,
      target: initiator,
      item: equippedWeapon(primaryTarget.strikePartner),
      item2: attackItem,
      mode: 'defense',
    });
  }
  if (primaryTarget !== initiator) {
    participants.push({
      unit: primaryTarget,
      target: initiator,
      item: defenseItem,
      item2: attackItem,
      mode: 'defense',
    });
  }
  for (const participant of participants) {
    const gotHit = strikes.some((strike) => strike.defender === participant.unit && strike.hit);
    const tookDamage = strikes.some((strike) =>
      strike.defender === participant.unit && strike.hit && strike.damage > 0);
    const dealtCrit = strikes.some((strike) =>
      strike.attacker === participant.unit && strike.crit);
    for (const skill of participant.unit.skills) {
      if (participant.item && !combatSkillEnabled(
        game, participant.unit, skill, participant.target, participant.item,
        participant.item2, participant.mode,
      )) continue;
      for (const [component, value] of skill.components) {
        const fires = component === 'event_after_combat' ||
          (component === 'event_after_kill' && participant.target.currentHp <= 0) ||
          (component === 'crit_event' && dealtCrit) ||
          (component === 'event_after_combat_if_take_damage' && tookDamage) ||
          (component === 'event_after_combat_when_hit' && gotHit) ||
          (component === 'true_miracle_event_after_combat' && strikes.some(
            (strike) => strike.defender === participant.unit &&
              strike.survivalProc?.skill === skill,
          ));
        if (fires && triggerSkillEvent(
          game, value, component, participant.unit, participant.target,
          participant.item, participant.item2, participant.mode,
          component === 'event_after_combat' ? [['playback', playback]] : [],
        )) {
          queued++;
          if (component === 'event_after_kill') triggerSkillCharge(game, skill);
        }
      }
    }
  }
  return queued;
}

function grantCombatStatus(
  game: CombatLifecycleGame,
  source: UnitObject,
  target: UnitObject,
  skill: SkillObject,
  statusNid: string,
  consumeCharge: boolean = true,
): number {
  const prefab = game.db?.skills.get(statusNid);
  if (!prefab || !game.actionLog) return 0;
  const status = new SkillObject(prefab);
  status.initiatorNid = source.nid;
  game.actionLog.doAction(new AddSkillAction(target, status));
  if (consumeCharge) triggerSkillCharge(game, skill);
  return 1;
}

function combatComponentNumber(
  game: CombatLifecycleGame,
  rawValue: unknown,
  unit: UnitObject,
  target: UnitObject,
  item: ItemObject,
  skill: SkillObject,
  mode: string,
): number {
  if (typeof rawValue === 'number') return Math.trunc(rawValue);
  if (typeof rawValue !== 'string' || rawValue.length === 0) return 0;
  try {
    const value = evaluateExpression(rawValue, {
      game,
      unit1: unit,
      unit2: target,
      position: unit.position ?? undefined,
      item,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
      localArgs: new Map<string, unknown>([
        ['item2', equippedWeapon(target)],
        ['mode', mode],
        ['skill', skill],
      ]),
    });
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  } catch (error) {
    console.error(`Could not evaluate combat component ${rawValue}`, error);
    return 0;
  }
}

function componentOption(rawValue: unknown, key: string): unknown {
  if (!rawValue || typeof rawValue !== 'object') return undefined;
  return rawValue instanceof Map
    ? rawValue.get(key)
    : (rawValue as Record<string, unknown>)[key];
}

function strikeMode(strike: CombatStrike): string {
  return strike.mode ?? (strike.isCounter ? 'defense' : 'attack');
}

function eotfSelfShoveMagnitude(
  game: CombatLifecycleGame,
  strike: CombatStrike,
  expression: unknown,
): number {
  if (typeof expression === 'number') return Math.trunc(expression);
  if (typeof expression !== 'string' || !expression) return 0;
  try {
    const targetPosition = strike.defender.position
      ? [...strike.defender.position] as [number, number]
      : null;
    const value = evaluateExpression(expression, {
      game,
      unit1: strike.attacker,
      unit2: strike.defender,
      item: strike.item,
      position: strike.attacker.position ?? undefined,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
      localArgs: new Map<string, unknown>([
        ['item', strike.item],
        ['item2', equippedWeapon(strike.defender)],
        ['mode', strikeMode(strike)],
        ['target', strike.defender],
        ['target_pos', targetPosition],
      ]),
    });
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  } catch (error) {
    console.error(`Could not evaluate self shove component ${expression}`, error);
    return 0;
  }
}

function legacyMultipleOption(
  rawValue: unknown,
  key: string,
  fallback: string,
): string {
  if (Array.isArray(rawValue)) {
    const entry = rawValue.find((candidate: unknown) =>
      Array.isArray(candidate) && candidate[0] === key);
    return String(entry?.[1] ?? fallback);
  }
  return String(componentOption(rawValue, key) ?? fallback);
}

/** Apply Python's persistent post-strike/end-combat skill hooks. */
export function applyCombatSkillEndHooks(
  game: CombatLifecycleGame,
  strikes: CombatStrike[],
  initiator?: UnitObject,
  primaryTarget?: UnitObject,
  procPlayback: CombatProcMark[] = [],
): number {
  if (!game.actionLog || !game.db) return 0;
  initiator ??= strikes[0]?.attacker;
  primaryTarget ??= strikes[0]?.defender;
  let applied = 0;
  const conditionOwners = new Set<UnitObject>([
    ...(initiator ? [initiator] : []),
    ...(primaryTarget ? [primaryTarget] : []),
    ...strikes.flatMap((strike) => [strike.attacker, strike.defender]),
  ]);
  const conditionSkills = new Set<SkillObject>([
    ...[...conditionOwners].flatMap((unit) => [...unit.skills]),
    ...procPlayback.flatMap((mark) => [mark.parentSkill, mark.procSkill]),
  ]);
  const processedGlobalHooks = new Map<SkillObject, Set<string>>();
  const claimGlobalHook = (skill: SkillObject, component: string): boolean => {
    const processed = processedGlobalHooks.get(skill) ?? new Set<string>();
    if (processed.has(component)) return false;
    processed.add(component);
    processedGlobalHooks.set(skill, processed);
    return true;
  };
  const grantSkill = (
    unit: UnitObject,
    sourceSkill: SkillObject,
    skillNid: unknown,
    initiator: UnitObject | null = null,
    consumeCharge: boolean = true,
  ): number => {
    if (typeof skillNid !== 'string') return 0;
    const prefab = game.db?.skills.get(skillNid);
    if (!prefab) return 0;
    const granted = new SkillObject(prefab);
    if (initiator) granted.initiatorNid = initiator.nid;
    game.actionLog!.doAction(new AddSkillAction(unit, granted));
    if (consumeCharge) triggerSkillCharge(game, sourceSkill);
    return 1;
  };
  const grantAreaSkills = (
    unit: UnitObject,
    sourceSkill: SkillObject,
    rawValue: unknown,
  ): number => {
    if (!unit.position || !rawValue || typeof rawValue !== 'object') return 0;
    const get = (key: string): unknown => rawValue instanceof Map
      ? rawValue.get(key)
      : (rawValue as Record<string, unknown>)[key];
    const skillNid = get('skill');
    const configuredRange = Number(get('range') ?? 1);
    const range = Number.isFinite(configuredRange)
      ? Math.max(0, Math.trunc(configuredRange))
      : 1;
    const targetKind = String(get('target') ?? 'ally');
    let granted = 0;
    for (const candidate of game.units?.values?.() ?? []) {
      if (!candidate.position || candidate === unit) continue;
      if (game.board?.getUnit(
        candidate.position[0],
        candidate.position[1],
      ) !== candidate) continue;
      const distance = Math.abs(candidate.position[0] - unit.position[0]) +
        Math.abs(candidate.position[1] - unit.position[1]);
      if (distance > range) continue;
      const allied = checkAlly(unit, candidate, game.db);
      if ((allied && (targetKind === 'ally' || targetKind === 'any')) ||
          (!allied && (targetKind === 'enemy' || targetKind === 'any'))) {
        granted += grantSkill(candidate, sourceSkill, skillNid, unit, false);
      }
    }
    if (get('affect_self') === true) {
      granted += grantSkill(unit, sourceSkill, skillNid, unit, false);
    }
    if (granted > 0) triggerSkillCharge(game, sourceSkill);
    return granted;
  };
  for (const strike of strikes) {
    const proc = strike.survivalProc;
    if (!proc) continue;
    if (proc.component === 'nine_lives_event') {
      const removeNid = typeof proc.value === 'string' ? proc.value : proc.skill.nid;
      const remove = strike.defender.skills.find((skill) => skill.nid === removeNid);
      if (remove) {
        game.actionLog.doAction(new RemoveSkillAction(strike.defender, remove));
        applied++;
      }
    } else if (proc.component === 'true_miracle_event' ||
        proc.component === 'True_Miracle_Event' ||
        proc.component === 'TrueMiracle' ||
        proc.component === 'ignore_damage') {
      triggerSkillCharge(game, proc.skill);
      applied++;
    }
  }
  const pairs = new Map<string, {
    unit: UnitObject;
    target: UnitObject;
    item: ItemObject;
    strikes: CombatStrike[];
  }>();
  for (const strike of strikes) {
    const key = `${strike.attacker.nid}:${strike.defender.nid}:${strike.item.nid}`;
    const pair = pairs.get(key) ?? {
      unit: strike.attacker,
      target: strike.defender,
      item: strike.item,
      strikes: [],
    };
    pair.strikes.push(strike);
    pairs.set(key, pair);
  }
  if (initiator && primaryTarget && strikes[0]) {
    const addPassivePair = (
      unit: UnitObject,
      target: UnitObject,
      fallbackItem: ItemObject | null,
    ): void => {
      const key = `${unit.nid}:${target.nid}:passive`;
      if (!pairs.has(key) && ![...pairs.values()].some(
        (pair) => pair.unit === unit && pair.target === target,
      ) && fallbackItem) {
        pairs.set(key, { unit, target, item: fallbackItem, strikes: [] });
      }
    };
    addPassivePair(
      initiator,
      primaryTarget,
      strikes.find((strike) => strike.attacker === initiator)?.item ?? equippedWeapon(initiator),
    );
    addPassivePair(
      primaryTarget,
      initiator,
      strikes.find((strike) => strike.attacker === primaryTarget)?.item ??
        equippedWeapon(primaryTarget),
    );
  }

  for (const { unit, target, item, strikes: pairStrikes } of pairs.values()) {
    const isAlly = checkAlly(unit, target, game.db);
    const endCombatSkills = [...unit.skills];
    for (const mark of procPlayback) {
      if (mark.unit === unit &&
          (mark.kind === 'attack_pre_proc' || mark.kind === 'defense_pre_proc') &&
          !endCombatSkills.includes(mark.procSkill)) {
        endCombatSkills.push(mark.procSkill);
      }
    }
    for (const skill of endCombatSkills) {
      const isMainAttacker = unit === initiator || unit === initiator?.strikePartner;
      const hookTarget = isMainAttacker ? primaryTarget : initiator;
      const isHookTarget = !!hookTarget && target === hookTarget;
      const unitAttacked = strikes.some((strike) => strike.attacker === unit);
      const mode = isMainAttacker ? 'attack' : 'defense';
      const enemyHookTarget = isHookTarget && checkEnemy(unit, target, game.db);
      const incrementCharge = (component: string, rawAmount: unknown): void => {
        if (!claimGlobalHook(skill, component) || skill.data.get('active')) return;
        const current = Number(skill.data.get('charge') ?? 0);
        const total = Number(skill.data.get('total_charge') ?? current);
        const amount = Number(rawAmount ?? 1);
        game.actionLog!.doAction(new SetSkillDataAction(
          skill,
          'charge',
          Math.min(total, current + (Number.isFinite(amount) ? amount : 1)),
        ));
        applied++;
      };
      const activeIncrease = skill.getComponent<unknown>(
        'active_combat_charge_increase',
      );
      if (activeIncrease !== undefined && isMainAttacker && unitAttacked) {
        incrementCharge('active_combat_charge_increase', activeIncrease);
      }
      const combatIncrease = skill.getComponent<unknown>(
        'combat_charge_increase_better',
      );
      if (combatIncrease !== undefined && enemyHookTarget) {
        incrementCharge('combat_charge_increase_better', combatIncrease);
      }
      const killIncrease = skill.getComponent<unknown>('kill_charge_increase');
      if (killIncrease !== undefined && isHookTarget && target.currentHp <= 0) {
        incrementCharge('kill_charge_increase', killIncrease);
      }
      if (!combatSkillEnabled(
        game,
        unit,
        skill,
        target,
        item,
        equippedWeapon(target),
        mode,
      )) continue;

      const afterCombat = skill.getComponent<string>('give_status_after_combat');
      if (afterCombat && !isAlly) {
        applied += grantCombatStatus(game, unit, target, skill, afterCombat);
      }
      const allyAfterCombat = skill.getComponent<string>('give_ally_status_after_combat');
      if (allyAfterCombat && isAlly) {
        applied += grantCombatStatus(game, unit, target, skill, allyAfterCombat);
      }
      const afterAttack = skill.getComponent<string>('give_status_after_attack');
      if (afterAttack && isMainAttacker && unitAttacked) {
        applied += grantCombatStatus(game, unit, target, skill, afterAttack);
      }
      const afterCombatHit = skill.getComponent<string>('give_status_after_combat_on_hit');
      const unitHit = strikes.some((strike) =>
        strike.attacker === unit && strike.hit);
      if (afterCombatHit && isMainAttacker && unitHit) {
        applied += grantCombatStatus(game, unit, target, skill, afterCombatHit);
      }
      const afterCombatStatuses = skill.getComponent<unknown>('give_statuses_after_combat');
      if (!isAlly && Array.isArray(afterCombatStatuses) &&
          afterCombatStatuses.length > 0) {
        let granted = 0;
        for (const statusNid of afterCombatStatuses) {
          if (typeof statusNid !== 'string') continue;
          granted += grantCombatStatus(
            game, unit, target, skill, statusNid, false,
          );
        }
        if (granted > 0) {
          triggerSkillCharge(game, skill);
          applied += granted;
        }
      }
      const applySavageTargets = (
        component: string,
        rangeValue: unknown,
        apply: (splashTarget: UnitObject) => number,
      ): number => {
        if (!enemyHookTarget || !target.position ||
            !claimGlobalHook(skill, component)) return 0;
        const configuredRange = Number(rangeValue ?? 1);
        const range = Number.isFinite(configuredRange)
          ? Math.max(0, Math.trunc(configuredRange))
          : 1;
        let count = 0;
        for (const splashTarget of game.units?.values?.() ?? []) {
          if (!splashTarget.position || splashTarget === target ||
              !checkEnemy(unit, splashTarget, game.db!)) continue;
          if (game.board?.getUnit(
            splashTarget.position[0],
            splashTarget.position[1],
          ) !== splashTarget) continue;
          const distance =
            Math.abs(splashTarget.position[0] - target.position[0]) +
            Math.abs(splashTarget.position[1] - target.position[1]);
          if (distance <= range) count += apply(splashTarget);
        }
        return count;
      };
      const savageStatus = skill.getComponent<unknown>('savage_status');
      if (savageStatus !== undefined) {
        const statusNid = componentOption(savageStatus, 'status');
        applied += applySavageTargets(
          'savage_status',
          componentOption(savageStatus, 'range'),
          (splashTarget) => typeof statusNid === 'string'
            ? grantCombatStatus(
              game, unit, splashTarget, skill, statusNid, false,
            )
            : 0,
        );
      }
      const savageStatuses = skill.getComponent<unknown>('savage_statuses');
      if (savageStatuses !== undefined) {
        const statusNids = componentOption(savageStatuses, 'statuses');
        applied += applySavageTargets(
          'savage_statuses',
          componentOption(savageStatuses, 'range'),
          (splashTarget) => {
            if (!Array.isArray(statusNids)) return 0;
            let granted = 0;
            for (const statusNid of statusNids) {
              if (typeof statusNid !== 'string') continue;
              granted += grantCombatStatus(
                game, unit, splashTarget, skill, statusNid, false,
              );
            }
            return granted;
          },
        );
      }
      const savageBlow = skill.getComponent<unknown>('savage_blow_fates');
      if (savageBlow !== undefined) {
        applied += applySavageTargets(
          'savage_blow_fates',
          savageBlow,
          (splashTarget) => {
            const damage = Math.trunc(splashTarget.currentHp * 0.2);
            game.actionLog!.doAction(new SetCurrentHpAction(
              splashTarget,
              Math.max(1, splashTarget.currentHp - damage),
            ));
            return 1;
          },
        );
      }
      const betterAfterHit = skill.getComponent<string>(
        'better_give_status_after_combat_on_hit',
      );
      if (betterAfterHit && claimGlobalHook(
        skill,
        'better_give_status_after_combat_on_hit',
      )) {
        const targets = new Set(strikes
          .filter((strike) =>
            strike.attacker === unit && strike.hit &&
            checkEnemy(strike.attacker, strike.defender, game.db!))
          .map((strike) => strike.defender));
        let granted = 0;
        for (const hitTarget of targets) {
          granted += grantCombatStatus(
            game, unit, hitTarget, skill, betterAfterHit, false,
          );
        }
        if (granted > 0) {
          triggerSkillCharge(game, skill);
          applied += granted;
        }
      }
      const betterAllyAfterHit = skill.getComponent<string>(
        'better_give_ally_status_after_combat_on_hit',
      );
      if (betterAllyAfterHit && claimGlobalHook(
        skill,
        'better_give_ally_status_after_combat_on_hit',
      )) {
        const targets = new Set(strikes
          .filter((strike) =>
            strike.attacker === unit && strike.hit &&
            !checkEnemy(strike.attacker, strike.defender, game.db!))
          .map((strike) => strike.defender));
        let granted = 0;
        for (const hitTarget of targets) {
          granted += grantCombatStatus(
            game, unit, hitTarget, skill, betterAllyAfterHit, false,
          );
        }
        if (granted > 0) {
          triggerSkillCharge(game, skill);
          applied += granted;
        }
      }

      const activateHpHook = (
        component: string,
        affected: UnitObject,
        nextHp: number,
      ): void => {
        game.actionLog!.doAction(new SetCurrentHpAction(affected, nextHp));
        triggerSkillCharge(game, skill);
        claimGlobalHook(skill, component);
        applied++;
      };
      const flatDamage = skill.getComponent<unknown>('better_post_combat_damage');
      if (flatDamage !== undefined && enemyHookTarget && target.currentHp > 0 &&
          !processedGlobalHooks.get(skill)?.has('better_post_combat_damage')) {
        const amount = combatComponentNumber(
          game, flatDamage, unit, target, item, skill, mode,
        );
        activateHpHook(
          'better_post_combat_damage',
          target,
          Math.max(1, target.currentHp - amount),
        );
      }
      const evalDamage = skill.getComponent<unknown>('eval_post_combat_damage');
      if (evalDamage !== undefined && enemyHookTarget && target.currentHp > 0 &&
          !processedGlobalHooks.get(skill)?.has('eval_post_combat_damage')) {
        const amount = combatComponentNumber(
          game, evalDamage, unit, target, item, skill, mode,
        );
        activateHpHook(
          'eval_post_combat_damage',
          target,
          Math.max(1, target.currentHp - amount),
        );
      }
      const healing = skill.getComponent<unknown>('post_combat_healing');
      if (healing !== undefined && enemyHookTarget && unit.currentHp > 0 &&
          !processedGlobalHooks.get(skill)?.has('post_combat_healing')) {
        const amount = combatComponentNumber(
          game, healing, unit, target, item, skill, mode,
        );
        activateHpHook(
          'post_combat_healing',
          unit,
          Math.min(
            unit.maxHp,
            unit.currentHp + modifiedHealAmount(amount, unit, unit, game),
          ),
        );
      }
      const evalHealing = skill.getComponent<unknown>('eval_post_combat_healing');
      if (evalHealing !== undefined && isHookTarget && unit.currentHp > 0 &&
          !processedGlobalHooks.get(skill)?.has('eval_post_combat_healing')) {
        const amount = combatComponentNumber(
          game, evalHealing, unit, target, item, skill, mode,
        );
        activateHpHook(
          'eval_post_combat_healing',
          unit,
          Math.min(
            unit.maxHp,
            unit.currentHp + modifiedHealAmount(amount, unit, unit, game),
          ),
        );
      }
      const recoil = skill.getComponent<unknown>('better_recoil');
      const foughtEnemy = strikes.some((strike) =>
        strike.attacker === unit && checkEnemy(unit, strike.defender, game.db!));
      if (recoil !== undefined && isHookTarget && unit.currentHp > 0 &&
          (enemyHookTarget || foughtEnemy) &&
          !processedGlobalHooks.get(skill)?.has('better_recoil')) {
        const amount = combatComponentNumber(
          game, recoil, unit, target, item, skill, mode,
        );
        activateHpHook(
          'better_recoil',
          unit,
          Math.max(1, unit.currentHp - amount),
        );
      }
      const evalAll = skill.getComponent<unknown>('eval_post_combat_damage_all');
      if (evalAll !== undefined && claimGlobalHook(
        skill,
        'eval_post_combat_damage_all',
      )) {
        const allTargets = new Set(strikes
          .filter((strike) =>
            strike.attacker === unit &&
            checkEnemy(unit, strike.defender, game.db!))
          .map((strike) => strike.defender));
        let damaged = 0;
        for (const hitTarget of allTargets) {
          if (hitTarget.currentHp <= 0) continue;
          const amount = combatComponentNumber(
            game, evalAll, unit, target, item, skill, mode,
          );
          game.actionLog.doAction(new SetCurrentHpAction(
            hitTarget,
            Math.max(1, hitTarget.currentHp - amount),
          ));
          damaged++;
        }
        if (damaged > 0) {
          triggerSkillCharge(game, skill);
          applied += damaged;
        }
      }
      const betterSplash = skill.getComponent<unknown>('better_post_combat_splash');
      if (betterSplash !== undefined && isHookTarget && unitAttacked &&
          target.position && claimGlobalHook(skill, 'better_post_combat_splash')) {
        const configuredRange = Number(componentOption(betterSplash, 'range') ?? 1);
        const range = Number.isFinite(configuredRange)
          ? Math.max(0, Math.trunc(configuredRange))
          : 1;
        const rawAmount = Number(componentOption(
          betterSplash,
          'Amount/Percentage',
        ) ?? 5);
        const percentage = componentOption(betterSplash, 'is percent?') === true;
        let damaged = 0;
        for (const splashTarget of game.units?.values?.() ?? []) {
          if (!splashTarget.position || checkAlly(unit, splashTarget, game.db) ||
              splashTarget.currentHp <= 0) continue;
          const distance =
            Math.abs(splashTarget.position[0] - target.position[0]) +
            Math.abs(splashTarget.position[1] - target.position[1]);
          if (distance > range) continue;
          const amount = percentage
            ? Math.trunc(splashTarget.maxHp * (rawAmount / 100))
            : Math.trunc(rawAmount);
          game.actionLog.doAction(new SetCurrentHpAction(
            splashTarget,
            Math.max(1, splashTarget.currentHp - amount),
          ));
          damaged++;
        }
        if (damaged > 0) {
          triggerSkillCharge(game, skill);
          applied += damaged;
        }
      }
      const allyStrikeheal = skill.getComponent<unknown>('ally_strikeheal_ranged');
      if (allyStrikeheal !== undefined && isHookTarget && unitAttacked &&
          unit.position && claimGlobalHook(skill, 'ally_strikeheal_ranged')) {
        const configuredRange = Number(componentOption(allyStrikeheal, 'range') ?? 1);
        const range = Number.isFinite(configuredRange)
          ? Math.max(0, Math.trunc(configuredRange))
          : 1;
        const rawAmount = Number(componentOption(
          allyStrikeheal,
          'Amount/Percentage',
        ) ?? 5);
        const percentage = componentOption(allyStrikeheal, 'is percent?') === true;
        let healed = 0;
        for (const ally of game.units?.values?.() ?? []) {
          if (!ally.position || !checkAlly(unit, ally, game.db)) continue;
          if (game.board?.getUnit(ally.position[0], ally.position[1]) !== ally) continue;
          const distance =
            Math.abs(ally.position[0] - unit.position[0]) +
            Math.abs(ally.position[1] - unit.position[1]);
          if (distance > range) continue;
          const amount = percentage
            ? Math.trunc(ally.maxHp * (rawAmount / 100))
            : Math.trunc(rawAmount);
          game.actionLog.doAction(new SetCurrentHpAction(
            ally,
            ally.currentHp + modifiedHealAmount(amount, ally, unit, game),
          ));
          healed++;
        }
        if (healed > 0) {
          triggerSkillCharge(game, skill);
          applied += healed;
        }
      }
      const flatKillHeal = skill.getComponent<unknown>('heal_on_kill');
      if (flatKillHeal !== undefined && isHookTarget && target.currentHp <= 0) {
        const amount = combatComponentNumber(
          game, flatKillHeal, unit, target, item, skill, mode,
        );
        game.actionLog.doAction(new SetCurrentHpAction(
          unit,
          unit.currentHp + modifiedHealAmount(amount, unit, unit, game),
        ));
        applied++;
      }
      const evalKillHeal = skill.getComponent<unknown>('eval_heal_on_kill');
      if (evalKillHeal !== undefined && isHookTarget && target.currentHp <= 0) {
        const amount = Math.max(0, combatComponentNumber(
          game, evalKillHeal, unit, target, item, skill, mode,
        ));
        game.actionLog.doAction(new SetCurrentHpAction(
          unit,
          unit.currentHp + modifiedHealAmount(amount, unit, unit, game),
        ));
        applied++;
      }
      const removeStatus = skill.getComponent<unknown>('remove_status_after_combat');
      if (typeof removeStatus === 'string' && enemyHookTarget) {
        const status = target.skills.find((candidate) => candidate.nid === removeStatus);
        if (status) game.actionLog.doAction(new RemoveSkillAction(target, status));
        triggerSkillCharge(game, skill);
        applied++;
      }
      if (skill.hasComponent('combat_trigger_charge') && enemyHookTarget &&
          strikes.some((strike) => strike.attacker === unit && strike.hit)) {
        triggerSkillCharge(game, skill, unit);
        applied++;
      }

      if (target.currentHp <= 0) {
        applied += grantSkill(unit, skill, skill.getComponent('gain_skill_after_kill'));
        if (unit === initiator) {
          applied += grantSkill(unit, skill, skill.getComponent('gain_skill_after_active_kill'));
        }
        applied += grantAreaSkills(
          unit,
          skill,
          skill.getComponent('aoe_gain_skill_after_kill'),
        );
      }
      applied += grantSkill(unit, skill, skill.getComponent('gain_skill_after_combat'));
      if (unit === initiator && pairStrikes.some((strike) => strike.attacker === unit)) {
        applied += grantSkill(unit, skill, skill.getComponent('gain_skill_after_attack'));
      }
      if ((unit === initiator || unit === initiator?.strikePartner) &&
          strikes.some((strike) => strike.attacker === unit && strike.crit)) {
        applied += grantSkill(
          unit,
          skill,
          skill.getComponent('gain_skill_after_crit'),
          target,
        );
      }
      if (strikes.some((strike) => strike.defender === unit && strike.hit)) {
        applied += grantSkill(
          unit,
          skill,
          skill.getComponent('gain_skill_after_combat_on_take_hit'),
          unit,
        );
      }
      if (unit === initiator && target.currentHp > 0 && strikes.length > 0) {
        applied += grantSkill(
          unit,
          skill,
          skill.getComponent('gain_skill_after_active_not_kill'),
        );
      }
      applied += grantAreaSkills(
        unit,
        skill,
        skill.getComponent('aoe_gain_skill_after_combat'),
      );

      const splashDamage = Number(skill.getComponent<number>('post_combat_splash') ?? 0);
      const splashAoe = Number(skill.getComponent<number>('post_combat_splash_aoe') ?? 0);
      if (splashDamage > 0 && splashAoe >= 0 && target.position &&
          checkEnemy(unit, target, game.db)) {
        for (const splashTarget of game.units?.values?.() ?? []) {
          if (!splashTarget.position || splashTarget === target ||
              checkAlly(unit, splashTarget, game.db)) continue;
          const distance = Math.abs(splashTarget.position[0] - target.position[0]) +
            Math.abs(splashTarget.position[1] - target.position[1]);
          if (distance <= splashAoe) {
            game.actionLog.doAction(new SetCurrentHpAction(
              splashTarget,
              Math.max(1, splashTarget.currentHp - splashDamage),
            ));
            applied++;
          }
        }
      }

      let shouldReset = false;
      if (skill.hasComponent('powerstaff')) {
        shouldReset = item.getComponent<string>('weapon_type') === 'Staff' &&
          pairStrikes.some((strike) => strike.hit);
      } else if (skill.hasComponent('combat_artist')) {
        shouldReset = pairStrikes.some((strike) =>
          strike.attackProcs?.some((mark) =>
            mark.kind === 'attack_pre_proc' && mark.unit === unit)) ||
          unit.skills.some((candidate) =>
            candidate.hasComponent('combat_art') && candidate.data.get('active') === true);
      } else if (skill.hasComponent('second_wind')) {
        shouldReset = pairStrikes.some((strike) => !strike.hit);
      } else if (skill.hasComponent('galeforce')) {
        shouldReset = unit === initiator && target.currentHp <= 0 &&
          pairStrikes.some((strike) => strike.attacker === unit);
      } else {
        const expression = skill.getComponent<string>('eval_galeforce');
        if (expression) {
          try {
            shouldReset = evaluateCondition(expression, {
              game,
              unit1: unit,
              unit2: target,
              position: unit.position ?? undefined,
              item,
              gameVars: game.gameVars,
              levelVars: game.levelVars,
              localArgs: new Map<string, unknown>([
                ['item', item],
                ['item2', equippedWeapon(target)],
                ['mode', pairStrikes[0]?.mode ?? 'attack'],
              ]),
            });
          } catch (error) {
            console.error(`Could not evaluate EvalGaleforce condition ${expression}`, error);
          }
        }
      }
      if (shouldReset) {
        game.actionLog.doAction(new ResetAction(unit));
        triggerSkillCharge(game, skill);
        applied++;
      }

      if (skill.hasComponent('combat_art') && skill.data.get('active') === true) {
        const sharedSkillNid = skill.getComponent<string>('combat_art_all');
        if (sharedSkillNid) {
          for (const ally of game.units?.values?.() ?? []) {
            const inSharedParty = ally.team === 'player' &&
              (ally.party === game.currentParty || ally.party === 'Flex');
            if (!inSharedParty || ally.nid === unit.nid) continue;
            const sharedSkill = ally.skills.find((candidate) =>
              candidate.nid === sharedSkillNid);
            if (sharedSkill) triggerSkillCharge(game, sharedSkill, ally);
          }
        }
        const child = unit.skills.find((candidate) =>
          candidate.data.get('combatArtSource') === skill);
        triggerSkillCharge(game, skill);
        game.actionLog.doAction(new SetSkillDataAction(skill, 'active', false));
        if (child) game.actionLog.doAction(new RemoveSkillAction(unit, child));
        applied += child ? 2 : 1;
      }

      if (skill.hasComponent('lost_on_kill') && target.currentHp <= 0 &&
          unit.skills.includes(skill)) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
        applied++;
      }
    }
  }

  // Ability items are generated outside inventory and may strike many targets;
  // consume their owning skill charge once per unit/root-item encounter.
  const abilityItemsByUnit = new Map<UnitObject, Set<ItemObject>>();
  for (const strike of strikes) {
    const root = rootItem(strike.item);
    const seen = abilityItemsByUnit.get(strike.attacker) ?? new Set<ItemObject>();
    if (seen.has(root)) continue;
    seen.add(root);
    abilityItemsByUnit.set(strike.attacker, seen);
    applied += triggerAbilityItemCharge(
      game,
      strike.attacker,
      strike.item,
      strike.mode ?? (strike.attacker === initiator ? 'attack' : 'defense'),
    );
  }

  // Python LostOnEndCombat2 marks itself during cleanup_combat and resolves
  // after every other post-combat hook. Keep this final so event_on_remove and
  // multi-skill ownership observe the completed combat state.
  const participants = [...new Set([
    ...(initiator ? [initiator] : []),
    ...(primaryTarget ? [primaryTarget] : []),
    ...strikes.flatMap((strike) => [strike.attacker, strike.defender]),
  ])];
  for (const unit of participants) {
    const attackStrike = strikes.find((strike) => strike.attacker === unit);
    const defenseStrike = strikes.find((strike) => strike.defender === unit);
    const onlySplash = !!attackStrike && !strikes.some((strike) =>
      strike.attacker === unit && strike.mode !== 'splash');
    const target = onlySplash
      ? null
      : (attackStrike?.defender
        ?? defenseStrike?.attacker
        ?? (unit === initiator ? primaryTarget : initiator)
        ?? null);
    const mode = attackStrike?.mode ?? (unit === initiator ? 'attack' : 'defense');
    for (const skill of [...unit.skills]) {
      const raw = skill.getComponent<unknown>('lost_on_end_combat2');
      if (raw === undefined) continue;
      const options = raw && typeof raw === 'object'
        ? raw as Record<string, unknown>
        : {};
      if (options.only_if_initiated === true && mode !== 'attack' && mode !== 'splash') {
        continue;
      }
      let remove = false;
      if (!target && options.lost_on_splash !== false) remove = true;
      if (target === unit && options.lost_on_self !== false) remove = true;
      if (target && target !== unit) {
        const allied = checkAlly(unit, target, game.db);
        if (allied && options.lost_on_ally !== false) remove = true;
        if (!allied && options.lost_on_enemy !== false) remove = true;
      }
      if (remove) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
        applied++;
      }
    }
    for (const skill of [...unit.skills]) {
      const raw = skill.getComponent<unknown>('lost_on_end_next_combat');
      if (raw === undefined) continue;
      let remove = false;
      const decrement = (): void => {
        const current = Number(skill.data.get('combats') ??
          legacyMultipleOption(raw, 'NumberOfCombats (X)', '2'));
        const next = (Number.isFinite(current) ? current : 2) - 1;
        game.actionLog!.doAction(new SetSkillDataAction(skill, 'combats', next));
        if (next <= 0) remove = true;
      };
      if (target === unit &&
          legacyMultipleOption(raw, 'LostOnSelf (T/F)', 'T') === 'T') {
        decrement();
      }
      if (target && checkAlly(unit, target, game.db) &&
          legacyMultipleOption(raw, 'LostOnAlly (T/F)', 'T') === 'T') {
        decrement();
      }
      if (target && checkEnemy(unit, target, game.db) &&
          legacyMultipleOption(raw, 'LostOnEnemy (T/F)', 'T') === 'T') {
        decrement();
      }
      if (!target &&
          legacyMultipleOption(raw, 'LostOnSplash (T/F)', 'T') === 'T') {
        decrement();
      }
      if (remove && unit.skills.includes(skill)) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
        applied++;
      }
    }
  }
  game.memory?.delete('combat_art_parent');
  game.memory?.delete('combat_art_weapons');
  for (const skill of conditionSkills) {
    skill.data.delete('_combat_condition');
  }
  return applied;
}

/** Matches Python banner.AcquiredItem: "{name} got {article} {item}." with no article for possessive names. */
export function droppableAcquiredBannerText(unit: UnitObject, item: ItemObject): string {
  if (item.name.includes("'")) return `${unit.name} got ${item.name}.`;
  const article = /^[aeiouAEIOU]/.test(item.name) ? 'an' : 'a';
  return `${unit.name} got ${article} ${item.name}.`;
}

/** Matches Python banner.SentToConvoy: "{item} sent to convoy." */
export function droppableSentToConvoyBannerText(item: ItemObject): string {
  return `${item.name} sent to convoy.`;
}

export interface DroppablePickupResult {
  /** Banner text for each pickup, in order, for the caller to display. */
  banners: string[];
  /**
   * Player units force-given a drop while at capacity: the caller must route
   * the player through the 'item_discard' state after combat resolves
   * (Python's force_give -> item_discard flow).
   */
  pendingDiscards: Array<{ unit: UnitObject; item: ItemObject }>;
}

/**
 * Applies Python's simple_combat.handle_item_gain: every droppable item on a
 * unit killed this combat transfers to the killer (the attacker for defender
 * deaths, or the primary defender if the attacker itself died). No team
 * allegiance gate exists in Python — an enemy killing a player unit loots its
 * droppable items exactly like a player killing an enemy.
 *
 * A full PLAYER killer is force-given the item anyway (over capacity) and
 * reported in `pendingDiscards` so the caller can open the 'item_discard'
 * state, matching Python's GiveItem force_give -> item_discard flow. A full
 * non-player killer matches Python's GiveItem silent refusal: the item is
 * removed from the dead unit and lost.
 */
export function applyDroppableItemPickups(
  actionLog: Pick<ActionLog, 'doAction'>,
  db: DroppableGame,
  results: CombatResults,
  attacker: UnitObject,
  dropRecipient: UnitObject | null,
): DroppablePickupResult {
  const banners: string[] = [];
  const pendingDiscards: Array<{ unit: UnitObject; item: ItemObject }> = [];
  for (const { unit: deadUnit, item } of results.droppedItems ?? []) {
    const killer = deadUnit === attacker ? dropRecipient : attacker;
    if (!killer) continue;
    actionLog.doAction(new SetItemDroppableAction(item, false));
    const accessory = item.isAccessory();
    const limit = Number(db.getConstant(accessory ? 'num_accessories' : 'num_items', accessory ? 0 : 5));
    const count = killer.items.filter((candidate) => candidate.isAccessory() === accessory).length;
    const full = count >= limit;
    if (!full) {
      actionLog.doAction(new MoveItemBetweenUnitsAction(deadUnit, killer, item));
      banners.push(droppableAcquiredBannerText(killer, item));
    } else if (killer.team === 'player') {
      // Python force-gives the item (over capacity) and then opens the
      // item_discard state for the player to choose what to store/discard.
      actionLog.doAction(new MoveItemBetweenUnitsAction(deadUnit, killer, item));
      banners.push(droppableAcquiredBannerText(killer, item));
      pendingDiscards.push({ unit: killer, item });
    } else {
      // Python's GiveItem.do() silently refuses to add to a full non-player
      // inventory; the item is simply removed from the dead unit and lost.
      actionLog.doAction(new RemoveItemFromUnitAction(deadUnit, item));
    }
  }
  return { banners, pendingDiscards };
}

/**
 * Apply a successful Steal transfer and report Python's forced-discard followup.
 * EotF's custom theft components allow a player to select an item while full,
 * then force-give it before opening item_discard; enemy inventories never
 * receive this overflow path.
 */
export function applyStolenItemTransfer(
  actionLog: Pick<ActionLog, 'doAction'>,
  db: Database,
  attacker: UnitObject,
  defender: UnitObject,
  item: ItemObject,
): { unit: UnitObject; item: ItemObject } | null {
  const needsDiscard = attacker.team === 'player' && inventoryFull(attacker, item, db);
  actionLog.doAction(new MoveItemBetweenUnitsAction(defender, attacker, item));
  if (attacker.team !== 'player') {
    actionLog.doAction(new SetItemDroppableAction(item, true));
  }
  actionLog.doAction(new UpdateRecordsAction(
    'steal',
    attacker.nid,
    defender.nid,
    item.nid,
  ));
  return needsDiscard ? { unit: attacker, item } : null;
}

function eventNid(item: ItemObject, component: string): string | null {
  const value = item.getComponent<any>(component);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function triggerForStrike(strike: CombatStrike, _attackIndex: number): EventTrigger {
  const targetPosition = strike.defender.position
    ? [...strike.defender.position] as [number, number]
    : null;
  const item2 = strike.defender.items.find((item) => item.isWeapon()) ?? null;
  return {
    type: 'item_combat_event',
    unit1: strike.attacker,
    unit2: strike.defender,
    unitNid: strike.attacker.nid,
    position: strike.attacker.position
      ? [...strike.attacker.position] as [number, number]
      : undefined,
    item: strike.item,
    localArgs: new Map<string, any>([
      ['target_pos', targetPosition],
      ['mode', strike.mode ?? (strike.isCounter ? 'defense' : 'attack')],
      ['attack_info', [...strike.attackInfo]],
      ['item', strike.item],
      ['item2', item2],
    ]),
  };
}

/**
 * Queue hidden EventAfterInitiatedCombat skill hooks at Python's
 * skill-system end-combat point. Only active skills on the initiating side
 * participate; defenders are deliberately not scanned.
 */
export function queueAfterInitiatedCombatEvents(
  game: CombatLifecycleGame,
  bearer: UnitObject,
  target: UnitObject,
  item: ItemObject,
  item2: ItemObject | null,
  mode: string,
): number {
  const manager = game.eventManager;
  if (!manager || mode !== 'attack') return 0;

  let queued = 0;
  for (const skill of bearer.skills) {
    const nid = skill.getComponent<unknown>('event_after_initiated_combat');
    if (typeof nid !== 'string' || nid.length === 0) continue;
    if (!skillConditionActive(skill, bearer, { game, target, item })) continue;

    if (manager.triggerSpecific(nid, {
      type: 'event_after_initiated_combat',
      unit1: bearer,
      unit2: target,
      unitNid: bearer.nid,
      position: bearer.position
        ? [...bearer.position] as [number, number]
        : undefined,
      localArgs: new Map<string, unknown>([
        ['item', item],
        ['item2', item2],
        ['mode', mode],
      ]),
    })) queued++;
  }
  return queued;
}

/** Apply item end-combat resource hooks once per item that participated. */
export function applyCombatItemEndHooks(game: CombatLifecycleGame, strikes: CombatStrike[]): number {
  if (!game.actionLog || !game.db) return 0;
  const processed = new Set<ItemObject>();
  let applied = 0;
  for (const strike of strikes) {
    if (processed.has(strike.item)) continue;
    processed.add(strike.item);
    const itemMarks = strikes.filter((candidate) => candidate.item === strike.item);
    const firstMark = itemMarks[0];
    const hitMarks = [...new Map(
      itemMarks
        .filter((candidate) => candidate.hit)
        .map((candidate) => [candidate.defender.nid, candidate]),
    ).values()];
    for (const mark of itemMarks.filter((candidate) => candidate.hit)) {
      const healing = itemHealAmount(mark.attacker, strike.item, mark.defender, game);
      if (healing !== null) {
        game.actionLog.doAction(new SetCurrentHpAction(
          mark.defender,
          mark.defender.currentHp + healing,
        ));
        applied++;
      }
      if (strike.item.hasComponent('restore_no_target_restrict')) {
        for (const skill of [...mark.defender.skills]) {
          if (!skill.hasComponent('negative')) continue;
          game.actionLog.doAction(new RemoveSkillAction(mark.defender, skill));
          applied++;
        }
      }
      if (strike.item.hasComponent('refresh_no_target_restrict')) {
        game.actionLog.doAction(new ResetAction(mark.defender));
        applied++;
      }
    }
    const endStatuses = strike.item.getComponent<unknown>('statuses_after_combat_on_hit');
    if (Array.isArray(endStatuses)) {
      for (const mark of hitMarks) {
        for (const statusNid of endStatuses) {
          if (typeof statusNid !== 'string') continue;
          const prefab = game.db.skills.get(statusNid);
          if (!prefab) continue;
          const status = new SkillObject(prefab);
          status.initiatorNid = mark.attacker.nid;
          game.actionLog.doAction(new AddSkillAction(mark.defender, status));
          applied++;
        }
      }
    }
    const foeOnlyStatus = strike.item.getComponent<unknown>(
      'status_after_combat_on_hit_foe_only',
    );
    if (typeof foeOnlyStatus === 'string') {
      const prefab = game.db.skills.get(foeOnlyStatus);
      if (prefab) {
        for (const mark of hitMarks) {
          if (!checkEnemy(mark.attacker, mark.defender, game.db)) continue;
          const status = new SkillObject(prefab);
          status.initiatorNid = mark.attacker.nid;
          game.actionLog.doAction(new AddSkillAction(mark.defender, status));
          applied++;
        }
      }
    }
    const selfRemove = strike.item.getComponent<unknown>('self_remove_skill');
    if (typeof selfRemove === 'string') {
      for (const skill of firstMark.attacker.skills.filter(
        (candidate) => candidate.nid === selfRemove,
      )) {
        game.actionLog.doAction(new RemoveSkillAction(firstMark.attacker, skill));
        applied++;
      }
    }
    const critMark = itemMarks.find((candidate) => candidate.crit);
    if (critMark) {
      const blitzStrike = critMark.attacker.skills.find((skill) => {
        const overrideNid = skill.getComponent<string>('item_override');
        const override = overrideNid ? game.db?.items.get(overrideNid) : null;
        if (!override?.components.some(([nid]) => nid === 'galeforce_on_crit')) return false;
        if (!skillConditionActive(skill, critMark.attacker, {
          game,
          target: critMark.defender,
          item: strike.item,
        })) return false;
        if (skill.hasComponent('build_charge')) {
          const charge = Number(skill.data.get('charge') ?? 0);
          const total = Number(
            skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0,
          );
          if (charge < total) return false;
        }
        return !hasDrainingCharge(skill) ||
          Number(skill.data.get('charge') ?? 0) > 0;
      });
      if (blitzStrike) {
        const prefab = game.db.skills.get('Galeforce_Status');
        if (prefab) {
          const status = new SkillObject(prefab);
          status.initiatorNid = critMark.attacker.nid;
          game.actionLog.doAction(new AddSkillAction(critMark.attacker, status));
          applied++;
        }
        triggerSkillCharge(game, blitzStrike, critMark.attacker);
        applied++;
      }
    }
    applied += applyItemEndResourceHooks(game, firstMark.attacker, strike.item);
    if (game.board) {
      for (const componentNid of strike.item.components.keys()) {
        const initiationOnly = componentNid === 'shove_on_end_combat_initiate' ||
          componentNid === 'shove_flexible_on_end_combat_initiate' ||
          componentNid === 'pivot_on_end_combat_initiate' ||
          componentNid === 'pivot_always_on_end_combat_initiate' ||
          componentNid === 'draw_back_on_end_combat_initiate';
        const marks = componentNid === 'shove_on_end_combat' ||
          componentNid === 'swap_on_end_combat' || initiationOnly
          ? [firstMark]
          : hitMarks;
        for (const mark of marks) {
          if ((componentNid === 'shove' || componentNid === 'shove_on_end_combat') &&
              mark.attacker.position && !ignoreForcedMovement(mark.defender)) {
            const destination = shoveDestination(
              mark.defender,
              mark.attacker.position,
              Number(strike.item.getComponent<number>(componentNid) ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destination, game.board));
              applied++;
            }
          } else if ((componentNid === 'shove_on_end_combat_initiate' ||
              componentNid === 'shove_flexible_on_end_combat_initiate') &&
              strikeMode(mark) === 'attack' && mark.attacker.position &&
              !ignoreForcedMovement(mark.defender)) {
            const destination = eotfShoveDestination(
              mark.defender,
              mark.attacker.position,
              Number(strike.item.getComponent<number>(componentNid) ?? 1),
              { board: game.board, db: game.db, game },
              componentNid === 'shove_flexible_on_end_combat_initiate',
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destination, game.board));
              applied++;
            }
          } else if ((componentNid === 'shove_flex_stops' ||
              componentNid === 'shove_flex_stops_event') &&
              mark.attacker.position && !ignoreForcedMovement(mark.defender)) {
            const rawValue = strike.item.getComponent<unknown>(componentNid);
            const magnitude = componentNid === 'shove_flex_stops_event'
              ? Number(componentOption(rawValue, 'magnitude') ?? 0)
              : Number(rawValue ?? 1);
            const destination = eotfShoveDestination(
              mark.defender,
              mark.attacker.position,
              magnitude,
              { board: game.board, db: game.db, game },
              true,
              false,
              componentNid === 'shove_flex_stops_event'
                ? (occupant) => {
                    const event = componentOption(rawValue, 'impact_event');
                    if (typeof event !== 'string' || !event || !game.eventManager) return;
                    game.eventManager.triggerSpecific(event, {
                      type: 'shove_impact',
                      unit1: mark.defender,
                      unit2: occupant,
                      unitNid: mark.defender.nid,
                      position: mark.defender.position
                        ? [...mark.defender.position] as [number, number]
                        : undefined,
                      item: strike.item,
                      localArgs: new Map<string, unknown>([
                        ['item', strike.item],
                        ['item2', equippedWeapon(mark.defender)],
                        ['mode', strikeMode(mark)],
                      ]),
                    });
                  }
                : undefined,
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destination, game.board));
              applied++;
            }
          } else if (componentNid === 'self_shove_flex_stops' &&
              mark.defender.position && !ignoreForcedMovement(mark.attacker)) {
            const destination = eotfShoveDestination(
              mark.attacker,
              mark.defender.position,
              eotfSelfShoveMagnitude(
                game,
                mark,
                strike.item.getComponent<unknown>('self_shove_flex_stops'),
              ),
              { board: game.board, db: game.db, game },
              true,
              true,
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destination, game.board));
              applied++;
            }
          } else if ((componentNid === 'swap' || componentNid === 'swap_on_end_combat') &&
              mark.attacker.position && mark.defender.position &&
              !ignoreForcedMovement(mark.attacker) && !ignoreForcedMovement(mark.defender) &&
              (!mark.isCounter || componentNid === 'swap')) {
            game.actionLog.doAction(new SwapUnitsAction(mark.attacker, mark.defender, game.board));
            applied++;
          } else if (componentNid === 'pivot' && mark.defender.position &&
              !ignoreForcedMovement(mark.attacker)) {
            const destination = pivotDestination(
              mark.attacker,
              mark.defender.position,
              Number(strike.item.getComponent<number>('pivot') ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destination, game.board));
              applied++;
            }
          } else if ((componentNid === 'pivot_on_end_combat_initiate' ||
              componentNid === 'pivot_always_on_end_combat_initiate') &&
              strikeMode(mark) === 'attack' && mark.defender.position &&
              !ignoreForcedMovement(mark.attacker)) {
            const destination = eotfPivotDestination(
              mark.attacker,
              mark.defender.position,
              Number(strike.item.getComponent<number>(componentNid) ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destination, game.board));
              applied++;
            }
          } else if (componentNid === 'draw_back' && !ignoreForcedMovement(mark.defender)) {
            const destinations = drawBackDestinations(
              mark.attacker,
              mark.defender,
              Number(strike.item.getComponent<number>('draw_back') ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destinations) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destinations[0], game.board));
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destinations[1], game.board));
              applied += 2;
            }
          } else if (componentNid === 'draw_back_on_end_combat_initiate' &&
              strikeMode(mark) === 'attack' &&
              !ignoreForcedMovement(mark.attacker) && !ignoreForcedMovement(mark.defender)) {
            const destinations = eotfDrawBackDestinations(
              mark.attacker,
              mark.defender,
              Number(strike.item.getComponent<number>(componentNid) ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destinations) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destinations[0], game.board));
              if (!game.board.getUnit(destinations[1][0], destinations[1][1])) {
                game.actionLog.doAction(new WarpUnitAction(mark.defender, destinations[1], game.board));
                applied += 2;
              } else {
                applied++;
              }
            }
          } else if (componentNid === 'advance' && !ignoreForcedMovement(mark.defender)) {
            const destinations = advanceDestinations(
              mark.attacker,
              mark.defender,
              Number(strike.item.getComponent<number>('advance') ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destinations) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destinations[0], game.board));
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destinations[1], game.board));
              applied += 2;
            }
          } else if (
            (componentNid === 'phasewalk' ||
              componentNid === 'charge' ||
              componentNid === 'bullrush') &&
            mark.defender.position && game.db
          ) {
            const endpoints = rekkaMovementEndpoints(
              mark.attacker, strike.item, game.board, game.db, game,
            );
            const endpoint = endpoints.get(
              `${mark.defender.position[0]},${mark.defender.position[1]}`,
            );
            if (endpoint) {
              const occupant = game.board.getUnit(endpoint[0], endpoint[1]);
              if (occupant && occupant !== mark.attacker &&
                  componentNid !== 'phasewalk') {
                const open = nearestOpenTile(game, occupant, endpoint);
                if (open) {
                  game.actionLog.doAction(new WarpUnitAction(occupant, open, game.board));
                  applied++;
                }
              }
              game.actionLog.doAction(
                new WarpUnitAction(mark.attacker, endpoint, game.board),
              );
              applied++;
            }
          }
        }
      }
    }
    const fatigue = strike.item.getComponent<number>('fatigue');
    if (!strike.isCounter && typeof fatigue === 'number' && fatigue !== 0) {
      game.actionLog.doAction(new ChangeFatigueAction(strike.attacker, fatigue));
      applied++;
    }

    const expression = strike.item.getComponent<unknown>('gain_mana_after_combat');
    if (typeof expression === 'string' && expression.length > 0) {
      try {
        const amount = Math.trunc(Number(evaluateExpression(expression, {
          game,
          unit1: strike.attacker,
          unit2: strike.defender,
          position: strike.attacker.position ?? undefined,
          item: strike.item,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        })));
        if (!Number.isFinite(amount)) continue;
        const manaExpression = game.db.getEquation('MANA') ?? '0';
        const maximum = Math.max(
          0,
          Math.trunc(evaluateEquation(manaExpression, strike.attacker, {
            db: game.db as any,
            item: strike.item,
          })),
        );
        game.actionLog.doAction(new ChangeManaAction(strike.attacker, amount, maximum));
        applied++;
      } catch (error) {
        console.error(`Could not evaluate ${expression}`, error);
      }
    }

    if (strike.item.hasComponent('trace') && game.items) {
      const traceMark = hitMarks[0];
      const targetItem = strike.item.data.get('target_item') as ItemObject | undefined;
      if (traceMark && targetItem) {
        const copyNid = targetItem.nid.includes('Fragarach') &&
          game.db.items.has('Deviant_Fragarach')
          ? 'Deviant_Fragarach'
          : targetItem.nid;
        const prefab = game.db.items.get(copyNid);
        if (prefab) {
          const copy = createItemTree(prefab, (nid) => game.db!.items.get(nid));
          const key = `trace_${strike.attacker.nid}_${copy.nid}_${game.items.size}`;
          game.actionLog.doAction(new RegisterItemTreeAction(game.items, copy, key));
          if (!copyNid.includes('Deviant_Fragarach') && copy.maxUses > 0) {
            game.actionLog.doAction(new SetItemUsesAction(copy, 1));
          }
          game.actionLog.doAction(new GiveItemAction(strike.attacker, copy));
          applied += 3;
        }
      }
    }
  }
  return applied;
}

/** Apply item start-combat resource and EotF event hooks for one participant. */
export function applyCombatItemStartHooks(
  game: CombatLifecycleGame,
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject | null = null,
  item2: ItemObject | null = null,
  mode: string = 'attack',
): number {
  let applied = applyItemStartResourceHooks(game, unit, item);
  const nid = eventNid(item, 'event_before_combat');
  if (nid && game.eventManager?.triggerSpecific(nid, {
    type: 'event_before_combat',
    unit1: unit,
    unit2: target ?? undefined,
    unitNid: unit.nid,
    position: unit.position ? [...unit.position] as [number, number] : undefined,
    item,
    localArgs: new Map<string, unknown>([
      ['item', item],
      ['item2', item2],
      ['mode', mode],
    ]),
  })) applied++;
  return applied;
}

/** Queue on_broken hooks after durability cleanup but before end_combat hooks. */
export function queueCombatItemBreakEvents(
  game: CombatLifecycleGame,
  strikes: CombatStrike[],
): number {
  const manager = game.eventManager;
  if (!manager) return 0;
  let queued = 0;
  const processed = new Set<ItemObject>();
  for (const mark of strikes) {
    if (processed.has(mark.item)) continue;
    processed.add(mark.item);
    const nid = eventNid(mark.item, 'event_on_break');
    if (!nid || mark.item.maxUses <= 0 || mark.item.uses > 0) continue;
    if (manager.triggerSpecific(nid, {
      type: 'event_on_break',
      unit1: mark.attacker,
      unitNid: mark.attacker.nid,
      item: mark.item,
      localArgs: new Map<string, unknown>([['item', mark.item]]),
    })) queued++;
  }
  return queued;
}

/**
 * Queue item component events in Python hook order after strike resolution.
 * Specific events bypass their prefab condition, matching trigger_specific_event.
 */
export function queueCombatItemEvents(game: CombatLifecycleGame, strikes: CombatStrike[]): number {
  const manager = game.eventManager;
  if (!manager) return 0;
  let queued = 0;

  strikes.forEach((strike, index) => {
    if (!strike.hit) return;
    for (const component of ['event_on_use', 'event_on_hit']) {
      const nid = eventNid(strike.item, component);
      if (nid && manager.triggerSpecific(nid, triggerForStrike(strike, index))) queued++;
    }
  });

  const itemStrikes = new Map<ItemObject, CombatStrike[]>();
  for (const strike of strikes) {
    const marks = itemStrikes.get(strike.item) ?? [];
    marks.push(strike);
    itemStrikes.set(strike.item, marks);
  }
  for (const [item, marks] of itemStrikes) {
    const hits = marks.filter((strike) => strike.hit);
    const firstMark = marks[0];
    const lastMark = marks[marks.length - 1];
    const lastHit = hits[hits.length - 1];
    const hitComponents = [
      'event_after_use',
      'event_after_combat',
      'event_after_combat_on_hit',
    ];
    if (lastHit) {
      for (const component of hitComponents) {
        const nid = eventNid(item, component);
        if (nid && manager.triggerSpecific(nid, triggerForStrike(lastHit, marks.indexOf(lastHit)))) {
          queued++;
        }
      }
    }
    const perHitNid = eventNid(item, 'event_for_each_after_combat_on_hit');
    if (perHitNid && firstMark) {
      const uniqueTargets = new Set(hits.map((hit) => hit.defender));
      for (const targetFoe of uniqueTargets) {
        const trigger = triggerForStrike(firstMark, 0);
        trigger.type = 'event_for_each_after_combat_on_hit';
        trigger.localArgs = new Map(trigger.localArgs ?? []);
        trigger.localArgs.set('target_foe', targetFoe);
        if (manager.triggerSpecific(perHitNid, trigger)) queued++;
      }
    }
    const evenMissNid = eventNid(item, 'event_after_combat_even_miss');
    if (evenMissNid && lastMark &&
        manager.triggerSpecific(evenMissNid, triggerForStrike(lastMark, marks.length - 1))) {
      queued++;
    }
  }
  return queued;
}

/** Resolve an auto-hit event spell aimed at an empty tile (Python on_hit/end_combat). */
export function queueDirectItemUseEvents(
  game: CombatLifecycleGame,
  unit: UnitObject,
  item: ItemObject,
  targetPosition: [number, number],
  target: UnitObject | null = null,
): number {
  const manager = game.eventManager;
  if (!manager) return 0;
  let queued = 0;
  const trigger = (component: string): void => {
    const nid = eventNid(item, component);
    if (!nid) return;
    if (manager.triggerSpecific(nid, {
      type: component,
      unit1: unit,
      unit2: target ?? undefined,
      unitNid: unit.nid,
      position: unit.position ? [...unit.position] as [number, number] : undefined,
      item,
      localArgs: new Map<string, unknown>([
        ['target_pos', targetPosition],
        ['mode', 'attack'],
        ['attack_info', [0, 0]],
        ['item', item],
        ['item2', null],
      ]),
    })) queued++;
  };
  for (const component of ['event_on_use', 'event_on_hit']) trigger(component);
  for (const component of [
    'event_after_use',
    'event_after_combat',
    'event_after_combat_on_hit',
    'event_after_combat_even_miss',
  ]) trigger(component);
  return queued;
}
