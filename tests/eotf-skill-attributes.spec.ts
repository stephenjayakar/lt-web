import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page, level = 'X'): Promise<void> {
  await page.goto(
    `/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level)}&clean=true&bundle=false`,
  );
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

const COMPONENTS = [
  'global',
  'grey_if_inactive',
  'has_tags',
  'hidden_if_inactive',
  'hide_aura',
  'is_terrain',
  'negative',
  'stack',
] as const;

test.describe('Embrace of the Fog skill attributes', () => {
  test('count-locks all 671 authored attribute and aura-visibility markers', async ({ page }) => {
    await bootEotf(page);
    const counts = await page.evaluate((componentNids) => {
      const game = (window as any).__gameRef;
      const selected = new Set(componentNids);
      const result: Record<string, number> = {};
      for (const skill of game.db.skills.values()) {
        for (const [nid] of skill.components) {
          if (selected.has(nid)) result[nid] = (result[nid] ?? 0) + 1;
        }
      }
      return result;
    }, [...COMPONENTS]);

    expect(counts).toEqual({
      global: 29,
      grey_if_inactive: 38,
      has_tags: 82,
      hidden_if_inactive: 122,
      hide_aura: 96,
      is_terrain: 9,
      negative: 71,
      stack: 224,
    });
  });

  test('applies terrain, visibility, tag, global, stack, and aura policies', async ({ page }) => {
    await bootEotf(page, 'Grigol');
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        additionalTags,
        modifyAvoid,
        statChange,
      } = await import('/src/combat/skill-system.ts');
      const { skillInfoPresentation } =
        await import('/src/engine/states/info-menu-state.ts');
      const { auraHighlightPositions } = await import('/src/combat/aura-system.ts');
      const { HighlightManager } = await import('/src/rendering/highlight.ts');
      const { AddSkillAction } = await import('/src/engine/action.ts');
      const harness = (window as any).__harness;
      const unit = [...game.units.values()].find((candidate: any) => candidate.position);
      const oldSkills = unit.skills;
      const oldTags = unit.tags;
      const oldPosition = unit.position;
      const oldItems = game.items;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid,
          name: nid,
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components,
        });

      const terrain = new SkillObject(game.db.skills.get('Forest'));
      unit.skills = [terrain];
      unit.tags = [];
      const groundedTerrain = {
        defense: statChange(unit, 'DEF', game),
        avoid: modifyAvoid(unit, null, game),
        presentation: skillInfoPresentation(terrain, unit, game),
      };
      unit.tags = ['Flying'];
      const flyingTerrain = {
        defense: statChange(unit, 'DEF', game),
        avoid: modifyAvoid(unit, null, game),
      };

      const inactiveHidden = make('_InactiveHidden', [
        ['condition', 'False'],
        ['hidden_if_inactive', null],
      ]);
      const inactiveGrey = make('_InactiveGrey', [
        ['condition', 'False'],
        ['grey_if_inactive', null],
      ]);
      const tags = make('_Tags', [['has_tags', ['Armor', 'Monster']]]);
      unit.tags = [];
      unit.skills = [inactiveHidden, inactiveGrey, tags];
      const presentation = {
        hidden: skillInfoPresentation(inactiveHidden, unit, game),
        grey: skillInfoPresentation(inactiveGrey, unit, game),
        tags: [...additionalTags(unit, game)].sort(),
      };

      const stackPrefab = {
        nid: '_Stacked',
        name: '_Stacked',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0] as [number, number],
        components: [['stack', 2]] as [string, unknown][],
      };
      unit.skills = [];
      for (let i = 0; i < 3; i++) {
        new AddSkillAction(unit, new SkillObject(stackPrefab)).execute();
      }
      const stackCount = unit.skills.filter((skill: any) => skill.nid === '_Stacked').length;

      game.items = new Map();
      const built = game.buildUnit(game.db.units.get('Player'), 'player', 'None');
      const globals = built.skills.filter(
        (skill: any) => skill.data.get('sourceType') === 'global',
      );

      const visibleAura = new SkillObject(game.db.skills.get('Leadership'));
      const hiddenAura = new SkillObject(game.db.skills.get('CaptureAura'));
      unit.position = [5, 5];
      const board = {
        bounds: [0, 0, 10, 10],
        inBounds: (x: number, y: number) => x >= 0 && x <= 10 && y >= 0 && y <= 10,
      };
      unit.skills = [visibleAura, hiddenAura];
      const visiblePositions = auraHighlightPositions(unit, board as any);
      unit.skills = [hiddenAura];
      const hiddenPositions = auraHighlightPositions(unit, board as any);

      unit.skills = [visibleAura];
      unit.position = oldPosition;
      game.cursor.setPos(unit.position[0], unit.position[1]);
      game.state.restoreStack(['free']);
      harness.stepFrames(2);
      const visibleHoverCount = [...game.highlight.getHighlights().values()]
        .filter((type: string) => type === 'aura').length;
      unit.skills = [hiddenAura];
      game.state.restoreStack(['free']);
      harness.stepFrames(2);
      const hiddenHoverCount = [...game.highlight.getHighlights().values()]
        .filter((type: string) => type === 'aura').length;

      const highlights = new HighlightManager();
      highlights.setThreatHighlights([[6, 5]]);
      highlights.setAuraHighlights([[6, 5], [7, 5]]);
      const layered = Object.fromEntries(highlights.getHighlights());
      highlights.clearType('aura');
      const restored = Object.fromEntries(highlights.getHighlights());

      unit.skills = oldSkills;
      unit.tags = oldTags;
      unit.position = oldPosition;
      game.items = oldItems;
      return {
        groundedTerrain,
        flyingTerrain,
        presentation,
        stackCount,
        globals: {
          count: globals.length,
          sources: [...new Set(globals.map((skill: any) => skill.data.get('sourceNid')))],
        },
        aura: {
          visibleCount: visiblePositions.length,
          hiddenCount: hiddenPositions.length,
          visibleHoverCount,
          hiddenHoverCount,
          layered,
          restored,
        },
      };
    });

    expect(result).toEqual({
      groundedTerrain: {
        defense: 1,
        avoid: 20,
        presentation: 'hidden',
      },
      flyingTerrain: {
        defense: 0,
        avoid: 0,
      },
      presentation: {
        hidden: 'hidden',
        grey: 'grey',
        tags: ['Armor', 'Monster'],
      },
      stackCount: 2,
      globals: {
        count: 29,
        sources: ['game'],
      },
      aura: {
        visibleCount: 24,
        hiddenCount: 0,
        visibleHoverCount: 24,
        hiddenHoverCount: 0,
        layered: {
          '6,5': 'aura',
          '7,5': 'aura',
        },
        restored: {
          '6,5': 'threat',
        },
      },
    });
  });
});
