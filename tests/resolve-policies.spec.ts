/**
 * Component resolve-policy parity tests (P3).
 *
 * Python's generated `skill_system`/`item_system` dispatchers resolve each
 * hook via a fixed policy defined in
 * `app/engine/component_system/compile_skill_system.py` /
 * `compile_item_system.py`, backed by `app/engine/component_system/utils.py`:
 *
 *   - ALL_DEFAULT_FALSE / ALL_DEFAULT_TRUE: `all(vals)` if any component
 *     defines the hook, else the named default.
 *   - ANY_DEFAULT_FALSE: `any(vals)` if any component defines the hook, else
 *     False.
 *   - NUMERIC_ACCUM / NUMERIC_MULTIPLY: sum / product of all defined values.
 *   - UNIQUE: `vals[-1]` — the LAST component (in skill iteration order) that
 *     defines the hook wins, with a named default only if none do.
 *
 * These are unit tests against the pure dispatch functions in
 * `src/combat/skill-system.ts`, using minimal fake skill/unit objects (no
 * browser harness needed — this file runs in Playwright's plain Node
 * context, like a probe spec).
 */

import { test, expect } from '@playwright/test';
import { SkillObject } from '../src/objects/skill';
import { ItemObject } from '../src/objects/item';
import * as skillSystem from '../src/combat/skill-system';
import * as combatCalcs from '../src/combat/combat-calcs';
import type { Database } from '../src/data/database';
import type { ItemPrefab, SkillPrefab } from '../src/data/types';
import type { UnitObject } from '../src/objects/unit';

function makeSkill(nid: string, components: [string, any][]): SkillObject {
  const prefab: SkillPrefab = {
    nid,
    name: nid,
    desc: '',
    icon_nid: '',
    icon_index: [0, 0],
    components,
  };
  return new SkillObject(prefab);
}

function fakeUnit(skills: SkillObject[]): any {
  return { skills };
}

test.describe('UNIQUE resolve policy: last-defined component wins (Python utils.unique = vals[-1])', () => {
  test('damageFormula: second skill overrides the first', () => {
    const first = makeSkill('formula_a', [['damage_formula', 'MAGIC_DAMAGE']]);
    const second = makeSkill('formula_b', [['damage_formula', 'TRUE_DAMAGE']]);
    const unit = fakeUnit([first, second]);
    expect(skillSystem.damageFormula(unit)).toBe('TRUE_DAMAGE');
  });

  test('damageFormula: order reversed flips the winner', () => {
    const first = makeSkill('formula_b', [['damage_formula', 'TRUE_DAMAGE']]);
    const second = makeSkill('formula_a', [['damage_formula', 'MAGIC_DAMAGE']]);
    const unit = fakeUnit([first, second]);
    expect(skillSystem.damageFormula(unit)).toBe('MAGIC_DAMAGE');
  });

  test('accuracyFormula: last-defined wins, and falls back to alternate_accuracy_formula alias', () => {
    const first = makeSkill('alt', [['alternate_accuracy_formula', 'HIT2']]);
    const second = makeSkill('override', [['accuracy_formula', 'HIT3']]);
    const unit = fakeUnit([first, second]);
    // Both component nids map to the same hook name in Python; only the
    // later-registered skill's contribution should be visible.
    expect(skillSystem.accuracyFormula(unit)).toBe('HIT3');
  });

  test('formula aliases compete in skill order instead of fixed alias priority', () => {
    const primary = makeSkill('primary', [['damage_formula', 'PRIMARY']]);
    const alternate = makeSkill('alternate', [['alternate_damage_formula', 'ALTERNATE']]);
    expect(skillSystem.damageFormula(fakeUnit([primary, alternate]))).toBe('ALTERNATE');
    expect(skillSystem.damageFormula(fakeUnit([alternate, primary]))).toBe('PRIMARY');
  });

  test('inactive formulas do not shadow an earlier active formula', () => {
    const active = makeSkill('active', [['alternate_damage_formula', 'ACTIVE']]);
    const inactive = makeSkill('inactive', [
      ['alternate_damage_formula', 'INACTIVE'],
      ['condition', 'False'],
    ]);
    expect(skillSystem.damageFormula(fakeUnit([active, inactive]))).toBe('ACTIVE');
  });

  test('accuracyFormula: default undefined when no skill defines the hook', () => {
    const unit = fakeUnit([makeSkill('unrelated', [['vantage', true]])]);
    expect(skillSystem.accuracyFormula(unit)).toBeUndefined();
  });

  test('resistFormulaOverride: last-defined wins', () => {
    const first = makeSkill('a', [['resist_formula_override', 'RES1']]);
    const second = makeSkill('b', [['resist_formula_override', 'RES2']]);
    expect(skillSystem.resistFormulaOverride(fakeUnit([first, second]))).toBe('RES2');
    expect(skillSystem.resistFormulaOverride(fakeUnit([second, first]))).toBe('RES1');
  });

  test('expMultiplier: last-defined wins, default 1 when undefined', () => {
    const unit = fakeUnit([]);
    expect(skillSystem.expMultiplier(unit, null)).toBe(1);
    const first = makeSkill('a', [['exp_multiplier', 2]]);
    const second = makeSkill('b', [['exp_multiplier', 0.5]]);
    expect(skillSystem.expMultiplier(fakeUnit([first, second]), null)).toBe(0.5);
    expect(skillSystem.expMultiplier(fakeUnit([second, first]), null)).toBe(2);
  });

  test('alternateSplash: last-defined skill component wins, not the first', () => {
    const oversplash = makeSkill('over', [['oversplash', 2]]);
    const cleave = makeSkill('cleave', [['Cleave', true]]);
    // Cleave registered after oversplash -> Cleave wins.
    expect(skillSystem.alternateSplash(fakeUnit([oversplash, cleave]))).toBe('enemy_cleave');
    // Reversed order -> oversplash (blast) wins instead.
    expect(skillSystem.alternateSplash(fakeUnit([cleave, oversplash]))).toBe('blast');
  });

  test('alternateSplash: default null when no skill defines it', () => {
    const unit = fakeUnit([makeSkill('unrelated', [['vantage', true]])]);
    expect(skillSystem.alternateSplash(unit)).toBeNull();
  });
});

test.describe('NUMERIC_ACCUM resolve policy: sums every component (Python utils.numeric_accumulate = sum)', () => {
  test('modifyDamage: two skills each contributing accumulate', () => {
    const a = makeSkill('a', [['modify_damage', 3]]);
    const b = makeSkill('b', [['damage', 2]]);
    expect(skillSystem.modifyDamage(fakeUnit([a, b]), null)).toBe(5);
  });

  test('modifyDamage: default 0 with no contributing skills', () => {
    expect(skillSystem.modifyDamage(fakeUnit([]), null)).toBe(0);
  });

  test('empowerSplash: sums oversplash/enemy_oversplash/smart_oversplash across skills', () => {
    const a = makeSkill('a', [['oversplash', 1]]);
    const b = makeSkill('b', [['enemy_oversplash', 2]]);
    expect(skillSystem.empowerSplash(fakeUnit([a, b]))).toBe(3);
  });
});

test.describe('ALL_DEFAULT_TRUE / ALL_DEFAULT_FALSE resolve policies', () => {
  test('canCounter (skill, ALL_DEFAULT_TRUE): true by default, false if any skill disables it', () => {
    expect(skillSystem.canCounter(fakeUnit([]))).toBe(true);
    const enabling = makeSkill('a', [['some_other', true]]);
    expect(skillSystem.canCounter(fakeUnit([enabling]))).toBe(true);
    const disabling = makeSkill('b', [['cannot_counter', true]]);
    expect(skillSystem.canCounter(fakeUnit([enabling, disabling]))).toBe(false);
  });

  test('noDouble (ALL_DEFAULT_FALSE-shaped OR-of-booleans): false by default, true if any skill sets it', () => {
    expect(skillSystem.noDouble(fakeUnit([]))).toBe(false);
    expect(skillSystem.noDouble(fakeUnit([makeSkill('a', [['no_double', true]])]))).toBe(true);
  });
});

test.describe('item and skill formula precedence', () => {
  test('skill override beats item override, skill alternate, item alternate, and default', () => {
    const equations = new Map<string, string>([
      ['DAMAGE', '1'],
      ['ITEM_DAMAGE_LOW', '11'],
      ['ITEM_DAMAGE_HIGH', '22'],
      ['SKILL_DAMAGE_LOW', '33'],
      ['SKILL_DAMAGE_HIGH', '44'],
      ['ATTACK_SPEED', '1'],
      ['ITEM_SPEED_LOW', '10'],
      ['ITEM_SPEED_HIGH', '20'],
      ['SKILL_SPEED_LOW', '30'],
      ['SKILL_SPEED_HIGH', '40'],
      ['CRIT_HIT', '1'],
      ['ITEM_CRIT_LOW', '50'],
      ['ITEM_CRIT_HIGH', '60'],
      ['SKILL_CRIT_LOW', '70'],
      ['SKILL_CRIT_HIGH', '90'],
      ['CRIT_AVOID', '1'],
      ['ITEM_DODGE_LOW', '10'],
      ['ITEM_DODGE_HIGH', '20'],
      ['SKILL_DODGE_LOW', '25'],
      ['SKILL_DODGE_HIGH', '30'],
    ]);
    const db = {
      classes: new Map(),
      weapons: [],
      getEquation: (nid: string) => equations.get(nid),
      getEquationNames: () => [...equations.keys()],
      getConstant: (_nid: string, fallback: unknown) => fallback,
    } as unknown as Database;
    const makeUnit = (skills: SkillObject[]): UnitObject => ({
      nid: 'FormulaUnit',
      level: 1,
      klass: '',
      tags: [],
      skills,
      items: [],
      wexp: {},
      position: null,
      getStatValue: (nid: string) => nid === 'SPD' ? 9 : nid === 'CON' ? 5 : 0,
    }) as unknown as UnitObject;
    const item = new ItemObject({
      nid: 'FormulaItem',
      name: 'FormulaItem',
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['damage', 0],
        ['crit', 0],
        ['weight', 0],
        ['alternate_damage_formula', 'ITEM_DAMAGE_LOW'],
        ['damage_formula_override', 'ITEM_DAMAGE_HIGH'],
        ['alternate_attack_speed_formula', 'ITEM_SPEED_LOW'],
        ['attack_speed_formula_override', 'ITEM_SPEED_HIGH'],
        ['alternate_defense_speed_formula', 'ITEM_SPEED_LOW'],
        ['defense_speed_formula_override', 'ITEM_SPEED_HIGH'],
        ['alternate_crit_accuracy_formula', 'ITEM_CRIT_LOW'],
        ['crit_accuracy_formula_override', 'ITEM_CRIT_HIGH'],
        ['alternate_crit_avoid_formula', 'ITEM_DODGE_LOW'],
        ['crit_avoid_formula_override', 'ITEM_DODGE_HIGH'],
      ],
    } as ItemPrefab);
    const attacker = makeUnit([
      makeSkill('low', [
        ['damage_formula', 'SKILL_DAMAGE_LOW'],
        ['attack_speed_formula', 'SKILL_SPEED_LOW'],
        ['crit_accuracy_formula', 'SKILL_CRIT_LOW'],
      ]),
      makeSkill('high', [
        ['damage_formula_override', 'SKILL_DAMAGE_HIGH'],
        ['attack_speed_formula_override', 'SKILL_SPEED_HIGH'],
        ['crit_accuracy_formula_override', 'SKILL_CRIT_HIGH'],
      ]),
    ]);
    const defender = makeUnit([
      makeSkill('def_low', [
        ['defense_speed_formula', 'SKILL_SPEED_LOW'],
        ['crit_avoid_formula', 'SKILL_DODGE_LOW'],
      ]),
      makeSkill('def_high', [
        ['defense_speed_formula_override', 'SKILL_SPEED_HIGH'],
        ['crit_avoid_formula_override', 'SKILL_DODGE_HIGH'],
      ]),
    ]);

    expect(combatCalcs.damage(attacker, item, db)).toBe(44);
    expect(combatCalcs.attackSpeed(attacker, item, db)).toBe(40);
    expect(combatCalcs.defenseSpeed(defender, item, db, item)).toBe(40);
    expect(combatCalcs.computeCrit(attacker, item, defender, db)).toBe(60);

    attacker.skills = [];
    defender.skills = [];
    expect(combatCalcs.damage(attacker, item, db)).toBe(22);
    expect(combatCalcs.attackSpeed(attacker, item, db)).toBe(20);
    expect(combatCalcs.defenseSpeed(defender, item, db, item)).toBe(20);
    expect(combatCalcs.computeCrit(attacker, item, defender, db)).toBe(40);
  });
});
