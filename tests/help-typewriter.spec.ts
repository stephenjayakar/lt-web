/**
 * help-typewriter.spec.ts: help boxes reveal their description through a
 * Dialog in the `__default_help` speak style (help_menu.py create_dialog):
 * nothing during the dialog's 10-frame transition, then about one character
 * per frame (text_speed 32 x speed 0.5), retyping when the box reappears
 * after more than a second unseen. StatDialog types its bonus leaders at
 * {max_speed} and resumes at {starting_speed}.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });
test.use({ launchOptions: { args: ['--mute-audio'] } });

const DEFAULT = '/?harness=true&level=0&clean=true&bundle=false';

async function boot(page: Page): Promise<void> {
  await page.goto(DEFAULT);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
}

async function step(page: Page, frames: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
}

/** The info menu's shown help box: revealed text and its full description. */
const shown = (page: Page) => page.evaluate(() => {
  const s = (window as any).__gameRef.state.getCurrentState();
  const bb = s.currentBB;
  if (!bb?.boxes) return null;
  const box = bb.boxes[bb.page] ?? bb.boxes[0];
  return { revealed: box.revealedText as string, full: (box.lines as string[]).join(' ') };
});

const norm = (text: string): string => text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

test('info-menu help text types out after the dialog transition and retypes after a second unseen', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.infoMenuUnit = g.units.get('Eirika');
    g.memory.set('info_menu_state', 'personal_data');
    g.state.change('info_menu');
  });
  await step(page, 4);
  await step(page, 1, 'INFO');
  // Dialog TRANSITION_IN (10 frames) shows no text.
  await step(page, 8);
  const early = await shown(page);
  expect(early?.revealed).toBe('');
  const full = norm(early?.full ?? '');
  expect(full.length).toBeGreaterThan(20);
  // Then roughly one character per frame (32 ms x 0.5 per char, 3-frame punctuation pauses).
  await step(page, 14);
  const partial = (await shown(page))?.revealed ?? '';
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThanOrEqual(13);
  expect(full.startsWith(norm(partial))).toBe(true);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('help-typing.png') });
  await step(page, 400);
  // A stat box goes on to type its bonus lines after the description.
  const typed = norm((await shown(page))?.revealed ?? '');
  expect(typed.startsWith(full)).toBe(true);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('help-typed.png') });

  // Hidden for under a second: the text stays revealed.
  await step(page, 1, 'INFO');
  await step(page, 20);
  await step(page, 1, 'INFO');
  await step(page, 2);
  expect(norm((await shown(page))?.revealed ?? '')).toBe(typed);
  // Hidden for over a second: it types out again.
  await step(page, 1, 'INFO');
  await step(page, 70);
  await step(page, 1, 'INFO');
  await step(page, 2);
  expect((await shown(page))?.revealed).toBe('');
});

test('StatDialog types bonus leaders at max speed; upstream item boxes keep their text on reappearing', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).__harness;
    const g = (window as any).__gameRef;
    const { StatDialog, ItemHelpDialog, HelpDialog } = await import('/src/ui/help-menu.ts');
    const { Surface } = await import('/src/engine/surface.ts');
    const { createItemTree } = await import('/src/objects/item.ts');
    const surf = new Surface(240, 160);
    const stat: any = new StatDialog('Strength.', { 'Base Value': 5, Sword: 2 });
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) {
      stat.draw(surf, 0, 0);
      seen.push(stat.revealedText);
    }
    const leaders = seen.map((t) => (t.match(/﹘/g) ?? []).length);
    const firstLeader = leaders.findIndex((n) => n > 0);
    const final = seen[seen.length - 1];

    const item = [...g.db.items.values()]
      .map((prefab: any) => createItemTree(prefab, (n: string) => g.db.items.get(n)))
      .find((it: any) => it.desc && it.isWeapon());
    const itemBox: any = new ItemHelpDialog(item);
    const plain: any = new HelpDialog('Plain help text.');
    for (let i = 0; i < 300; i++) {
      itemBox.draw(surf, 0, 0);
      plain.draw(surf, 0, 0);
      h.stepFrames(1, null);
    }
    const before = [itemBox.revealedText.length, plain.revealedText.length];
    h.stepFrames(70, null);
    itemBox.draw(surf, 0, 0);
    plain.draw(surf, 0, 0);
    return {
      firstLeader,
      leaderAtFirst: leaders[firstLeader],
      firstLeaderLength: (final.match(/﹘+/) ?? [''])[0].length,
      // The source name after the leader takes several frames ({starting_speed}).
      nameFrames: seen.findIndex((t) => t.endsWith('Base Value')) - firstLeader,
      final,
      before,
      after: [itemBox.revealedText.length, plain.revealedText.length],
    };
  });
  expect(result.firstLeader).toBeGreaterThan(10);
  expect(result.leaderAtFirst).toBe(result.firstLeaderLength);
  expect(result.nameFrames).toBeGreaterThan(3);
  expect(result.final.startsWith('Strength.')).toBe(true);
  expect(result.before.every((n: number) => n > 0)).toBe(true);
  expect(result.after).toEqual([result.before[0], 0]);
});
