// Aura propagation and cleanup.
//
// Mirrors lt-maker/app/engine/aura_funcs.py plus the `Aura`/`AuraRange`/
// `AuraTarget` skill components (lt-maker/app/engine/skill_components/
// status_components.py). A unit with an `aura` skill component radiates a
// child skill to units within `aura_range` tiles that match `aura_target`
// ('ally' | 'enemy' | 'unit').
//
// Design note: rather than tracking per-tile aura registries (Python's
// `game.board.add_aura`/`get_auras`) and hooking every individual
// arrive/leave/add-skill/remove-skill call site, this port treats aura
// coverage as pure *derived* state: a full function of live unit positions
// and skill lists. `refreshAuras()` recomputes the whole board's aura
// coverage from scratch and diffs it against the aura-sourced skills
// currently present, adding/removing exactly what changed. It is wired to
// run automatically after every board position change (see
// GameBoard.onUnitPositionChanged in game-state.ts), which covers unit
// arrival, movement, warping, spawning, and removal/death — the same set of
// triggers Python's `game.arrive`/`game.leave` use to call
// `pull_auras`/`propagate_aura`/`release_aura`.
//
// Custom aura shapes (`aura_shape` component) are not implemented — no
// bundled project uses them (only the default sphere shape, via `aura`/
// `aura_range`/`aura_target` on Inspiration_child-style skills), so this is
// a deferred synthetic-shape case rather than a used one.

import type { UnitObject } from '../objects/unit';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import { SkillObject } from '../objects/skill';
import { initializeSkillData, isCantoSkill } from './skill-system';

/** Tag keys stored on a skill instance granted by an aura's propagation. */
export const AURA_SOURCE_TYPE_KEY = 'auraSourceType';
export const AURA_OWNER_NID_KEY = 'auraOwnerNid';
export const AURA_PARENT_SKILL_UID_KEY = 'auraParentSkillUid';

/** True when `skill` was granted to a unit by another unit's aura. */
export function isAuraSourcedSkill(skill: SkillObject): boolean {
  return skill.data.get(AURA_SOURCE_TYPE_KEY) === 'aura';
}

/** Strip every aura-sourced skill from `unit` (used before full re-derivation). */
export function removeAllAuraSourcedSkills(unit: UnitObject): void {
  for (const skill of unit.skills) {
    if (isAuraSourcedSkill(skill)) skill.ownerNid = null;
  }
  unit.skills = unit.skills.filter((skill) => !isAuraSourcedSkill(skill));
}

interface AuraInfo {
  /** The parent skill on the aura holder that carries the `aura` component. */
  parentSkill: SkillObject;
  /** NID of the child skill radiated to targets in range. */
  childNid: string;
  range: number;
  target: 'ally' | 'enemy' | 'unit';
}

/** Read every aura-bearing skill off `unit` (Python `get_all_aura_info`). */
function getAuraInfos(unit: UnitObject): AuraInfo[] {
  const infos: AuraInfo[] = [];
  for (const skill of unit.skills) {
    const childNid = skill.getComponent<string>('aura');
    if (!childNid) continue;
    const range = skill.getComponent<number>('aura_range') ?? 3;
    const target = (skill.getComponent<string>('aura_target') ?? 'unit') as
      | 'ally'
      | 'enemy'
      | 'unit';
    infos.push({ parentSkill: skill, childNid, range, target });
  }
  return infos;
}

/** Manhattan-distance shell (ring band, distance 1..range) around `origin`. */
function getShellPositions(
  origin: [number, number],
  range: number,
  board: GameBoard,
): [number, number][] {
  const [cx, cy] = origin;
  const seen = new Set<string>();
  const result: [number, number][] = [];
  const [minX, minY, maxX, maxY] = board.bounds;
  const dxMin = Math.max(-range, minX - cx);
  const dxMax = Math.min(range, maxX - cx);
  const dyMin = Math.max(-range, minY - cy);
  const dyMax = Math.min(range, maxY - cy);
  for (let dx = dxMin; dx <= dxMax; dx++) {
    for (let dy = dyMin; dy <= dyMax; dy++) {
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist < 1 || dist > range) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!board.inBounds(x, y)) continue;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push([x, y]);
    }
  }
  return result;
}

/** Python `apply_aura`'s target-filter check (ally/enemy/unit), minus LOS. */
function auraTargets(owner: UnitObject, target: UnitObject, filter: string, db: Database): boolean {
  if (owner === target) return false;
  if (filter === 'enemy') return !owner.isAlly(target.team, db.teams.alliances);
  if (filter === 'ally') return owner.isAlly(target.team, db.teams.alliances);
  return true; // 'unit'
}

interface DesiredEntry {
  targetUnit: UnitObject;
  ownerNid: string;
  parentUid: number;
  childNid: string;
}

/**
 * Recompute aura coverage across every unit on the board and reconcile the
 * aura-sourced skills currently present so they match. Safe to call at any
 * time (idempotent); intended to run after any unit position change and
 * once after level/save load.
 */
export function refreshAuras(
  units: Iterable<UnitObject>,
  board: GameBoard | null,
  db: Database,
): void {
  if (!board) return;

  const allUnits = Array.from(units);
  const positionedUnits = allUnits.filter((unit) => unit.position);

  // 1. Compute desired coverage: for each aura holder, which units in range
  // should carry the child skill.
  const desired: DesiredEntry[] = [];
  for (const owner of positionedUnits) {
    if (!owner.position) continue;
    for (const info of getAuraInfos(owner)) {
      const positions = getShellPositions(owner.position, info.range, board);
      for (const [x, y] of positions) {
        const occupant = board.getUnit(x, y);
        if (!occupant) continue;
        if (!auraTargets(owner, occupant, info.target, db)) continue;
        desired.push({
          targetUnit: occupant,
          ownerNid: owner.nid,
          parentUid: info.parentSkill.uid,
          childNid: info.childNid,
        });
      }
    }
  }

  // Python UnitObject.add_skill retains only the first non-displaceable aura
  // source for a non-stack child, and at most the authored stack limit for
  // stack children. Preserve desired traversal order so removing the first
  // source exposes the next qualifying aura on the following refresh.
  const limitedDesired: DesiredEntry[] = [];
  const desiredGroups = new Map<string, DesiredEntry[]>();
  for (const entry of desired) {
    const key = `${entry.targetUnit.nid}|${entry.childNid}`;
    const group = desiredGroups.get(key) ?? [];
    group.push(entry);
    desiredGroups.set(key, group);
  }
  for (const entries of desiredGroups.values()) {
    const first = entries[0];
    const prefab = db.skills?.get?.(first.childNid);
    const configuredLimit = Number(
      prefab?.components?.find?.(
        ([nid]: [string, unknown]) => nid === 'stack' || nid === 'stax',
      )?.[1] ?? 1,
    );
    const stackLimit = Number.isFinite(configuredLimit)
      ? Math.max(1, Math.trunc(configuredLimit))
      : 1;
    const naturalCount = first.targetUnit.skills.filter(
      (skill) => !isAuraSourcedSkill(skill) && skill.nid === first.childNid,
    ).length;
    limitedDesired.push(...entries.slice(0, Math.max(0, stackLimit - naturalCount)));
  }

  const desiredKey = (d: DesiredEntry) =>
    `${d.targetUnit.nid}|${d.ownerNid}|${d.parentUid}|${d.childNid}`;
  const desiredSet = new Set(limitedDesired.map(desiredKey));

  // 2. Remove aura-sourced skills that are no longer desired.
  for (const unit of allUnits) {
    for (let i = unit.skills.length - 1; i >= 0; i--) {
      const skill = unit.skills[i];
      if (!isAuraSourcedSkill(skill)) continue;
      const key = `${unit.nid}|${skill.data.get(AURA_OWNER_NID_KEY)}|${skill.data.get(
        AURA_PARENT_SKILL_UID_KEY,
      )}|${skill.nid}`;
      if (!desiredSet.has(key)) {
        unit.skills.splice(i, 1);
        skill.ownerNid = null;
      }
    }
  }

  // 3. Add aura-sourced skills that are newly desired (and not already present).
  for (const d of limitedDesired) {
    const alreadyHas = d.targetUnit.skills.some(
      (skill) =>
        isAuraSourcedSkill(skill) &&
        skill.nid === d.childNid &&
        skill.data.get(AURA_OWNER_NID_KEY) === d.ownerNid &&
        skill.data.get(AURA_PARENT_SKILL_UID_KEY) === d.parentUid,
    );
    if (alreadyHas) continue;
    const prefab = db.skills?.get?.(d.childNid);
    if (!prefab) continue;
    const childSkill = new SkillObject(prefab);
    childSkill.data.set(AURA_SOURCE_TYPE_KEY, 'aura');
    childSkill.data.set(AURA_OWNER_NID_KEY, d.ownerNid);
    childSkill.data.set(AURA_PARENT_SKILL_UID_KEY, d.parentUid);
    // EotF Defense Zone describes the aura bearer as its cover source. Its
    // Python component reads initiator_nid, which aura propagation leaves
    // empty; use the already-persisted aura owner as the intended source.
    initializeSkillData(childSkill, d.targetUnit);
    d.targetUnit.skills.push(childSkill);
  }

  // Keep hasCanto in sync in case an aura child skill grants/loses canto.
  for (const unit of allUnits) {
    unit.hasCanto = unit.skills.some(isCantoSkill);
  }
}
