import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog per-strike skill hooks', () => {
  test('count-locks all 32 authored strike and mitigation uses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const componentNids = [
        'lost_on_take_hit',
        'event_stack_on_take_hit',
        'event_on_strike',
        'lost_on_strike',
        'gain_on_strike',
        'gain_on_hit',
        'gain_on_miss',
        'dynamic_resist_multiplier',
      ];
      const uses = Object.fromEntries(componentNids.map((componentNid) => [
        componentNid,
        [...game.db.skills.values()].flatMap((skill: any) => skill.components
          .filter(([nid]: [string, unknown]) => nid === componentNid)
          .map(([, value]: [string, unknown]) => [skill.nid, value])),
      ]));
      const referenced = [
        ...uses.gain_on_strike,
        ...uses.gain_on_hit,
        ...uses.gain_on_miss,
      ]
        .map(([, value]: any) => value)
        .filter((value: unknown): value is string =>
          typeof value === 'string' && !value.startsWith('Global '));
      return {
        uses,
        missingSkills: referenced.filter((nid) => !game.db.skills.has(nid)),
      };
    });

    expect(result.uses).toEqual({
      lost_on_take_hit: [
        ['Absolute_Defense', null],
        ['Shielded_Tonic', null],
        ['Frost_Shield', null],
        ['Ritual_Barrier', null],
        ['River_Steps_Handler', null],
        ['Steel_Steps_Handler', null],
        ['LGFG_Confident', null],
        ['Howling_Spirit_Follow_Up', null],
        ['Defender_Arts_D', null],
        ['Nullify_and_Resist_Proc', null],
        ['Hero_Guard', null],
      ],
      event_stack_on_take_hit: [
        ['Rage_Helper', 'Global Ability_Jealous_Rage_Lose'],
        ['Turning_Flesh', 'Global Ability_Turning_Flesh'],
        ['Illusion_Handler', 'Global Ability_Astral_Storm_Recharge'],
        ['Defense_Zone_Aura_Child', 'Global Ability_Oscillation'],
      ],
      event_on_strike: [
        ['Rage_Helper', 'Global Ability_Jealous_Rage_Lose'],
      ],
      lost_on_strike: [
        ['Flickering_Flames_Child', null],
        ['Beta_Guard_Status', null],
      ],
      gain_on_strike: [
        ['Anger_Point', 'Rage'],
        ['Howling_Spirit_Double', 'Howling_Spirit_Follow_Up'],
        ['Sanguine_Wrath', 'Crit_20'],
        ['Broken_Stance', 'Broken_Stance_Proc'],
      ],
      gain_on_hit: [
        ['Amp_Up', 'Charged'],
      ],
      gain_on_miss: [
        ['Flickering_Flames', 'Flickering_Flames_Child'],
      ],
      dynamic_resist_multiplier: [
        ['Brilliant_Shield_Initiate', "0.5 if game.phase.get_current() == unit.team and (unit.get_hp() >= unit.get_max_hp() * 0.5) else 1"],
        ['Protective_Coating_Plus', '0.5 if utils.calculate_distance(unit.position, target.position) > 2 else 1'],
        ['Defender_Arts_D', "0.5 if 'Armor' in unit.tags else 0.75"],
        ['Ignoble_Blade_Effect', '0.5 if target.level > unit.level else 1.0'],
        ['Draconic_Urge', "1- (.2 * (2 - get_charge(unit, 'Hope_for_Humanity')))"],
        ['Draconic_Urge_Plus', "1 - (.2 * (2 - get_charge(unit, 'Hope_for_Humanity_Plus')))"],
        ['Shame_Cowardice', "min(1.00, 0.00 + (.25 * len(get_units_within_distance(unit.position, 4, team='player'))))"],
        ['Border_Guard', "1- (.25 * len(['Boss' in u.tags for u in game.get_enemy_units() if u.nid != unit.nid]))"],
      ],
    });
    expect(result.missingSkills).toEqual([]);
  });

  test('evaluates all dynamic mitigation forms and threads strike context into damage', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { resistMultiplier } = await import('/src/combat/skill-system.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerItems: attacker.items,
        defenderItems: defender.items,
        attackerWeapon: attacker.equippedWeapon,
        defenderWeapon: defender.equippedWeapon,
        attackerStats: { ...attacker.stats },
        defenderStats: { ...defender.stats },
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        attackerDead: attacker.dead,
        defenderDead: defender.dead,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
      };
      const item = new ItemObject({
        nid: '_EotfDynamicMitigationWeapon',
        name: 'Dynamic mitigation weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 5],
          ['hit', 100],
          ['uses', 99],
        ],
      });
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.stats.STR = 10;
      attacker.stats.SKL = 0;
      attacker.stats.SPD = 5;
      defender.stats.DEF = 0;
      defender.stats.RES = 0;
      defender.stats.LCK = 0;
      defender.stats.SPD = 5;
      attacker.items = [item];
      attacker.equippedWeapon = item;
      defender.items = [];
      defender.equippedWeapon = null;
      const expressions = [...game.db.skills.values()].flatMap((prefab: any) =>
        prefab.components
          .filter(([nid]: [string, unknown]) => nid === 'dynamic_resist_multiplier')
          .map(([, expression]: [string, string]) => ({ nid: prefab.nid, expression })));
      const authoredResults = expressions.map(({ nid, expression }) => {
        defender.skills = [new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [['dynamic_resist_multiplier', expression]],
        })];
        return [
          nid,
          resistMultiplier(
            defender,
            null,
            attacker,
            item,
            'defense',
            [0, 0],
            20,
            game,
          ),
        ];
      });

      defender.skills = [];
      attacker.currentHp = 999;
      defender.currentHp = 999;
      attacker.dead = false;
      defender.dead = false;
      const baseline = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['hit1', 'end'], undefined, game,
      );
      const baseDamage = baseline.strikes[0].damage;
      const contextual = new SkillObject({
        nid: '_EotfContextualMitigation',
        name: 'Contextual mitigation',
        desc: '',
        components: [[
          'dynamic_resist_multiplier',
          "0.5 if attack_info[0] == 0 and base_value > 0 and mode == 'attack' else 1",
        ]],
      });
      const inactive = new SkillObject({
        nid: '_EotfInactiveMitigation',
        name: 'Inactive mitigation',
        desc: '',
        components: [
          ['combat_condition', 'False'],
          ['resist_multiplier', 0],
        ],
      });
      defender.skills = [contextual, inactive];
      attacker.currentHp = 999;
      defender.currentHp = 999;
      const combat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['hit1', 'hit1', 'end'], undefined, game,
      );
      const contextualDamages = combat.strikes.map((strike: any) => strike.damage);

      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      defender.items = old.defenderItems;
      attacker.equippedWeapon = old.attackerWeapon;
      defender.equippedWeapon = old.defenderWeapon;
      attacker.stats = old.attackerStats;
      defender.stats = old.defenderStats;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      attacker.dead = old.attackerDead;
      defender.dead = old.defenderDead;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      return { authoredResults, baseDamage, contextualDamages };
    });

    expect(result.authoredResults).toHaveLength(8);
    expect(result.authoredResults.every(([, value]) => Number.isFinite(value))).toBe(true);
    expect(result.contextualDamages).toEqual([
      Math.floor(result.baseDamage * 0.5),
      result.baseDamage,
    ]);
  });

  test('preserves within-strike ordering, next-strike effects, and exact replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerItems: attacker.items,
        defenderItems: defender.items,
        attackerWeapon: attacker.equippedWeapon,
        defenderWeapon: defender.equippedWeapon,
        attackerStats: { ...attacker.stats },
        defenderStats: { ...defender.stats },
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        attackerDead: attacker.dead,
        defenderDead: defender.dead,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
      };
      const childNid = '_EotfPerStrikeDamageChild';
      const oldChildPrefab = game.db.skills.get(childNid);
      game.db.skills.set(childNid, {
        nid: childNid,
        name: 'Per-strike damage child',
        desc: '',
        components: [['damage', 10]],
      });
      const weapon = new ItemObject({
        nid: '_EotfPerStrikeWeapon',
        name: 'EotF per-strike weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 5],
          ['hit', 100],
          ['uses', 99],
        ],
      });
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.stats.STR = 10;
      attacker.stats.SKL = 0;
      attacker.stats.SPD = 5;
      defender.stats.DEF = 0;
      defender.stats.RES = 0;
      defender.stats.LCK = 0;
      defender.stats.SPD = 5;
      attacker.items = [weapon];
      attacker.equippedWeapon = weapon;
      defender.items = [];
      defender.equippedWeapon = null;

      const make = (nid: string, components: [string, any][]) =>
        new SkillObject({ nid, name: nid, desc: '', components });
      const resetHp = () => {
        attacker.currentHp = 999;
        defender.currentHp = 999;
        attacker.dead = false;
        defender.dead = false;
        weapon.uses = 99;
      };
      const resolve = (
        attackerSkills: any[],
        defenderSkills: any[],
        apply = true,
      ) => {
        attacker.skills = attackerSkills;
        defender.skills = defenderSkills;
        resetHp();
        const before = game.actionLog.actionIndex;
        const combat = new MapCombat(
          attacker,
          weapon,
          defender,
          null,
          game.db,
          'classic',
          game.board,
          ['hit1', 'hit1', 'end'],
          undefined,
          game,
        );
        if (apply) combat.applyResults(game.actionLog);
        return { combat, before, after: game.actionLog.actionIndex };
      };
      const rewind = (index: number) => {
        while (game.actionLog.actionIndex > index) {
          game.actionLog.runActionBackward();
        }
      };
      const redo = (index: number) => {
        while (game.actionLog.actionIndex < index) {
          game.actionLog.runActionForward();
        }
      };

      const baselineRun = resolve([], [], false);
      const baseDamage = baselineRun.combat.strikes[0].damage;

      const immediate = make('_ImmediateGainOnStrike', [
        ['gain_on_strike', childNid],
      ]);
      const immediateRun = resolve([immediate], []);
      const immediateChild = attacker.skills.find(
        (skill: any) => skill.nid === childNid,
      );
      const immediateState = {
        damages: immediateRun.combat.strikes.map((strike: any) => strike.damage),
        childInitiator: immediateChild?.initiatorNid ?? null,
        sameChild: attacker.skills.includes(immediateChild),
      };
      rewind(immediateRun.before);
      const immediateRewound = {
        parent: attacker.skills.includes(immediate),
        child: attacker.skills.some((skill: any) => skill.nid === childNid),
      };
      redo(immediateRun.after);
      const immediateRedone = {
        child: attacker.skills.some((skill: any) => skill.nid === childNid),
        sameChild: attacker.skills.includes(immediateChild),
      };

      const delayed = make('_DeferredGainOnHit', [
        ['gain_on_hit', childNid],
        ['drain_charge', 2],
      ]);
      delayed.data.set('charge', 2);
      delayed.data.set('total_charge', 2);
      const delayedRun = resolve([delayed], []);
      const delayedState = {
        damages: delayedRun.combat.strikes.map((strike: any) => strike.damage),
        child: attacker.skills.some((skill: any) => skill.nid === childNid),
        initiator: attacker.skills.find(
          (skill: any) => skill.nid === childNid,
        )?.initiatorNid ?? null,
        charge: delayed.data.get('charge'),
      };

      const delayedRemoval = make('_DeferredLostOnStrike', [
        ['damage', 10],
        ['lost_on_strike', null],
      ]);
      const removalRun = resolve([delayedRemoval], []);
      const removalState = {
        damages: removalRun.combat.strikes.map((strike: any) => strike.damage),
        removed: !attacker.skills.includes(delayedRemoval),
      };

      const onRemoveEvent = 'Global Ability_LookGoodFeelGood_Remove';
      const oldRemoveEvent = game.db.events.get(onRemoveEvent);
      if (!oldRemoveEvent) {
        game.db.events.set(onRemoveEvent, {
          nid: onRemoveEvent,
          name: onRemoveEvent,
          trigger: 'never',
          level_nid: null,
          condition: 'False',
          commands: [],
          only_once: false,
          priority: 0,
          _source: [],
        });
      }
      const removalCalls: any[] = [];
      const originalEventManager = game.eventManager;
      game.eventManager = {
        getPrefab(nid: string) {
          return game.db.events.get(nid);
        },
        triggerSpecific(nid: string, trigger: any) {
          removalCalls.push({ nid, trigger });
          return true;
        },
      };
      const shield = make('_ImmediateLostOnTakeHit', [
        ['resist_multiplier', 0],
        ['lost_on_take_hit', null],
        ['event_on_remove', onRemoveEvent],
      ]);
      const shieldRun = resolve([], [shield]);
      const shieldState = {
        damages: shieldRun.combat.strikes.map((strike: any) => strike.damage),
        removed: !defender.skills.includes(shield),
        removeCalls: removalCalls.map((call) => ({
          nid: call.nid,
          unit: call.trigger.unit1?.nid,
        })),
      };
      game.eventManager = originalEventManager;
      if (oldRemoveEvent) game.db.events.set(onRemoveEvent, oldRemoveEvent);
      else game.db.events.delete(onRemoveEvent);

      if (oldChildPrefab) game.db.skills.set(childNid, oldChildPrefab);
      else game.db.skills.delete(childNid);
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      defender.items = old.defenderItems;
      attacker.equippedWeapon = old.attackerWeapon;
      defender.equippedWeapon = old.defenderWeapon;
      attacker.stats = old.attackerStats;
      defender.stats = old.defenderStats;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      attacker.dead = old.attackerDead;
      defender.dead = old.defenderDead;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      return {
        baseDamage,
        immediateState,
        immediateRewound,
        immediateRedone,
        delayedState,
        removalState,
        shieldState,
      };
    });

    expect(result.immediateState).toEqual({
      damages: [result.baseDamage, result.baseDamage + 10],
      childInitiator: null,
      sameChild: true,
    });
    expect(result.immediateRewound).toEqual({ parent: true, child: false });
    expect(result.immediateRedone).toEqual({ child: true, sameChild: true });
    expect(result.delayedState).toEqual({
      damages: [result.baseDamage, result.baseDamage + 10],
      child: true,
      initiator: 'Player',
      charge: 0,
    });
    expect(result.removalState).toEqual({
      damages: [result.baseDamage + 10, result.baseDamage],
      removed: true,
    });
    expect(result.shieldState).toEqual({
      damages: [0, result.baseDamage],
      removed: true,
      removeCalls: [{
        nid: 'Global Ability_LookGoodFeelGood_Remove',
        unit: 'Keeper',
      }],
    });
  });

  test('queues strike and enemy-hit events from the original skill snapshots', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { queueCombatSkillEvents } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
        eventManager: game.eventManager,
      };
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.skills = [];
      defender.skills = [];
      const item = new ItemObject({
        nid: '_EotfPerStrikeEventWeapon',
        name: 'Per-strike event weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const attackSkill = new SkillObject({
        nid: '_EotfEventOnStrike',
        name: 'Event on strike',
        desc: '',
        components: [['event_on_strike', 'Global Ability_Jealous_Rage_Lose']],
      });
      const defenseSkill = new SkillObject({
        nid: '_EotfEventOnTakeHit',
        name: 'Event on take hit',
        desc: '',
        components: [['event_stack_on_take_hit', 'Global Ability_Turning_Flesh']],
      });
      const calls: any[] = [];
      game.eventManager = {
        triggerSpecific(nid: string, trigger: any) {
          calls.push({ nid, trigger });
          return true;
        },
      };
      const makeStrike = (hit: boolean, guarded = false) => ({
        attacker,
        defender,
        item,
        hit,
        crit: false,
        damage: hit ? 1 : 0,
        isCounter: false,
        guarded,
        mode: 'attack' as const,
        attackInfo: [0, 0] as [number, number],
        attackHookSkills: [attackSkill],
        defenseHookSkills: [defenseSkill],
      });
      const hitQueued = queueCombatSkillEvents(
        game,
        [makeStrike(true)],
        attacker,
        defender,
        item,
        null,
      );
      const hitCalls = calls.map((call) => ({
        nid: call.nid,
        type: call.trigger.type,
        unit: call.trigger.unit1.nid,
        target: call.trigger.unit2.nid,
        item: call.trigger.localArgs.get('item'),
        item2: call.trigger.localArgs.get('item2'),
        mode: call.trigger.localArgs.get('mode'),
      }));
      calls.length = 0;
      const missQueued = queueCombatSkillEvents(
        game,
        [makeStrike(false)],
        attacker,
        defender,
        item,
        null,
      );
      const missNids = calls.map((call) => call.nid);
      calls.length = 0;
      const guardQueued = queueCombatSkillEvents(
        game,
        [makeStrike(true, true)],
        attacker,
        defender,
        item,
        null,
      );
      const guardNids = calls.map((call) => call.nid);

      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      game.eventManager = old.eventManager;
      return { hitQueued, hitCalls, missQueued, missNids, guardQueued, guardNids };
    });

    expect(result.hitQueued).toBe(2);
    expect(result.hitCalls).toEqual([
      {
        nid: 'Global Ability_Jealous_Rage_Lose',
        type: 'event_on_strike',
        unit: 'Player',
        target: 'Keeper',
        item: null,
        item2: null,
        mode: null,
      },
      {
        nid: 'Global Ability_Turning_Flesh',
        type: 'event_stack_on_take_hit',
        unit: 'Keeper',
        target: 'Player',
        item: null,
        item2: null,
        mode: null,
      },
    ]);
    expect(result.missQueued).toBe(1);
    expect(result.missNids).toEqual(['Global Ability_Jealous_Rage_Lose']);
    expect(result.guardQueued).toBe(1);
    expect(result.guardNids).toEqual(['Global Ability_Jealous_Rage_Lose']);
  });
});
