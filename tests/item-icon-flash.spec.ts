/**
 * Python `item_system.item_icon_mod` parity: the combat-preview and
 * animation-combat item icons flash white (`image_mods.make_white(icon,
 * abs(250 - engine.get_time() % 500) / 250)`) for EOtF's 154
 * `effective_damage` items (all `show_effectiveness_flash: True`) when they
 * are effective against the target, the deprecated `effective_tag` items
 * (Wind_Sword, ballistae, ...), and the two `item_icon_flash` items
 * (Oversword, Throat_Slitter_OR).
 */
import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('item icon white flash (item_icon_mod)', () => {
  test('effective, deprecated effective_tag and item_icon_flash hooks', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { itemIconWhiteness } = await import('/src/combat/item-system.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);
      const makeUnit = (nid: string, team: string, tags: string[] = []) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags, bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
          starting_items: [], learned_skills: [], unit_notes: [], fields: [],
          wexp_gain: {}, portrait_nid: '', affinity: '',
        }, klass);
        unit.team = team;
        unit.items = [];
        unit.skills = [];
        unit.position = [1, 1];
        return unit;
      };
      const item = (nid: string, owner: any) => {
        const obj = new ItemObject(game.db.items.get(nid));
        obj.owner = owner;
        owner.items.push(obj);
        return obj;
      };
      const attacker = makeUnit('_Flash_A', 'player');
      const plain = makeUnit('_Flash_Plain', 'enemy');
      const armored = makeUnit('_Flash_Armor', 'enemy', ['Armor']);
      const flier = makeUnit('_Flash_Flier', 'enemy', ['Flying']);
      const negator = makeUnit('_Flash_Negate', 'enemy', ['Armor']);
      negator.skills = [new SkillObject({
        nid: '_Negate', name: '_Negate', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['negate', null]],
      } as any)];
      const swordsman = makeUnit('_Flash_Sword', 'enemy');
      const sword = item('Iron_Sword', swordsman);
      swordsman.equippedWeapon = sword;
      const exposed = makeUnit('_Flash_Exposed', 'enemy');
      exposed.skills = [new SkillObject(game.db.skills.get('Exposed'))];

      const armorslayer = item('Armorslayer', attacker);
      const windSword = item('Wind_Sword', attacker);
      const oversword = item('Oversword', attacker);
      const slitter = item('Throat_Slitter_OR', attacker);
      const ironSword = item('Iron_Sword', attacker);
      // engine.get_time() % 500 == 0 -> abs(250 - 0) / 250 == 1; 125 -> 0.5; 250 -> 0.
      const w = (it: any, target: any, t = 0) => itemIconWhiteness(attacker, it, target, null, game, t);
      return {
        armorVsArmor: w(armorslayer, armored),
        armorVsArmorMid: w(armorslayer, armored, 125),
        armorVsArmorZero: w(armorslayer, armored, 250),
        armorVsArmorWrap: w(armorslayer, armored, 875),
        armorVsPlain: w(armorslayer, plain),
        armorVsNegate: w(armorslayer, negator),
        windVsFlier: w(windSword, flier),
        windVsPlain: w(windSword, plain),
        overVsSword: w(oversword, swordsman),
        overVsPlain: w(oversword, plain),
        slitterVsExposed: w(slitter, exposed),
        slitterVsPlain: w(slitter, plain),
        ironVsArmor: w(ironSword, armored),
        noTarget: itemIconWhiteness(attacker, armorslayer, null, null, game, 0),
      };
    });
    expect(result).toEqual({
      armorVsArmor: 1,
      armorVsArmorMid: 0.5,
      armorVsArmorZero: 0,
      armorVsArmorWrap: 0.5,
      armorVsPlain: 0,
      armorVsNegate: 0,
      windVsFlier: 1,
      windVsPlain: 0,
      overVsSword: 1,
      overVsPlain: 0,
      slitterVsExposed: 1,
      slitterVsPlain: 0,
      ironVsArmor: 0,
      noTarget: 0,
    });
  });

  test('drawItemIcon whiteness is an RGB add that keeps alpha', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const { Surface } = await import('/src/engine/surface.ts');
      const { drawItemIcon, loadIconSheet } = await import('/src/ui/icons.ts');
      await loadIconSheet('Sword', '16');
      const icon = { iconNid: 'Sword', iconIndex: [0, 12] as [number, number] };
      const plain = new Surface(16, 16);
      const white = new Surface(16, 16);
      drawItemIcon(plain, icon, 0, 0);
      drawItemIcon(white, icon, 0, 0, 0.5);
      const a = plain.ctx.getImageData(0, 0, 16, 16).data;
      const b = white.ctx.getImageData(0, 0, 16, 16).data;
      let opaque = 0;
      let mismatched = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i + 3] !== b[i + 3]) mismatched++;
        if (a[i + 3] !== 255) continue;
        opaque++;
        for (let c = 0; c < 3; c++) {
          if (b[i + c] !== Math.min(255, a[i + c] + 127)) mismatched++;
        }
      }
      return { opaque, mismatched };
    });
    expect(result.opaque).toBeGreaterThan(10);
    expect(result.mismatched).toBe(0);
  });
});
