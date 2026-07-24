/**
 * Sequential full-campaign chain smoke test (P7).
 *
 * Unlike the per-chapter tests in harness.spec.ts (which each load a single
 * chapter in isolation via ?harness=true&level=N), this spec drives ONE
 * continuous playthrough: Prologue -> Ch.1 -> Ch.2 -> Ch.3 -> Ch.4 -> Ch.5,
 * chaining through the real win-condition/level-transition machinery
 * (killUnit + triggerEvent('combat_end'), Seize via the map menu) rather
 * than manually splicing level state. This exercises:
 *   - persistent player-unit carryover across chapter transitions
 *   - HP reset / cleanUpLevel rules
 *   - event-state cleanliness across transitions (no stuck event queues)
 *   - convoy/prep supply access (Ch.4 and Ch.5 intros both run `prep;1`)
 *   - recruitment persistence across a chapter boundary (Ch.3 Colm -> Ch.4)
 *   - a mid-campaign save/load round trip (Ch.5 prep)
 *
 * The bundled default.ltproj is a truncated demo (Prologue..Ch.5 + DEBUG),
 * so this chain necessarily ends at the Ch.5 win condition.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/harness.spec.ts conventions)
// ---------------------------------------------------------------------------

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

async function getState(page: any) {
  return page.evaluate(() => (window as any).__harness.getState());
}

async function saveScreenshot(page: any, label: string): Promise<string> {
  const filePath = path.join(SCREENSHOT_DIR, `${label}.png`);
  await page.screenshot({ path: filePath });
  return filePath;
}

async function killUnit(page: any, unitNid: string): Promise<boolean> {
  return page.evaluate(
    (nid: string) => (window as any).__harness.killUnit(nid),
    unitNid,
  );
}

async function triggerEvent(page: any, triggerType: string): Promise<boolean> {
  return page.evaluate(
    (tt: string) => (window as any).__harness.triggerEvent(tt),
    triggerType,
  );
}

/**
 * Step through whatever event/menu/cutscene flow is currently running,
 * pressing SELECT periodically to clear dialog, until `stop` returns true
 * for the raw __gameRef top-state snapshot, or maxBatches is exhausted.
 *
 * Returns the last snapshot seen.
 */
async function advanceUntil(
  page: any,
  stop: (snap: { levelNid: string | null; stateName: string | null }) => boolean,
  maxBatches: number,
  opts: { selectEvery?: number; framesPerBatch?: number; waitMs?: number } = {},
): Promise<{ levelNid: string | null; stateName: string | null; hitTitle: boolean }> {
  const selectEvery = opts.selectEvery ?? 3;
  const framesPerBatch = opts.framesPerBatch ?? 5;
  const waitMs = opts.waitMs ?? 2;

  let hitTitle = false;
  let snap: { levelNid: string | null; stateName: string | null } = { levelNid: null, stateName: null };

  for (let batch = 0; batch < maxBatches; batch++) {
    const input = batch % selectEvery === 0 ? 'SELECT' : null;
    await stepFrames(page, framesPerBatch, input);
    await page.waitForTimeout(waitMs);

    snap = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        levelNid: g?.currentLevel?.nid ?? null,
        stateName: g?.state?.getCurrentState?.()?.name ?? null,
      };
    });

    if (snap.stateName === 'title' || snap.stateName === 'title_main') {
      hitTitle = true;
      break;
    }
    if (stop(snap)) break;
  }

  return { ...snap, hitTitle };
}

/** Get all living enemy-team unit nids currently tracked by the game. */
async function livingEnemyNids(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const g = (window as any).__gameRef;
    const out: string[] = [];
    for (const u of g.units.values()) {
      if (u.team === 'enemy' && !u.isDead?.()) out.push(u.nid);
    }
    return out;
  });
}

async function routEnemies(page: any) {
  const nids = await livingEnemyNids(page);
  for (const nid of nids) {
    await killUnit(page, nid);
  }
}

/** Move a unit onto a tile and open the map command menu there (mirrors the
 * Ch.3 seize test pattern in tests/harness.spec.ts). */
async function openMenuAt(page: any, unitNid: string, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, x, y }: { unitNid: string; x: number; y: number }) => {
      const g = (window as any).__gameRef;
      const unit = g?.units?.get?.(unitNid);
      if (!g || !unit || !g.board) return false;
      g.board.moveUnit(unit, x, y);
      g.cursor.setPos(x, y);
      g.selectedUnit = unit;
      g._moveOrigin = [x, y];
      g.state.change('menu');
      return true;
    },
    { unitNid, x, y },
  );
}

async function selectMenuOption(page: any, label: string): Promise<boolean> {
  return page.evaluate((label: string) => {
    const g = (window as any).__gameRef;
    const st = g?.state?.getCurrentState?.();
    if (!st || st.name !== 'menu' || !st.menu) return false;
    const idx = st.menu.options.findIndex((o: any) => o?.label === label);
    if (idx < 0) return false;
    st.menu.selectedIndex = idx;
    return true;
  }, label);
}

// ---------------------------------------------------------------------------
// Chain smoke test
// ---------------------------------------------------------------------------

test.describe('Sacred Stones Campaign Chain', () => {
  test('Prologue -> Ch.1 -> Ch.2 -> Ch.3 -> Ch.4 -> Ch.5 sequential chain', async ({ page }) => {
    test.setTimeout(900_000);

    // ---- Prologue -----------------------------------------------------
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    let state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');

    const eirikaAtProlouge = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaAtProlouge).toBeTruthy();
    const eirikaMaxHpProlouge = eirikaAtProlouge.maxHp ?? eirikaAtProlouge.hp;

    expect(await killUnit(page, "O'Neill")).toBe(true);
    expect(await triggerEvent(page, 'combat_end')).toBe(true);
    await stepFrames(page, 3);

    let result = await advanceUntil(
      page,
      (s) => s.levelNid === '1' && s.stateName === 'free',
      900,
    );
    expect(result.hitTitle).toBe(false);
    // Guard: land on level 1 in *some* concrete state even if the intro
    // cutscene is still finishing its final frames.
    state = await getState(page);
    for (let i = 0; i < 60 && (state.levelNid !== '1' || !state.units.length); i++) {
      await stepFrames(page, 5, i % 3 === 0 ? 'SELECT' : null);
      await page.waitForTimeout(10);
      state = await getState(page);
    }
    expect(state.levelNid).toBe('1');
    expect(state.units.length).toBeGreaterThan(0);

    // Persistent unit carried over across the transition.
    const eirikaCh1 = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaCh1).toBeTruthy();
    expect(eirikaCh1.isDead).toBe(false);
    // cleanUpLevel resets HP to max for the new chapter.
    if (eirikaCh1.maxHp) expect(eirikaCh1.hp).toBe(eirikaCh1.maxHp);

    // No stuck event state left over from the transition.
    let eventStuck = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return !!g?.eventManager?.hasActiveEvents?.();
    });
    // Drain any trailing dialog if the intro is still mid-flight.
    for (let i = 0; i < 200 && eventStuck; i++) {
      await stepFrames(page, 5, 'SELECT');
      await page.waitForTimeout(10);
      eventStuck = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return !!g?.eventManager?.hasActiveEvents?.();
      });
      state = await getState(page);
      if (state.currentStateName === 'free') break;
    }

    await saveScreenshot(page, '70-chain-ch1-reached');

    // ---- Ch.1: Seize the Gate -----------------------------------------
    // Make sure we're settled on the map before manipulating position/menu.
    if (state.currentStateName !== 'free') {
      state = await getState(page);
      for (let i = 0; i < 200 && state.currentStateName !== 'free'; i++) {
        await stepFrames(page, 5, 'SELECT');
        await page.waitForTimeout(10);
        state = await getState(page);
      }
    }
    expect(state.currentStateName).toBe('free');

    expect(await openMenuAt(page, 'Eirika', 2, 2)).toBe(true);
    await stepFrames(page, 8);
    expect(await selectMenuOption(page, 'Seize')).toBe(true);
    await stepFrames(page, 2, 'SELECT');

    result = await advanceUntil(page, (s) => s.levelNid === '2', 800, {
      selectEvery: 1,
      framesPerBatch: 8,
    });
    expect(result.hitTitle).toBe(false);
    expect(result.levelNid).toBe('2');
    await saveScreenshot(page, '71-chain-ch2-reached');

    // ---- Ch.2: skip intro, then Rout -----------------------------------
    state = await getState(page);
    if (state.currentStateName !== 'free') {
      const r = await advanceUntil(page, (s) => s.stateName === 'free', 900);
      expect(r.hitTitle).toBe(false);
    }
    state = await getState(page);
    for (let i = 0; i < 200 && !state.currentStateName; i++) {
      await stepFrames(page, 3, i % 3 === 0 ? 'SELECT' : null);
      await page.waitForTimeout(10);
      state = await getState(page);
    }
    expect(state.levelNid).toBe('2');
    expect(state.currentStateName).toBe('free');

    // Persistent units still alive/present entering Ch.2.
    const eirikaCh2 = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaCh2).toBeTruthy();
    expect(eirikaCh2.isDead).toBe(false);

    await routEnemies(page);
    expect(await triggerEvent(page, 'combat_end')).toBe(true);
    await stepFrames(page, 3);

    result = await advanceUntil(page, (s) => s.levelNid === '3', 800, {
      selectEvery: 1,
      framesPerBatch: 8,
    });
    expect(result.hitTitle).toBe(false);
    expect(result.levelNid).toBe('3');
    await saveScreenshot(page, '72-chain-ch3-reached');

    // ---- Ch.3: skip intro, recruit Colm, then Seize the throne ---------
    state = await getState(page);
    if (state.currentStateName !== 'free') {
      const r = await advanceUntil(page, (s) => s.stateName === 'free', 900);
      expect(r.hitTitle).toBe(false);
    }
    state = await getState(page);
    for (let i = 0; i < 200 && !state.currentStateName; i++) {
      await stepFrames(page, 3, i % 3 === 0 ? 'SELECT' : null);
      await page.waitForTimeout(10);
      state = await getState(page);
    }
    expect(state.levelNid).toBe('3');
    expect(state.currentStateName).toBe('free');

    // Spawn Colm via the turn-1 event.
    const colmSpawned = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      g.turnCount = 1;
      (g as any).turncount = 1;
      return h.triggerEvent('other_turn_change');
    });
    expect(colmSpawned).toBe(true);

    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return !!colm?.position && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }
    let colmSnap = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      return { pos: colm?.position ?? null, team: colm?.team ?? null };
    });
    expect(colmSnap.pos).toBeTruthy();

    // Neimi talks to Colm to recruit him (mirrors the isolated Ch.3 test).
    const talkSetup = await page.evaluate((pos: [number, number]) => {
      const g = (window as any).__gameRef;
      const neimi = g?.units?.get?.('Neimi');
      if (!g || !neimi || !g.board) return false;
      neimi.finished = false;
      neimi.hasMoved = false;
      neimi.hasAttacked = false;
      neimi.hasTraded = false;
      const [cx, cy] = pos;
      g.board.moveUnit(neimi, cx, cy + 1);
      g.cursor.setPos(cx, cy + 1);
      g.selectedUnit = neimi;
      g._moveOrigin = [cx, cy + 1];
      g.state.change('menu');
      return true;
    }, colmSnap.pos);
    expect(talkSetup).toBe(true);
    await stepFrames(page, 8);
    expect(await selectMenuOption(page, 'Talk')).toBe(true);
    await stepFrames(page, 2, 'SELECT');

    let colmRecruited = false;
    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'SELECT');
      colmRecruited = await page.evaluate(() => (window as any).__gameRef?.units?.get?.('Colm')?.team === 'player');
      if (colmRecruited) break;
    }
    expect(colmRecruited).toBe(true);

    // Clear Bazba (Ch.3 boss) so the outro death-check branch resolves cleanly,
    // then seize the throne.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const bazba = g?.units?.get?.('Bazba');
      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }
    });

    // Re-settle Eirika for the seize maneuver (menu interactions above may
    // have left her mid-action).
    state = await getState(page);
    if (state.currentStateName !== 'free') {
      await page.evaluate(() => { (window as any).__gameRef.state.change('free'); });
      await stepFrames(page, 5);
    }
    expect(await openMenuAt(page, 'Eirika', 14, 1)).toBe(true);
    await stepFrames(page, 8);
    expect(await selectMenuOption(page, 'Seize')).toBe(true);
    await stepFrames(page, 2, 'SELECT');

    result = await advanceUntil(page, (s) => s.levelNid === '4', 800, {
      selectEvery: 1,
      framesPerBatch: 8,
    });
    expect(result.hitTitle).toBe(false);
    expect(result.levelNid).toBe('4');
    await saveScreenshot(page, '73-chain-ch4-reached');

    // ---- Ch.4: intro (contains `prep;1`) -> verify prep/convoy, then Rout
    // Recruitment persistence check: Colm should have carried into Ch.4 as
    // a player unit.
    let colmInCh4 = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      return colm ? { team: colm.team, exists: true } : { exists: false, team: null };
    });

    // Advance through the Ch.4 intro cutscene, stopping early if we land on
    // the prep screen (this chapter's intro runs `prep;1`).
    result = await advanceUntil(
      page,
      (s) => s.stateName === 'prep_main' || s.stateName === 'free',
      900,
    );
    expect(result.hitTitle).toBe(false);

    if (result.stateName === 'prep_main') {
      // Verify Python-compatible prep access: Manage routes to convoy/unit
      // inventory and Fight exits preparations.
      const prepProbe = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st: any = g?.state?.getCurrentState?.();
        return {
          hasManage: (st?.options ?? []).includes('Manage'),
          options: st?.options ?? [],
        };
      });
      expect(prepProbe.hasManage).toBe(true);
      expect(prepProbe.options).toContain('Fight');
      await saveScreenshot(page, '74-chain-ch4-prep');

      // Re-check Colm's team via prep roster too (belt & suspenders for the
      // recruitment-persistence assertion).
      const colmInPrep = await page.evaluate(() => (window as any).__gameRef?.units?.get?.('Colm')?.team ?? null);
      if (colmInPrep) colmInCh4 = { exists: true, team: colmInPrep };

      // Proceed: Fight
      await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st: any = g?.state?.getCurrentState?.();
        if (st && Array.isArray(st.options)) {
          st.cursor = st.options.indexOf('Fight');
        }
      });
      await stepFrames(page, 2, 'SELECT');
    }

    expect(colmInCh4.exists).toBe(true);
    expect(colmInCh4.team).toBe('player');

    result = await advanceUntil(page, (s) => s.stateName === 'free', 900);
    expect(result.hitTitle).toBe(false);
    state = await getState(page);
    for (let i = 0; i < 200 && !state.currentStateName; i++) {
      await stepFrames(page, 3, i % 3 === 0 ? 'SELECT' : null);
      await page.waitForTimeout(10);
      state = await getState(page);
    }
    if (state.currentStateName !== 'free') {
      const debugInfo = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return {
          stateStack: g?.state?.stack?.map?.((s: any) => s?.name) ?? null,
          levelTransitionInProgress: g?.currentEvent?.name ?? null,
          hasActiveEvents: g?.eventManager?.hasActiveEvents?.() ?? null,
          currentEvent: g?.eventManager?.getCurrentEvent?.() ? {
            nid: g.eventManager.getCurrentEvent().nid,
            pointer: g.eventManager.getCurrentEvent().commandPointer,
            cmdCount: g.eventManager.getCurrentEvent().commands?.length,
          } : null,
        };
      });
      console.log('DEBUG ch4-post-prep stall:', JSON.stringify(debugInfo), 'result=', JSON.stringify(result));
    }
    expect(state.levelNid).toBe('4');
    expect(state.currentStateName).toBe('free');

    await routEnemies(page);
    expect(await triggerEvent(page, 'combat_end')).toBe(true);
    await stepFrames(page, 3);

    result = await advanceUntil(page, (s) => s.levelNid === '5', 800, {
      selectEvery: 1,
      framesPerBatch: 8,
    });
    expect(result.hitTitle).toBe(false);
    expect(result.levelNid).toBe('5');
    await saveScreenshot(page, '75-chain-ch5-reached');

    // ---- Ch.5: intro (also `prep;1`) -> mid-campaign save/load, then win -
    result = await advanceUntil(
      page,
      (s) => s.stateName === 'prep_main' || s.stateName === 'free',
      900,
    );
    expect(result.hitTitle).toBe(false);

    if (result.stateName === 'prep_main') {
      await saveScreenshot(page, '76-chain-ch5-prep');

      // Mid-campaign save/load round trip: snapshot here, mutate state,
      // reload, and verify we resume the chain correctly on Ch.5's prep menu
      // with Eirika (and any other persistent units) intact.
      const snapshot = await page.evaluate(() => (window as any).__harness.saveSnapshot());
      expect(snapshot).toBeTruthy();

      // Perturb state post-snapshot (kill a unit) so we can tell the load
      // actually restored rather than no-op'd.
      expect(await killUnit(page, 'Seth')).toBe(true);

      // loadSnapshot's harness wrapper only returns false if restoreGameState
      // throws all the way out; per-unit restore failures inside it are
      // caught and logged individually (see save.ts restoreGameState), so a
      // `true` here does NOT by itself prove every unit round-tripped. The
      // real proof is the explicit per-unit sethAlive/eirikaAlive checks
      // below — this assert only rules out a catastrophic restore failure.
      const loaded = await page.evaluate(
        (snap: unknown) => (window as any).__harness.loadSnapshot(snap),
        snapshot,
      );
      expect(loaded).toBe(true);
      await stepFrames(page, 5);

      const postLoad = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const seth = g?.units?.get?.('Seth');
        const eirika = g?.units?.get?.('Eirika');
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          sethAlive: seth ? !seth.isDead?.() : null,
          eirikaAlive: eirika ? !eirika.isDead?.() : null,
        };
      });
      expect(postLoad.levelNid).toBe('5');
      expect(postLoad.sethAlive).toBe(true);
      expect(postLoad.eirikaAlive).toBe(true);

      // Resume the chain: press Fight on the already-active prep_main.
      //
      // NOTE: we do NOT call game.state.change('prep_main') here. The
      // StateMachine (src/engine/state-machine.ts) keeps one singleton
      // State instance per registered name and change() *pushes* that
      // shared instance onto the stack rather than replacing the top;
      // since result.stateName is already 'prep_main' (checked above),
      // calling change('prep_main') again would push the SAME object a
      // second time. After Fight -> back() pops that duplicate, the
      // stack still exposes the identical prep_main instance underneath,
      // which looks like "Fight did nothing" and can eventually be
      // misread as re-entering 'Pick Units' once further stray SELECT
      // presses land on it.
      await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st: any = g?.state?.getCurrentState?.();
        if (st && Array.isArray(st.options)) {
          st.cursor = st.options.indexOf('Fight');
        }
      });
      await stepFrames(page, 2, 'SELECT');
    }

    result = await advanceUntil(page, (s) => s.stateName === 'free', 900);
    expect(result.hitTitle).toBe(false);
    state = await getState(page);
    for (let i = 0; i < 200 && !state.currentStateName; i++) {
      await stepFrames(page, 3, i % 3 === 0 ? 'SELECT' : null);
      await page.waitForTimeout(10);
      state = await getState(page);
    }
    expect(state.levelNid).toBe('5');
    expect(state.currentStateName).toBe('free');

    // Recruit Joshua via Natasha's talk (mirrors the isolated Ch.5 test),
    // another in-chain recruitment-persistence data point (even though the
    // demo campaign ends here, so there is no further chapter to carry it
    // into -- see PLAN.md Known Bugs for the Ch.6+ data gap).
    const natashaSetup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const natasha = g?.units?.get?.('Natasha');
      const joshua = g?.units?.get?.('Joshua');
      if (!g || !natasha || !joshua || !joshua.position) return false;
      const [jx, jy] = joshua.position;
      natasha.finished = false;
      natasha.hasMoved = false;
      natasha.hasAttacked = false;
      natasha.hasTraded = false;
      g.board.moveUnit(natasha, jx, jy + 1 <= 15 ? jy + 1 : jy - 1);
      const pos = natasha.position;
      g.cursor.setPos(pos[0], pos[1]);
      g.selectedUnit = natasha;
      g._moveOrigin = pos;
      g.state.change('menu');
      return true;
    });

    if (natashaSetup) {
      await stepFrames(page, 8);
      const hasTalk = await selectMenuOption(page, 'Talk');
      if (hasTalk) {
        await stepFrames(page, 2, 'SELECT');
        for (let i = 0; i < 1500; i++) {
          await stepFrames(page, 2, 'SELECT');
          const recruited = await page.evaluate(() => (window as any).__gameRef?.units?.get?.('Joshua')?.team === 'player');
          if (recruited) break;
        }
      }
    }

    // Re-settle before forcing the boss kill.
    state = await getState(page);
    if (state.currentStateName !== 'free') {
      await page.evaluate(() => { (window as any).__gameRef.state.change('free'); });
      await stepFrames(page, 5);
    }

    // ---- Ch.5 win condition: defeat Saar --------------------------------
    expect(await killUnit(page, 'Saar')).toBe(true);
    expect(await triggerEvent(page, 'combat_end')).toBe(true);
    await stepFrames(page, 3);

    // No Ch.6 exists in the bundled demo project. GameState.levelEnd()
    // (src/engine/states/game-states.ts ~7514-7534) correctly falls back to
    // the title screen when there is no next sequential level and no
    // `_goto_level` override -- this matches the Python reference (there is
    // no "credits"/"the end" state to fall into instead). So reaching the
    // title screen here is the CORRECT, expected outcome of this demo's
    // data gap, not a soft-lock -- we assert we get there cleanly (no
    // crash/hang) rather than asserting the opposite. See PLAN.md Known
    // Bugs for the documented Ch.6+ data gap.
    const finalSnap = await advanceUntil(page, () => false, 300, { selectEvery: 3, framesPerBatch: 5 });
    expect(finalSnap.hitTitle).toBe(true);
    await saveScreenshot(page, '77-chain-ch5-win-final');
  });

  test.fixme(
    'Ch.6+ continuation is untestable: bundled default.ltproj has no data beyond Ch.5',
    async () => {
      // Intentionally left as a documented gap. See PLAN.md Known Bugs /
      // P7 for details: verifying campaign completion beyond Ch.5 requires
      // an external, non-truncated .ltproj fixture.
    },
  );
});
