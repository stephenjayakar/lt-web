import type { GameState } from '../engine/game-state';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';
import { evaluateCondition } from '../events/event-manager';
import { available as itemAvailable } from './item-system';
import { skillConditionActive } from './skill-system';

export interface CombatArtOption {
  skill: SkillObject;
  childNid: string;
  weapons: ItemObject[];
}

export const COMBAT_ART_SOURCE = 'combatArtSource';

export function combatArtReady(
  game: GameState,
  unit: UnitObject,
  skill: SkillObject,
): boolean {
  if (skill.hasComponent('build_charge') &&
      Number(skill.data.get('charge') ?? 0) <
        Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0)) {
    return false;
  }
  if ((skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) &&
      Number(skill.data.get('charge') ?? 0) <= 0) return false;
  return skillConditionActive(skill, unit, { game });
}

export function getCombatArtOptions(
  game: GameState,
  unit: UnitObject,
  requireCurrentTarget: boolean = true,
): CombatArtOption[] {
  const options: CombatArtOption[] = [];
  for (const skill of [...unit.skills]) {
    const childNid = skill.getComponent<string>('combat_art');
    if (!childNid || !combatArtReady(game, unit, skill)) continue;
    const childPrefab = game.db.skills.get(childNid);
    if (!childPrefab) continue;
    const child = new SkillObject(childPrefab);
    child.data.set(COMBAT_ART_SOURCE, skill);
    unit.skills.push(child);
    try {
      const expression = skill.getComponent<string>('allowed_weapons');
      const weapons = unit.items.filter((item) => {
        if ((!item.isWeapon() && !item.isSpell()) ||
            !itemAvailable(unit, item, game.db, game)) return false;
        if (expression && !evaluateCondition(expression, {
          game,
          unit1: unit,
          item,
          position: unit.position ?? undefined,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: new Map<string, unknown>([
            ['item', item],
            ['skill', skill],
          ]),
        })) return false;
        return !requireCurrentTarget ||
          (game.targetSystem?.getValidTargetsRecursive(unit, item).length ?? 0) > 0;
      });
      if (weapons.length > 0) options.push({ skill, childNid, weapons });
    } finally {
      const index = unit.skills.indexOf(child);
      if (index >= 0) unit.skills.splice(index, 1);
    }
  }
  return options;
}

export function deactivateCombatArts(unit: UnitObject): void {
  const children = unit.skills.filter((skill) => skill.data.has(COMBAT_ART_SOURCE));
  unit.skills = unit.skills.filter((skill) => !skill.data.has(COMBAT_ART_SOURCE));
  for (const child of children) {
    const parent = child.data.get(COMBAT_ART_SOURCE) as SkillObject | undefined;
    parent?.data.set('active', false);
  }
  for (const skill of unit.skills) {
    if (skill.hasComponent('combat_art')) skill.data.set('active', false);
  }
}

export function activateCombatArt(
  game: GameState,
  unit: UnitObject,
  option: CombatArtOption,
): boolean {
  deactivateCombatArts(unit);
  const prefab = game.db.skills.get(option.childNid);
  if (!prefab) return false;
  const child = new SkillObject(prefab);
  child.data.set(COMBAT_ART_SOURCE, option.skill);
  unit.skills.push(child);
  option.skill.data.set('active', true);
  game.memory.set('combat_art_parent', option.skill);
  game.memory.set('combat_art_weapons', option.weapons);
  return true;
}
