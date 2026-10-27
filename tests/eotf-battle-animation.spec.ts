/**
 * EOtF battle-animation presentation, checked against the fork engine run
 * headless (frame comparisons of the same scripted exchange: start pose,
 * hit spark, damage numbers, HP drain, crit, level-up, exit).
 *
 * EOtF itself never shows a battle animation: every unit carries the global
 * Global_Parameters skill, whose item_override (No_Anim_Override) adds
 * never_use_battle_animation to every item, so both engines fall back to
 * map combat. The presentation checks neutralise that override, as the
 * oracle comparison did.
 */
import { expect, test, type Page } from '@playwright/test';

const BATTLE = [
  'load_unit;Termina;player;None',
  'add_unit;Termina;5,9;immediate',
  'load_unit;Amant;enemy;None',
  'add_unit;Amant;6,9;immediate',
  'give_item;Termina;Slim Sword;no_banner',
  'equip_item;Termina;Slim Sword',
  'give_item;Amant;Iron_Sword;no_banner',
  'equip_item;Amant;Iron_Sword',
  'set_exp;Termina;99',
  'interact_unit;Termina;Amant;hit1,miss2,crit1;;1;force_animation',
];

async function bootHub(page: Page, allowAnimations: boolean): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__harness.settle(12_000, ['free_roam']));
  await page.evaluate(async ({ lines, allow }) => {
    const g = (window as any).__gameRef;
    const settings = await import('/src/engine/states/settings-state.ts');
    settings.setSetting('animation', 'Always');
    if (allow) g.db.items.get('No_Anim_Override').components = [];
    g.db.events.set('battle_cmp', {
      name: 'battle_cmp', nid: 'battle_cmp', trigger: 'battle_cmp', level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: lines,
    });
    g.eventManager.triggerSpecific('battle_cmp', { type: 'battle_cmp' }, true);
    g.state.change('event');
  }, { lines: BATTLE, allow: allowAnimations });
}

/** Step one frame and report the combat state. */
async function frame(page: Page): Promise<{ state: string; anim: string; phase: string }> {
  return page.evaluate(() => {
    const h = (window as any).__harness;
    const g = (window as any).__gameRef;
    h.stepFrames(1, null);
    const s = g.state.getCurrentState() as any;
    return { state: s?.name ?? '', anim: s?.animCombat?.state ?? '', phase: s?.phase ?? '' };
  });
}

test('EOtF forces map combat through Global_Parameters (No_Anim_Override)', async ({ page }) => {
  await bootHub(page, false);
  let sawAnimation = false;
  let sawCombat = false;
  for (let i = 0; i < 200; i++) {
    const f = await frame(page);
    if (f.state === 'combat') sawCombat = true;
    if (f.anim) sawAnimation = true;
    if (sawCombat && f.state !== 'combat' && i > 20) break;
  }
  expect(sawCombat).toBe(true);
  expect(sawAnimation).toBe(false);
});

test('battle scene: 25% fuzz, no map units behind it, fork level-up timing, HP kept', async ({ page }) => {
  test.setTimeout(240_000);
  await bootHub(page, true);
  const seen: Record<string, number> = {};
  let atInit: any = null;
  let darkened = false;
  for (let i = 0; i < 1200; i++) {
    const f = await frame(page);
    if (i % 4 === 0) await page.waitForTimeout(5);
    const key = f.anim === 'exp_wait' ? `exp:${f.phase}` : f.anim;
    if (key && seen[key] === undefined) seen[key] = i;
    if (f.anim === 'init_pause' && !atInit) {
      // Mid init_pause: the battle scene is up and the viewbox has closed.
      atInit = await page.evaluate(async () => {
        const g = (window as any).__gameRef;
        const combat = (g.state.getCurrentState() as any).animCombat;
        return {
          viewbox: combat.viewbox,
          camera: g.camera.getOffset(),
        };
      });
    }
    if (f.phase === 'level_screen' && !darkened) {
      darkened = await page.evaluate(() =>
        ((window as any).__gameRef.state.getCurrentState() as any).animCombat.darkenUiBackground !== 0);
    }
    if (f.state !== 'combat' && i > 100) break;
  }
  // The viewbox iris has closed (width 0): Python draws no map units then.
  expect(atInit.viewbox[2]).toBe(0);
  // Camera centred like Python Camera._center_y: row 9 - TILEY // 2 = 4.
  expect(atInit.camera[1]).toBe(64);
  expect(darkened, 'the level screen darkens the battle UI').toBe(true);
  // Fork: level_up lasts ~38 frames (logo at double speed), the level screen ~200.
  const levelUp = seen['exp:level_screen'] - seen['exp:level_up'];
  const levelScreen = seen['fade_out_wait'] - seen['exp:level_screen'];
  expect(levelUp).toBeGreaterThanOrEqual(34);
  expect(levelUp).toBeLessThanOrEqual(44);
  expect(levelScreen).toBeGreaterThanOrEqual(190);
  expect(levelScreen).toBeLessThanOrEqual(212);
  const termina = await page.evaluate(() => {
    const u = (window as any).__gameRef.units.get('Termina');
    return { level: u.level, hp: u.currentHp, maxHp: u.maxHp };
  });
  // Level 2 raised max HP, not current HP (ApplyStatChanges(..., False)).
  expect(termina.level).toBe(2);
  expect(termina.hp).toBe(termina.maxHp - 1);
});

test('battle scene draws the map at 75% brightness and hides map units', async ({ page }) => {
  test.setTimeout(240_000);
  await bootHub(page, true);
  for (let i = 0; i < 400; i++) {
    const f = await frame(page);
    if (i % 4 === 0) await page.waitForTimeout(5);
    if (f.anim === 'init_pause') break;
  }
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { Surface } = await import('/src/engine/surface.ts');
    const combat = (g.state.getCurrentState() as any).animCombat;
    // The fuzz alone over an opaque white surface.
    const white = new Surface(240, 160);
    white.fill(255, 255, 255, 1);
    combat.drawViewboxFuzz(white);
    const px = white.ctx.getImageData(10, 10, 1, 1).data;
    // Map units are culled while the closed viewbox is active.
    const counts: number[] = [];
    const original = g.mapView.draw.bind(g.mapView);
    g.mapView.draw = (...args: any[]) => { counts.push(args[2].length); return original(...args); };
    (window as any).__harness.stepFrames(1, null);
    g.mapView.draw = original;
    return { fuzz: [px[0], px[1], px[2]], counts, placed: [...g.units.values()].filter((u: any) => u.position).length };
  });
  expect(result.placed).toBeGreaterThan(1);
  expect(result.counts.length).toBeGreaterThan(0);
  expect(result.counts.every((n: number) => n === 0)).toBe(true);
  // 255 * (1 - 64/255) = 191.
  expect(result.fuzz[0]).toBeGreaterThanOrEqual(189);
  expect(result.fuzz[0]).toBeLessThanOrEqual(193);
});
