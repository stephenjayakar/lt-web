import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('trade item end-combat flow', () => {
  test('opens a forced partner trade and swaps the selected inventory rows reversibly', async ({ page }, testInfo) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { TradeState, setGameRef } = await import('/src/engine/states/game-states.ts');
      const { Surface } = await import('/src/engine/surface.ts');
      const { combatTradePair } = await import('/src/combat/combat-lifecycle.ts');
      const unit = game.units.get('Eirika');
      const partner = game.units.get('Seth');
      if (!unit || !partner) return null;
      setGameRef(game);

      const makeItem = (nid: string, components: [string, any][] = []) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const tradeStaff = makeItem('_TradeStaff', [['trade', null]]);
      const missPair = combatTradePair([{
        attacker: unit, defender: partner, item: tradeStaff, hit: false,
      } as any]);
      const hitPair = combatTradePair([{
        attacker: unit, defender: partner, item: tradeStaff, hit: true,
      } as any]);

      const oldSelected = game.selectedUnit;
      const oldUnitItems = [...unit.items];
      const oldPartnerItems = [...partner.items];
      const a0 = makeItem('_UnitFirst');
      const b0 = makeItem('_PartnerFirst');
      const b1 = makeItem('_PartnerSecond');
      unit.items = [a0];
      partner.items = [b0, b1];
      a0.owner = unit;
      b0.owner = partner;
      b1.owner = partner;
      game.selectedUnit = unit;
      game.memory.set('trade_partner', partner);

      const beforeActionIndex = game.actionLog.actionIndex;
      const state: any = new TradeState();
      state.begin();
      const forcedPhase = state.phase;
      state.takeInput('SELECT');
      const destinationPhase = {
        side: state.activeTradeSide,
        sourceIndex: state.selectedIndexA,
      };
      state.itemMenuB.selectedIndex = 1;
      state.takeInput('SELECT');
      const swapped = {
        unit: unit.items.map((item: any) => item.nid),
        partner: partner.items.map((item: any) => item.nid),
        side: state.activeTradeSide,
      };

      const surface = new Surface(240, 160);
      state.draw(surface);
      const canvas = document.createElement('canvas');
      canvas.id = 'trade-ui-visual';
      canvas.width = 720;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = false;
      context.drawImage(surface.canvas, 0, 0, 720, 480);
      document.body.replaceChildren(canvas);
      const data = surface.getImageData().data;
      let gold = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 220 && data[i + 1] > 180 && data[i + 2] < 150) gold++;
      }

      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        unit: unit.items.map((item: any) => item.nid),
        partner: partner.items.map((item: any) => item.nid),
      };

      unit.items = oldUnitItems;
      partner.items = oldPartnerItems;
      game.selectedUnit = oldSelected;
      game.memory.delete('trade_partner');
      return {
        missPair: missPair === null,
        hitPair: hitPair ? [hitPair.unit.nid, hitPair.partner.nid] : null,
        forcedPhase,
        destinationPhase,
        swapped,
        reversed,
        gold,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.missPair).toBe(true);
    expect(result!.hitPair).toEqual(['Eirika', 'Seth']);
    expect(result!.forcedPhase).toBe('select_items');
    expect(result!.destinationPhase).toEqual({ side: 'b', sourceIndex: 0 });
    expect(result!.swapped).toEqual({
      unit: ['_PartnerSecond'],
      partner: ['_PartnerFirst', '_UnitFirst'],
      side: 'a',
    });
    expect(result!.reversed).toEqual({
      unit: ['_UnitFirst'],
      partner: ['_PartnerFirst', '_PartnerSecond'],
    });
    expect(result!.gold).toBeGreaterThan(100);
    await page.locator('#trade-ui-visual').screenshot({
      path: testInfo.outputPath('trade-ui.png'),
    });
  });
});
