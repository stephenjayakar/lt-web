/**
 * Skill-granted ability items (Python skill_system.get_extra_abilities):
 * shared by the unit menu and the AI, with stable registered item identity.
 */

import type { UnitObject } from '../objects/unit';
import { type ItemObject, createItemTree } from '../objects/item';
import type { SkillObject } from '../objects/skill';
import { hasDrainingCharge, skillConditionActive } from './skill-system';

export interface SkillAbilityOption {
  skill: SkillObject;
  item: ItemObject;
  component: 'ability' | 'ability_attack_charge' | 'ability_parent';
}

/** Python skill_system.get_extra_abilities, with stable registered item identity. */
export function getSkillAbilityOptions(game: any, unit: UnitObject): SkillAbilityOption[] {
  const result: SkillAbilityOption[] = [];
  const components = [
    'ability',
    'ability_attack_charge',
    'ability_parent',
  ] as const;
  const registerTree = (item: ItemObject, key: string): void => {
    game.items.set(key, item);
    item.subitems.forEach((child, index) =>
      registerTree(child, `${key}_sub_${index}_${child.nid}`));
  };
  for (const skill of unit.skills) {
    const total = Number(skill.data.get('total_charge'));
    const charge = Number(skill.data.get('charge'));
    if (skill.hasComponent('build_charge') && Number.isFinite(total) && charge < total) {
      continue;
    }
    if (hasDrainingCharge(skill) && Number.isFinite(charge) && charge <= 0) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    for (const component of components) {
      const itemNid = skill.getComponent<string>(component);
      if (!itemNid) continue;
      const prefab = game.db.items.get(itemNid);
      if (!prefab) continue;
      const dataKey = `abilityItemKey:${component}`;
      let registryKey = skill.data.get(dataKey);
      let item = typeof registryKey === 'string'
        ? game.items.get(registryKey) as ItemObject | undefined
        : undefined;
      if (!item || item.nid !== itemNid) {
        registryKey = `ability_${unit.nid}_${skill.uid}_${component}_${itemNid}`;
        item = createItemTree(prefab, (nid) => game.db.items.get(nid));
        registerTree(item, registryKey);
        skill.data.set(dataKey, registryKey);
      }
      item.owner = unit;
      result.push({ skill, item, component });
    }
  }
  return result;
}

