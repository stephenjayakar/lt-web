import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog status admission and cleansing', () => {
  test('count-locks all 23 authored status defense and cleansing uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const selected = new Set([
        'block_specific_status',
        'block_status',
        'immune_status',
        'purge_ailments',
        'resist_status',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      const game = (window as any).__gameRef;
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (!selected.has(component)) continue;
          counts[component] = (counts[component] ?? 0) + 1;
          if (component === 'block_specific_status' &&
              (!Array.isArray(value) ||
               value.some((nid: unknown) => typeof nid !== 'string'))) {
            invalid.push(skill.nid);
          } else if (component !== 'block_specific_status' && value !== null) {
            invalid.push(`${skill.nid}:${component}`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        block_specific_status: 4,
        block_status: 1,
        immune_status: 14,
        purge_ailments: 1,
        resist_status: 3,
      },
      invalid: [],
    });
  });

  test('applies admission hooks and upkeep cleansing reversibly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        ActionLog,
        AddSkillAction,
      } = await import('/src/engine/action.ts');
      const { applySkillTurnHooks } =
        await import('/src/engine/skill-turn-lifecycle.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid,
          name: nid,
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components,
        });
      const runAdmission = (
        protector: any,
        status: any,
      ) => {
        const actionLog = new ActionLog();
        unit.skills = [protector];
        const before = actionLog.actionIndex;
        actionLog.doAction(new AddSkillAction(unit, status));
        const after = actionLog.actionIndex;
        const applied = {
          present: unit.skills.includes(status),
          turns: status.data.get('turns') ?? null,
          charge: protector.data.get('charge') ?? null,
        };
        while (actionLog.actionIndex > before) actionLog.runActionBackward();
        const reversed = {
          nids: unit.skills.map((skill: any) => skill.nid),
          turns: status.data.get('turns') ?? null,
          charge: protector.data.get('charge') ?? null,
        };
        while (actionLog.actionIndex < after) actionLog.runActionForward();
        const redone = {
          present: unit.skills.includes(status),
          turns: status.data.get('turns') ?? null,
          charge: protector.data.get('charge') ?? null,
        };
        return { applied, reversed, redone };
      };

      const resistance = make('_Resistance', [['resist_status', null]]);
      const timed = make('_TimedAilment', [
        ['negative', null],
        ['time', 4],
      ]);
      const resisted = runAdmission(resistance, timed);
      const existingTimed = make('_DuplicateTimed', [['time', 4]]);
      const rejectedTimed = make('_DuplicateTimed', [['time', 4]]);
      unit.skills = [resistance, existingTimed];
      const duplicateLog = new ActionLog();
      duplicateLog.doAction(new AddSkillAction(unit, rejectedTimed));
      const rejectedDuplicate = {
        present: unit.skills.includes(rejectedTimed),
        turns: rejectedTimed.data.get('turns'),
      };

      const block = make('_BlockFirstTwo', [
        ['block_status', null],
        ['drain_charge', 2],
      ]);
      const blocked = runAdmission(
        block,
        make('_BlockedAilment', [['negative', null]]),
      );
      block.data.set('charge', 2);
      unit.skills = [block];
      const exhaustionLog = new ActionLog();
      const blockedOne = make('_BlockedOne', [['negative', null]]);
      const blockedTwo = make('_BlockedTwo', [['negative', null]]);
      const admittedThree = make('_AdmittedThree', [['negative', null]]);
      exhaustionLog.doAction(new AddSkillAction(unit, blockedOne));
      exhaustionLog.doAction(new AddSkillAction(unit, blockedTwo));
      exhaustionLog.doAction(new AddSkillAction(unit, admittedThree));
      const exhaustedBlock = {
        charge: block.data.get('charge'),
        nids: unit.skills.map((skill: any) => skill.nid),
      };

      const specific = make('_SpecificBlock', [
        ['block_specific_status', ['_SpecificStatus']],
      ]);
      const specificallyBlocked = runAdmission(
        specific,
        make('_SpecificStatus', []),
      );

      const immunity = make('_Immunity', [['immune_status', null]]);
      const immune = runAdmission(
        immunity,
        make('_ImmuneAilment', [['negative', null]]),
      );

      const purge = make('_Purge', [['purge_ailments', null]]);
      const ailmentA = make('_AilmentA', [['negative', null]]);
      const boon = make('_Boon', []);
      const ailmentB = make('_AilmentB', [['negative', null]]);
      unit.skills = [purge, ailmentA, boon, ailmentB];
      const purgeLog = new ActionLog();
      const purgeGame = { ...game, actionLog: purgeLog };
      const purgeStart = purgeLog.actionIndex;
      const effects = applySkillTurnHooks(purgeGame, [unit], 'upkeep');
      const purgeEnd = purgeLog.actionIndex;
      const cleansed = unit.skills.map((skill: any) => skill.nid);
      while (purgeLog.actionIndex > purgeStart) purgeLog.runActionBackward();
      const cleanseReversed = unit.skills.map((skill: any) => skill.nid);
      while (purgeLog.actionIndex < purgeEnd) purgeLog.runActionForward();
      const cleanseRedone = unit.skills.map((skill: any) => skill.nid);

      unit.skills = oldSkills;
      return {
        resisted,
        rejectedDuplicate,
        blocked: { ...blocked, exhausted: exhaustedBlock },
        specificallyBlocked,
        immune,
        cleansing: {
          effects: effects.map((effect: any) => effect.component),
          cleansed,
          reversed: cleanseReversed,
          redone: cleanseRedone,
        },
      };
    });

    expect(result.resisted).toEqual({
      applied: { present: true, turns: 1, charge: null },
      reversed: { nids: ['_Resistance'], turns: 4, charge: null },
      redone: { present: true, turns: 1, charge: null },
    });
    expect(result.rejectedDuplicate).toEqual({ present: false, turns: 4 });
    expect(result.blocked).toEqual({
      applied: { present: false, turns: null, charge: 1 },
      reversed: { nids: ['_BlockFirstTwo'], turns: null, charge: 2 },
      redone: { present: false, turns: null, charge: 1 },
      exhausted: {
        charge: 0,
        nids: ['_BlockFirstTwo', '_AdmittedThree'],
      },
    });
    expect(result.specificallyBlocked).toEqual({
      applied: { present: false, turns: null, charge: null },
      reversed: { nids: ['_SpecificBlock'], turns: null, charge: null },
      redone: { present: false, turns: null, charge: null },
    });
    expect(result.immune).toEqual({
      applied: { present: false, turns: null, charge: null },
      reversed: { nids: ['_Immunity'], turns: null, charge: null },
      redone: { present: false, turns: null, charge: null },
    });
    expect(result.cleansing).toEqual({
      effects: ['purge_ailments'],
      cleansed: ['_Purge', '_Boon'],
      reversed: ['_Purge', '_AilmentA', '_Boon', '_AilmentB'],
      redone: ['_Purge', '_Boon'],
    });
  });
});
