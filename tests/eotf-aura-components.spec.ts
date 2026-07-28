import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog aura components', () => {
  test('count-locks all 786 authored aura, range, and target uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        const components = new Map(skill.components);
        if (!components.has('aura')) continue;
        for (const nid of ['aura', 'aura_range', 'aura_target']) {
          counts[nid] = (counts[nid] ?? 0) + 1;
        }
        if (typeof components.get('aura') !== 'string') invalid.push(`${skill.nid}:aura`);
        if (typeof components.get('aura_range') !== 'number') {
          invalid.push(`${skill.nid}:aura_range`);
        }
        if (!['ally', 'enemy', 'unit'].includes(String(components.get('aura_target')))) {
          invalid.push(`${skill.nid}:aura_target`);
        }
        if (!game.db.skills.has(components.get('aura'))) {
          invalid.push(`${skill.nid}:missing_child`);
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        aura: 262,
        aura_range: 262,
        aura_target: 262,
      },
      invalid: [],
    });
  });

  test('limits overlapping children and strips or replaces stale aura sources', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        AURA_OWNER_NID_KEY,
        isAuraSourcedSkill,
        refreshAuras,
      } = await import('/src/combat/aura-system.ts');
      const [owner1, owner2, target] = [...game.units.values()];
      if (!owner1 || !owner2 || !target) return null;
      const saved = [owner1, owner2, target].map((unit: any) => ({
        unit,
        skills: unit.skills,
        position: unit.position,
        team: unit.team,
        hasCanto: unit.hasCanto,
        nid: unit.nid,
      }));
      const parent = (nid: string) => new SkillObject(game.db.skills.get(nid));
      owner1.nid = '_AuraOwner1';
      owner2.nid = '_AuraOwner2';
      target.nid = '_AuraTarget';
      owner1.team = owner2.team = target.team = 'player';
      owner1.position = [0, 0];
      owner2.position = [2, 0];
      target.position = [1, 0];
      owner1.skills = [parent('Leading_Charge')];
      owner2.skills = [parent('Leading_Charge_Plus')];
      target.skills = [];
      const occupancy = new Map<string, any>([
        ['0,0', owner1],
        ['2,0', owner2],
        ['1,0', target],
      ]);
      const board = {
        bounds: [0, 0, 4, 4],
        inBounds: (x: number, y: number) => x >= 0 && x <= 4 && y >= 0 && y <= 4,
        getUnit: (x: number, y: number) => occupancy.get(`${x},${y}`) ?? null,
      };
      const units = [owner1, owner2, target];
      const auraChildren = () => target.skills
        .filter((skill: any) => isAuraSourcedSkill(skill))
        .map((skill: any) => ({
          nid: skill.nid,
          owner: skill.data.get(AURA_OWNER_NID_KEY),
          runtimeOwner: skill.ownerNid,
        }));

      refreshAuras(units, board as any, game.db);
      const firstSource = auraChildren();

      owner1.position = null;
      occupancy.delete('0,0');
      refreshAuras(units, board as any, game.db);
      const replacementSource = auraChildren();

      const removedChild = target.skills.find((skill: any) => isAuraSourcedSkill(skill));
      target.position = null;
      occupancy.delete('1,0');
      refreshAuras(units, board as any, game.db);
      const offBoard = {
        children: auraChildren(),
        removedOwner: removedChild?.ownerNid ?? null,
      };

      owner1.position = [0, 0];
      target.position = [1, 0];
      occupancy.set('0,0', owner1);
      occupancy.set('1,0', target);
      owner1.skills = [parent('BadVibes')];
      owner2.skills = [parent('BadVibes_Debuff')];
      target.skills = [];
      refreshAuras(units, board as any, game.db);
      const stacked = auraChildren();

      owner1.skills = [parent('Deafening_Aura')];
      owner2.skills = [];
      target.skills = [];
      target.team = 'enemy';
      refreshAuras(units, board as any, game.db);
      const enemyTarget = auraChildren();
      target.team = 'player';
      refreshAuras(units, board as any, game.db);
      const allyRejected = auraChildren();

      for (const entry of saved) {
        entry.unit.skills = entry.skills;
        entry.unit.position = entry.position;
        entry.unit.team = entry.team;
        entry.unit.hasCanto = entry.hasCanto;
        entry.unit.nid = entry.nid;
      }
      return {
        firstSource,
        replacementSource,
        offBoard,
        stacked,
        enemyTarget,
        allyRejected,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.firstSource).toEqual([{
      nid: 'Leading_Charge_Child',
      owner: '_AuraOwner1',
      runtimeOwner: '_AuraTarget',
    }]);
    expect(result!.replacementSource).toEqual([{
      nid: 'Leading_Charge_Child',
      owner: '_AuraOwner2',
      runtimeOwner: '_AuraTarget',
    }]);
    expect(result!.offBoard).toEqual({ children: [], removedOwner: null });
    expect(result!.stacked).toEqual([
      {
        nid: 'BadVibes_Child',
        owner: '_AuraOwner1',
        runtimeOwner: '_AuraTarget',
      },
      {
        nid: 'BadVibes_Child',
        owner: '_AuraOwner2',
        runtimeOwner: '_AuraTarget',
      },
    ]);
    expect(result!.enemyTarget).toEqual([{
      nid: 'Silence_Aura',
      owner: '_AuraOwner1',
      runtimeOwner: '_AuraTarget',
    }]);
    expect(result!.allyRejected).toEqual([]);
  });
});
