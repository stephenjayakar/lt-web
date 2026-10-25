import { test, expect, type Page } from '@playwright/test';

/** Python event_functions.interact_unit argument and ability parity. */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
}

async function runEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await page.evaluate(() => (window as any).__harness.stepFrames(30, null));
}

test.describe('interact_unit', () => {
  test('Ability=keyword fights with a temporary item that never enters the inventory', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const bone = g.units.get('Bone') ?? [...g.units.values()].find((u: any) => u.team === 'enemy');
      bone.currentHp = 99;
      return {
        bone: bone.nid,
        hp: bone.currentHp,
        items: g.units.get('Eirika').items.map((item: any) => item.nid),
      };
    });
    await runEvent(page, 'QaInteractAbility', [
      `interact_unit;Eirika;${before.bone};hit1,end;Ability=Steel_Sword;immediate`,
    ]);
    const after = await page.evaluate((boneNid: string) => {
      const g = (window as any).__gameRef;
      return {
        hp: g.units.get(boneNid).currentHp,
        items: g.units.get('Eirika').items.map((item: any) => item.nid),
        steelOwned: [...g.items.values()].some((item: any) => item.nid === 'Steel_Sword' && item.uses < item.maxUses),
      };
    }, before.bone);
    expect(after.items).toEqual(before.items);
    expect(after.hp).toBeLessThan(before.hp);
    expect(after.steelOwned).toBe(true);
  });

  test('a position target strikes the unit standing there', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const bone = g.units.get('Bone') ?? [...g.units.values()].find((u: any) => u.team === 'enemy');
      bone.currentHp = 99;
      return { bone: bone.nid, hp: bone.currentHp, pos: bone.position };
    });
    await runEvent(page, 'QaInteractPos', [
      `interact_unit;Eirika;${before.pos[0]},${before.pos[1]};hit1,end;;immediate`,
    ]);
    const hp = await page.evaluate((boneNid: string) =>
      (window as any).__gameRef.units.get(boneNid).currentHp, before.bone);
    expect(hp).toBeLessThan(before.hp);
  });
});

test.describe('create_unit', () => {
  test('Keyword=value positions, copy_stats, and {created_unit} follow Python parsing', async ({ page }) => {
    await boot(page);
    const template = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = [...g.units.values()].find((u: any) => u.team === 'enemy' && u.position);
      unit.stats.STR = 77;
      const group = g.db.classes.get(unit.klass)?.movement_group;
      for (let x = 0; x < g.board.width; x += 1) {
        for (let y = 0; y < g.board.height; y += 1) {
          if (!g.board.getUnit(x, y) && g.board.getMovementCost(x, y, group, g.db) < 99) {
            return { nid: unit.nid, spot: [x, y] as [number, number] };
          }
        }
      }
      return { nid: unit.nid, spot: null };
    });
    expect(template.spot).not.toBeNull();
    // EOtF's reinforcement form: `create_unit;112;Position=2,4;copy_stats`.
    await runEvent(page, 'QaCreate', [
      `create_unit;${template.nid};Position=${template.spot![0]},${template.spot![1]};copy_stats`,
      'game_var;qa_created;{created_unit}',
    ]);
    const created = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      // `game_var` evaluates the substituted nid, so 201 comes back numeric.
      const nid = String(g.gameVars.get('qa_created'));
      const unit = g.units.get(nid);
      return unit ? { nid, position: unit.position, str: unit.stats.STR } : { nid, position: null, str: null };
    });
    expect(String(created.nid)).not.toContain('Position');
    expect(created.position).toEqual(template.spot);
    expect(created.str).toBe(77);
  });
});
