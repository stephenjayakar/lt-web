import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item status and stack hooks', () => {
  test('count-locks every authored value shape and referenced status', async ({ page }) => {
    await bootEotf(page);
    const authored = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const wanted = new Set([
        'statuses_after_combat_on_hit',
        'status_after_combat_on_hit_foe_only',
        'buff_ally',
        'stacks_on_hit',
        'self_stacks_on_hit',
        'self_remove_skill',
      ]);
      const values: Record<string, unknown[]> = {};
      let missingStatusReferences = 0;
      for (const item of game.db.items.values()) {
        for (const [nid, value] of item.components) {
          if (!wanted.has(nid)) continue;
          (values[nid] ??= []).push(value);
          const statusNids = Array.isArray(value)
            ? value
            : value && typeof value === 'object'
              ? [(value as Record<string, unknown>).skill]
              : [value];
          for (const statusNid of statusNids) {
            if (typeof statusNid === 'string' && !game.db.skills.has(statusNid)) {
              missingStatusReferences++;
            }
          }
        }
      }
      return {
        counts: Object.fromEntries(
          Object.entries(values).map(([nid, entries]) => [nid, entries.length]),
        ),
        statusLengths: (values.statuses_after_combat_on_hit ?? [])
          .map((value) => Array.isArray(value) ? value.length : -1)
          .sort((left, right) => left - right),
        foeOnly: values.status_after_combat_on_hit_foe_only,
        buffs: values.buff_ally,
        stacks: values.stacks_on_hit,
        selfStacks: values.self_stacks_on_hit,
        selfRemove: values.self_remove_skill,
        missingStatusReferences,
      };
    });

    expect(authored).toEqual({
      counts: {
        statuses_after_combat_on_hit: 32,
        self_stacks_on_hit: 1,
        buff_ally: 14,
        stacks_on_hit: 2,
        self_remove_skill: 2,
        status_after_combat_on_hit_foe_only: 6,
      },
      statusLengths: [
        1, 1, 2,
        2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
        3, 3, 3, 3,
        4,
        5, 5,
        6,
        2,
      ].sort((left, right) => left - right),
      foeOnly: ['Burning', 'Exposed', 'Toxin', 'Chilled', 'SPD_minus_4', 'Inflexible'],
      buffs: [
        'Divine_Favor', 'Amped', 'Starfire_Stride', 'Sunflare_Shield',
        'Moonlit_Rush', 'Nothing', 'Nothing', 'Nothing_1', 'Nothing_1',
        'Nothing_2', 'Nothing_2', 'Nothing_3', 'Nothing_3', 'Worker_Bee',
      ],
      stacks: [
        { skill: 'Bleeding', amount: 5 },
        { skill: 'Toxin', amount: 3 },
      ],
      selfStacks: [{ skill: 'Frost_Shield', amount: 3 }],
      selfRemove: ['Convergeance', 'Convergeance'],
      missingStatusReferences: 0,
    });
  });

  test('applies hit statuses before later strikes and replays exact stacks', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: {
            ...klass.bases,
            HP: 40, STR: 0, MAG: 0, SKL: 10, SPD: 10,
            LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5,
          },
          growths: {}, stat_cap_modifiers: {}, starting_items: [],
          learned_skills: [], unit_notes: [], fields: [], wexp_gain: {},
          portrait_nid: '', affinity: '',
        }, klass);
        unit.team = team;
        unit.currentHp = 40;
        unit.skills = [];
        return unit;
      };
      const attacker = makeUnit('_ImmediateStatusUser', 'player');
      const target = makeUnit('_ImmediateStatusTarget', 'enemy');
      const prefabs = [
        {
          nid: '_ImmediateBuff', name: '', desc: '',
          components: [['resist', 1]],
        },
        {
          nid: '_ImmediateTargetStack', name: '', desc: '',
          components: [['stack', 5], ['resist', 2]],
        },
        {
          nid: '_ImmediateSelfStack', name: '', desc: '',
          components: [['stack', 5], ['damage', 3]],
        },
      ];
      for (const prefab of prefabs) game.db.skills.set(prefab.nid, prefab);
      const item = new ItemObject({
        nid: '_ImmediateStatusItem',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 10], ['hit', 100],
          ['uses', 10],
          ['buff_ally', '_ImmediateBuff'],
          ['stacks_on_hit', { skill: '_ImmediateTargetStack', amount: 2 }],
          ['self_stacks_on_hit', { skill: '_ImmediateSelfStack', amount: 2 }],
        ],
      });
      attacker.items = [item];
      const actionLog = new ActionLog();
      const combat = new MapCombat(
        attacker,
        item,
        target,
        null,
        game.db,
        'classic',
        null,
        ['hit1', 'hit1'],
        undefined,
        game,
      );
      const damage = combat.strikes.map((strike: any) => strike.damage);
      const afterSolve = {
        targetBuffs: target.skills.filter((skill: any) => skill.nid === '_ImmediateBuff').length,
        targetStacks: target.skills.filter(
          (skill: any) => skill.nid === '_ImmediateTargetStack',
        ).length,
        selfStacks: attacker.skills.filter(
          (skill: any) => skill.nid === '_ImmediateSelfStack',
        ).length,
      };
      combat.applyResults(actionLog);
      const afterResults = {
        targetBuffs: target.skills.filter((skill: any) => skill.nid === '_ImmediateBuff').length,
        targetStacks: target.skills.filter(
          (skill: any) => skill.nid === '_ImmediateTargetStack',
        ).length,
        selfStacks: attacker.skills.filter(
          (skill: any) => skill.nid === '_ImmediateSelfStack',
        ).length,
      };
      while (actionLog.actionIndex >= 0) actionLog.runActionBackward();
      const rewound = [target.skills.length, attacker.skills.length];
      while (actionLog.actionIndex < actionLog.actions.length - 1) {
        actionLog.runActionForward();
      }
      const redone = {
        targetBuffs: target.skills.filter((skill: any) => skill.nid === '_ImmediateBuff').length,
        targetStacks: target.skills.filter(
          (skill: any) => skill.nid === '_ImmediateTargetStack',
        ).length,
        selfStacks: attacker.skills.filter(
          (skill: any) => skill.nid === '_ImmediateSelfStack',
        ).length,
      };
      for (const prefab of prefabs) game.db.skills.delete(prefab.nid);
      return {
        damage, afterSolve, afterResults, rewound, redone,
        combatUseEffect: item.hasCombatUseEffect(),
      };
    });

    expect(result).toEqual({
      damage: [10, 11],
      afterSolve: { targetBuffs: 1, targetStacks: 4, selfStacks: 4 },
      afterResults: { targetBuffs: 1, targetStacks: 4, selfStacks: 4 },
      rewound: [0, 0],
      redone: { targetBuffs: 1, targetStacks: 4, selfStacks: 4 },
      combatUseEffect: true,
    });
  });

  test('re-evaluates doubling after a mid-combat speed status', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);
      const makeUnit = (nid: string, speed: number) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: {
            ...klass.bases,
            HP: 40, STR: 0, MAG: 0, SKL: 10, SPD: speed,
            LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5,
          },
          growths: {}, stat_cap_modifiers: {}, starting_items: [],
          learned_skills: [], unit_notes: [], fields: [], wexp_gain: {},
          portrait_nid: '', affinity: '',
        }, klass);
        unit.team = nid.includes('Target') ? 'enemy' : 'player';
        unit.currentHp = 40;
        unit.skills = [];
        return unit;
      };
      game.db.skills.set('_MidCombatSlow', {
        nid: '_MidCombatSlow',
        name: '',
        desc: '',
        components: [['stat_change', [['SPD', -10]]]],
      });
      const makeItem = (withStatus: boolean) => new ItemObject({
        nid: withStatus ? '_SlowWeapon' : '_BaselineWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 1], ['hit', 100],
          ...(withStatus ? [['status_on_hit', '_MidCombatSlow'] as [string, unknown]] : []),
        ],
      });
      const baselineUser = makeUnit('_BaselineUser', 5);
      const baselineTarget = makeUnit('_BaselineTarget', 8);
      const baseline = new CombatPhaseSolver(undefined, game).resolve(
        baselineUser,
        makeItem(false),
        baselineTarget,
        null,
        game.db,
        'classic',
      );
      const statusUser = makeUnit('_StatusUser', 5);
      const statusTarget = makeUnit('_StatusTarget', 8);
      const status = new CombatPhaseSolver(undefined, game).resolve(
        statusUser,
        makeItem(true),
        statusTarget,
        null,
        game.db,
        'classic',
      );
      game.db.skills.delete('_MidCombatSlow');
      return {
        baselineStrikes: baseline.length,
        statusStrikes: status.length,
        appliedStatuses: statusTarget.skills.map((skill: any) => skill.nid),
      };
    });

    expect(result).toEqual({
      baselineStrikes: 1,
      statusStrikes: 2,
      appliedStatuses: ['_MidCombatSlow'],
    });
  });

  test('lets support AI use status staves on full-health allies', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { AIController } = await import('/src/ai/ai-controller.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      if (!unit.position || !target.position) return null;
      const old = {
        items: unit.items,
        targetSkills: target.skills,
        targetHp: target.currentHp,
        unitTeam: unit.team,
        targetTeam: target.team,
      };
      game.db.skills.set('_AiStatusBuff', {
        nid: '_AiStatusBuff',
        name: '',
        desc: '',
        components: [],
      });
      const item = new ItemObject({
        nid: '_AiStatusStaff',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['spell', null], ['target_ally', null], ['min_range', 1], ['max_range', 99],
          ['uses', 5], ['buff_ally', '_AiStatusBuff'],
        ],
      });
      unit.items = [item];
      unit.team = 'player';
      target.team = 'player';
      target.currentHp = target.maxHp;
      target.skills = [];
      const controller = new AIController(game.db, game.board, game.pathSystem);
      controller.gameRef = game;
      const available = (controller as any).supportPrimaryAI(
        unit,
        [unit.position],
        [target],
        false,
      );
      target.skills = [new SkillObject(game.db.skills.get('_AiStatusBuff'))];
      const redundant = (controller as any).supportPrimaryAI(
        unit,
        [unit.position],
        [target],
        false,
      );
      unit.items = old.items;
      target.skills = old.targetSkills;
      target.currentHp = old.targetHp;
      unit.team = old.unitTeam;
      target.team = old.targetTeam;
      game.db.skills.delete('_AiStatusBuff');
      return {
        available: available
          ? {
              type: available.type,
              item: available.item?.nid,
              target: available.targetUnit?.nid,
            }
          : null,
        redundant: redundant === null,
        combatUseEffect: item.hasCombatUseEffect(),
      };
    });

    expect(result).toEqual({
      available: { type: 'attack', item: '_AiStatusStaff', target: 'Keeper' },
      redundant: true,
      combatUseEffect: true,
    });
  });

  test('deduplicates end statuses, filters foes, and removes self stacks reversibly', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { applyCombatItemEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { ...klass.bases }, growths: {},
          stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        }, klass);
        unit.team = team;
        unit.skills = [];
        return unit;
      };
      const attacker = makeUnit('_EndStatusUser', 'player');
      const foe = makeUnit('_EndStatusFoe', 'enemy');
      const ally = makeUnit('_EndStatusAlly', 'player');
      const prefabs = [
        { nid: '_EndStatusA', name: '', desc: '', components: [] },
        { nid: '_EndStatusB', name: '', desc: '', components: [] },
        { nid: '_EndStatusFoeOnly', name: '', desc: '', components: [] },
        { nid: '_EndStatusConsume', name: '', desc: '', components: [['stack', 5]] },
      ];
      for (const prefab of prefabs) game.db.skills.set(prefab.nid, prefab);
      const consumed = [
        new SkillObject(prefabs[3]),
        new SkillObject(prefabs[3]),
      ];
      attacker.skills = [...consumed];
      const item = new ItemObject({
        nid: '_EndStatusItem',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['statuses_after_combat_on_hit', ['_EndStatusA', '_EndStatusB']],
          ['status_after_combat_on_hit_foe_only', '_EndStatusFoeOnly'],
          ['self_remove_skill', '_EndStatusConsume'],
        ],
      });
      const mark = (defender: any, hit = true) => ({
        attacker, defender, item, hit, crit: false, damage: 0,
        isCounter: false, mode: 'attack', attackInfo: [0, 0] as [number, number],
      });
      const actionLog = new ActionLog();
      const applied = applyCombatItemEndHooks(
        { ...game, actionLog, db: game.db, board: game.board },
        [mark(foe), mark(foe), mark(ally), mark(ally, false)] as any,
      );
      const after = {
        foe: foe.skills.map((skill: any) => [skill.nid, skill.initiatorNid]),
        ally: ally.skills.map((skill: any) => [skill.nid, skill.initiatorNid]),
        self: attacker.skills.length,
      };
      while (actionLog.actionIndex >= 0) actionLog.runActionBackward();
      const rewound = {
        foe: foe.skills.length,
        ally: ally.skills.length,
        selfIdentity: attacker.skills[0] === consumed[0] &&
          attacker.skills[1] === consumed[1],
      };
      while (actionLog.actionIndex < actionLog.actions.length - 1) {
        actionLog.runActionForward();
      }
      const redone = {
        foe: foe.skills.map((skill: any) => skill.nid),
        ally: ally.skills.map((skill: any) => skill.nid),
        self: attacker.skills.length,
      };
      for (const prefab of prefabs) game.db.skills.delete(prefab.nid);
      return { applied, after, rewound, redone };
    });

    expect(result).toEqual({
      applied: 7,
      after: {
        foe: [
          ['_EndStatusA', '_EndStatusUser'],
          ['_EndStatusB', '_EndStatusUser'],
          ['_EndStatusFoeOnly', '_EndStatusUser'],
        ],
        ally: [
          ['_EndStatusA', '_EndStatusUser'],
          ['_EndStatusB', '_EndStatusUser'],
        ],
        self: 0,
      },
      rewound: { foe: 0, ally: 0, selfIdentity: true },
      redone: {
        foe: ['_EndStatusA', '_EndStatusB', '_EndStatusFoeOnly'],
        ally: ['_EndStatusA', '_EndStatusB'],
        self: 0,
      },
    });
  });
});
