import type { ActionLog } from './action';
import {
  RemoveSkillAction,
  SetSkillDataAction,
} from './action';
import type { UnitObject } from '../objects/unit';
import type { SkillObject } from '../objects/skill';
import { evaluateCondition } from '../events/event-manager';

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
  gameVars?: Map<string, unknown>;
  levelVars?: Map<string, unknown>;
}

function isConditionActive(
  game: SkillTurnGame,
  unit: UnitObject,
  skill: SkillObject,
): boolean {
  const condition = skill.getComponent<string>('condition');
  if (!condition) return true;
  return evaluateCondition(condition, {
    game,
    unit1: unit,
    position: unit.position ?? undefined,
    gameVars: game.gameVars,
    levelVars: game.levelVars,
    localArgs: new Map([['skill', skill]]),
  });
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
        }
      }

      if (removeAfterHooks) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
      }
    }
  }
  return effects;
}
