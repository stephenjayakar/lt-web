import type { ActionLog } from './action';
import {
  AddSkillAction,
  ChangeManaAction,
  RemoveSkillAction,
  SetCurrentHpAction,
  SetSkillDataAction,
} from './action';
import type { UnitObject } from '../objects/unit';
import { SkillObject } from '../objects/skill';
import type { EventManager } from '../events/event-manager';
import type { Database } from '../data/database';
import { evaluateEquation } from '../combat/combat-calcs';
import {
  checkAlly,
  modifiedHealAmount,
  skillConditionActive,
} from '../combat/skill-system';
import { evaluateExpression } from '../events/event-manager';

export type SkillTurnPhase = 'upkeep' | 'endstep';

export interface SkillTurnEffect {
  unit: UnitObject;
  skill: SkillObject;
  component: string;
  value?: number;
  removed?: boolean;
}

interface SkillTurnGame {
  actionLog: ActionLog;
  db?: Database;
  gameVars?: Map<string, unknown>;
  levelVars?: Map<string, unknown>;
  eventManager?: EventManager | null;
  units?: Map<string, UnitObject>;
}

function componentOption(rawValue: unknown, key: string): unknown {
  if (!rawValue || typeof rawValue !== 'object') return undefined;
  return rawValue instanceof Map
    ? rawValue.get(key)
    : (rawValue as Record<string, unknown>)[key];
}

function isConditionActive(
  game: SkillTurnGame,
  unit: UnitObject,
  skill: SkillObject,
): boolean {
  const parent = skill.data.get('multiSkillSource');
  if (parent instanceof SkillObject && !isConditionActive(game, unit, parent)) return false;
  if (skill.hasComponent('build_charge') &&
      Number(skill.data.get('charge') ?? 0) < Number(skill.data.get('total_charge') ?? 0)) {
    return false;
  }
  if ((skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) &&
      Number(skill.data.get('charge') ?? 0) <= 0) {
    return false;
  }
  const mana = Number(unit.currentMana ?? 0);
  const manaRequirement = skill.getComponent<number>('cost_mana') ??
    skill.getComponent<number>('check_mana');
  if (typeof manaRequirement === 'number' && mana < manaRequirement) return false;
  return skillConditionActive(skill, unit, { game });
}

function maximumMana(game: SkillTurnGame, unit: UnitObject): number {
  if (!game.db) return Math.max(0, Number(unit.currentMana ?? 0));
  const expression = game.db.getEquation('MANA') ?? '0';
  return Math.max(0, Math.trunc(evaluateEquation(expression, unit, { db: game.db })));
}

function triggerCharge(game: SkillTurnGame, skill: SkillObject): void {
  if (skill.hasComponent('build_charge')) {
    setData(game, skill, 'charge', 0);
  } else if (skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
    setData(game, skill, 'charge', Number(skill.data.get('charge') ?? 0) - 1);
  }
}

function setData(
  game: SkillTurnGame,
  skill: SkillObject,
  key: string,
  value: number,
): void {
  game.actionLog.doAction(new SetSkillDataAction(skill, key, value));
}

function evaluatedTurnAmount(
  game: SkillTurnGame,
  unit: UnitObject,
  skill: SkillObject,
  expression: unknown,
): number {
  if (typeof expression !== 'string') return 0;
  try {
    const value = Number(evaluateExpression(expression, {
      game,
      unit1: unit,
      position: unit.position ?? undefined,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
      localArgs: new Map([['skill', skill]]),
    }));
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  } catch (error) {
    console.error(`Could not evaluate skill turn amount ${expression}`, error);
    return 0;
  }
}

function applyHpChange(
  game: SkillTurnGame,
  unit: UnitObject,
  amount: number,
): void {
  game.actionLog.doAction(new SetCurrentHpAction(unit, unit.currentHp + amount));
}

/**
 * Run Python's upkeep/endstep charge and time hooks in component order.
 * Returned effects are deliberately presentation-neutral so a map status state
 * can animate them without changing deterministic mutation ordering.
 */
export function applySkillTurnHooks(
  game: SkillTurnGame,
  units: UnitObject[],
  phase: SkillTurnPhase,
): SkillTurnEffect[] {
  const effects: SkillTurnEffect[] = [];
  for (const unit of units) {
    for (const skill of [...unit.skills]) {
      let removeAfterHooks = false;
      const conditional = isConditionActive(game, unit, skill);

      for (const [component, rawValue] of skill.components) {
        if (((phase === 'upkeep' &&
              (component === 'event_on_upkeep' || component === 'upkeep_event')) ||
             (phase === 'endstep' && component === 'endstep_event')) &&
            conditional) {
          if (typeof rawValue === 'string' && rawValue && game.eventManager?.triggerSpecific(
            rawValue,
            {
              type: component,
              unit1: unit,
              unit2: unit,
              unitNid: unit.nid,
              position: unit.position ? [...unit.position] as [number, number] : undefined,
              localArgs: new Map<string, unknown>([
                ['item', null],
                ['mode', null],
              ]),
            },
          )) {
            effects.push({ unit, skill, component });
          }
        } else if (
          ((phase === 'upkeep' && component === 'upkeep_skill_gain') ||
           (phase === 'endstep' && component === 'endstep_skill_gain')) &&
          conditional
        ) {
          const prefab = typeof rawValue === 'string'
            ? game.db?.skills.get(rawValue)
            : null;
          if (prefab) {
            game.actionLog.doAction(new AddSkillAction(unit, new SkillObject(prefab)));
            effects.push({ unit, skill, component });
          }
        } else if (
          phase === 'upkeep' &&
          component === 'upkeep_aoe_skill_gain' &&
          conditional &&
          unit.position
        ) {
          const skillNid = componentOption(rawValue, 'skill');
          const prefab = typeof skillNid === 'string'
            ? game.db?.skills.get(skillNid)
            : null;
          const configuredRange = Number(componentOption(rawValue, 'range') ?? 1);
          const range = Number.isFinite(configuredRange)
            ? Math.max(0, Math.trunc(configuredRange))
            : 1;
          const targetKind = String(componentOption(rawValue, 'target') ?? 'ally');
          let granted = 0;
          const grant = (recipient: UnitObject): void => {
            if (!prefab) return;
            const status = new SkillObject(prefab);
            status.initiatorNid = unit.nid;
            game.actionLog.doAction(new AddSkillAction(recipient, status));
            if (recipient.skills.includes(status)) granted++;
          };
          for (const candidate of game.units?.values() ?? []) {
            if (candidate === unit || !candidate.position || candidate.isDead()) continue;
            const distance =
              Math.abs(candidate.position[0] - unit.position[0]) +
              Math.abs(candidate.position[1] - unit.position[1]);
            if (distance > range) continue;
            const allied = !!game.db && checkAlly(unit, candidate, game.db);
            if ((allied && (targetKind === 'ally' || targetKind === 'any')) ||
                (!allied && (targetKind === 'enemy' || targetKind === 'any'))) {
              grant(candidate);
            }
          }
          if (componentOption(rawValue, 'affect_self') === true) grant(unit);
          if (granted > 0) {
            effects.push({ unit, skill, component, value: granted });
          }
        } else if (phase === 'upkeep' && component === 'upkeep_charge_increase') {
          const charge = Number(skill.data.get('charge') ?? 0);
          const total = Number(skill.data.get('total_charge') ?? charge);
          const amount = Number(rawValue);
          const value = Math.max(0, Math.min(total, charge + (Number.isFinite(amount) ? amount : 0)));
          setData(game, skill, 'charge', value);
          effects.push({ unit, skill, component, value });
        } else if (phase === 'endstep' && component === 'charges_per_turn') {
          const value = Number(skill.data.get('total_charge') ?? rawValue ?? 0);
          setData(game, skill, 'charge', value);
          effects.push({ unit, skill, component, value });
        } else if (
          (phase === 'upkeep' && (component === 'time' || component === 'combined_time')) ||
          (phase === 'endstep' && (component === 'end_time' || component === 'combined_time'))
        ) {
          const value = Number(skill.data.get('turns') ?? 0) - 1;
          setData(game, skill, 'turns', value);
          removeAfterHooks ||= value <= 0;
          effects.push({ unit, skill, component, value, removed: value <= 0 });
        } else if (
          (phase === 'upkeep' && component === 'lost_on_upkeep') ||
          (phase === 'endstep' && component === 'lost_on_endstep')
        ) {
          removeAfterHooks = true;
          effects.push({ unit, skill, component, removed: true });
        } else if (
          phase === 'upkeep' &&
          component === 'upkeep_stat_change' &&
          conditional
        ) {
          const value = Number(skill.data.get('counter') ?? 0) + 1;
          setData(game, skill, 'counter', value);
          effects.push({ unit, skill, component, value });
        } else if (phase === 'upkeep' && component === 'regeneration' && conditional) {
          const amount = Math.trunc(unit.maxHp * Number(rawValue ?? 0));
          if (amount !== 0 && unit.currentHp < unit.maxHp) {
            applyHpChange(game, unit, amount);
            effects.push({ unit, skill, component, value: amount });
          }
        } else if (
          phase === 'upkeep' &&
          component === 'eval_regeneration' &&
          conditional &&
          unit.currentHp < unit.maxHp
        ) {
          const baseAmount = evaluatedTurnAmount(game, unit, skill, rawValue);
          if (baseAmount !== 0) {
            const amount = modifiedHealAmount(baseAmount, unit, null, game);
            applyHpChange(game, unit, amount);
            effects.push({ unit, skill, component, value: amount });
          }
        } else if (phase === 'upkeep' && component === 'mana_regeneration' && conditional) {
          const amount = Math.trunc(Number(rawValue ?? 0));
          if (amount !== 0) {
            game.actionLog.doAction(new ChangeManaAction(unit, amount, maximumMana(game, unit)));
            effects.push({ unit, skill, component, value: amount });
          }
        } else if (phase === 'upkeep' && component === 'purge_ailments' && conditional) {
          for (const ailment of [...unit.skills]) {
            if (ailment.hasComponent('negative')) {
              game.actionLog.doAction(new RemoveSkillAction(unit, ailment));
            }
          }
          effects.push({ unit, skill, component });
        } else if (
          ((phase === 'upkeep' && component === 'upkeep_damage') ||
            (phase === 'endstep' && component === 'endstep_damage')) &&
          conditional
        ) {
          const amount = Math.trunc(Number(rawValue ?? 0));
          if (amount !== 0) {
            applyHpChange(game, unit, -amount);
            triggerCharge(game, skill);
            effects.push({ unit, skill, component, value: -amount });
          }
        } else if (
          phase === 'upkeep' &&
          component === 'eval_upkeep_damage' &&
          conditional
        ) {
          const amount = evaluatedTurnAmount(game, unit, skill, rawValue);
          applyHpChange(game, unit, -amount);
          triggerCharge(game, skill);
          effects.push({ unit, skill, component, value: -amount });
        }
      }

      if (removeAfterHooks) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
      }
    }
  }
  return effects;
}
