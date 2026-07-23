import type { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';
import type { CombatProcMark, ProcKind } from './combat-skill-lifecycle';

/** Python gui.SkillIcon timing: 400ms in, 700ms hold, 150ms out. */
export const PROC_CUE_DURATION_MS = 1250;
export const PROC_CUE_FADE_IN_MS = 400;
export const PROC_CUE_HOLD_MS = 700;

export interface CombatProcCue {
  kind: ProcKind | 'display';
  unit: UnitObject;
  skill: SkillObject;
  elapsed: number;
  duration: number;
}

export function isProcIconVisible(mark: CombatProcMark): boolean {
  return !mark.parentSkill.hasComponent('hide_skill_icon_in_combat');
}

export function cueFromMark(mark: CombatProcMark): CombatProcCue {
  return {
    kind: mark.kind,
    unit: mark.unit,
    skill: mark.parentSkill,
    elapsed: 0,
    duration: PROC_CUE_DURATION_MS,
  };
}

export function displaySkillCues(units: UnitObject[]): CombatProcCue[] {
  return units.flatMap((unit) => unit.skills
    .filter((skill) =>
      skill.hasComponent('display_skill_icon_in_combat') &&
      !skill.hasComponent('hide_skill_icon_in_combat'))
    .map((skill) => ({
      kind: 'display' as const,
      unit,
      skill,
      elapsed: 0,
      duration: PROC_CUE_DURATION_MS,
    })));
}

export function dedupeProcCues(cues: CombatProcCue[]): CombatProcCue[] {
  const seen = new Set<string>();
  return cues.filter((cue) => {
    const key = `${cue.unit.nid}:${cue.skill.nid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Spring-in X offset and alpha used by Python's SkillIcon. */
export function procCueMotion(cue: CombatProcCue): { alpha: number; offsetX: number } {
  const elapsed = Math.max(0, cue.elapsed);
  let alpha = 1;
  if (elapsed < PROC_CUE_FADE_IN_MS) {
    alpha = Math.min(1, elapsed / (PROC_CUE_FADE_IN_MS * 0.66));
  } else if (elapsed > PROC_CUE_FADE_IN_MS + PROC_CUE_HOLD_MS) {
    alpha = Math.max(
      0,
      1 - (elapsed - PROC_CUE_FADE_IN_MS - PROC_CUE_HOLD_MS) /
        (PROC_CUE_DURATION_MS - PROC_CUE_FADE_IN_MS - PROC_CUE_HOLD_MS),
    );
  }
  return {
    alpha,
    offsetX: 10 * Math.exp(-elapsed / 250) * Math.sin(elapsed / 25),
  };
}
