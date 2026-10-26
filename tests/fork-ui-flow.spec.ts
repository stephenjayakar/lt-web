import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF engine-fork UI/flow customizations (temp/forkdiff-ui.md rows 1-6,
 * 8-10, 17-21): each is gated on isForkEngine(), so the default project
 * keeps upstream lt-maker behaviour.
 */

async function boot(page: Page, query: string): Promise<void> {
  await page.goto(`/?harness=true&clean=true&bundle=false&${query}`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 90_000,
  });
  // Tests import the state modules directly; point them at the live game.
  await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    (await import('/src/engine/states/game-states.ts')).setGameRef(game);
    (await import('/src/engine/states/manage-state.ts')).setManageGameRef(game);
    (await import('/src/engine/states/supply-state.ts')).setSupplyGameRef(game);
    (await import('/src/engine/states/settings-state.ts')).setSettingsGameRef(game);
    (await import('/src/ui/help-menu.ts')).setHelpMenuGameRef(game);
  });
}

const bootEotf = (page: Page, level = 'X') => boot(page, `project=eotf.ltproj&level=${level}`);

test.describe('EOtF fork map menus and Canto', () => {
  test('option menu has no Save/Suspend on the Safe Location hub', async ({ page }) => {
    await bootEotf(page);
    const labels = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { OptionMenuState } = await import('/src/engine/states/game-states.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const read = () => {
        const state: any = new OptionMenuState();
        state.begin();
        return state.menu.options.map((o: any) => o.label);
      };
      const hub = read();
      setForkEngine(false);
      const upstream = read();
      setForkEngine(true);
      return { level: game.currentLevel?.nid, hub, upstream };
    });
    expect(labels.level).toBe('X');
    expect(labels.hub).not.toContain('Save');
    expect(labels.hub).not.toContain('Suspend');
    expect(labels.upstream.some((l: string) => l === 'Save' || l === 'Suspend')).toBe(true);
  });

  test('Canto BACK and own-tile SELECT wait the unit; canto Wait is not actively chosen', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { MoveState, CantoWaitState } = await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Player');
      const waits: unknown[] = [];
      const trigger = game.eventManager.trigger.bind(game.eventManager);
      game.eventManager.trigger = (t: any, ctx: any) => {
        if (t.type === 'unit_wait') waits.push(t.localArgs?.get('actively_chosen'));
        return trigger(t, ctx);
      };
      const reset = () => {
        unit.finished = false;
        unit.hasAttacked = true;
        unit.hasTraded = false;
        game.selectedUnit = unit;
      };

      reset();
      const back: any = new MoveState();
      back.begin();
      back.takeInput('BACK');
      const afterBack = unit.finished;

      reset();
      const select: any = new MoveState();
      select.begin();
      game.cursor.setPos(unit.position[0], unit.position[1]);
      select.takeInput('SELECT');
      const afterSelect = unit.finished;

      reset();
      const canto: any = new CantoWaitState();
      canto.start();
      const cantoOptions = canto.menu.options.map((o: any) => o.label);
      canto.takeInput('SELECT');
      const afterCanto = unit.finished;
      game.eventManager.trigger = trigger;
      return { afterBack, afterSelect, afterCanto, cantoOptions, waits };
    });
    expect(result).toEqual({
      afterBack: true,
      afterSelect: true,
      afterCanto: true,
      cantoOptions: ['Wait'],
      waits: [false, false, false],
    });
  });
});

test.describe('EOtF fork item menus', () => {
  test('item child menu: Storage whenever the convoy is on, no Trade', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemMenuState } = await import('/src/engine/states/game-states.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Player');
      const ally = game.units.get('Keeper');
      const item = new ItemObject(game.db.items.get('Iron_Sword') ?? [...game.db.items.values()][0]);
      item.owner = unit;
      const oldItems = unit.items;
      unit.items = [item];
      // A trade partner next to the unit, far from any supply unit.
      const oldAllyPos = ally?.position;
      const oldAllyTeam = ally?.team;
      if (ally) {
        game.board.removeUnit?.(ally);
        ally.team = 'player';
        ally.position = [unit.position[0] + 1, unit.position[1]];
        game.board.setUnit?.(ally.position[0], ally.position[1], ally);
      }
      game.gameVars.set('_convoy', true);
      const state: any = new ItemMenuState();
      const fork = state.childOptions(unit, item);
      setForkEngine(false);
      const upstream = state.childOptions(unit, item);
      setForkEngine(true);
      game.gameVars.set('_convoy', false);
      const noConvoy = state.childOptions(unit, item);
      unit.items = oldItems;
      if (ally) {
        game.board.removeUnit?.(ally);
        ally.team = oldAllyTeam;
        ally.position = oldAllyPos;
        if (oldAllyPos) game.board.setUnit?.(oldAllyPos[0], oldAllyPos[1], ally);
      }
      return { fork, upstream, noConvoy };
    });
    expect(result.fork).toContain('Storage');
    expect(result.fork).not.toContain('Trade');
    expect(result.noConvoy).toContain('Discard');
    // Upstream: long_range_storage defaults to True (constant absent).
    expect(result.upstream).toContain('Storage');
    expect(result.upstream).toContain('Trade');
  });

  test('forced discard stores whenever the convoy is on, with no accessory filter', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemDiscardState } = await import('/src/engine/states/supply-state.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Player');
      const weapon = new ItemObject([...game.db.items.values()].find((i: any) =>
        !i.components.some((c: any) => c[0] === 'accessory' || c[0] === 'locked')));
      const accessory = new ItemObject(game.db.items.get('Alert_Charm'));
      const oldItems = unit.items;
      unit.items = [weapon, accessory];
      game.gameVars.set('_convoy', true);
      const run = () => {
        const state: any = new ItemDiscardState();
        state.unit = unit;
        state.newItem = accessory;
        state.computeMode();
        state.buildMenu();
        return { mode: state.mode, enabled: state.menu.options.map((o: any) => o.enabled) };
      };
      const fork = run();
      setForkEngine(false);
      const upstream = run();
      setForkEngine(true);
      unit.items = oldItems;
      return { fork, upstream };
    });
    expect(result.fork).toEqual({ mode: 'storage', enabled: [true, true] });
    // Upstream greys out the new item and other-class items.
    expect(result.upstream).toEqual({ mode: 'storage', enabled: [false, false] });
  });

  test('c_uses items draw purple uses and eval_weight feeds the help Wt', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { itemOptionColors } = await import('/src/ui/prep-ui.ts');
      const { ItemHelpDialog } = await import('/src/ui/help-menu.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Player');
      const soul = new ItemObject(game.db.items.get('Soul_Blade'));
      soul.owner = unit;
      const fork = itemOptionColors(game, soul, false, unit);
      setForkEngine(false);
      const upstream = itemOptionColors(game, soul, false, unit);
      setForkEngine(true);
      const blades = [0, 1].map(() => new ItemObject(game.db.items.get('Tri_Blade')));
      const oldItems = unit.items;
      unit.items = [...blades];
      blades.forEach((b) => { b.owner = unit; });
      const help: any = new ItemHelpDialog(blades[0], unit);
      const weight = help.vals[2];
      unit.items = oldItems;
      return { fork, upstream, weight };
    });
    expect(result.fork).toEqual([null, 'purple']);
    expect(result.upstream[1]).not.toBe('purple');
    expect(result.weight).toBe(16);
  });
});

test.describe('EOtF fork prep, shop, title and settings', () => {
  test('Temporary units cannot be managed or traded with', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ManageState, ManageSelectState, TradeSelectState } = await import('/src/engine/states/manage-state.ts');
      const unit = game.units.get('Player');
      unit.tags.push('Temporary');
      const table = { getCurrentUnit: () => unit, update() {}, currentIndex: 0, fakeCursorIdx: 0 } as any;
      const changes: string[] = [];
      const change = game.state.change.bind(game.state);
      game.state.change = (name: string) => { changes.push(name); };

      const manage: any = new ManageState();
      manage.menu = table;
      manage.takeInput('SELECT');

      game.memory.set('manage_menu', table);
      game.memory.set('current_unit', game.units.get('Termina') ?? unit);
      const trade: any = new TradeSelectState();
      trade.start();
      trade.takeInput('SELECT');

      game.memory.set('current_unit', unit);
      game.gameVars.set('_convoy', true);
      const select: any = new ManageSelectState();
      select.start();
      const ignore = select.getIgnore();
      const topleft = select.selectMenu.topleft;
      const forkChanges = [...changes];
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      setForkEngine(false);
      manage.takeInput('SELECT');
      game.memory.set('current_unit', game.units.get('Termina') ?? unit);
      trade.takeInput('SELECT');
      setForkEngine(true);
      game.state.change = change;
      unit.tags.splice(unit.tags.indexOf('Temporary'), 1);
      return { forkChanges, changes, itemsIgnored: ignore[4], topleft };
    });
    expect(result.forkChanges).toEqual([]);
    expect(result.changes).toEqual(['prep_manage_select', 'prep_trade']);
    expect(result.itemsIgnored).toBe(true);
    expect(result.topleft).toEqual([120, 74]);
  });

  test('shop says shop_max when hands are full', async ({ page }) => {
    await bootEotf(page);
    const key = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ShopState } = await import('/src/engine/states/game-states.ts');
      game.shopUnit = game.units.get('Player');
      game.shopItems = [];
      const shop: any = new ShopState();
      shop.start();
      return shop.messages.max_inventory;
    });
    expect(key).toBe('shop_max');
  });

  test('title: no Restart Level, Credits_Title credits, ending panorama', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { TitleMainState, TitleExtrasState } = await import('/src/engine/states/game-states.ts');
      const { titleBackgroundNid } = await import('/src/ui/title-menu.ts');
      const { RECORDS } = await import('/src/engine/records.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const main: any = new TitleMainState();
      main.hasSaveData = true;
      main.rebuildOptions();
      const forkOptions = [...main.options];
      setForkEngine(false);
      main.rebuildOptions();
      const upstreamOptions = [...main.options];
      setForkEngine(true);

      const triggered: string[] = [];
      const triggerSpecific = game.eventManager.triggerSpecific.bind(game.eventManager);
      game.eventManager.triggerSpecific = (nid: string) => { triggered.push(nid); return true; };
      const change = game.state.change.bind(game.state);
      game.state.change = () => {};
      const extras: any = new TitleExtrasState();
      extras.start();
      extras.phase = 'normal';
      extras.menu.moveDown();
      extras.takeInput('SELECT');
      game.eventManager.triggerSpecific = triggerSpecific;
      game.state.change = change;

      const before = titleBackgroundNid();
      RECORDS.set('True_Ending_Cleared', true);
      const trueEnding = titleBackgroundNid();
      RECORDS.set('Extra_Ending_Cleared', true);
      const extraEnding = titleBackgroundNid();
      RECORDS.delete('True_Ending_Cleared');
      RECORDS.delete('Extra_Ending_Cleared');
      return { forkOptions, upstreamOptions, triggered, before, trueEnding, extraEnding };
    });
    expect(result.forkOptions).toEqual(['Load Game', 'New Game', 'Extras']);
    expect(result.upstreamOptions).toEqual(['Load Game', 'Restart Level', 'New Game', 'Extras']);
    expect(result.triggered).toEqual(['Global Credits_Title']);
    expect(result).toMatchObject({
      before: 'title_background',
      trueEnding: 'title_background_2',
      extraEnding: 'title_background',
    });
  });

  test('settings list mirrors the fork and pins hidden animation settings', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const { SettingsMenuState, getSetting, setSetting } = await import('/src/engine/states/settings-state.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const names = () => {
        const state: any = new SettingsMenuState();
        state.start();
        return state.settings.map((d: any) => d.name);
      };
      setSetting('animation', 'Never');
      const fork = names();
      const forkAnimation = getSetting('animation');
      const windowDisplay = getSetting('window_display');
      setForkEngine(false);
      const upstream = names();
      const upstreamAnimation = getSetting('animation');
      setForkEngine(true);
      setSetting('animation', 'Always');
      return { fork, upstream, forkAnimation, upstreamAnimation, windowDisplay };
    });
    expect(result.fork).not.toContain('animation');
    expect(result.fork).not.toContain('battle_bg');
    expect(result.fork).not.toContain('display_hints');
    expect(result.fork.indexOf('window_display')).toBe(result.fork.indexOf('grid_opacity') + 1);
    expect(result.upstream).toContain('animation');
    expect(result.upstream).not.toContain('window_display');
    expect(result.forkAnimation).toBe('Always');
    expect(result.upstreamAnimation).toBe('Never');
    expect(result.windowDisplay).toBe(1);
  });

  test('window_display skin resolves the suffixed menu sprites', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const { skinnedSpriteName } = await import('/src/ui/sprites.ts');
      const { setSetting } = await import('/src/engine/states/settings-state.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const names = ['menu_bg_base', 'menu_gem_small', 'menu_shimmer2', 'funds_display',
        'tile_info_quick_opaque', 'sound_player', 'menu_shimmer3', 'menu_bg_brown'];
      setSetting('window_display', 3);
      const skin3 = names.map(skinnedSpriteName);
      setSetting('window_display', 1);
      const skin1 = names.map(skinnedSpriteName);
      setForkEngine(false);
      const upstream = names.map(skinnedSpriteName);
      setForkEngine(true);
      return { skin1, skin3, upstream, names };
    });
    expect(result.skin1).toEqual(['menu_bg_base1', 'menu_gem_small1', 'menu_shimmer21', 'funds_display1',
      'tile_info_quick_opaque1', 'sound_player1', 'menu_shimmer3', 'menu_bg_brown']);
    // Skin 3 ships no sound_player3: fall back to the bare sprite.
    expect(result.skin3).toEqual(['menu_bg_base3', 'menu_gem_small3', 'menu_shimmer23', 'funds_display3',
      'tile_info_quick_opaque3', 'sound_player', 'menu_shimmer3', 'menu_bg_brown']);
    expect(result.upstream).toEqual(result.names);
  });
});
