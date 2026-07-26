import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog initiated-combat event pairs', () => {
  test('count-locks values and queues both events only for the initiating side', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        queueCombatSkillEvents,
        queueCombatSkillStartEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldAttackerSkills = attacker.skills;
      const oldDefenderSkills = defender.skills;
      const item = new ItemObject({
        nid: '_InitiatedEventWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null]],
      });
      const source = new SkillObject({
        nid: '_InitiatedEventSource',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [[
          'start_and_end_event_initiate',
          {
            start_event: '_InitiatedStart',
            end_event: '_InitiatedEnd',
          },
        ]],
      });
      const defenderSource = new SkillObject({
        nid: '_DefendingEventSource',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [[
          'start_and_end_event_initiate',
          {
            start_event: '_DefendingStart',
            end_event: '_DefendingEnd',
          },
        ]],
      });
      attacker.skills = [source];
      defender.skills = [defenderSource];
      const calls: any[] = [];
      const originalEventManager = game.eventManager;
      game.eventManager = {
        triggerSpecific(nid: string, trigger: any) {
          calls.push({
            nid,
            type: trigger.type,
            unit1: trigger.unit1.nid,
            unit2: trigger.unit2.nid,
            position: trigger.position,
            item: trigger.localArgs.get('item')?.nid ?? null,
            item2: trigger.localArgs.get('item2')?.nid ?? null,
            mode: trigger.localArgs.get('mode'),
          });
          return true;
        },
      };
      const started = queueCombatSkillStartEvents(
        game,
        attacker,
        defender,
        item,
        item,
      );
      const ended = queueCombatSkillEvents(game, [{
        attacker,
        defender,
        item,
        hit: false,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender, item, item);
      const authored = [...game.db.skills.values()]
        .flatMap((skill: any) => skill.components
          .filter(([nid]: [string, unknown]) =>
            nid === 'start_and_end_event_initiate')
          .map(([, value]: [string, any]) => ({
            skill: skill.nid,
            start: value?.start_event,
            end: value?.end_event,
          })));

      attacker.skills = oldAttackerSkills;
      defender.skills = oldDefenderSkills;
      game.eventManager = originalEventManager;
      return {
        authored,
        started,
        ended,
        calls,
        attackerPosition: attacker.position,
      };
    });

    expect(result.authored).toHaveLength(8);
    expect(result.authored).toContainEqual({
      skill: 'Justice_Drive',
      start: 'Global Ability_Justice_Drive_Start',
      end: 'Global Ability_Justice_Drive_End',
    });
    expect(result.authored.every((row) =>
      typeof row.start === 'string' && row.start.length > 0 &&
      typeof row.end === 'string' && row.end.length > 0)).toBe(true);
    expect(result.started).toBe(1);
    expect(result.ended).toBe(1);
    expect(result.calls).toEqual([
      {
        nid: '_InitiatedStart',
        type: 'start_and_end_event_initiate_start',
        unit1: 'Player',
        unit2: 'Keeper',
        position: result.attackerPosition,
        item: '_InitiatedEventWeapon',
        item2: '_InitiatedEventWeapon',
        mode: 'attack',
      },
      {
        nid: '_InitiatedEnd',
        type: 'start_and_end_event_initiate_end',
        unit1: 'Player',
        unit2: 'Keeper',
        position: result.attackerPosition,
        item: '_InitiatedEventWeapon',
        item2: '_InitiatedEventWeapon',
        mode: 'attack',
      },
    ]);
  });
});
