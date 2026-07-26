import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import * as calcs from './combat-calcs';
import * as skillSystem from './skill-system';
import {
  damageOnMiss,
  extraDamage,
  hasDamageOnMiss,
  solomonHpChange,
} from './item-system';
import {
  CombatSkillLifecycle,
  type CombatProcMark,
} from './combat-skill-lifecycle';
import { AddSkillAction, RemoveSkillAction } from '../engine/action';
import { evaluateExpression } from '../events/event-manager';

// ============================================================
// CombatPhaseSolver - Resolves a full combat encounter into a
// sequence of strikes.
// Matches LT's CombatPhaseSolver from app/engine/combat/solver.py
// Now with vantage, desperation, and full skill dispatch.
// ============================================================

export type RngMode = 'classic' | 'true_hit' | 'true_hit_plus' | 'fates_hit' | 'grandmaster';
export type CombatMode = 'attack' | 'defense' | 'splash';

export interface CombatStrike {
  attacker: UnitObject;
  defender: UnitObject;
  item: ItemObject;
  hit: boolean;
  crit: boolean;
  damage: number;
  /** Separate EotF non-critical damage instance applied after normal damage. */
  extraDamage?: number;
  isCounter: boolean;
  /** True for an attack-stance partner strike (half damage). */
  assist?: boolean;
  /** True when a full guard gauge negated this strike. */
  guarded?: boolean;
  /**
   * True when the roll landed in the "glancing" band just above the
   * to-hit threshold (solver.py: `roll >= unclamped_hit - glancing_hit`),
   * dealing half damage instead of a normal hit. Gated by the
   * `glancing_hit` DB constant (default 0 = feature off). Mutually
   * exclusive with `crit`.
   */
  glancing?: boolean;
  mode?: CombatMode;
  attackInfo: [number, number];
  attackProcs?: CombatProcMark[];
  defenseProcs?: CombatProcMark[];
  /** Rekka project-local lethal-strike prevention hook consumed by this strike. */
  survivalProc?: skillSystem.CustomSurvivalSkill;
  /** Net self HP change from skill after_strike hooks, applied in strike order. */
  selfSkillHpChange?: number;
  /** Defender healing appended by after_take_strike hooks after strike damage. */
  defenderSkillHpChange?: number;
  /** Ally HP changes from skill after_strike hooks, applied in strike order. */
  allySkillHpChanges?: Array<{ unit: UnitObject; amount: number }>;
  /** Damage rewritten to a cover unit by EotF after_take_strike hooks. */
  redirectedDamage?: Array<{ unit: UnitObject; amount: number }>;
  /** Skill snapshots retained for event dispatch after immediate mutations. */
  attackHookSkills?: SkillObject[];
  defenseHookSkills?: SkillObject[];
}

type DeferredStrikeSkillMutation =
  | {
    kind: 'add';
    unit: UnitObject;
    sourceSkill: SkillObject;
    skillNid: string;
  }
  | {
    kind: 'remove';
    unit: UnitObject;
    skill: SkillObject;
  };

/** Valid CombatScript tokens for interact_unit. */
export type ScriptToken = 'hit1' | 'hit2' | 'crit1' | 'crit2' | 'miss1' | 'miss2' | '--' | 'end';

export class CombatPhaseSolver {
  private strikes: CombatStrike[];
  private randomRoll: () => number;
  private lifecycle: CombatSkillLifecycle | null = null;
  private combatDb: Database | null = null;
  private phaseCounts: Map<UnitObject, number> = new Map();
  readonly procPlayback: CombatProcMark[] = [];
  readonly guardGaugeResults: Map<UnitObject, number> = new Map();
  /**
   * Units saved from death at the very end of this combat by a 'miracle'
   * skill (Python cleanup_combat: SetHP(1) + TriggerCharge). Populated only
   * after all strikes have resolved, mirroring Python's post-combat cleanup
   * rather than a mid-combat clamp. Consumers (e.g. MapCombat.computeResults)
   * should treat a unit in this set as surviving at 1 HP instead of dying.
   */
  readonly miracleSaved: Set<UnitObject> = new Set();
  readonly miracleRestoreHp: Map<UnitObject, number> = new Map();
  private customSurvivalTriggered: Set<SkillObject> = new Set();
  /** Simulated HP for non-target cover units across precomputed strikes. */
  private coverHps: Map<UnitObject, number> = new Map();

  constructor(randomRoll?: () => number, game?: any) {
    this.strikes = [];
    this.randomRoll = randomRoll ?? (() => Math.floor(Math.random() * 100));
    this.game = game;
  }

  private game: any;

  private beginLifecycle(
    db: Database,
    attacker: UnitObject,
    attackItem: ItemObject,
    defenders: UnitObject[],
    defenseItems: Map<UnitObject, ItemObject | null>,
  ): void {
    this.combatDb = db;
    this.phaseCounts.clear();
    this.procPlayback.length = 0;
    this.guardGaugeResults.clear();
    this.miracleSaved.clear();
    this.miracleRestoreHp.clear();
    this.customSurvivalTriggered.clear();
    this.coverHps.clear();
    for (const unit of [attacker, ...defenders]) {
      this.guardGaugeResults.set(unit, unit.getGuardGauge());
    }
    this.lifecycle = new CombatSkillLifecycle(db, this.randomRoll, this.game);
    this.lifecycle.beginCombat(attacker, attackItem, defenders, defenseItems);
  }

  private finishLifecycle(strikes: CombatStrike[]): void {
    if (!this.lifecycle) return;
    this.lifecycle.endCombat(strikes);
    this.procPlayback.push(...this.lifecycle.marks);
    this.lifecycle = null;
  }

  /**
   * Python cleanup_combat: at the very end of the whole combat (after all
   * strikes, including doubles/desperation/vantage), any unit at <= 0 HP
   * with an available 'miracle' skill is resurrected at 1 HP and the
   * skill's charge (if any) is consumed. Called once per resolved combat
   * for each participant that took damage.
   */
  private applyMiracleCleanup(unit: UnitObject, hp: { hp: number }): void {
    if (hp.hp > 0) return;
    const miracle = skillSystem.miracleSkill(unit);
    if (!miracle) return;
    skillSystem.consumeMiracleCharge(miracle.skill, unit, this.game);
    hp.hp = miracle.full ? unit.maxHp : 1;
    this.miracleSaved.add(unit);
    this.miracleRestoreHp.set(unit, hp.hp);
  }

  /** Apply one strike to a simulated HP reference, including Rekka survival hooks. */
  private applyStrikeDamage(
    target: UnitObject,
    hp: { hp: number },
    strike: CombatStrike,
    ignoreDying: boolean = false,
  ): void {
    if (!strike.hit && !hasDamageOnMiss(strike.item)) {
      strike.selfSkillHpChange = 0;
      this.applyPostStrikeSkillEffects(target, strike, hp.hp);
      return;
    }
    const before = hp.hp;
    const totalDamage = strike.damage + (strike.extraDamage ?? 0);
    const proc = totalDamage > 0
      ? skillSystem.damagePreventionSkill(
        target,
        before - totalDamage <= 0,
        this.customSurvivalTriggered,
        this.game,
      )
      : null;
    if (proc) {
      if (proc.component === 'ignore_damage') {
        strike.damage = 0;
        strike.extraDamage = 0;
      } else {
        const survivableDamage = Math.max(0, before - 1);
        strike.damage = Math.min(strike.damage, survivableDamage);
        strike.extraDamage = Math.min(
          strike.extraDamage ?? 0,
          Math.max(0, survivableDamage - strike.damage),
        );
      }
      strike.survivalProc = proc;
      strike.defenseProcs = [
        ...(strike.defenseProcs ?? []),
        { kind: 'defense_proc', unit: target, parentSkill: proc.skill, procSkill: proc.skill },
      ];
      this.customSurvivalTriggered.add(proc.skill);
      this.applySelfLifelink(
        strike,
        Math.max(
          0,
          Math.min(before, strike.damage + (strike.extraDamage ?? 0)),
        ),
      );
      this.applyPostStrikeSkillEffects(target, strike, before);
      const resolvedDamage = strike.damage + (strike.extraDamage ?? 0);
      hp.hp = ignoreDying && before - resolvedDamage <= 0
        ? 1
        : Math.min(
            target.maxHp,
            before - resolvedDamage + (strike.defenderSkillHpChange ?? 0),
          );
      return;
    }
    this.applySelfLifelink(
      strike,
      Math.max(0, Math.min(before, strike.damage)),
    );
    this.applyPostStrikeSkillEffects(target, strike, before);
    const resolvedDamage = strike.damage + (strike.extraDamage ?? 0);
    hp.hp = ignoreDying && before - resolvedDamage <= 0
      ? 1
      : Math.min(
          target.maxHp,
          before - resolvedDamage + (strike.defenderSkillHpChange ?? 0),
        );
  }

  private evaluatedExtraDamage(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    hit: boolean,
    guarded: boolean,
    glancing: boolean,
    grandmasterHit?: number,
    mode: 'attack' | 'defense' | 'splash' = 'attack',
    attackInfo: [number, number] = [0, 0],
  ): number {
    if (!hit || guarded || glancing ||
        target.tags.includes('IgnoringDamage') ||
        skillSystem.additionalTags(target, this.game).has('IgnoringDamage')) return 0;
    const itemValue = item.hasComponent('eval_extra_damage')
      ? extraDamage(striker, item, this.game)
      : 0;
    const defenseItem = target.items.find((candidate) => candidate.isWeapon()) ?? null;
    const skillValue = skillSystem.evaluatedExtraDamage(
      striker, item, target, defenseItem, mode, attackInfo, itemValue, this.game,
    );
    let value = Math.max(0, itemValue + skillValue);
    if (grandmasterHit !== undefined) value = Math.trunc(value * grandmasterHit / 100);
    return value;
  }

  private combatSkillActive(
    unit: UnitObject,
    skill: SkillObject,
    strike: CombatStrike,
  ): boolean {
    if (skill.hasComponent('combat_condition') &&
        !skill.data.get('_combat_condition')) return false;
    if (skill.hasComponent('build_charge') &&
        Number(skill.data.get('charge') ?? 0) <
          Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0)) {
      return false;
    }
    if (skillSystem.hasDrainingCharge(skill) &&
        Number(skill.data.get('charge') ?? 0) <= 0) return false;
    return skillSystem.skillConditionActive(skill, unit, {
      game: this.game,
      item: unit === strike.attacker ? strike.item : unit.equippedWeapon,
      target: unit === strike.attacker ? strike.defender : strike.attacker,
    });
  }

  private grantImmediateSkills(
    recipient: UnitObject,
    source: UnitObject | null,
    sourceSkill: SkillObject,
    skillNids: unknown[],
    consumeCharge: boolean = true,
  ): void {
    const db = this.game?.db;
    if (!db) return;
    let attempted = false;
    for (const skillNid of skillNids) {
      if (typeof skillNid !== 'string') continue;
      const prefab = db.skills.get(skillNid);
      if (!prefab) continue;
      const granted = new SkillObject(prefab);
      if (source) granted.initiatorNid = source.nid;
      new AddSkillAction(recipient, granted).execute();
      attempted = true;
    }
    if (attempted && consumeCharge) {
      skillSystem.consumeMiracleCharge(
        sourceSkill,
        source ?? recipient,
        this.game,
      );
    }
  }

  /** Execute item on-hit status actions before the next strike is calculated. */
  private grantImmediateItemSkills(
    recipient: UnitObject,
    source: UnitObject,
    skillNids: unknown[],
  ): void {
    const db = this.game?.db ?? this.combatDb;
    if (!db) return;
    for (const skillNid of skillNids) {
      if (typeof skillNid !== 'string') continue;
      const prefab = db.skills.get(skillNid);
      if (!prefab) continue;
      const granted = new SkillObject(prefab);
      granted.initiatorNid = source.nid;
      new AddSkillAction(recipient, granted).execute();
    }
  }

  private evaluateSkillNumber(
    expression: string,
    strike: CombatStrike,
    skill: SkillObject,
  ): number {
    try {
      const value = evaluateExpression(expression, {
        game: this.game,
        unit1: strike.attacker,
        unit2: strike.defender,
        position: strike.attacker.position ?? undefined,
        item: strike.item,
        gameVars: this.game?.gameVars,
        levelVars: this.game?.levelVars,
        localArgs: new Map<string, unknown>([
          ['item2', strike.defender.equippedWeapon],
          ['mode', strike.mode ?? (strike.isCounter ? 'defense' : 'attack')],
          ['skill', skill],
        ]),
      });
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
    } catch (error) {
      console.error(`Could not evaluate lifelink component ${expression}`, error);
      return 0;
    }
  }

  private applySelfLifelink(strike: CombatStrike, trueDamage: number): void {
    strike.selfSkillHpChange = 0;
    strike.allySkillHpChanges = [];
    if (!strike.hit) return;
    for (const skill of [...strike.attacker.skills]) {
      if (!this.combatSkillActive(strike.attacker, skill, strike)) continue;
      const apply = (
        amount: number,
        triggerAtZero: boolean = false,
        useHealModifiers: boolean = false,
      ): void => {
        const adjusted = useHealModifiers
          ? skillSystem.modifiedHealAmount(
            amount,
            strike.attacker,
            strike.attacker,
            this.game,
          )
          : amount;
        if (adjusted === 0 && !triggerAtZero) return;
        strike.selfSkillHpChange = (strike.selfSkillHpChange ?? 0) + adjusted;
        skillSystem.consumeMiracleCharge(skill, strike.attacker, this.game);
      };
      const lifelink = skill.getComponent<unknown>('lifelink');
      if (typeof lifelink === 'number') {
        apply(Math.trunc(trueDamage * lifelink), true);
      }
      const unbounded = skill.getComponent<unknown>('shitty_lifelink');
      if (typeof unbounded === 'number') {
        apply(Math.trunc(strike.damage * unbounded), false, true);
      }
      const evaluated = skill.getComponent<unknown>('eval_lifelink');
      if (typeof evaluated === 'string') {
        apply(this.evaluateSkillNumber(evaluated, strike, skill), false, true);
      }
      const onCrit = skill.getComponent<unknown>('lifelink_on_crit');
      if (strike.crit && typeof onCrit === 'number') {
        apply(Math.trunc(trueDamage * onCrit), false, true);
      }
      const grantAllies = (
        percentage: number,
        center: UnitObject,
        range: number,
        includeSelf: boolean,
      ): void => {
        const amount = Math.trunc(trueDamage * percentage);
        if (amount <= 0 || !center.position) return;
        let granted = 0;
        for (const candidate of this.game?.units?.values?.() ?? []) {
          if (!candidate.position) continue;
          if (candidate === strike.attacker && !includeSelf) continue;
          if (!skillSystem.checkAlly(strike.attacker, candidate, this.game.db)) continue;
          if (this.game.board?.getUnit(
            candidate.position[0],
            candidate.position[1],
          ) !== candidate) continue;
          const distance =
            Math.abs(candidate.position[0] - center.position[0]) +
            Math.abs(candidate.position[1] - center.position[1]);
          if (distance > range) continue;
          strike.allySkillHpChanges!.push({
            unit: candidate,
            amount: skillSystem.modifiedHealAmount(
              amount,
              candidate,
              strike.attacker,
              this.game,
            ),
          });
          granted++;
        }
        if (granted > 0) {
          skillSystem.consumeMiracleCharge(skill, strike.attacker, this.game);
        }
      };
      const adjacent = skill.getComponent<unknown>('ally_lifelink');
      if (typeof adjacent === 'number') {
        grantAllies(adjacent, strike.attacker, 1, false);
      }
      const targetAdjacent = skill.getComponent<unknown>('ally_lifelink_target');
      if (typeof targetAdjacent === 'number') {
        grantAllies(targetAdjacent, strike.defender, 1, false);
      }
      const ranged = skill.getComponent<unknown>('ally_lifelink_ranged');
      if (ranged && typeof ranged === 'object') {
        const option = (key: string): unknown => ranged instanceof Map
          ? ranged.get(key)
          : (ranged as Record<string, unknown>)[key];
        const percentage = Number(option('percentage') ?? 0.5);
        const range = Math.max(0, Math.trunc(Number(option('range') ?? 1)));
        grantAllies(
          Number.isFinite(percentage) ? percentage : 0.5,
          strike.attacker,
          Number.isFinite(range) ? range : 1,
          option('include self?') === true,
        );
      }
    }
  }

  private applyPostStrikeSkillEffects(
    target: UnitObject,
    strike: CombatStrike,
    targetHpBefore: number,
  ): void {
    const deferredMutations: DeferredStrikeSkillMutation[] = [];
    strike.redirectedDamage = [];
    if (strike.hit) {
      const status = strike.item.getComponent<unknown>('status_on_hit');
      const selfStatus = strike.item.getComponent<unknown>('self_status_on_hit');
      const statuses = strike.item.getComponent<unknown>('statuses_on_hit');
      const allyBuff = strike.item.getComponent<unknown>('buff_ally');
      this.grantImmediateItemSkills(
        strike.defender,
        strike.attacker,
        [
          status,
          allyBuff,
          ...(Array.isArray(statuses) ? statuses : []),
        ],
      );
      this.grantImmediateItemSkills(
        strike.attacker,
        strike.attacker,
        [selfStatus],
      );

      const option = (value: unknown, key: string): unknown => {
        if (!value || typeof value !== 'object') return undefined;
        return value instanceof Map
          ? value.get(key)
          : (value as Record<string, unknown>)[key];
      };
      for (const [component, recipient] of [
        ['stacks_on_hit', strike.defender],
        ['self_stacks_on_hit', strike.attacker],
      ] as const) {
        const value = strike.item.getComponent<unknown>(component);
        const skill = option(value, 'skill');
        const amount = Math.max(0, Math.trunc(Number(option(value, 'amount') ?? 1)));
        this.grantImmediateItemSkills(
          recipient,
          strike.attacker,
          Array.from({ length: amount }, () => skill),
        );
      }

    }

    const attackHookSkills = [...strike.attacker.skills];
    strike.attackHookSkills = attackHookSkills;
    for (const sourceSkill of attackHookSkills) {
      if (!this.combatSkillActive(strike.attacker, sourceSkill, strike)) continue;
      for (const [component, value] of sourceSkill.components) {
        if (component === 'give_status_after_hit' && strike.hit) {
          this.grantImmediateSkills(
            strike.defender,
            strike.attacker,
            sourceSkill,
            [value],
          );
        } else if (component === 'gain_on_strike' && typeof value === 'string') {
          // EotF calls action.do(AddSkill) without an initiator or charge.
          this.grantImmediateSkills(
            strike.attacker,
            null,
            sourceSkill,
            [value],
            false,
          );
        } else if (component === 'lost_on_strike') {
          // Python appends this action until the current strike resolves.
          deferredMutations.push({
            kind: 'remove',
            unit: strike.attacker,
            skill: sourceSkill,
          });
        } else if (
          typeof value === 'string' &&
          ((component === 'gain_on_hit' && strike.hit) ||
            (component === 'gain_on_miss' && !strike.hit))
        ) {
          deferredMutations.push({
            kind: 'add',
            unit: strike.attacker,
            sourceSkill,
            skillNid: value,
          });
        }
      }
    }

    const defenseHookSkills = [...target.skills];
    strike.defenseHookSkills = defenseHookSkills;
    for (const sourceSkill of defenseHookSkills) {
      if (!this.combatSkillActive(target, sourceSkill, strike)) continue;
      for (const [component, value] of sourceSkill.components) {
        if (component === 'gain_skill_after_take_miss' &&
            !strike.hit && typeof value === 'string') {
          this.grantImmediateSkills(target, target, sourceSkill, [value]);
        } else if (component === 'gain_skill_after_take_damage' &&
            strike.damage > 0 && typeof value === 'string') {
          this.grantImmediateSkills(target, target, sourceSkill, [value]);
        } else if (component === 'give_status_on_take_hit' &&
            typeof value === 'string') {
          this.grantImmediateSkills(
            strike.attacker,
            target,
            sourceSkill,
            [value],
          );
        } else if (component === 'give_statuses_on_take_hit' &&
            Array.isArray(value) && value.length > 0) {
          this.grantImmediateSkills(
            strike.attacker,
            target,
            sourceSkill,
            value,
          );
        } else if (
          component === 'heal_after_follow_up' &&
          strike.hit &&
          (strike.damage > 0 || (strike.extraDamage ?? 0) > 0) &&
          strike.attackInfo[0] > 0 &&
          targetHpBefore >
            (strike.damage > 0 ? strike.damage : (strike.extraDamage ?? 0))
        ) {
          const baseAmount = Math.trunc(Number(value));
          if (Number.isFinite(baseAmount)) {
            strike.defenderSkillHpChange =
              (strike.defenderSkillHpChange ?? 0) +
              skillSystem.modifiedHealAmount(
                baseAmount,
                target,
                target,
                this.game,
              );
            skillSystem.consumeMiracleCharge(sourceSkill, target, this.game);
          }
        } else if (
          component === 'lost_on_take_hit' &&
          strike.hit &&
          !strike.guarded &&
          this.combatDb &&
          skillSystem.checkEnemy(target, strike.attacker, this.combatDb)
        ) {
          // EotF uses action.do here: later strikes must no longer receive
          // this skill's defensive contribution.
          new RemoveSkillAction(target, sourceSkill).do();
        } else if (
          (component === 'redirect_damage' ||
            component === 'redirect_partial_damage') &&
          !strike.guarded
        ) {
          const configuredCover = sourceSkill.data.get('cover');
          const coverNid = typeof configuredCover === 'string'
            ? configuredCover
            : sourceSkill.initiatorNid ??
              (typeof sourceSkill.data.get('auraOwnerNid') === 'string'
                ? sourceSkill.data.get('auraOwnerNid')
                : null);
          if (!sourceSkill.data.has('cover')) {
            sourceSkill.data.set('cover', coverNid ?? null);
          }
          const cover = typeof coverNid === 'string'
            ? this.game?.units?.get?.(coverNid) ??
              this.game?.getUnit?.(coverNid)
            : null;
          const coverHp = cover
            ? (this.coverHps.get(cover) ?? cover.currentHp)
            : 0;
          if (!cover || cover.dead || coverHp <= 0) continue;

          const fraction = component === 'redirect_damage'
            ? 1
            : Number(value);
          if (!Number.isFinite(fraction)) continue;
          let redirected = 0;
          const rewrite = (damage: number): number => {
            if (damage <= 0) return damage;
            const coverAmount = Math.trunc(damage * fraction);
            const targetAmount = Math.trunc(damage * (1 - fraction));
            // Python checks each ChangeHP independently against the cover's
            // current HP and requires a strict inequality.
            if (coverAmount <= 0 || coverAmount >= coverHp) return damage;
            redirected += coverAmount;
            strike.redirectedDamage!.push({ unit: cover, amount: coverAmount });
            return targetAmount;
          };
          strike.damage = rewrite(strike.damage);
          if (strike.extraDamage !== undefined) {
            strike.extraDamage = rewrite(strike.extraDamage);
          }
          if (redirected > 0) {
            this.coverHps.set(cover, Math.max(0, coverHp - redirected));
            skillSystem.consumeMiracleCharge(sourceSkill, target, this.game);
          }
        }
      }
    }

    // Python's appended actions execute after both after_strike and
    // after_take_strike dispatch, before the solver advances to the next
    // strike. This is later than action.do hooks but still mid-combat.
    for (const mutation of deferredMutations) {
      if (mutation.kind === 'remove') {
        new RemoveSkillAction(mutation.unit, mutation.skill).do();
      } else {
        this.grantImmediateSkills(
          mutation.unit,
          mutation.unit,
          mutation.sourceSkill,
          [mutation.skillNid],
        );
      }
    }
  }

  private criticalMultiplier(striker: UnitObject, item: ItemObject, db: Database): number {
    const formula = skillSystem.criticalMultiplierFormula(striker);
    if (!formula) return 3;
    const expression = db.getEquation(formula) ?? formula;
    return Math.max(0, calcs.evaluateEquation(expression, striker, { db, item }));
  }

  private nextPhase(unit: UnitObject): number {
    const phase = this.phaseCounts.get(unit) ?? 0;
    this.phaseCounts.set(unit, phase + 1);
    return phase;
  }

  private maxGuardGauge(unit: UnitObject, db: Database): number {
    const expression = db.getEquation('MAX_GUARD');
    if (!expression) return 10;
    const value = calcs.evaluateEquation(expression, unit, { db });
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 10;
  }

  private gaugeIncrease(unit: UnitObject, db: Database): number {
    const expression = db.getEquation('GAUGE_INCREASE');
    if (!expression) return 2;
    const value = calcs.evaluateEquation(expression, unit, { db });
    return Number.isFinite(value) ? Math.trunc(value) : 2;
  }

  private guardGauge(unit: UnitObject): number {
    return this.guardGaugeResults.get(unit) ?? unit.getGuardGauge();
  }

  private setGuardGauge(unit: UnitObject, value: number, db: Database): void {
    this.guardGaugeResults.set(unit, Math.max(0, Math.min(value, this.maxGuardGauge(unit, db))));
  }

  private updateGuardGauges(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
  ): void {
    if (!db.getConstant('pairup', false) || !item.isWeapon() ||
        !skillSystem.checkEnemy(striker, target, db)) return;
    const targetGauge = this.guardGauge(target);
    if (targetGauge >= this.maxGuardGauge(target, db)) {
      this.setGuardGauge(target, 0, db);
    } else if (target.traveler) {
      this.setGuardGauge(target, targetGauge + this.gaugeIncrease(target, db), db);
    }
    if (striker.traveler) {
      this.setGuardGauge(striker, this.guardGauge(striker) + this.gaugeIncrease(striker, db), db);
    }
  }

  /**
   * Resolve a scripted combat encounter (from interact_unit).
   * The script is an ordered list of tokens that control both:
   *   (a) which side strikes next, and
   *   (b) whether the strike is forced hit/crit/miss.
   *
   * Tokens:
   *   hit1/crit1/miss1 → attacker (unit 1) strikes with forced outcome
   *   hit2/crit2/miss2 → defender (unit 2) strikes with forced outcome
   *   '--' → next natural strike (uses normal combat ordering + RNG)
   *   'end' → terminate combat immediately
   *
   * When the script is exhausted, remaining natural strikes play out
   * if there are any.
   */
  private resolveScripted(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    script: string[],
    board?: GameBoard | null,
  ): CombatStrike[] {
    this.strikes = [];
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;
    const atkHp = { hp: attackerHp };
    const defHp = { hp: defenderHp };

    const phases = new Map<UnitObject, number>();
    const partnerUsed = new Set<UnitObject>();
    const limitAttackStance = !!db.getConstant('limit_attack_stance', false);
    const runPartnerPhase = (
      leader: UnitObject,
      target: UnitObject,
      targetHp: { hp: number },
      isCounter: boolean,
      phase: number,
    ): void => {
      const partner = leader.strikePartner;
      if (!partner || partner.currentHp <= 0 || targetHp.hp <= 0) return;
      if (limitAttackStance && partnerUsed.has(leader)) return;
      const partnerItem = partner.items.find((candidate) => candidate.isWeapon());
      if (!partnerItem) return;
      const targetItem = target.items.find((candidate) => candidate.isWeapon()) ?? null;
      const count = calcs.computeStrikeCount(
        partner,
        partnerItem,
        target,
        targetItem,
        isCounter ? 'defense' : 'attack',
      );
      for (let index = 0; index < count && targetHp.hp > 0; index++) {
        const strike = this.resolveStrike(
          partner,
          partnerItem,
          target,
          db,
          rngMode,
          isCounter,
          board,
          isCounter ? 'defense' : 'attack',
          [phase, index],
          undefined,
          true,
        );
        this.strikes.push(strike);
        this.applyStrikeDamage(target, targetHp, strike);
      }
      partnerUsed.add(leader);
    };
    // Process each script token
    for (const rawToken of script) {
      const token = rawToken.toLowerCase().trim();
      if (token === 'end') break;
      if (atkHp.hp <= 0 || defHp.hp <= 0) break;

      if (token === '--') {
        // Natural strike: use normal resolution for the next expected strike.
        // For simplicity, default to attacker if no script context.
        // (In Python this falls through to the state machine's normal logic,
        // but for our pre-computed approach we just do one attacker strike.)
        const phase = phases.get(attacker) ?? 0;
        phases.set(attacker, phase + 1);
        const strike = this.resolveStrike(
          attacker, attackItem, defender, db, rngMode, false, board, 'attack', [phase, 0],
        );
        this.strikes.push(strike);
        this.applyStrikeDamage(defender, defHp, strike);
        runPartnerPhase(attacker, defender, defHp, false, phase);
      } else if (token === 'hit1' || token === 'crit1' || token === 'miss1') {
        // Attacker strikes with forced outcome
        const phase = phases.get(attacker) ?? 0;
        phases.set(attacker, phase + 1);
        const strike = this.resolveScriptedStrike(
          attacker, attackItem, defender, db, false, token, board, 'attack', [phase, 0],
        );
        this.strikes.push(strike);
        this.applyStrikeDamage(defender, defHp, strike);
        runPartnerPhase(attacker, defender, defHp, false, phase);
      } else if (token === 'hit2' || token === 'crit2' || token === 'miss2') {
        // Defender strikes with forced outcome
        if (!defenseItem) continue; // Defender can't strike without a weapon
        const phase = phases.get(defender) ?? 0;
        phases.set(defender, phase + 1);
        const strike = this.resolveScriptedStrike(
          defender, defenseItem, attacker, db, true, token, board, 'defense', [phase, 0],
        );
        this.strikes.push(strike);
        this.applyStrikeDamage(attacker, atkHp, strike);
        runPartnerPhase(defender, attacker, atkHp, true, phase);
      }
    }

    this.applyMiracleCleanup(attacker, atkHp);
    this.applyMiracleCleanup(defender, defHp);

    return this.strikes;
  }

  /**
   * Resolve a single strike with a forced outcome from a script token.
   */
  private resolveScriptedStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
    isCounter: boolean,
    token: string,
    board?: GameBoard | null,
    mode: CombatMode = isCounter ? 'defense' : 'attack',
    attackInfo: [number, number] = [0, 0],
    forcedAttackProcs?: CombatProcMark[],
    assist: boolean = false,
  ): CombatStrike {
    const procs = this.lifecycle?.beginStrike(striker, item, target, forcedAttackProcs) ??
      { attack: [], defense: [] };
    const defWeapon = calcs.getEquippedWeapon(target, db, this.game);
    const wt = calcs.weaponTriangle(item, defWeapon, db, striker, target);

    const guarded = db.getConstant('pairup', false) && item.isWeapon() &&
      skillSystem.checkEnemy(striker, target, db) && !!target.traveler &&
      this.guardGauge(target) >= this.maxGuardGauge(target, db);
    const isMiss = token.startsWith('miss');
    const isCrit = token.startsWith('crit');
    const hit = guarded || !isMiss;
    const crit = !guarded && isCrit;

    let dmg = 0;
    if (!guarded && (hit || hasDamageOnMiss(item))) {
      const baseDmg = calcs.computeDamage(
        striker, item, target, db, board, this.game, mode, assist, attackInfo,
      );
      const normalDamage = baseDmg + wt.damageBonus;
      if (!hit) {
        dmg = damageOnMiss(item, normalDamage) ?? 0;
      } else {
        dmg = normalDamage;
        if (crit) {
          const baseCritMult = this.criticalMultiplier(striker, item, db);
          dmg *= baseCritMult;
          dmg += skillSystem.modifyCritDamage(striker, item, this.game);
          dmg += skillSystem.dynamicCritDamageAddition(
            striker, item, target, defWeapon, mode, attackInfo, dmg, this.game,
          );
        }
        dmg = this.applyCustomHitDamage(item, target, dmg);
      }
      const solomonChange = solomonHpChange(
        striker,
        item,
        target,
        this.game,
      );
      dmg = solomonChange === null ? Math.max(0, dmg) : -solomonChange;
    }

    const strike: CombatStrike = {
      attacker: striker,
      defender: target,
      item,
      hit,
      crit,
      damage: dmg,
      extraDamage: this.evaluatedExtraDamage(
        striker,
        item,
        target,
        hit,
        guarded,
        false,
        this.game?.rngMode === 'grandmaster'
          ? calcs.computeHit(
            striker, item, target, db, board, this.game, mode, attackInfo,
          )
          : undefined,
        mode,
        attackInfo,
      ),
      isCounter,
      assist,
      guarded,
      mode,
      attackInfo,
      ...(procs.attack.length ? { attackProcs: procs.attack } : {}),
      ...(procs.defense.length ? { defenseProcs: procs.defense } : {}),
    };
    this.lifecycle?.endStrike(procs);
    this.updateGuardGauges(striker, item, target, db);
    return strike;
  }

  /**
   * Resolve one Python-shaped main+splash encounter.
   *
   * The main defender follows normal combat ordering and is the only target
   * that can counter. Splash targets are processed immediately after each
   * propagated attacker strike. Unless double_splash is enabled, only the
   * first attacker subattack reaches splash targets.
   */
  resolveGroup(
    attacker: UnitObject,
    attackItem: ItemObject,
    mainDefender: UnitObject | null,
    defenseItem: ItemObject | null,
    splashDefenders: UnitObject[],
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    const splash = [...new Set(splashDefenders)].filter((unit) => unit !== mainDefender);
    if (splash.length === 0 && mainDefender) {
      return this.resolve(attacker, attackItem, mainDefender, defenseItem, db, rngMode, board, script);
    }

    const doubleSplash = !!db.getConstant('double_splash', false);
    const splashHp = new Map(splash.map((unit) => [unit, unit.currentHp]));
    const result: CombatStrike[] = [];
    let propagatedAttacks = 0;

    this.beginLifecycle(
      db,
      attacker,
      attackItem,
      [...(mainDefender ? [mainDefender] : []), ...splash],
      new Map([
        ...(mainDefender ? [[mainDefender, defenseItem] as [UnitObject, ItemObject | null]] : []),
        ...splash.map((unit) => [unit, null] as [UnitObject, ItemObject | null]),
      ]),
    );

    const appendSplash = (
      forcedToken?: string,
      sourceStrike?: CombatStrike,
      explicitAttackInfo?: [number, number],
    ): void => {
      if (!doubleSplash && propagatedAttacks > 0) return;
      let sharedAttackProcs = sourceStrike?.attackProcs;
      for (const target of splash) {
        const hp = splashHp.get(target) ?? 0;
        if (hp <= 0 && !skillSystem.ignoreDyingInCombat(target)) continue;
        const strike = forcedToken
          ? this.resolveScriptedStrike(
            attacker, attackItem, target, db, false, forcedToken, board, 'splash',
            sourceStrike?.attackInfo ?? explicitAttackInfo ?? [propagatedAttacks, 0],
            sharedAttackProcs,
          )
          : this.resolveStrike(
            attacker, attackItem, target, db, rngMode, false, board, 'splash',
            sourceStrike?.attackInfo ?? explicitAttackInfo ?? [propagatedAttacks, 0],
            sharedAttackProcs,
          );
        result.push(strike);
        sharedAttackProcs ??= strike.attackProcs;
        const hpRef = { hp };
        this.applyStrikeDamage(
          target, hpRef, strike, skillSystem.ignoreDyingInCombat(target),
        );
        splashHp.set(target, hpRef.hp);
      }
      propagatedAttacks++;
    };

    if (script && script.length > 0) {
      let attackerHp = attacker.currentHp;
      let defenderHp = mainDefender?.currentHp ?? 0;
      for (const rawToken of script) {
        const token = rawToken.toLowerCase().trim();
        if (token === 'end' || attackerHp <= 0 || (mainDefender && defenderHp <= 0)) break;
        if (token === 'hit2' || token === 'crit2' || token === 'miss2') {
          if (!mainDefender || !defenseItem) continue;
          const phase = this.nextPhase(mainDefender);
          const strike = this.resolveScriptedStrike(
            mainDefender, defenseItem, attacker, db, true, token, board, 'defense', [phase, 0],
          );
          result.push(strike);
          const attackerHpRef = { hp: attackerHp };
          this.applyStrikeDamage(attacker, attackerHpRef, strike);
          attackerHp = attackerHpRef.hp;
          continue;
        }
        const forcedToken = token === '--' ? undefined : token;
        if (mainDefender) {
          const phase = this.nextPhase(attacker);
          const strike = forcedToken
            ? this.resolveScriptedStrike(
              attacker, attackItem, mainDefender, db, false, forcedToken, board, 'attack', [phase, 0],
            )
            : this.resolveStrike(
              attacker, attackItem, mainDefender, db, rngMode, false, board, 'attack', [phase, 0],
            );
          result.push(strike);
          const defenderHpRef = { hp: defenderHp };
          this.applyStrikeDamage(mainDefender, defenderHpRef, strike);
          defenderHp = defenderHpRef.hp;
          appendSplash(forcedToken, strike);
        } else {
          appendSplash(forcedToken, undefined, [this.nextPhase(attacker), 0]);
        }
      }
      this.strikes = result;
      this.finishLifecycle(result);
      return result;
    }

    if (mainDefender) {
      const mainStrikes = [...this.resolveCore(
        attacker, attackItem, mainDefender, defenseItem, db, rngMode, board,
      )];
      for (const strike of mainStrikes) {
        result.push(strike);
        if (strike.attacker === attacker) appendSplash(undefined, strike);
      }
    } else {
      const reference = splash[0];
      if (reference) {
        const strikeCount = doubleSplash
          ? calcs.computeStrikeCount(attacker, attackItem, reference, null)
          : 1;
        const phase = this.nextPhase(attacker);
        for (let idx = 0; idx < strikeCount; idx++) appendSplash(undefined, undefined, [phase, idx]);
      }
    }

    this.strikes = result;
    this.finishLifecycle(result);
    return result;
  }

  resolve(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    this.beginLifecycle(
      db,
      attacker,
      attackItem,
      [defender],
      new Map([[defender, defenseItem]]),
    );
    const strikes = this.resolveCore(
      attacker, attackItem, defender, defenseItem, db, rngMode, board, script,
    );
    this.finishLifecycle(strikes);
    return strikes;
  }

  /**
   * Resolve a complete combat encounter.
   * Returns an ordered array of all strikes that should occur.
   *
   * Standard strike order:
   *   1. Attacker strikes (x brave)
   *   2. Defender counter (if able) (x brave)
   *   3. Attacker double (if speed check passes) (x brave)
   *   4. Defender double counter (if speed + defDouble) (x brave)
   *
   * Modified by:
   *   - Vantage: defender strikes first if they have vantage
   *   - Desperation: attacker does all strikes before counter
   *   - Disvantage: attacker goes second (opposite of vantage)
   *
   * If `script` is provided, uses resolveScripted() instead of
   * the normal combat flow.
   */
  private resolveCore(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    // If a combat script is provided, use scripted resolution
    if (script && script.length > 0) {
      return this.resolveScripted(attacker, attackItem, defender, defenseItem, db, rngMode, script, board);
    }
    this.strikes = [];

    // Track simulated HP for lethality checks (stop attacking dead units)
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;

    // Determine capabilities
    const defenderCanCounterNow = (): boolean =>
      calcs.canCounterattack(attacker, attackItem, defender, db, this.game);
    const attackerDoublesNow = (): boolean =>
      calcs.canDouble(
        attacker, attackItem, defender, defenseItem, db, this.game,
        'attack', [this.phaseCounts.get(attacker) ?? 0, 0],
      );
    const defenderDoublesNow = (): boolean =>
      !!defenseItem && defenderCanCounterNow() &&
      calcs.canDefenderDouble(
        attacker, attackItem, defender, defenseItem, db, this.game,
        [this.phaseCounts.get(defender) ?? 0, 0],
      );
    const defenderCanCounter = defenderCanCounterNow();

    // Compute strike counts (brave weapons, dynamic multiattacks from skills)
    const attackerStrikeCount = (): number => calcs.computeStrikeCount(
      attacker, attackItem, defender, defenseItem,
      'attack', [this.phaseCounts.get(attacker) ?? 0, 0], this.game,
    );
    const defenderStrikeCount = (): number => defenseItem
      ? calcs.computeStrikeCount(
        defender, defenseItem, attacker, attackItem, 'defense',
        [this.phaseCounts.get(defender) ?? 0, 0], this.game,
      )
      : 1;

    // Check for skill-based ordering
    const defenderHasVantage = defenderCanCounter && defenseItem &&
      skillSystem.vantage(defender) && !skillSystem.disvantage(attacker);
    const attackerHasDesperation = skillSystem.desperation(attacker);
    const attackerHasDisvantage = skillSystem.disvantage(attacker) &&
      !skillSystem.vantage(attacker);

    // Check ignoreDyingInCombat (miracle)
    const attackerMiracle = skillSystem.ignoreDyingInCombat(attacker);
    const defenderMiracle = skillSystem.ignoreDyingInCombat(defender);
    const partnerUsed = new Set<UnitObject>();
    const limitAttackStance = !!db.getConstant('limit_attack_stance', false);

    const doPartnerStrikes = (
      leader: UnitObject,
      item: ItemObject,
      target: UnitObject,
      isCounter: boolean,
      targetHpRef: { hp: number },
      targetMiracle: boolean,
      phase: number,
    ): void => {
      const partner = leader.strikePartner;
      if (!partner || partner.currentHp <= 0 || targetHpRef.hp <= 0) return;
      if (limitAttackStance && partnerUsed.has(leader)) return;
      const partnerWeapon = partner.items.find((candidate) => candidate.isWeapon());
      if (!partnerWeapon) return;
      const targetWeapon = target.items.find((candidate) => candidate.isWeapon()) ?? null;
      const count = calcs.computeStrikeCount(
        partner, partnerWeapon, target, targetWeapon, isCounter ? 'defense' : 'attack',
        [phase, 0], this.game,
      );
      for (let index = 0; index < count; index++) {
        if (targetHpRef.hp <= 0) break;
        const strike = this.resolveStrike(
          partner, partnerWeapon, target, db, rngMode, isCounter, board,
          isCounter ? 'defense' : 'attack', [phase, index], undefined, true,
        );
        this.strikes.push(strike);
        this.applyStrikeDamage(target, targetHpRef, strike, targetMiracle);
      }
      partnerUsed.add(leader);
    };

    // Helper: execute a series of strikes for one side
    const doStrikes = (
      striker: UnitObject,
      item: ItemObject,
      target: UnitObject,
      count: number,
      isCounter: boolean,
      strikerHpRef: { hp: number },
      targetHpRef: { hp: number },
      targetMiracle: boolean,
    ) => {
      const phase = this.phaseCounts.get(striker) ?? 0;
      for (let i = 0; i < count; i++) {
        if (targetHpRef.hp <= 0) break;
        if (strikerHpRef.hp <= 0) break;
        const strike = this.resolveStrike(
          striker, item, target, db, rngMode, isCounter, board,
          isCounter ? 'defense' : 'attack', [phase, i],
        );
        this.strikes.push(strike);
        this.applyStrikeDamage(target, targetHpRef, strike, targetMiracle);
      }
      this.phaseCounts.set(striker, phase + 1);
      doPartnerStrikes(striker, item, target, isCounter, targetHpRef, targetMiracle, phase);
    };

    const atkHp = { hp: attackerHp };
    const defHp = { hp: defenderHp };
    const repeatAttacker = (count: number): void => {
      for (let phase = 0; phase < count; phase++) {
        doStrikes(
          attacker, attackItem, defender, attackerStrikeCount(), false,
          atkHp, defHp, defenderMiracle,
        );
      }
    };
    const repeatDefender = (count: number): void => {
      if (!defenseItem) return;
      for (let phase = 0; phase < count; phase++) {
        doStrikes(
          defender, defenseItem, attacker, defenderStrikeCount(), true,
          defHp, atkHp, attackerMiracle,
        );
      }
    };
    const attackerBlitzes = (): number => calcs.computeBlitzPhases(
      attacker, attackItem, defender, defenseItem, 'attack',
      [this.phaseCounts.get(attacker) ?? 0, 0], this.game,
    );
    const defenderBlitzes = (): number => defenseItem
      ? calcs.computeBlitzPhases(
        defender, defenseItem, attacker, attackItem, 'defense',
        [this.phaseCounts.get(defender) ?? 0, 0], this.game,
      )
      : 0;
    const attackerRemaining = (): number => calcs.computeExtraAttackPhases(
      attacker, attackItem, defender, defenseItem, 'attack',
      [this.phaseCounts.get(attacker) ?? 0, 0], this.game,
    ) + (attackerDoublesNow() ? 1 : 0);
    const defenderRemaining = (): number => defenseItem && defenderCanCounterNow()
      ? calcs.computeExtraAttackPhases(
        defender, defenseItem, attacker, attackItem, 'defense',
        [this.phaseCounts.get(defender) ?? 0, 0], this.game,
      ) + (defenderDoublesNow() ? 1 : 0)
      : 0;

    // ---- Determine strike ordering based on skills ----

    if (defenderHasVantage && defenseItem) {
      repeatDefender(1 + defenderBlitzes());
      repeatAttacker(1 + attackerBlitzes());
      if (attackerHasDesperation) {
        repeatAttacker(attackerRemaining());
      } else {
        repeatDefender(defenderRemaining());
        repeatAttacker(attackerRemaining());
      }
      if (attackerHasDesperation) repeatDefender(defenderRemaining());

    } else if (attackerHasDisvantage && defenderCanCounter && defenseItem) {
      repeatDefender(1 + defenderBlitzes());
      repeatAttacker(1 + attackerBlitzes());
      repeatDefender(defenderRemaining());
      repeatAttacker(attackerRemaining());

    } else if (attackerHasDesperation) {
      repeatAttacker(1 + attackerBlitzes());
      repeatAttacker(attackerRemaining());
      if (defenderCanCounterNow() && defenseItem) {
        repeatDefender(1 + defenderBlitzes());
        repeatDefender(defenderRemaining());
      }

    } else {
      repeatAttacker(1 + attackerBlitzes());
      if (defenderCanCounterNow() && defenseItem) {
        repeatDefender(1 + defenderBlitzes());
      }
      repeatAttacker(attackerRemaining());
      repeatDefender(defenderRemaining());
    }

    this.applyMiracleCleanup(attacker, atkHp);
    this.applyMiracleCleanup(defender, defHp);

    return this.strikes;
  }

  /**
   * Roll for hit based on RNG mode.
   *
   * - classic: single RN, random(0..99) < hitChance
   * - true_hit: average of 2 RNs (standard Fire Emblem 2-RN system)
   * - true_hit_plus: average of 3 RNs
   * - grandmaster: solver.py fixes `roll = 0` (no stream draw) and still
   *   compares `roll < to_hit`, so it "always hits" only while the to-hit
   *   value is positive -- a hit chance of exactly 0 (or negative, pre-clamp)
   *   still misses.
   */
  /**
   * solver.py's Fates Hit transform (calculate_fates_hit): maps a 0-100
   * hit chance through a sine-based curve. Exposed separately from
   * rollHitDetailed so glancing-band math can reuse the same "effective"
   * hit value that gated the hit roll.
   */
  private fatesAdjust(hitChance: number): number {
    const clamped = Math.max(0, Math.min(100, hitChance));
    return Math.round(
      clamped + (40 / 3) * (clamped / 100) *
      Math.sin((0.02 * clamped - 1) * Math.PI),
    );
  }

  /**
   * Roll for hit based on RNG mode, returning both the hit/miss result and
   * the raw roll + "effective" hit-chance actually compared against, so
   * callers can additionally derive glancing hits (solver.py: `roll >=
   * unclamped_hit - glancing_hit`) from the same draw.
   *
   * - classic: single RN, random(0..99) < hitChance
   * - true_hit: average of 2 RNs (standard Fire Emblem 2-RN system)
   * - true_hit_plus: average of 3 RNs
   * - fates_hit: single RN compared against the sine-adjusted hit chance
   * - grandmaster: solver.py fixes `roll = 0` (no stream draw) and still
   *   compares `roll < to_hit`, so it "always hits" only while the to-hit
   *   value is positive -- a hit chance of exactly 0 (or negative, pre-clamp)
   *   still misses.
   */
  private rollHitDetailed(
    hitChance: number,
    rngMode: RngMode,
  ): { hit: boolean; roll: number; effectiveHit: number } {
    switch (rngMode) {
      case 'grandmaster':
        return { hit: hitChance > 0, roll: 0, effectiveHit: hitChance };

      case 'true_hit': {
        const r1 = this.randomRoll();
        const r2 = this.randomRoll();
        const roll = Math.floor((r1 + r2) / 2);
        return { hit: roll < hitChance, roll, effectiveHit: hitChance };
      }

      case 'true_hit_plus': {
        const r1 = this.randomRoll();
        const r2 = this.randomRoll();
        const r3 = this.randomRoll();
        const roll = Math.floor((r1 + r2 + r3) / 3);
        return { hit: roll < hitChance, roll, effectiveHit: hitChance };
      }

      case 'fates_hit': {
        const adjusted = this.fatesAdjust(hitChance);
        const roll = this.randomRoll();
        return { hit: roll < adjusted, roll, effectiveHit: adjusted };
      }

      case 'classic':
      default: {
        const roll = this.randomRoll();
        return { hit: roll < hitChance, roll, effectiveHit: hitChance };
      }
    }
  }

  /**
   * Generate a single strike result.
   * Computes hit chance, crit chance, then rolls and determines damage.
   */
  private resolveStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
    rngMode: RngMode,
    isCounter: boolean,
    board?: GameBoard | null,
    mode: CombatMode = isCounter ? 'defense' : 'attack',
    attackInfo: [number, number] = [0, 0],
    forcedAttackProcs?: CombatProcMark[],
    assist: boolean = false,
  ): CombatStrike {
    const procs = this.lifecycle?.beginStrike(striker, item, target, forcedAttackProcs) ??
      { attack: [], defense: [] };
    // Compute hit chance with weapon triangle bonus
    const defWeapon = calcs.getEquippedWeapon(target, db, this.game);
    const baseHit = calcs.computeHit(
      striker, item, target, db, board, this.game, mode, attackInfo,
    );
    const wt = calcs.weaponTriangle(item, defWeapon, db, striker, target);
    const finalHit = Math.max(0, Math.min(100, baseHit + wt.hitBonus));

    // Compute crit chance
    let critChance = calcs.computeCrit(
      striker, item, target, db, this.game, mode, attackInfo,
    );

    // critAnyway skill: ensure at least some crit chance
    if (skillSystem.critAnyway(striker) && critChance <= 0) {
      critChance = 1; // Minimal crit chance if skill is active
    }

    const guarded = db.getConstant('pairup', false) && item.isWeapon() &&
      skillSystem.checkEnemy(striker, target, db) && !!target.traveler &&
      this.guardGauge(target) >= this.maxGuardGauge(target, db);

    // Roll for hit.
    // Python's solver.process() always calls generate_roll() first (consuming
    // the RNG stream for the active mode), then overwrites `roll = -1` for the
    // Pair Up guard case afterward -- the guard doesn't skip the roll, it just
    // discards it. Mirror that ordering so the combat-random stream position
    // stays aligned with Python even when a strike is guarded.
    // Items without a hit hook (Steal, Warp, utility staves) auto-hit in LT
    // and never call generate_roll() at all.
    let hitRoll = true;
    let roll = 0;
    let effectiveHit = finalHit;
    if (item.hasComponent('hit')) {
      const detail = this.rollHitDetailed(finalHit, rngMode);
      hitRoll = detail.hit;
      roll = detail.roll;
      effectiveHit = detail.effectiveHit;
    }
    const hit = guarded || hitRoll;

    // Roll for crit.
    // Python computes `to_crit` and calls generate_crit_roll() whenever the
    // strike hits, regardless of guard_hit -- guard_hit only gates whether the
    // crit *effect* applies (`if crit and not guard_hit:`), not whether the
    // roll happens. Consume the roll first, then discard the result on guard.
    const critRoll = hit ? this.randomRoll() < critChance : false;
    const crit = critRoll && !guarded;

    // Glancing hit: solver.py -- when a strike hits but isn't a crit, and
    // `roll >= unclamped_hit - glancing_hit`, it's a glancing hit (half
    // damage, truncated) instead of a normal one. Gated by the DB constant
    // `glancing_hit` (percent-width of the band, default 0/false = off).
    // Python compares against `unclamped_hit` (compute_hit before the 0-100
    // clamp); this port's computeHit always clamps internally (same
    // approximation already used for Grandmaster's damage scaling above),
    // so `effectiveHit` stands in for it here.
    const glancingBand = Number(db.getConstant('glancing_hit', 0));
    const glancing = hit && !guarded && !crit && item.hasComponent('hit') &&
      glancingBand > 0 && roll >= effectiveHit - glancingBand;

    // Compute hit damage, or the independent damage_on_miss hook on a miss.
    let dmg = 0;
    if (!guarded && (hit || hasDamageOnMiss(item))) {
      const baseDmg = calcs.computeDamage(
        striker, item, target, db, board, this.game, mode, assist, attackInfo,
      );
      const normalDamage = baseDmg + wt.damageBonus;
      if (!hit) {
        dmg = damageOnMiss(item, normalDamage) ?? 0;
      } else {
        dmg = normalDamage;

        // Crit damage
        if (crit) {
          const baseCritMult = this.criticalMultiplier(striker, item, db);
          dmg *= baseCritMult;
          dmg += skillSystem.modifyCritDamage(striker, item, this.game);
          dmg += skillSystem.dynamicCritDamageAddition(
            striker, item, target, defWeapon, mode, attackInfo, dmg, this.game,
          );
        }

        // Grandmaster mode scales hit damage by to-hit%; DamageOnMiss calls
        // compute_damage directly and therefore does not use this scaling.
        if (rngMode === 'grandmaster') {
          dmg = Math.trunc(dmg * finalHit / 100);
        }

        if (glancing) {
          dmg = Math.trunc(dmg / 2);
        }

        dmg = this.applyCustomHitDamage(item, target, dmg);
      }
      dmg = Math.max(0, dmg);
    }

    const strike: CombatStrike = {
      attacker: striker,
      defender: target,
      item,
      hit,
      crit,
      damage: dmg,
      extraDamage: this.evaluatedExtraDamage(
        striker, item, target, hit, guarded, glancing,
        rngMode === 'grandmaster' ? finalHit : undefined,
        mode,
        attackInfo,
      ),
      isCounter,
      assist,
      guarded,
      ...(glancing ? { glancing: true } : {}),
      mode,
      attackInfo,
      ...(procs.attack.length ? { attackProcs: procs.attack } : {}),
      ...(procs.defense.length ? { defenseProcs: procs.defense } : {}),
    };
    this.lifecycle?.endStrike(procs);
    this.updateGuardGauges(striker, item, target, db);
    return strike;
  }

  private applyCustomHitDamage(
    item: ItemObject,
    target: UnitObject,
    damage: number,
  ): number {
    if (!item.hasComponent('cleave_2_range_aoe')) return damage;
    const suzerain = this.game?.units?.get?.('SuzerainC21') as UnitObject | undefined;
    const ennis = this.game?.units?.get?.('Ennis') as UnitObject | undefined;
    const protectedTarget = target === suzerain ||
      (!suzerain && target === ennis && ennis.party !== 'Ennis');
    return protectedTarget ? 0 : Math.max(0, target.currentHp - 1);
  }
}
