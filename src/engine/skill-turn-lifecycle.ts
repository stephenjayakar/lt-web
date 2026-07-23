import type { ActionLog } from './action';
import {
  ChangeManaAction,
  DamageAction,
  HealAction,
  RemoveSkillAction,
  SetSkillDataAction,
} from './action';
import type { UnitObject } from '../objects/unit';
import type { SkillObject } from '../objects/skill';
import { evaluateCondition } from '../events/event-manager';
import type { Database } from '../data/database';
import { evaluateEquation } from '../combat/combat-calcs';

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
}

function isConditionActive(
  game: SkillTurnGame,
  unit: UnitObject,
  skill: SkillObject,
): boolean {
  const condition = skill.getComponent<string>('condition');
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
  return !condition || evaluateCondition(condition, {
    game,
    unit1: unit,
    position: unit.position ?? undefined,
    gameVars: game.gameVars,
    levelVars: game.levelVars,
    localArgs: new Map([['skill', skill]]),
  });
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
        if (phase === 'upkeep' && component === 'upkeep_charge_increase') {
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
          if (amount > 0 && unit.currentHp < unit.maxHp) {
            game.actionLog.doAction(new HealAction(unit, amount));
            effects.push({ unit, skill, component, value: amount });
          }
        } else if (phase === 'upkeep' && component === 'mana_regeneration' && conditional) {
          const amount = Math.trunc(Number(rawValue ?? 0));
          if (amount !== 0) {
            game.actionLog.doAction(new ChangeManaAction(unit, amount, maximumMana(game, unit)));
            effects.push({ unit, skill, component, value: amount });
          }
        } else if (phase === 'upkeep' && component === 'upkeep_damage' && conditional) {
          const amount = Math.max(0, Math.trunc(Number(rawValue ?? 0)));
          if (amount > 0) {
            game.actionLog.doAction(new DamageAction(unit, amount));
            triggerCharge(game, skill);
            effects.push({ unit, skill, component, value: -amount });
          }
        }
      }

      if (removeAfterHooks) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
      }
    }
  }
  return effects;
}
