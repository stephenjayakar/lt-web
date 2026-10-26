import { expect, test, type Page } from '@playwright/test';
import { projectInstalled } from './helpers/project-data';

/**
 * Map combat presentation parity with lt-maker map_combat.py / unit_sprite.py.
 * EOtF forces map combat for every item (Global_Parameters item_override ->
 * never_use_battle_animation), so this is what its players see.
 */

async function startEotfMapCombat(page: Page, script: string[], enemyHp: number): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__harness.settle?.(600));
  const ok = await page.evaluate(({ script, enemyHp }) => {
    const game = (window as any).__gameRef;
    const h = (window as any).__harness;
    const units = [...game.units.values()].filter((u: any) => u.position && !u.isDead() && u.team === 'enemy');
    const [attacker, defender] = units as any[];
    if (!attacker || !defender) return false;
    attacker.team = 'player';
    game.board.moveUnit(defender, attacker.position[0] + 1, attacker.position[1]);
    for (const unit of [attacker, defender]) {
      h.giveItem(unit.nid, 'Iron_Sword');
      unit.equippedWeapon = unit.items.find((item: any) => item.nid === 'Iron_Sword');
      unit.stats.HP = Math.max(unit.stats.HP, 30);
    }
    attacker.currentHp = attacker.stats.HP;
    defender.currentHp = enemyHp;
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = script;
    game.state.change('combat');
    (window as any).__combatPair = [attacker, defender];
    return true;
  }, { script, enemyHp });
  expect(ok).toBe(true);
}

interface FrameSample {
  state: string | null;
  phase: string | null;
  mapState: string | null;
  defenderTints: number;
  defenderTint: number[] | null;
  defenderOpacity: number;
  attackerOffset: [number, number];
  defenderOnBoard: boolean;
}

async function sampleFrames(page: Page, maxFrames: number): Promise<FrameSample[]> {
  return page.evaluate(async (maxFrames) => {
    const fx = await import('/src/combat/map-unit-fx.ts');
    const game = (window as any).__gameRef;
    const h = (window as any).__harness;
    const [attacker, defender] = (window as any).__combatPair;
    const samples: FrameSample[] = [];
    let left = -1;
    for (let frame = 0; frame < maxFrames; frame++) {
      h.stepFrames(1, null);
      const combat = game.state.allStates.get('combat');
      const top = game.state.getCurrentState()?.name ?? null;
      const dv = fx.getUnitFx(defender);
      const av = fx.getUnitFx(attacker);
      samples.push({
        state: top,
        phase: top === 'combat' ? combat.phase : null,
        mapState: top === 'combat' ? combat.combat?.state ?? null : null,
        defenderTints: dv?.tints.length ?? 0,
        defenderTint: dv?.tints[0]?.color ?? null,
        defenderOpacity: dv?.opacity ?? 1,
        attackerOffset: av?.offset ?? [0, 0],
        defenderOnBoard: game.board.getUnit(...(defender.position ?? [-1, -1])) === defender,
      });
      // Events the combat pushes (combat_death, unit_death before the dying
      // fade) sit above it; stop once the combat itself has been popped.
      if (left < 0 && !game.state.getStackNames().includes('combat') && frame > 5) left = frame;
      if (left >= 0 && frame > left + 3) break;
    }
    return samples;
  }, maxFrames);
}

test.describe('map combat presentation (EOtF)', () => {
  test.skip(!projectInstalled(), 'EOtF project not installed');

  test('follows Python strike timing, white hit flicker and lunge', async ({ page }) => {
    await startEotfMapCombat(page, ['hit1', 'end'], 30);
    const frames = await sampleFrames(page, 400);
    const states = frames.map((frame) => frame.mapState).filter((s): s is string => !!s);
    const order = states.filter((state, index) => state !== states[index - 1]);
    expect(order).toEqual([
      'init_pause', 'begin_phase', 'proc_animations', 'start_anim', 'sound',
      'anim', 'hp_bar_wait', 'end_phase_anim', 'end_phase', 'begin_phase', 'exp_wait', 'post_combat',
      'done',
    ]);
    // init_pause 200 ms, start_anim 200 ms, sound 250 ms, anim 83 ms (5
    // frames), end_phase_anim 550 ms: > N ms means N/16.7 + 1 frames.
    const count = (state: string) => states.filter((s) => s === state).length;
    expect(count('init_pause')).toBe(13);
    expect(count('start_anim')).toBe(13);
    expect(count('sound')).toBe(16);
    expect(count('anim')).toBe(5);
    expect(count('end_phase_anim')).toBe(33);

    // unit_tint_add: a 333 ms add-white flicker on the sprite, no overlay box.
    const tinted = frames.filter((frame) => frame.defenderTints > 0);
    expect(tinted.length).toBeGreaterThanOrEqual(19);
    expect(tinted.length).toBeLessThanOrEqual(21);
    expect(tinted[0].defenderTint).toEqual([255, 255, 255]);

    // combat_anim lunge: attack_movement_counter read twice per frame.
    const lunge = frames.map((frame) => frame.attackerOffset[0]).filter((x, i, all) => x !== 0 || all[i - 1]);
    expect(lunge.slice(0, 11)).toEqual([1, 3, 5, 5, 5, 5, 5, 5, 4, 2, 0]);
  });

  test('kills with a white fade after the exp bar instead of a white box', async ({ page }) => {
    await startEotfMapCombat(page, ['hit1', 'end'], 3);
    const frames = await sampleFrames(page, 900);
    const phases = frames.map((frame) => frame.phase).filter((p): p is string => !!p);
    const order = phases.filter((phase, index) => phase !== phases[index - 1]);
    const expIndex = order.indexOf('exp0');
    const deathIndex = order.indexOf('death');
    expect(deathIndex).toBeGreaterThan(-1);
    if (expIndex >= 0) expect(deathIndex).toBeGreaterThan(expIndex);

    // DeathManager: add-white flicker + fade_out for 450 ms, Die after 400 ms.
    const death = frames.filter((frame) => frame.phase === 'death');
    expect(death[0].defenderOnBoard).toBe(true);
    expect(death[1].defenderTint).toEqual([255, 255, 255]);
    const opacities = death.map((frame) => frame.defenderOpacity);
    for (let i = 2; i < opacities.length - 1; i++) {
      expect(opacities[i]).toBeLessThanOrEqual(opacities[i - 1]);
    }
    expect(death.length).toBeGreaterThanOrEqual(24);
    expect(death.length).toBeLessThanOrEqual(26);
    const after = frames[frames.length - 1];
    expect(after.defenderOnBoard).toBe(false);
  });
});
