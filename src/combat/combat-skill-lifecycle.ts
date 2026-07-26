import type { Database } from '../data/database';
import { Action } from '../engine/action';
import {
  getCombatRandomState,
  setCombatRandomState,
  type RandomGameState,
} from '../engine/static-random';
import { evaluateCondition, evaluateExpression } from '../events/event-manager';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';
import { evaluateEquation } from './combat-calcs';
import type { CombatStrike } from './combat-solver';
import {
  checkEnemy,
  consumeMiracleCharge,
  hasDrainingCharge,
  selfNihilActive,
} from './skill-system';

export type ProcKind = 'attack_proc' | 'defense_proc' | 'attack_pre_proc' | 'defense_pre_proc';

export interface CombatProcMark {
  kind: ProcKind;
  unit: UnitObject;
  parentSkill: SkillObject;
  procSkill: SkillObject;
}

interface ItemOverlay {
  item: ItemObject;
  values: Map<string, { existed: boolean; value: any }>;
}

interface ActiveProc extends CombatProcMark {
  overlay: ItemOverlay | null;
  consumeCharge: boolean;
}

interface SkillSnapshot {
  skills: SkillObject[];
  data: Map<SkillObject, Map<string, any>>;
  currentMana: number | undefined;
}

function captureSkills(units: UnitObject[]): Map<UnitObject, SkillSnapshot> {
  return new Map([...new Set(units)].map((unit) => [unit, {
    skills: [...unit.skills],
    data: new Map(unit.skills.map((skill) => [skill, new Map(skill.data)])),
    currentMana: unit.currentMana,
  }]));
}

function restoreSkills(snapshot: Map<UnitObject, SkillSnapshot>): void {
  for (const [unit, state] of snapshot) {
    unit.skills = [...state.skills];
    unit.currentMana = state.currentMana;
    for (const [skill, data] of state.data) skill.data = new Map(data);
  }
}

/**
 * Python's RecordRandomState plus the charge/temporary-skill mutations performed
 * before CombatResultAction begins. The first execute is a no-op because the
 * solver has already applied the transition; redo restores the exact after-state.
 */
export class CombatLifecycleRecord extends Action {
  private units: UnitObject[];
  private randomGame: RandomGameState | null;
  private beforeSkills: Map<UnitObject, SkillSnapshot>;
  private afterSkills: Map<UnitObject, SkillSnapshot> | null = null;
  private beforeRandom: number | null;
  private afterRandom: number | null = null;
  private firstExecute: boolean = true;

  constructor(units: UnitObject[], randomGame: RandomGameState | null) {
    super();
    this.units = [...new Set(units)];
    this.randomGame = randomGame;
    this.beforeSkills = captureSkills(this.units);
    this.beforeRandom = randomGame ? getCombatRandomState(randomGame) : null;
  }

  finish(): void {
    this.afterSkills = captureSkills(this.units);
    this.afterRandom = this.randomGame ? getCombatRandomState(this.randomGame) : null;
  }

  execute(): void {
    if (!this.afterSkills) throw new Error('CombatLifecycleRecord was not finished');
    if (this.firstExecute) {
      this.firstExecute = false;
      return;
    }
    restoreSkills(this.afterSkills);
    if (this.randomGame && this.afterRandom !== null) {
      setCombatRandomState(this.randomGame, this.afterRandom);
    }
  }

  reverse(): void {
    restoreSkills(this.beforeSkills);
    if (this.randomGame && this.beforeRandom !== null) {
      setCombatRandomState(this.randomGame, this.beforeRandom);
    }
  }
}

function isEnemy(db: Database, unit: UnitObject, target: UnitObject): boolean {
  return checkEnemy(unit, target, db);
}

/** Runtime implementation of LT's start/end combat and sub-combat proc hooks. */
export class CombatSkillLifecycle {
  readonly marks: CombatProcMark[] = [];
  private db: Database;
  private roll: () => number;
  private game: any;
  private preProcs: ActiveProc[] = [];
  private combatConditionSkills: Set<SkillObject> = new Set();

  constructor(db: Database, roll: () => number, game?: any) {
    this.db = db;
    this.roll = roll;
    this.game = game;
  }

  private evaluateSkillExpression(
    expression: string,
    unit: UnitObject,
    target: UnitObject | null,
    item: ItemObject | null,
    item2: ItemObject | null,
    mode: string,
    skill: SkillObject,
  ): boolean {
    const distance = (left: [number, number] | null, right: [number, number] | null) => {
      if (!left || !right) return 0;
      return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]);
    };
    const weaponType = (_unit: UnitObject, value: ItemObject | null) => value?.getWeaponType() ?? null;
    const jsExpression = expression
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
      .replace(/\band\b/g, '&&')
      .replace(/\bor\b/g, '||')
      .replace(/\bnot\b/g, '!')
      .replace(/utils\.calculate_distance/g, 'distance')
      .replace(/item_system\.weapon_type/g, 'weaponType');
    try {
      const fn = new Function(
        'unit', 'unit2', 'target', 'item', 'item2', 'mode', 'skill', 'distance', 'weaponType',
        `"use strict"; return !!(${jsExpression});`,
      );
      return !!fn(unit, target, target, item, item2, mode, skill, distance, weaponType);
    } catch {
      return evaluateCondition(expression, {
        game: this.game,
        unit1: unit,
        unit2: target,
        position: unit.position ?? undefined,
        item,
        gameVars: this.game?.gameVars,
        levelVars: this.game?.levelVars,
        localArgs: new Map<string, any>([
          ['item2', item2], ['mode', mode], ['skill', skill],
        ]),
      });
    }
  }

  private prepareCombatConditions(
    unit: UnitObject,
    item: ItemObject | null,
    target: UnitObject | null,
    item2: ItemObject | null,
    mode: string,
  ): void {
    for (const skill of unit.skills) {
      const expression = skill.getComponent<string>('combat_condition');
      if (!expression) continue;
      skill.data.set(
        '_combat_condition',
        this.evaluateSkillExpression(expression, unit, target, item, item2, mode, skill),
      );
      this.combatConditionSkills.add(skill);
    }
  }

  private active(skill: SkillObject, unit: UnitObject, item: ItemObject | null): boolean {
    const parent = skill.data.get('multiSkillSource');
    if (parent instanceof SkillObject && !this.active(parent, unit, item)) return false;
    if (skill.hasComponent('combat_condition') && !skill.data.get('_combat_condition')) return false;
    if (skill.hasComponent('build_charge')) {
      const charge = Number(skill.data.get('charge') ?? 0);
      const total = Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
      if (charge < total) return false;
    }
    if (hasDrainingCharge(skill)) {
      if (Number(skill.data.get('charge') ?? 0) <= 0) return false;
    }
    const mana = Number(unit.currentMana ?? 0);
    const requiredMana = skill.getComponent<number>('cost_mana') ??
      skill.getComponent<number>('check_mana');
    if (typeof requiredMana === 'number' && mana < requiredMana) return false;
    if (!selfNihilActive(skill, unit)) return false;
    const condition = skill.getComponent<string>('condition');
    if (condition && !this.evaluateSkillExpression(
      condition, unit, null, item, null, '', skill,
    )) return false;
    return true;
  }

  private maximumMana(unit: UnitObject): number {
    return Math.max(0, Math.trunc(evaluateEquation(
      this.db.getEquation('MANA') ?? '0',
      unit,
      { db: this.db },
    )));
  }

  private applyStartCombatResources(
    unit: UnitObject,
    item: ItemObject | null,
    target: UnitObject,
  ): void {
    for (const skill of unit.skills) {
      if (!this.active(skill, unit, item)) continue;
      for (const [component, rawValue] of skill.components) {
        if (component === 'gain_mana' && typeof rawValue === 'string') {
          const amount = Number(evaluateExpression(rawValue, {
            game: this.game,
            unit1: unit,
            unit2: target,
            item,
            position: unit.position ?? undefined,
            gameVars: this.game?.gameVars,
            levelVars: this.game?.levelVars,
            localArgs: new Map([['skill', skill]]),
          }));
          if (Number.isFinite(amount)) {
            unit.currentMana = Math.max(
              0,
              Math.min(this.maximumMana(unit), Number(unit.currentMana ?? 0) + Math.trunc(amount)),
            );
          }
        } else if (component === 'cost_mana' && typeof rawValue === 'number') {
          unit.currentMana = Math.max(0, Number(unit.currentMana ?? 0) - Math.trunc(rawValue));
        }
      }
    }
  }

  private weaponAllowed(skill: SkillObject, unit: UnitObject, item: ItemObject | null): boolean {
    const expression = skill.getComponent<string>('allowed_weapons');
    if (!expression) return true;
    return this.evaluateSkillExpression(expression, unit, null, item, null, '', skill);
  }

  private procRate(
    skill: SkillObject,
    unit: UnitObject,
    target: UnitObject,
    targetAware: boolean,
  ): number {
    const targetExpression = targetAware
      ? skill.getComponent<string>('eval_proc_rate')
      : null;
    if (typeof targetExpression === 'string') {
      const value = evaluateExpression(
        targetExpression.replace(/\bint\s*\(/g, 'Math.trunc('),
        {
          game: this.game,
          unit1: unit,
          unit2: target,
          position: unit.position ?? undefined,
          gameVars: this.game?.gameVars,
          levelVars: this.game?.levelVars,
          localArgs: new Map([['skill', skill]]),
        },
      );
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
    }
    const rate = skill.getComponent<number | string>('proc_rate');
    if (typeof rate === 'number') return rate;
    if (typeof rate === 'string') {
      const expression = this.db.getEquation(rate) ?? rate;
      return evaluateEquation(expression, unit, { db: this.db });
    }
    return 100;
  }

  private applyItemOverride(unit: UnitObject, item: ItemObject | null, procSkill: SkillObject): ItemOverlay | null {
    const overrideNid = procSkill.getComponent<string>('item_override');
    const prefab = overrideNid ? this.db.items.get(overrideNid) : null;
    if (!item || !prefab) return null;
    const values = new Map<string, { existed: boolean; value: any }>();
    for (const [nid, value] of prefab.components) {
      values.set(nid, { existed: item.components.has(nid), value: item.components.get(nid) });
      item.components.set(nid, value);
    }
    return { item, values };
  }

  private restoreItemOverride(overlay: ItemOverlay | null): void {
    if (!overlay) return;
    for (const [nid, previous] of overlay.values) {
      if (previous.existed) overlay.item.components.set(nid, previous.value);
      else overlay.item.components.delete(nid);
    }
  }

  private activate(
    kind: ProcKind,
    unit: UnitObject,
    item: ItemObject | null,
    target: UnitObject,
    forcedParents?: SkillObject[],
  ): ActiveProc[] {
    const candidates = forcedParents ?? [...unit.skills];
    const activated: ActiveProc[] = [];
    for (const parentSkill of candidates) {
      let procNid = parentSkill.getComponent<string>(kind);
      let targetAware = false;
      if (!procNid && kind === 'defense_proc') {
        procNid = parentSkill.getComponent<string>('defense_proc_with_target');
        targetAware = !!procNid;
      }
      if (!procNid || !isEnemy(this.db, unit, target)) continue;
      if (!forcedParents) {
        if (!this.active(parentSkill, unit, item) || !this.weaponAllowed(parentSkill, unit, item)) continue;
        if (this.roll() >= this.procRate(parentSkill, unit, target, targetAware)) continue;
      }
      const prefab = this.db.skills.get(procNid);
      if (!prefab) continue;
      const procSkill = new SkillObject(prefab);
      unit.skills.push(procSkill);
      const active: ActiveProc = {
        kind,
        unit,
        parentSkill,
        procSkill,
        overlay: this.applyItemOverride(unit, item, procSkill),
        consumeCharge: !forcedParents,
      };
      // Grouped splash targets reuse the initiating attack proc. They need the
      // same temporary effect for calculation, but Python emits one playback
      // mark for the surrounding attacker phase rather than one per target.
      if (!forcedParents) this.marks.push(active);
      activated.push(active);
    }
    return activated;
  }

  private triggerCharge(active: ActiveProc): void {
    if (!active.consumeCharge) return;
    const skill = active.parentSkill;
    if (skill.hasComponent('build_charge')) {
      skill.data.set('charge', 0);
    } else if (hasDrainingCharge(skill)) {
      consumeMiracleCharge(skill, active.unit, this.game);
    }
  }

  private deactivate(active: ActiveProc): void {
    this.restoreItemOverride(active.overlay);
    const index = active.unit.skills.indexOf(active.procSkill);
    if (index >= 0) active.unit.skills.splice(index, 1);
    this.triggerCharge(active);
  }

  beginCombat(
    attacker: UnitObject,
    item: ItemObject,
    defenders: UnitObject[],
    defenseItems: Map<UnitObject, ItemObject | null>,
  ): void {
    for (const parentSkill of attacker.skills) {
      if (!parentSkill.hasComponent('combat_art') || parentSkill.data.get('active') !== true) {
        continue;
      }
      const procSkill = attacker.skills.find((candidate) =>
        candidate.data.get('combatArtSource') === parentSkill);
      if (procSkill) {
        this.marks.push({
          kind: 'attack_pre_proc',
          unit: attacker,
          parentSkill,
          procSkill,
        });
      }
    }
    const mainTarget = defenders[0];
    this.prepareCombatConditions(
      attacker,
      item,
      mainTarget ?? null,
      mainTarget ? defenseItems.get(mainTarget) ?? null : null,
      'attack',
    );
    for (const defender of defenders) {
      this.prepareCombatConditions(
        defender,
        defenseItems.get(defender) ?? null,
        attacker,
        item,
        'defense',
      );
    }
    if (mainTarget) this.applyStartCombatResources(attacker, item, mainTarget);
    for (const defender of defenders) {
      this.applyStartCombatResources(
        defender,
        defenseItems.get(defender) ?? null,
        attacker,
      );
    }
    if (mainTarget) {
      this.preProcs.push(...this.activate('attack_pre_proc', attacker, item, mainTarget));
    }
    for (const defender of defenders) {
      this.preProcs.push(...this.activate(
        'defense_pre_proc',
        defender,
        defenseItems.get(defender) ?? null,
        attacker,
      ));
    }
  }

  beginStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    forcedAttack?: CombatProcMark[],
  ): { attack: ActiveProc[]; defense: ActiveProc[] } {
    const attack = this.activate(
      'attack_proc', striker, item, target, forcedAttack?.map((mark) => mark.parentSkill),
    );
    const defenseItem = target.items.find((candidate) => candidate.isWeapon()) ?? null;
    const defense = this.activate('defense_proc', target, defenseItem, striker);
    return { attack, defense };
  }

  endStrike(active: { attack: ActiveProc[]; defense: ActiveProc[] }): void {
    // Python removes the defending proc first, then the attacking proc.
    for (const proc of [...active.defense].reverse()) this.deactivate(proc);
    for (const proc of [...active.attack].reverse()) this.deactivate(proc);
  }

  endCombat(strikes: CombatStrike[]): void {
    for (const proc of [...this.preProcs].reverse()) this.deactivate(proc);
    this.preProcs = [];

    const marksByUnit = new Set(strikes
      .filter((strike) => strike.hit || this.db.getConstant('miss_wexp', false))
      .map((strike) => strike.attacker));
    for (const unit of new Set(strikes.flatMap((strike) => [strike.attacker, strike.defender]))) {
      if (!marksByUnit.has(unit)) continue;
      for (const skill of unit.skills) {
        if (skill.data.get('active')) continue;
        const total = Number(skill.data.get('total_charge'));
        if (!Number.isFinite(total)) continue;
        const flat = skill.getComponent<number>('combat_charge_increase');
        const stat = skill.getComponent<string>('combat_charge_increase_by_stat');
        const amount = typeof flat === 'number'
          ? flat
          : stat ? unit.getStatValue(stat) : 0;
        if (amount) {
          skill.data.set('charge', Math.min(total, Number(skill.data.get('charge') ?? 0) + amount));
        }
      }
    }
    // End-combat hooks run after the solver returns. Keep Python's
    // start-combat condition snapshot alive until that external lifecycle
    // stage consumes it; applyCombatSkillEndHooks performs the cleanup.
    this.combatConditionSkills.clear();
  }
}
