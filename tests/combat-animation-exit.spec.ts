import { expect, test } from '@playwright/test';

/**
 * Battle-scene sequencing parity with animation_combat.py: the exp bar shows
 * over the scene, the UI slides out, the viewbox re-opens onto the map, and
 * the dead unit's dying fade plays on the map afterwards. The old web scene
 * closed to an opaque black screen and redrew the battle behind the exp bar.
 */
test('battle scene exits like Python with no black or battle frame after the fade', async ({ page }) => {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => !!(window as any).__harness?.ready, undefined, { timeout: 60_000 });
  const started = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const attacker = game.units.get('Eirika');
    const defender = [...game.units.values()].find((unit: any) =>
      unit.team === 'enemy' && unit.position && !unit.isDead());
    if (!attacker?.position || !defender) return false;
    game.board.moveUnit(defender, attacker.position[0], attacker.position[1] - 1);
    defender.currentHp = 3;
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = ['hit1', 'end'];
    game.state.change('combat');
    (window as any).__exitPair = [attacker, defender];
    return true;
  });
  expect(started).toBe(true);

  const samples = await page.evaluate(async () => {
    const fx = await import('/src/combat/map-unit-fx.ts');
    const game = (window as any).__gameRef;
    const h = (window as any).__harness;
    const [, defender] = (window as any).__exitPair;
    const out: Array<{ top: string; phase: string | null; anim: string | null; vb: number[] | null; dark: number; dying: boolean }> = [];
    for (let frame = 0; frame < 1500; frame++) {
      h.stepFrames(1, null);
      const top = game.state.getCurrentState()?.name ?? '';
      const combat = game.state.allStates.get('combat');
      const anim = combat?.animCombat ?? null;
      // Mean brightness of the canvas: catches an all-black frame.
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4 * 37) sum += data[i] + data[i + 1] + data[i + 2];
      const dark = sum / (data.length / (4 * 37)) / 3;
      out.push({
        top,
        phase: top === 'combat' ? combat.phase : null,
        anim: anim?.state ?? null,
        vb: anim?.viewbox ? [...anim.viewbox] : null,
        dark,
        dying: !!fx.getUnitFx(defender)?.dying,
      });
      if (top !== 'combat' && frame > 20) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return out;
  });

  const animStates = samples.map((s) => s.anim).filter((s): s is string => !!s);
  const order = animStates.filter((s, i) => s !== animStates[i - 1]);
  expect(order.slice(order.indexOf('end_combat'))).toEqual([
    'end_combat', 'exp_pause', 'exp_wait', 'fade_out_wait', 'name_tags_out', 'all_out', 'fade_out', 'done',
  ]);
  // The exp bar runs while the scene waits at exp_wait (before it slides out).
  const expFrames = samples.filter((s) => s.phase?.startsWith('exp'));
  if (expFrames.length) expect(expFrames.every((s) => s.anim === 'exp_wait')).toBe(true);
  // fade_out re-opens the viewbox from the defender tile to the full screen.
  const fade = samples.filter((s) => s.anim === 'fade_out');
  expect(fade[0].vb![2]).toBeLessThanOrEqual(16);
  expect(fade[fade.length - 1].vb![2]).toBeGreaterThan(200);
  // No all-black frame anywhere in the exit, and the map is back afterwards.
  const exit = samples.slice(samples.findIndex((s) => s.anim === 'fade_out_wait'));
  expect(Math.min(...exit.map((s) => s.dark))).toBeGreaterThan(8);
  // The dying fade happens on the map after the scene is gone.
  const death = samples.filter((s) => s.phase === 'death');
  expect(death.length).toBeGreaterThan(20);
  expect(death.every((s) => s.anim === 'done')).toBe(true);
});
