import type { Database } from '../data/database';
import type { KlassDef, SkillPrefab } from '../data/types';
import type { UnitObject } from '../objects/unit';
import { getGrowthRandom } from './static-random';

interface LearnedSkillGameState {
  db: Database;
  gameVars: Map<string, any>;
}

function isFeat(prefab: SkillPrefab): boolean {
  return prefab.components.some(([componentNid]) => componentNid === 'feat');
}

/** Return Feat-prefab NIDs in database order, matching SkillCatalog.get_feats. */
export function getFeatNids(db: Database): string[] {
  return Array.from(db.skills.values())
    .filter(isFeat)
    .map((prefab) => prefab.nid);
}

function inheritedClasses(current: KlassDef, game: LearnedSkillGameState): KlassDef[] {
  const classes = [current];
  if (!game.db.getConstant('promote_skill_inheritance', false)) return classes;

  let parent: KlassDef | undefined = current;
  for (let depth = 0; depth < 5 && parent.tier > 1 && parent.promotes_from; depth++) {
    parent = game.db.classes.get(parent.promotes_from);
    if (!parent) break;
    classes.push(parent);
  }
  return classes.reverse();
}

/**
 * Port of Python `unit_funcs.get_starting_skills` for class-learned skills.
 *
 * `Feat` is a sentinel rather than a real skill. When `generic_feats` is on,
 * every eligible sentinel chooses a distinct available Feat with the shared
 * growth RNG. Ordinary learned skills retain class/inheritance ordering.
 */
export function getStartingClassSkillNids(
  unit: UnitObject,
  startingLevel: number,
  game: LearnedSkillGameState,
): string[] {
  const currentClass = game.db.classes.get(unit.klass);
  if (!currentClass) return [];

  const currentSkills = new Set(unit.skills.map((skill) => skill.nid));
  const skillsToAdd: string[] = [];
  const selected = new Set<string>();
  const feats = getFeatNids(game.db);

  for (const klass of inheritedClasses(currentClass, game)) {
    for (const [levelNeeded, skillNid] of klass.learned_skills ?? []) {
      const eligible = (
        (startingLevel < levelNeeded && levelNeeded <= unit.level) ||
        klass !== currentClass
      );
      if (!eligible || currentSkills.has(skillNid) || selected.has(skillNid)) continue;

      if (skillNid === 'Feat') {
        if (!game.db.getConstant('generic_feats', false)) continue;
        const available = feats.filter((nid) => !currentSkills.has(nid) && !selected.has(nid));
        if (available.length === 0) continue;
        const index = getGrowthRandom(game) % available.length;
        skillsToAdd.push(available[index]);
        selected.add(available[index]);
      } else {
        skillsToAdd.push(skillNid);
        selected.add(skillNid);
      }
    }
  }
  return skillsToAdd;
}
