import { expect, test } from '@playwright/test';

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 60_000,
  });
}

test.describe('save compatibility and failure reporting', () => {
  test('supports legacy versions and rejects malformed or future versions', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { validateSaveVersion } = await import('/src/engine/save.ts');
      const accepts: string[] = [];
      for (const version of [undefined, '0.9.0', '1.7.3']) {
        validateSaveVersion(version);
        accepts.push(version ?? 'unversioned');
      }
      const errors: string[] = [];
      for (const version of ['future', '2.0.0']) {
        try {
          validateSaveVersion(version);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { accepts, errors };
    });
    expect(result).toEqual({
      accepts: ['unversioned', '0.9.0', '1.7.3'],
      errors: [
        'Save has an invalid version "future"',
        'Save version 2.0.0 is newer than supported version 1.0.0',
      ],
    });
  });

  test('rejects unknown state and event references before mutating the game', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const snapshot = harness.saveSnapshot();
      const unitCount = game.units.size;

      const unknownState = structuredClone(snapshot);
      unknownState.stateStack.push('_removed_state');
      const stateLoaded = await harness.loadSnapshot(unknownState);
      const afterStateUnits = game.units.size;

      const unknownEvent = structuredClone(snapshot);
      unknownEvent.eventQueue = [{
        nid: '_removed_event',
        trigger: { type: 'test' },
        commandPointer: 0,
        state: 'running',
        currentDialog: null,
        waitingForInput: false,
      }];
      const eventLoaded = await harness.loadSnapshot(unknownEvent);
      const afterEventUnits = game.units.size;

      const corrupt = structuredClone(snapshot);
      delete corrupt.units;
      const corruptLoaded = await harness.loadSnapshot(corrupt);
      return {
        stateLoaded,
        eventLoaded,
        corruptLoaded,
        unitCount,
        afterStateUnits,
        afterEventUnits,
      };
    });
    expect(result).toEqual({
      stateLoaded: false,
      eventLoaded: false,
      corruptLoaded: false,
      unitCount: result.unitCount,
      afterStateUnits: result.unitCount,
      afterEventUnits: result.unitCount,
    });
  });

  test('load menu displays the concrete future-version error', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const save = await import('/src/engine/save.ts');
      await save.saveGame(game, 0, 'battle');
      const gameNid = game.db.getConstant('game_nid', 'default');

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('lt-web-saves', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('saves', 'readwrite');
          const get = tx.objectStore('saves').get(`${gameNid}-0.meta`);
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            tx.objectStore('saves').put(
              { ...get.result, version: '99.0.0' },
              `${gameNid}-0.meta`,
            );
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });

      game.state.change('load_menu');
      (window as any).__harness.stepFrames(2, null);
      for (let index = 0; index < 30; index++) {
        const state = game.state.getCurrentState() as any;
        if (state?.name === 'load_menu' && !state.loading) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
        (window as any).__harness.stepFrames(1, null);
      }
      const state = game.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex(
        (option: any) => option.value === '0',
      );
      state.takeInput('SELECT');
      for (let index = 0; index < 30 && state.restoring; index++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const output = {
        state: state.name,
        message: state.message,
        lastError: save.getLastLoadError(),
      };
      await save.deleteSave(gameNid, 0);
      return output;
    });

    expect(result).toEqual({
      state: 'load_menu',
      message: 'Load failed: Save version 99.0.0 is newer than supported version 1.0.0',
      lastError: 'Save version 99.0.0 is newer than supported version 1.0.0',
    });
  });
});
