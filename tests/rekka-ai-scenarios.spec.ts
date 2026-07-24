import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });
}

test.describe('Rekka AI scenarios', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('custom target restrictions eliminate illegal attacks', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const attacker = game.units.get('101');
      const blocked = game.units.get('Lyn');
      const legal = game.units.get('Batta');
      for (const unit of [attacker, blocked, legal]) {
        if (!unit) return null;
        if (unit.position) game.board.removeUnit(unit);
        unit.resetTurnState();
      }
      attacker.team = 'enemy';
      blocked.team = legal.team = 'player';
      game.board.setUnit(1, 1, attacker);
      game.board.setUnit(0, 1, blocked);
      game.board.setUnit(1, 2, legal);

      const weapon = new ItemObject({
        nid: '_AiAdvance', name: '_AiAdvance', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null],
          ['damage', 5], ['hit', 100], ['min_range', 1], ['max_range', 1],
          ['advance_target_restrict', 1], ['uses', 20],
        ],
      });
      attacker.items = [weapon];
      game.db.ai.set('_AiGuardAttack', {
        nid: '_AiGuardAttack', priority: 0, offense_bias: 2,
        behaviours: [{
          action: 'Attack', target: 'Enemy', target_spec: null,
          view_range: -1, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '',
        }],
      });
      attacker.ai = '_AiGuardAttack';
      const action = game.aiController.getAction(attacker);
      return {
        type: action.type,
        target: action.targetUnit?.nid ?? null,
        blockedTargets: game.targetSystem
          .getValidUnitTargets(attacker, weapon, attacker.position)
          .map((unit: any) => unit.nid),
      };
    });

    expect(result).toEqual({
      type: 'attack',
      target: 'Batta',
      blockedTargets: ['Batta'],
    });
  });

  test('AI honors item restrictions and inventory-local loadouts', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { available } = await import('/src/combat/item-system.ts');
      const attacker = game.units.get('101');
      const target = game.units.get('Lyn');
      if (!attacker || !target) return null;
      if (attacker.position) game.board.removeUnit(attacker);
      if (target.position) game.board.removeUnit(target);
      attacker.team = 'enemy';
      target.team = 'player';
      attacker.resetTurnState();
      game.board.setUnit(2, 2, attacker);
      game.board.setUnit(3, 2, target);

      const makeWeapon = (nid: string, weaponType: string, damage: number) =>
        new ItemObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
          components: [
            ['weapon', null], ['target_enemy', null], ['weapon_type', weaponType],
            ['damage', damage], ['hit', 100], ['min_range', 1], ['max_range', 1],
            ['uses', 20],
          ],
        });
      const forbidden = makeWeapon('_AiForbiddenSword', 'Sword', 99);
      const armor = makeWeapon('_AiInventoryOnlyArmor', 'Gear', 2);
      attacker.wexp.Gear = 251;
      game.db.classes.get(attacker.klass).wexp_gain.Gear = [true, 0, 251];
      attacker.items = [forbidden, armor];
      attacker.skills = [new SkillObject({
        nid: '_AiArmorOnly', name: '_AiArmorOnly', desc: '',
        components: [['cannot_use_items_except_armor', null]],
      })];
      game.db.ai.set('_AiItemRestriction', {
        nid: '_AiItemRestriction', priority: 0, offense_bias: 2,
        behaviours: [{
          action: 'Attack', target: 'Enemy', target_spec: null,
          view_range: -1, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '',
        }],
      });
      attacker.ai = '_AiItemRestriction';
      const action = game.aiController.getAction(attacker);
      return {
        type: action.type,
        item: action.item?.nid ?? null,
        registeredInProject: game.db.items.has(armor.nid),
        armorAvailable: available(attacker, armor, game.db, game),
        targets: game.targetSystem.getValidUnitTargets(attacker, armor, attacker.position)
          .map((unit: any) => unit.nid),
      };
    });

    expect(result).toEqual({
      type: 'attack',
      item: '_AiInventoryOnlyArmor',
      registeredInProject: false,
      armorAvailable: true,
      targets: ['Lyn'],
    });
  });

  test('AI scores splash targets and skill priority modifiers', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const attacker = game.units.get('101');
      const first = game.units.get('Lyn');
      const second = game.units.get('Batta');
      if (!attacker || !first || !second) return null;
      for (const unit of [attacker, first, second]) {
        if (unit.position) game.board.removeUnit(unit);
        unit.resetTurnState();
      }
      attacker.team = 'enemy';
      first.team = second.team = 'player';
      first.skills = [];
      second.skills = [];
      game.board.setUnit(2, 2, attacker);
      game.board.setUnit(3, 2, first);
      game.board.setUnit(2, 3, second);

      const makeWeapon = (nid: string, splash: boolean) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null],
          ['damage', 5], ['hit', 100], ['min_range', 1], ['max_range', 1],
          ...(splash ? [['enemy_blast_aoe', 2] as [string, number]] : []),
          ['uses', 20],
        ],
      });
      const plain = makeWeapon('_AiPlain', false);
      const blast = makeWeapon('_AiBlast', true);
      attacker.items = [plain, blast];
      game.db.ai.set('_AiSplash', {
        nid: '_AiSplash', priority: 0, offense_bias: 2,
        behaviours: [{
          action: 'Attack', target: 'Enemy', target_spec: null,
          view_range: -1, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '',
        }],
      });
      attacker.ai = '_AiSplash';
      const splashAction = game.aiController.getAction(attacker);

      attacker.items = [plain];
      first.skills = [new SkillObject(game.db.skills.get('CamoflageStatus'))];
      second.skills = [new SkillObject(game.db.skills.get('Provoke'))];
      const priorityAction = game.aiController.getAction(attacker);
      return {
        splashItem: splashAction.item?.nid ?? null,
        priorityTarget: priorityAction.targetUnit?.nid ?? null,
      };
    });

    expect(result).toEqual({
      splashItem: '_AiBlast',
      priorityTarget: 'Batta',
    });
  });

  test('AI selects a stronger combat art and exposes it for combat activation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const attacker = game.units.get('101');
      const target = game.units.get('Lyn');
      if (!attacker || !target) return null;
      if (attacker.position) game.board.removeUnit(attacker);
      if (target.position) game.board.removeUnit(target);
      attacker.team = 'enemy';
      target.team = 'player';
      attacker.resetTurnState();
      game.board.setUnit(2, 2, attacker);
      game.board.setUnit(3, 2, target);

      const weapon = new ItemObject({
        nid: '_AiArtWeapon', name: '_AiArtWeapon', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 1], ['hit', 100],
          ['min_range', 1], ['max_range', 1], ['uses', 20],
        ],
      });
      game.db.skills.set('_AiArtChild', {
        nid: '_AiArtChild', name: '_AiArtChild', desc: '',
        components: [['damage', 20]],
      });
      const parent = new SkillObject({
        nid: '_AiArtParent', name: '_AiArtParent', desc: '',
        components: [
          ['combat_art', '_AiArtChild'],
          ['allowed_weapons', 'item_system.is_weapon(unit, item)'],
        ],
      });
      attacker.items = [weapon];
      attacker.skills = [parent];
      game.db.ai.set('_AiCombatArt', {
        nid: '_AiCombatArt', priority: 0, offense_bias: 2,
        behaviours: [{
          action: 'Attack', target: 'Enemy', target_spec: null,
          view_range: -1, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '',
        }],
      });
      attacker.ai = '_AiCombatArt';
      const action = game.aiController.getAction(attacker);
      const decisionSnapshot = {
        type: action.type,
        art: action.combatArt?.skill.nid ?? null,
        child: action.combatArt?.childNid ?? null,
        leakedChild: attacker.skills.some((skill: any) =>
          skill.data.get('combatArtSource') === parent),
        activeAfterDecision: parent.data.get('active') ?? false,
      };
      const { AIState } = await import('/src/engine/states/game-states.ts');
      const aiState: any = new AIState();
      aiState.aiUnits = [attacker];
      aiState.currentAiIndex = 0;
      aiState.frameCounter = 5;
      game.aiController.getAction = () => action;
      aiState.update();
      return {
        ...decisionSnapshot,
        activatedForCombat: parent.data.get('active') === true &&
          attacker.skills.some((skill: any) =>
            skill.data.get('combatArtSource') === parent),
        memoryParent: game.memory.get('combat_art_parent')?.nid ?? null,
      };
    });

    expect(result).toEqual({
      type: 'attack',
      art: '_AiArtParent',
      child: '_AiArtChild',
      leakedChild: false,
      activeAfterDecision: false,
      activatedForCombat: true,
      memoryParent: '_AiArtParent',
    });
  });

  test('AI uses a movement-skill warp and records a reversible warp action', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { AIState } = await import('/src/engine/states/game-states.ts');
      const attacker = game.units.get('Lyn');
      const beacon = game.units.get('Batta');
      const target = game.units.get('101');
      if (!attacker || !beacon || !target) return null;
      for (const unit of [attacker, beacon, target]) {
        if (unit.position) game.board.removeUnit(unit);
        unit.resetTurnState();
      }
      attacker.team = beacon.team = 'enemy';
      target.team = 'player';
      game.board.setUnit(1, 1, attacker);
      game.board.setUnit(8, 8, beacon);
      game.board.setUnit(9, 8, target);

      attacker.skills = [new SkillObject({
        nid: '_AiWitchWarp', name: '_AiWitchWarp', desc: '',
        components: [['witch_warp_expression', "unit1.nid == 'Batta'"]],
      })];
      attacker.items = [new ItemObject({
        nid: '_AiWarpWeapon', name: '_AiWarpWeapon', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 5], ['hit', 100],
          ['min_range', 1], ['max_range', 2], ['uses', 20],
        ],
      })];
      game.db.ai.set('_AiWarpAttack', {
        nid: '_AiWarpAttack', priority: 0, offense_bias: 2,
        behaviours: [{
          action: 'Attack', target: 'Enemy', target_spec: null,
          view_range: -4, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '',
        }],
      });
      attacker.ai = '_AiWarpAttack';
      const action = game.aiController.getAction(attacker);
      const origin = [...attacker.position];
      const actionStart = game.actionLog.actions.length;
      const moved = action.targetPosition
        ? (new AIState() as any).moveWithAction(
          game, attacker, action.targetPosition, action.movePath,
        )
        : false;
      const recorded = game.actionLog.actions.slice(actionStart);
      const after = [...attacker.position];
      const undoneAction = game.actionLog.undo();
      return {
        decision: action.type,
        path: action.movePath,
        moved,
        after,
        actionName: recorded[0]?.constructor?.name ?? null,
        undoneName: undoneAction?.constructor?.name ?? null,
        restored: [...attacker.position],
        origin,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.decision).toBe('attack');
    expect(result!.path).toHaveLength(1);
    expect(result!.moved).toBe(true);
    expect(result!.after).not.toEqual(result!.origin);
    expect(result!.actionName).toBe('WarpUnitAction');
    expect(result!.undoneName).toBe('WarpUnitAction');
    expect(result!.restored).toEqual(result!.origin);
  });
});
