import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog skill map variants', () => {
  test('count-locks all four authored ChangeVariant skills', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const uses: { skill: string; value: unknown }[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (nid === 'change_variant') uses.push({ skill: skill.nid, value });
        }
      }
      return uses;
    });

    expect(result).toEqual([
      { skill: 'EnemyWoman', value: 'Female' },
      { skill: 'Armored_Up_1', value: 'Armored' },
      { skill: 'Reese_Variant', value: 'Reese' },
      { skill: 'Horo_Variant', value: 'Unchained' },
    ]);
  });

  test('loads native and skill variants with active precedence and base fallback', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { AddSkillAction } = await import('/src/engine/action.ts');
      const { changeVariant } = await import('/src/combat/skill-system.ts');
      const prefab = game.db.units.get('Termina');
      const klass = game.db.classes.get(prefab.klass);
      const unit = new UnitObject(prefab, klass);
      unit.team = 'player';
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });

      await game.loadMapSpriteForUnit(unit);
      const native = {
        variant: changeVariant(unit, game),
        sprite: unit.sprite?.resourceNid,
      };

      const inactive = make('_InactiveVariant', [
        ['change_variant', 'Reese'],
        ['condition', 'False'],
      ]);
      unit.skills = [inactive];
      await game.loadMapSpriteForUnit(unit);
      const inactiveResult = {
        variant: changeVariant(unit, game),
        sprite: unit.sprite?.resourceNid,
      };

      const missing = make('_MissingVariant', [
        ['change_variant', '_Missing'],
        ['condition', 'True'],
      ]);
      unit.skills = [inactive, missing];
      await game.loadMapSpriteForUnit(unit);
      const fallback = {
        variant: changeVariant(unit, game),
        sprite: unit.sprite?.resourceNid,
      };

      const oldTryLoad = game.resources.tryLoadMapSprite;
      let releaseStale: (() => void) | null = null;
      const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
      let delayedFemale = false;
      game.resources.tryLoadMapSprite = async (nid: string) => {
        if (nid === 'Sword_KnightFemale' && !delayedFemale) {
          delayedFemale = true;
          await staleGate;
        }
        return oldTryLoad.call(game.resources, nid);
      };
      let race = '';
      try {
        unit.skills = [];
        const staleLoad = game.loadMapSpriteForUnit(unit);
        await Promise.resolve();
        unit.skills = [missing];
        await game.loadMapSpriteForUnit(unit);
        releaseStale?.();
        await staleLoad;
        race = unit.sprite?.resourceNid ?? '';
      } finally {
        releaseStale?.();
        game.resources.tryLoadMapSprite = oldTryLoad;
      }

      const actionPrefab = game.db.units.get('Pao');
      const actionUnit = new UnitObject(
        actionPrefab,
        game.db.classes.get(actionPrefab.klass),
      );
      actionUnit.team = 'player';
      const active = make('_ActiveVariant', [
        ['change_variant', 'Armored'],
        ['condition', "not has_skill(unit, 'Blocker')"],
      ]);
      const oldLoader = game.loadMapSpriteForUnit;
      const refreshes: (string | null)[] = [];
      game.loadMapSpriteForUnit = async (candidate: any) => {
        refreshes.push(changeVariant(candidate, game));
      };
      try {
        const addVariant = new AddSkillAction(actionUnit, active);
        addVariant.execute();
        const addBlocker = new AddSkillAction(actionUnit, make('Blocker', []));
        addBlocker.execute();
        addBlocker.reverse();
        addVariant.reverse();
      } finally {
        game.loadMapSpriteForUnit = oldLoader;
      }

      unit.skills = [];
      await game.loadMapSpriteForUnit(unit);
      const selectedSprites = await game.resources.tryLoadMapSprite(
        unit.sprite?.resourceNid,
      );
      return {
        native,
        inactiveResult,
        fallback,
        race,
        refreshes,
        visual: {
          loaded: !!selectedSprites.stand,
          width: selectedSprites.stand?.width ?? 0,
          height: selectedSprites.stand?.height ?? 0,
        },
      };
    });

    expect(result).toEqual({
      native: { variant: 'Female', sprite: 'Sword_KnightFemale' },
      inactiveResult: { variant: 'Female', sprite: 'Sword_KnightFemale' },
      fallback: { variant: '_Missing', sprite: 'Sword_Knight' },
      race: 'Sword_Knight',
      refreshes: ['Armored', '', 'Armored', ''],
      visual: { loaded: true, width: 192, height: 144 },
    });
  });
});
