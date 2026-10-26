/**
 * `text_color` item component. EOtF's engine fork honours the authored font
 * colour (Rigalbured_A 'blue', Rigalbured_B 'purple') in item menus and in
 * the item banners (`item_system.text_color(None, item) or 'blue'`);
 * upstream deprecated it and always returns 'white'.
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page, project: string | null): Promise<void> {
  await page.goto(project ? `/?harness=true&project=${project}&level=X&clean=true&bundle=false` : '/?harness=true');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test('EOtF text_color colours item menus and banners like the fork', async ({ page }) => {
  await boot(page, 'eotf.ltproj');
  const result = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const { itemTextColor, bannerItemColor } = await import('/src/combat/item-system.ts');
    const { acquiredItemText, stoleItemText } = await import('/src/ui/banner.ts');
    const { itemOptionColors } = await import('/src/ui/prep-ui.ts');
    const a = new ItemObject(game.db.items.get('Rigalbured_A'));
    const b = new ItemObject(game.db.items.get('Rigalbured_B'));
    const plain = new ItemObject(game.db.items.get('Iron_Sword'));
    return {
      a: itemTextColor(a),
      b: itemTextColor(b),
      plain: itemTextColor(plain),
      bannerPlain: bannerItemColor(plain),
      got: acquiredItemText('Eve', b.name, bannerItemColor(b)),
      stole: stoleItemText('Eve', a.name, bannerItemColor(a)),
      menuMain: itemOptionColors(game, b, false)[0],
    };
  });
  expect(result.a).toBe('blue');
  expect(result.b).toBe('purple');
  expect(result.plain).toBeNull();
  expect(result.bannerPlain).toBe('blue');
  expect(result.got).toMatch(/<purple>[^<]+<\/>\.$/);
  expect(result.stole).toMatch(/<blue>[^<]+<\/>\.$/);
  expect(result.menuMain).toBe('purple');
});

test('upstream projects resolve text_color to white', async ({ page }) => {
  await boot(page, null);
  const color = await page.evaluate(async () => {
    const { ItemObject } = await import('/src/objects/item.ts');
    const { itemTextColor } = await import('/src/combat/item-system.ts');
    const item = new ItemObject({
      nid: '_Tinted', name: '_Tinted', desc: '', icon_nid: '', icon_index: [0, 0],
      components: [['text_color', 'purple']],
    } as any);
    return itemTextColor(item);
  });
  expect(color).toBe('white');
});
