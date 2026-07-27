/**
 * roam-overworld.spec.ts -- Free-roam talk/shop interaction and overworld
 * option menu parity tests (P5 slice).
 *
 * Reference:
 *   lt-maker/app/engine/roam/free_roam_state.py
 *   lt-maker/app/engine/overworld/overworld_states.py
 *
 * Uses the harness's raw window.__gameRef to construct minimal fixtures
 * directly (talk pairs, event prefabs, regions, a synthetic overworld),
 * the same approach as the "Event command parity" test in harness.spec.ts,
 * since the default DEBUG project ships no overworld/shop-region data.
 */

import { test, expect } from '@playwright/test';
import type { ItemPrefab, SkillPrefab } from '../src/data/types';

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

test.describe('Roam talk interaction', () => {
  test('SELECT talks to the nearest talk-eligible unit within taxicab range', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const eirika = game.units.get('Eirika');
      const others = [...game.units.values()].filter((u: any) => u !== eirika && u.position);
      if (!eirika || others.length < 2) return { ok: false };

      const near = others[0];
      const far = others[1];

      // Roam unit at (5,5). `near` sits adjacent (taxicab distance 1, inside
      // TALK_RANGE 1.2). `far` sits two tiles away (taxicab distance 2,
      // outside TALK_RANGE) despite also having a talk pair registered --
      // this exercises free_roam_state.py's utils.calculate_distance
      // (taxicab, not Euclidean) cutoff.
      eirika.position = [5, 5];
      near.position = [6, 5];
      far.position = [7, 5];

      game.eventManager.addTalkPair('Eirika', near.nid);
      game.eventManager.addTalkPair('Eirika', far.nid);

      // Two on_talk prefabs, each gated to a specific talk pair via
      // check_pair() (the same idiom Python projects use in event
      // conditions), so we can tell which candidate actually got picked.
      const nearPrefab = {
        nid: '_test_talk_near',
        name: 'Talk Near',
        trigger: 'on_talk',
        level_nid: '',
        condition: `check_pair('Eirika','${near.nid}')`,
        only_once: false,
        priority: 0,
        _source: [`set_game_var;_talked_to;${near.nid}`],
      };
      const farPrefab = {
        nid: '_test_talk_far',
        name: 'Talk Far',
        trigger: 'on_talk',
        level_nid: '',
        condition: `check_pair('Eirika','${far.nid}')`,
        only_once: false,
        priority: 0,
        _source: [`set_game_var;_talked_to;${far.nid}`],
      };
      game.eventManager.allEvents.set(nearPrefab.nid, nearPrefab);
      game.eventManager.allEvents.set(farPrefab.nid, farPrefab);

      game.roamInfo.roam = true;
      game.roamInfo.roamUnitNid = 'Eirika';
      game.state.change('free_roam');

      return { ok: true, nearNid: near.nid, farNid: far.nid };
    });

    expect(setup.ok).toBe(true);
    await stepFrames(page, 5);

    const beforeState = await getState(page);
    expect(beforeState.currentStateName).toBe('free_roam');

    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        talkedTo: game.gameVars.get('_talked_to') ?? null,
        stateName: game.state.getCurrentState()?.name ?? null,
      };
    });

    // The nearer unit (taxicab distance 1) should have been the talk target,
    // not the farther one (taxicab distance 2, outside TALK_RANGE).
    expect(result.talkedTo).toBe(setup.nearNid);
    expect(result.talkedTo).not.toBe(setup.farNid);
  });

  test('roam triggers reach level-scoped events, not just global ones', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Real projects scope their events to a level; EotF's authored talks all
    // carry level_nid. findMatchingEvents drops every level-scoped event when
    // the trigger has no levelNid, so a roam trigger that omits it silently
    // matches nothing — while a global (level_nid: '') fixture still passes.
    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const eirika = game.units.get('Eirika');
      const near = [...game.units.values()].find((u: any) => u !== eirika && u.position);
      if (!eirika || !near) return { ok: false, levelNid: null };

      eirika.position = [5, 5];
      near.position = [6, 5];
      game.eventManager.addTalkPair('Eirika', near.nid);

      const levelNid = game.currentLevel?.nid;
      const prefab = {
        nid: '_test_talk_level_scoped',
        name: 'Talk Level Scoped',
        trigger: 'on_talk',
        level_nid: levelNid,
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['set_game_var;_scoped_talk;yes'],
      };
      game.eventManager.allEvents.set(prefab.nid, prefab);

      game.roamInfo.roam = true;
      game.roamInfo.roamUnitNid = 'Eirika';
      game.state.change('free_roam');
      return { ok: true, levelNid };
    });

    expect(setup.ok).toBe(true);
    expect(setup.levelNid).toBeTruthy();
    await stepFrames(page, 5);
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    const talked = await page.evaluate(() =>
      (window as any).__gameRef.gameVars.get('_scoped_talk') ?? null);
    expect(talked).toBe('yes');
  });
});

test.describe('Roam shop interaction', () => {
  test('SELECT on a Shop region opens the vendor UI via region sub_nid fallback', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const eirika = game.units.get('Eirika');
      if (!eirika) return { ok: false };

      eirika.position = [3, 3];
      const startingItemCount = eirika.items.length;
      game.gameVars.set('money', 1000);
      game.getParty().money = 1000;

      const region = {
        nid: '_test_shop_region',
        region_type: 'event',
        sub_nid: 'Shop',
        position: [3, 3],
        size: [1, 1],
        condition: '',
        only_once: false,
      };
      if (!game.currentLevel.regions) game.currentLevel.regions = [];
      game.currentLevel.regions.push(region);

      const shopPrefab = {
        nid: '_test_shop_event',
        name: 'Shop Event',
        trigger: 'Shop',
        level_nid: '',
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['shop;Eirika;Iron_Sword'],
      };
      game.eventManager.allEvents.set(shopPrefab.nid, shopPrefab);

      // Make room in the inventory so the purchase isn't rejected for being full.
      while (eirika.items.length >= 4) eirika.items.pop();

      game.roamInfo.roam = true;
      game.roamInfo.roamUnitNid = 'Eirika';
      game.state.change('free_roam');

      return { ok: true, startingItemCount: eirika.items.length };
    });

    expect(setup.ok).toBe(true);
    await stepFrames(page, 5);
    expect((await getState(page)).currentStateName).toBe('free_roam');

    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 15);

    const opened = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const shopState = game.state.getCurrentState();
      return {
        stateName: shopState?.name ?? null,
        // ShopState.begin() copies these onto private fields and clears the
        // transient game.shopUnit/game.shopItems -- read the live state
        // instance instead of the (now-cleared) transient game fields.
        shopUnitNid: shopState?.unit?.nid ?? null,
        shopItemNids: (shopState?.shopItems ?? []).map((it: any) => it.nid),
      };
    });

    expect(opened.stateName).toBe('shop');
    expect(opened.shopUnitNid).toBe('Eirika');
    expect(opened.shopItemNids).toContain('Iron_Sword');

    // Complete an actual purchase: SELECT on the 'Buy' choice, then SELECT
    // on the first (only) item to buy it -- verifies "purchasing works",
    // not just that the vendor UI opened.
    await stepFrames(page, 3, 'SELECT'); // choice -> buy phase
    await stepFrames(page, 3);
    await stepFrames(page, 3, 'SELECT'); // buy the highlighted item
    await stepFrames(page, 5);

    const afterBuy = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const eirika = game.units.get('Eirika');
      return {
        money: Number(game.gameVars.get('money') ?? 0),
        itemNids: eirika.items.map((it: any) => it.nid),
      };
    });

    expect(afterBuy.money).toBeLessThan(1000);
    expect(afterBuy.itemNids).toContain('Iron_Sword');
    expect(afterBuy.itemNids.length).toBe(setup.startingItemCount + 1);
  });

  test('shop price hooks honor overrides, durability, modifiers, and final truncation', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const setup = await page.evaluate(async () => {
      const game = Reflect.get(window, '__gameRef');
      const unit = game.units.get('Eirika');
      if (!unit) return false;

      // This callback runs in Chromium, so runtime classes must come from Vite's browser module graph.
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const itemPrefab = (
        nid: string,
        value: number,
        includeUses: boolean,
      ): ItemPrefab => ({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: includeUses ? [['value', value], ['uses', 3]] : [['value', value]],
      });
      const skillPrefab = (nid: string, components: SkillPrefab['components']): SkillPrefab => ({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components,
      });

      const basePrefab = itemPrefab('_PriceBase', 100, true);
      game.db.items.set(basePrefab.nid, basePrefab);
      game.db.items.set('_PriceOverrideFirst', itemPrefab('_PriceOverrideFirst', 89, false));
      game.db.items.set('_PriceOverrideLast', itemPrefab('_PriceOverrideLast', 101, false));
      game.db.items.set('_PriceOverrideInactive', itemPrefab('_PriceOverrideInactive', 999, false));
      game.db.constants.set('sell_modifier', 0.4);

      unit.skills = [
        new SkillObject(skillPrefab('_PriceFirst', [
          ['item_override', '_PriceOverrideFirst'],
          ['change_buy_price', 0.4],
          ['change_sell_price', 0.5],
        ])),
        new SkillObject(skillPrefab('_PriceLast', [
          ['item_override', '_PriceOverrideLast'],
          ['change_buy_price', 0.8],
          ['change_sell_price', 0.75],
        ])),
        new SkillObject(skillPrefab('_PriceInactive', [
          ['item_override', '_PriceOverrideInactive'],
          ['change_buy_price', 0.1],
          ['change_sell_price', 0.1],
          ['condition', 'False'],
        ])),
      ];

      const shopItem = new ItemObject(basePrefab);
      const sellItem = new ItemObject(basePrefab);
      shopItem.setUses(2);
      sellItem.setUses(2);
      sellItem.owner = unit;
      unit.items = [sellItem];
      game.memory.set('_price_sell_item', sellItem);
      game.gameVars.set('money', 1000);
      game.getParty().money = 1000;
      game.shopUnit = unit;
      game.shopItems = [shopItem];
      game.shopStock = [-1];
      game.state.change('shop');
      return true;
    });

    expect(setup).toBe(true);
    await stepFrames(page, 3);

    const prices = await page.evaluate(async () => {
      const game = Reflect.get(window, '__gameRef');
      const shopState = game.state.getCurrentState();
      const unit = game.units.get('Eirika');
      const shopItem = Reflect.get(shopState, 'shopItems')[0];
      const sellItem = game.memory.get('_price_sell_item');
      // Browser-side import exposes the exact dispatch functions used by ShopState.
      const itemSystem = await import('/src/combat/item-system.ts');

      const full = Reflect.get(shopState, 'getFullPrice').call(shopState, shopItem);
      const buy = Reflect.get(shopState, 'getBuyPrice').call(shopState, shopItem);
      const sell = Reflect.get(shopState, 'getSellPrice').call(shopState, sellItem);
      const convoyFull = itemSystem.fullPrice(null, shopItem, game.db, game);
      const convoyBuy = itemSystem.buyPrice(null, shopItem, game.db, game);
      const convoySell = itemSystem.sellPrice(null, shopItem, game.db, game);
      const depletedItem = new shopItem.constructor(game.db.items.get('_PriceBase'));
      depletedItem.setUses(0);
      const depletedBuy = itemSystem.buyPrice(null, depletedItem, game.db, game);

      Reflect.get(shopState, 'tryBuyItem').call(shopState, game);
      const moneyAfterBuy = Number(game.gameVars.get('money'));
      Reflect.get(shopState, 'trySellItem').call(shopState, game, [sellItem]);
      const moneyAfterSell = Number(game.gameVars.get('money'));

      return {
        stateName: shopState.name,
        full,
        buy,
        sell,
        convoyFull,
        convoyBuy,
        convoySell,
        depletedBuy,
        moneyAfterBuy,
        moneyAfterSell,
        inventoryNids: unit.items.map((item: { nid: string }) => item.nid),
      };
    });

    expect(prices.stateName).toBe('shop');
    expect(prices.full).toBe(101);
    expect(prices.buy).toBe(53);
    expect(prices.sell).toBe(20);
    expect(prices.convoyFull).toBe(100);
    expect(prices.convoyBuy).toBeCloseTo(200 / 3);
    expect(prices.convoySell).toBeCloseTo(80 / 3);
    expect(prices.depletedBuy).toBe(100);
    expect(prices.moneyAfterBuy).toBe(947);
    expect(prices.moneyAfterSell).toBe(967);
    expect(prices.inventoryNids).toEqual(['_PriceBase']);
  });
});

test.describe('Overworld option menus', () => {
  async function setupOverworld(page: any) {
    return page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { OverworldManager } = await import('/src/engine/overworld/overworld-manager.ts');

      const prefab = {
        nid: '_test_overworld',
        name: 'Test Overworld',
        tilemap: null,
        music: null,
        overworld_nodes: [
          {
            nid: 'Node1',
            name: 'Home Node',
            pos: [2, 2],
            icon: '',
            level: null,
            menu_options: [
              { nid: 'CustomOpt', event: '_test_overworld_menu_event', option_name: 'Custom Option', visible: true, enabled: true },
            ],
          },
        ],
        map_paths: {},
        border_tile_width: 0,
      };

      const ow = new OverworldManager(prefab as any);
      ow.enableNode('Node1');
      ow.createEntity('PartyEntity', 'party', 'Eirika', 'player', 'Node1');
      ow.selectEntity('PartyEntity');
      game.overworldController = ow;

      const menuEventPrefab = {
        nid: '_test_overworld_menu_event',
        name: 'Custom Overworld Option',
        trigger: 'overworld_menu',
        level_nid: '',
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['set_game_var;_custom_opt_fired;true'],
      };
      game.eventManager.allEvents.set(menuEventPrefab.nid, menuEventPrefab);

      game.cursor.setMapSize?.(20, 20);
      game.camera.setMapSize?.(20, 20);
      game.state.change('overworld');
      return true;
    });
  }

  test('selecting empty space opens the game option menu with Options/Save, and BACK cancels', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await setupOverworld(page);
    await stepFrames(page, 5);
    expect((await getState(page)).currentStateName).toBe('overworld');

    // Move the cursor to an empty tile (no node there) and select it.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.cursor.setPos(10, 10);
    });
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    const afterOpen = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState();
      return {
        name: state?.name,
        options: state?.menu?.options?.map((o: any) => o.value) ?? [],
      };
    });
    expect(afterOpen.name).toBe('overworld_game_option_menu');
    expect(afterOpen.options).toContain('options');
    expect(afterOpen.options).toContain('save');
    // Unit/Status are deferred (not yet implemented upstream either).
    expect(afterOpen.options).toContain('unit');
    expect(afterOpen.options).toContain('status');

    // BACK cancels back to the overworld.
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 5);
    expect((await getState(page)).currentStateName).toBe('overworld');
  });

  test('selecting the "Options" entry opens settings_menu, cancel resumes overworld menu', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await setupOverworld(page);
    await stepFrames(page, 5);
    await page.evaluate(() => (window as any).__gameRef.cursor.setPos(10, 10));
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    // Navigate to and select 'Options' (index depends on lore unlocks; find
    // it directly rather than assuming a fixed offset).
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState();
      const idx = state.menu.options.findIndex((o: any) => o.value === 'options');
      state.menu.selectedIndex = idx;
    });
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    expect((await getState(page)).currentStateName).toBe('settings_menu');

    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 5);
    expect((await getState(page)).currentStateName).toBe('overworld_game_option_menu');
  });

  test('party node menu offers "Base Camp" first and enters base_main; BACK cancels to overworld', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await setupOverworld(page);
    await stepFrames(page, 5);

    // Move cursor onto the party's own node and select it.
    await page.evaluate(() => (window as any).__gameRef.cursor.setPos(2, 2));
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    const menuInfo = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return {
        name: state?.name,
        options: state?.nodeMenu?.options?.map((o: any) => o.value) ?? [],
      };
    });
    expect(menuInfo.name).toBe('overworld');
    expect(menuInfo.options[0]).toBe('_base_camp');
    expect(menuInfo.options).toContain('CustomOpt');

    // Cancel out first, to verify BACK resumes the bare overworld state.
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 5);
    const afterCancel = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return { name: state?.name, nodeMenuOpen: !!state?.nodeMenu };
    });
    expect(afterCancel.name).toBe('overworld');
    expect(afterCancel.nodeMenuOpen).toBe(false);

    // Re-open and select Base Camp.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);
    await stepFrames(page, 3, 'SELECT'); // Base Camp is index 0
    await stepFrames(page, 5);

    expect((await getState(page)).currentStateName).toBe('base_main');
  });
});

test.describe('Roam movement', () => {
  test('a held direction key walks the roam unit across walkable terrain', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { RoamPlayerMovementComponent } = await import('/src/movement/roam-movement.ts');
      const unit = [...game.units.values()].find((u: any) => u.position);
      const [sx, sy] = unit.position;

      // Free-roam polls held keys every frame; a press event alone cannot
      // express "still walking", so InputManager must expose isKeyHeld.
      const inputHasHeldQuery = typeof game.input?.isKeyHeld === 'function';
      game.input.keysDown.add('KeyD');
      const heldByCode = game.input.isKeyHeld('KeyD');
      const heldByChar = game.input.isKeyHeld('d');
      game.input.keysDown.delete('KeyD');

      // Terrain cost must be resolved through the board, which maps the
      // terrain NID to the mtype the mcost grid is keyed by. Reading it off
      // the raw NID reports every tile impassable and roaming freezes.
      const movement = new RoamPlayerMovementComponent(unit, game.board, game.db);
      movement.setAcceleration(1, 0);
      for (let i = 0; i < 30; i += 1) movement.update(1 / 60);

      return {
        inputHasHeldQuery,
        heldByCode,
        heldByChar,
        startX: sx,
        roamX: movement.roamPosition.x,
        movedTiles: unit.position[0] - sx,
        sameRow: unit.position[1] === sy,
      };
    });

    expect(result.inputHasHeldQuery).toBe(true);
    expect(result.heldByCode).toBe(true);
    expect(result.heldByChar).toBe(true);
    expect(result.roamX).toBeGreaterThan(result.startX);
    expect(result.movedTiles).toBeGreaterThan(0);
    expect(result.sameRow).toBe(true);
  });
});
