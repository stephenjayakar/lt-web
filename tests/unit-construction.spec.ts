/**
 * Unit construction parity with Python UnitObject.from_prefab (upstream
 * lt-maker and EOtF's engine fork run the same code here): class skills for
 * unique units, the level's party on every level unit, generic wexp raised
 * to item requirements, generic autolevels by `enemy_leveling`, promoted
 * generics scaled by `promoted_autolevels_fraction`, and the fork's 50
 * starting growth points for Fixed-method units.
 *
 * Expected numbers come from the differential oracle's Python runs
 * (tools/oracle, scenarios default-combat-exp, default-ai-phase,
 * default-event-units, eotf-hub-start).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { projectInstalled } from './helpers/project-data';

async function boot(page: Page, query: string): Promise<void> {
  await page.goto(`/?harness=true&clean=true&bundle=false&${query}`);
  await page.waitForFunction(() => !!(window as any).__harness?.ready, null, { timeout: 120_000 });
}

function unitSummary(page: Page, nids: string[]) {
  return page.evaluate((list) => {
    const g = (window as any).__gameRef;
    return Object.fromEntries(list.map((nid: string) => {
      const u = g.units.get(nid);
      return [nid, u ? {
        stats: { ...u.stats },
        hp: u.currentHp,
        party: u.party,
        team: u.team,
        level: u.level,
        skills: u.skills.map((s: any) => s.nid),
        hasCanto: !!u.hasCanto,
        wexp: { ...u.wexp },
        growthPoints: { ...u.growthPoints },
      } : null];
    }));
  }, nids);
}

const nonzero = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v));

test.describe('Unit construction (Python UnitObject.from_prefab)', () => {
  test('unique units get class skills; every level unit gets the level party; generics wield their items', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=DEBUG');
    const units = await unitSummary(page, ['Seth', 'Vanessa', 'Eirika', 'Bone', '103', '101']);
    // Paladin and Pegasus_Knight learn Canto at level 1.
    expect(units.Seth!.skills).toContain('Canto');
    expect(units.Seth!.hasCanto).toBe(true);
    expect(units.Vanessa!.skills).toContain('Canto');
    expect(units.Eirika!.skills).not.toContain('Canto');
    // Python level_setup: enemies join the level's party too.
    for (const nid of ['Eirika', 'Bone', '103', '101']) expect(units[nid]!.party).toBe('Eirika');
    // Shaman 101 carries Luna (rank C): Dark rises from the class's 31 to 71.
    expect(units['101']!.wexp.Dark).toBe(71);
  });

  test('generic autolevels follow enemy_leveling (Dynamic in default.ltproj)', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=0&seed=0');
    const units = await unitSummary(page, ['102']);
    // Zero stats are dropped: the web also carries class-only stats (LEAD) at 0.
    expect(nonzero(units['102']!.stats)).toEqual(nonzero({
      HP: 21, STR: 6, MAG: 0, SKL: 2, SPD: 4, LCK: 0, DEF: 3, CON: 11, MOV: 5, RES: 1,
    }));
    expect(nonzero(units['102']!.growthPoints)).toEqual({
      DEF: -8.5, HP: -1.5, LCK: 1.5, RES: -8.5, SKL: 3.5, SPD: 3, STR: -4.5,
    });
  });

  test('load_unit and create_unit build units like level units', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=DEBUG&seed=0');
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const nid = 'TestEventUnits';
      g.db.events.set(nid, {
        name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: [
          'load_unit;Franz;player',
          'add_unit;Franz;3,3;immediate',
          'create_unit;103;Nid=Clone;Level=10;Position=6,8;EntryType=immediate',
        ],
      });
      g.eventManager.triggerSpecific(nid, { type: nid }, true);
      g.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.settle(600));
    const units = await unitSummary(page, ['Franz', 'Clone']);
    expect(units.Franz!.skills).toContain('Canto');
    expect(units.Franz!.party).toBe('Eirika');
    expect(units.Clone!.level).toBe(10);
    expect(nonzero(units.Clone!.stats)).toEqual(nonzero({
      HP: 26, STR: 9, MAG: 0, SKL: 3, SPD: 4, LCK: 3, DEF: 1, CON: 6, MOV: 5, RES: 0,
    }));
    expect(units.Clone!.hp).toBe(26);
  });

  test('EOtF: promoted generics level by promoted_autolevels_fraction; Fixed units start at 50 growth points', async ({ page }) => {
    test.skip(!projectInstalled('eotf.ltproj'), 'EOtF project not installed');
    await boot(page, 'project=eotf.ltproj&level=X');
    const units = await unitSummary(page, ['Keeper', 'Trace', 'Player']);
    // Great_Knight (tier 2) at level 1 with fraction 0.0: one Fixed level-up
    // from class bases, not the 40-odd levels of its promotion chain.
    expect(nonzero(units.Keeper!.stats)).toEqual(nonzero({
      HP: 22, STR: 8, MAG: 4, SKL: 6, SPD: 7, LCK: 0, DEF: 11, CON: 13, MOV: 6, RES: 3,
    }));
    expect(units.Trace!.stats.HP).toBe(23);
    for (const nid of ['Keeper', 'Trace', 'Player']) {
      expect(Object.values(units[nid]!.growthPoints).every((v) => v === 50)).toBe(true);
    }
  });

  test('EOtF: construction runs skill/item init and shows one instance per skill nid', async ({ page }) => {
    test.skip(!projectInstalled('eotf.ltproj'), 'EOtF project not installed');
    const probe = (level: string, fn: string) => boot(page, `project=eotf.ltproj&level=${level}`)
      .then(() => page.evaluate(fn));
    // CombatArt.init: data['active'] = False (Capture_Piece on EV_Chess pieces).
    expect(await probe('EV_Chess', `(() => {
      const u = window.__gameRef.units.get('101');
      return u.skills.find((s) => s.nid === 'Capture_Piece')?.data.get('active');
    })()`)).toBe(false);
    // The fork's WitchWarpExpression.init: data['arbitrary'] = ''.
    expect(await probe('EV_Prometheus', `(() => {
      const u = window.__gameRef.units.get('Prometheus_E');
      return u.skills.find((s) => s.nid === 'Nexus_Warp')?.data.get('arbitrary');
    })()`)).toBe('');
    // Deprecated Effective.init copies the value into the item data.
    expect(await probe('Ilona', `(() => {
      const u = window.__gameRef.units.get('106');
      return u.items.map((i) => i.data.get('effective') ?? null);
    })()`)).toContain(18);
    // Demon's class and the generic's starting skills both grant HP_Double:
    // Python's unit.skills shows it once, so HP doubles once (60 -> 120).
    expect(await probe('Trial_Extra', `(() => {
      const u = window.__gameRef.units.get('127');
      return [u.skills.filter((s) => s.nid === 'HP_Double').length, u.maxHp, u.currentHp];
    })()`)).toEqual([1, 120, 120]);
    // Keyblade grants Locktouch_Keyblade on hold and on equip: one visible
    // instance, and none once the item leaves.
    expect(await probe('Serpens', `(async () => {
      const g = window.__gameRef;
      const { RemoveItemFromUnitAction } = await import('/src/engine/action.ts');
      const u = g.units.get('132');
      const before = u.skills.filter((s) => s.nid === 'Locktouch_Keyblade').length;
      g.actionLog.doAction(new RemoveItemFromUnitAction(u, u.items.find((i) => i.nid === 'Keyblade')));
      return [before, u.skills.filter((s) => s.nid === 'Locktouch_Keyblade').length];
    })()`)).toEqual([1, 0]);
  });

  test('kill_unit leaves HP alone, as Python does', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=DEBUG');
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const nid = 'TestKillKeepsHp';
      g.db.events.set(nid, {
        name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0, _source: ['kill_unit;Vanessa;immediate'],
      });
      g.eventManager.triggerSpecific(nid, { type: nid }, true);
      g.state.change('event');
      await (window as any).__harness.settle(300);
      const u = g.units.get('Vanessa');
      return { dead: u.dead, hp: u.currentHp, position: u.position };
    });
    expect(result).toEqual({ dead: true, hp: 17, position: null });
  });
});
