/**
 * tests/audio-parity.spec.ts
 *
 * P6 audio verification slice. Covers `src/audio/audio-manager.ts` against
 * `lt-maker/app/engine/sound.py` (SongStack/channel play/push/pop/fade
 * semantics) and `lt-maker/app/engine/phase.py` (phase-music switching on
 * turn change, restored via `PhaseChangeState`/`FreeState`/`AIState` in
 * `src/engine/states/game-states.ts`).
 *
 * All assertions are call-recording based (`AudioManager.calls`), not real
 * audio playback — `AudioManager` records every op (play/push/pop/stop/
 * fadeIn/fadeToPause/sfx/sfxLoop/sfxStop) with nid + fade duration
 * regardless of whether a real AudioContext exists, so these specs run
 * headless without needing a user-gesture-unlocked audio context.
 */

import { test, expect } from '@playwright/test';

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 30_000 },
  );
}

async function stepFrames(page: any, count: number, input?: string | null) {
  await page.evaluate(
    ({ count, input }: { count: number; input: string | null }) => {
      (window as any).__harness.stepFrames(count, input);
    },
    { count, input: input ?? null },
  );
}

async function settle(page: any, ms: number) {
  await page.evaluate(async (ms: number) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      (window as any).__harness.stepFrames(1, null);
      await new Promise((r) => setTimeout(r, 0));
    }
  }, ms);
}

/**
 * Step frames until the phase controller reports `team`, stopping as soon
 * as that happens rather than stepping a fixed wall-clock window — Prologue
 * (level 0) has live enemy AI, and settling for a fixed duration risks
 * letting AI-initiated combat run (and push battle music) before we get a
 * chance to inspect the phase-music state.
 */
async function stepUntilPhaseMusicFadeIn(page: any, team: string, maxFrames: number = 400) {
  await page.evaluate(
    ({ team, maxFrames }: { team: string; maxFrames: number }) => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      for (let i = 0; i < maxFrames; i++) {
        const reachedTeam = game.phase?.getCurrent() === team;
        const fadedIn = game.audioManager.calls.some((c: any) => c.op === 'fadeIn');
        if (reachedTeam && fadedIn) return;
        harness.stepFrames(1, null);
      }
    },
    { team, maxFrames },
  );
}

test.describe('Audio parity: music stack, phase/battle music, SFX loops, volume', () => {
  test('event music command semantics: play/push/pop/stop record correctly on the stack', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const am = game.audioManager;
      am.init();
      am.clearCalls();

      await am.playMusic('Distant Roads');
      await am.pushMusic('Attack');
      await am.pushMusic('Defense');
      await am.popMusic();
      await am.popMusic();
      am.stopMusic(250);

      return {
        calls: am.calls,
        finalNid: am.getCurrentMusicNid(),
      };
    });

    // play, then push(Attack) -> [play Attack], push(Defense) -> [play Defense],
    // pop -> [play Attack] (from stack), pop -> [play Distant Roads] (from stack), stop.
    const ops = result.calls.map((c: any) => `${c.op}:${c.nid ?? ''}`);
    expect(ops).toEqual([
      'play:Distant Roads',
      'push:Attack',
      'play:Attack',
      'push:Defense',
      'play:Defense',
      'pop:',
      'play:Attack',
      'pop:',
      'play:Distant Roads',
      'stop:',
    ]);
    // Stop recorded the requested fade duration.
    expect(result.calls[result.calls.length - 1].fadeMs).toBe(250);
    // After both pops, the stack is fully unwound and stop() clears current music.
    expect(result.finalNid).toBe('');
  });

  test('phase music switches across a player -> enemy -> player turn cycle', async ({ page }) => {
    // Prologue (level 0): player_phase = "Distant Roads", enemy_phase =
    // "Shadow of the Enemy" (lt-maker/default.ltproj/game_data/levels.json).
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    // The harness loads the level before any user gesture unlocks the
    // AudioContext, so the level-load `playMusic(player_phase)` call
    // recorded but no-oped. Unlock it now and replay that initial call so
    // `currentMusicNid` reflects reality for the rest of the test, exactly
    // as it would once main.ts's real init-on-click/keydown fires.
    const initial = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      game.audioManager.init();
      await game.audioManager.playMusic(game.currentLevel.music.player_phase);
      return {
        state: game.state.getCurrentState()?.name,
        nid: game.audioManager.getCurrentMusicNid(),
      };
    });
    expect(initial.state).toBe('free');
    expect(initial.nid).toBe('Distant Roads');

    // Advance to enemy phase.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.audioManager.clearCalls();
      game.state.change('turn_change');
    });
    await stepUntilPhaseMusicFadeIn(page, 'enemy');
    // fadeIn() awaits a real fetch+decode of the audio buffer, which won't
    // resolve on simulated frame steps alone — give it real wall-clock time.
    await settle(page, 300);

    const enemyPhase = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        team: game.phase.getCurrent(),
        nid: game.audioManager.getCurrentMusicNid(),
        calls: game.audioManager.calls,
      };
    });
    expect(enemyPhase.team).toBe('enemy');
    // fade_out_phase_music() then fade_in_phase_music(at_turn_change=true) to
    // the enemy_phase track, matching phase.py's PhaseChangeState.begin/end.
    const enemyOps = enemyPhase.calls.map((c: any) => c.op);
    expect(enemyOps).toContain('fadeToPause');
    expect(enemyOps).toContain('fadeIn');
    const fadeInCall = enemyPhase.calls.find((c: any) => c.op === 'fadeIn');
    expect(fadeInCall.nid).toBe('Shadow of the Enemy');
    expect(fadeInCall.fadeMs).toBe(400); // Python DEFAULT_FADE_TIME_MS
    // Note: we don't assert `enemyPhase.nid` directly here — Prologue's
    // enemy AI can act within the settle window and immediately push battle
    // music ("Defense") on top, which is the *correct* real behavior (see
    // the battle-music-override spec below), not a bug in the fade-in call
    // we just verified above.

    // Advance back to player phase.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.audioManager.clearCalls();
      game.state.change('turn_change');
    });
    await stepUntilPhaseMusicFadeIn(page, 'player');
    await settle(page, 300);

    const playerPhase = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        team: game.phase.getCurrent(),
        nid: game.audioManager.getCurrentMusicNid(),
      };
    });
    expect(playerPhase.team).toBe('player');
    expect(playerPhase.nid).toBe('Distant Roads');
  });

  test('battle music pushes on combat entry and restores phase music on exit', async ({ page }) => {
    // Prologue (level 0): player_battle = "Attack", enemy_battle = "Defense".
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      // Unlock the AudioContext (see the phase-cycle test above for why).
      game.audioManager.init();
      await game.audioManager.playMusic(game.currentLevel.music.player_phase);
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return false;

      let origin: [number, number] | null = null;
      for (let y = 1; y < game.board.height - 1 && !origin; y++) {
        for (let x = 1; x < game.board.width - 1 && !origin; x++) {
          if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
            origin = [x, y];
          }
        }
      }
      if (!origin) return false;

      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 40, STR: 10, MAG: 0, SKL: 10, SPD: 10, LCK: 0, DEF: 0, RES: 5, CON: 10, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 40;
        return unit;
      };
      const attacker = makeUnit('_AudioAttacker', 'player');
      const defender = makeUnit('_AudioDefender', 'enemy');
      const item = new ItemObject({
        nid: '_AudioTestSpell', name: '_AudioTestSpell', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_enemy', null], ['damage', 0], ['hit', 100],
          ['uses', 2], ['min_range', 1], ['max_range', 1],
        ],
      });
      attacker.items.push(item);
      game.board.setUnit(origin[0], origin[1], attacker);
      game.board.setUnit(origin[0] + 1, origin[1], defender);
      game.units.set(attacker.nid, attacker);
      game.units.set(defender.nid, defender);
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1'];
      game.memory.set('combat_item', item);
      game.audioManager.clearCalls();
      (window as any).__audioCombatTest = { attacker, defender, item };
      game.state.change('combat');
      return true;
    });
    expect(setup).toBe(true);

    // pushMusic's playMusic awaits a real fetch+decode of the audio buffer,
    // which doesn't resolve on simulated frame steps alone — give it real
    // wall-clock time to settle before checking.
    await stepFrames(page, 2);
    await settle(page, 300);
    const musicDuringCombat = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return game.audioManager.getCurrentMusicNid();
    });
    // Attacker is player team -> level.music.player_battle == "Attack".
    expect(musicDuringCombat).toBe('Attack');

    await settle(page, 1500);

    const after = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const calls = game.audioManager.calls;
      return {
        nid: game.audioManager.getCurrentMusicNid(),
        pushed: calls.some((c: any) => c.op === 'push' && c.nid === 'Attack'),
        popped: calls.filter((c: any) => c.op === 'pop').length,
      };
    });
    expect(after.pushed).toBe(true);
    expect(after.popped).toBeGreaterThanOrEqual(1);
    // Restored to the current phase's music after combat ends (player phase
    // track, since the whole exchange happens on the player's turn).
    expect(after.nid).toBe('Distant Roads');
  });

  test('SFX loop lifecycle: start is idempotent, stop clears the loop', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const am = game.audioManager;
      am.clearCalls();

      await am.playSfxLoop('Experience Gain');
      await am.playSfxLoop('Experience Gain'); // no-op re-entry, still recorded as a call
      am.stopSfx('Experience Gain');
      am.stopSfx('Experience Gain'); // no-op, loop already gone

      return am.calls.map((c: any) => `${c.op}:${c.nid}`);
    });

    expect(result).toEqual([
      'sfxLoop:Experience Gain',
      'sfxLoop:Experience Gain',
      'sfxStop:Experience Gain',
      'sfxStop:Experience Gain',
    ]);
  });

  test('volume settings apply to the music/sfx gain state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const am = game.audioManager;
      am.setMusicVolume(0.3);
      am.setSfxVolume(0.6);
      return {
        musicVolume: (am as any).musicVolume,
        sfxVolume: (am as any).sfxVolume,
      };
    });
    expect(result.musicVolume).toBeCloseTo(0.3, 5);
    expect(result.sfxVolume).toBeCloseTo(0.6, 5);

    // Clamped to [0, 1] (Python: utils.clamp(volume, 0, 1) in reset_volume()).
    const clamped = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const am = game.audioManager;
      am.setMusicVolume(1.5);
      am.setSfxVolume(-0.5);
      return { musicVolume: (am as any).musicVolume, sfxVolume: (am as any).sfxVolume };
    });
    expect(clamped.musicVolume).toBe(1);
    expect(clamped.sfxVolume).toBe(0);
  });
});
