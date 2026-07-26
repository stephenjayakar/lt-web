import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog Savage post-combat skill hooks', () => {
  test('count-locks all authored values and referenced statuses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const values = (componentNid: string) => [...game.db.skills.values()]
        .flatMap((skill: any) => skill.components
          .filter(([nid]: [string, unknown]) => nid === componentNid)
          .map(([, value]: [string, unknown]) => value));
      const single = values('savage_status');
      const multiple = values('savage_statuses');
      const blow = values('savage_blow_fates');
      const rangeCounts = (entries: any[]) => Object.fromEntries(
        [...new Set(entries.map((value) => value.range))]
          .sort((left, right) => left - right)
          .map((range) => [
            range,
            entries.filter((value) => value.range === range).length,
          ]),
      );
      const statuses = [
        ...single.map((value) => value.status),
        ...multiple.flatMap((value) => value.statuses),
      ];
      return {
        singleCount: single.length,
        singleRanges: rangeCounts(single),
        multipleCount: multiple.length,
        multipleRanges: rangeCounts(multiple),
        multipleLengths: multiple.map((value) => value.statuses.length).sort(),
        blowCounts: Object.fromEntries([2, 4].map((range) => [
          range,
          blow.filter((value) => value === range).length,
        ])),
        missingStatuses: statuses.filter(
          (status) => !game.db.skills.has(status),
        ),
      };
    });

    expect(result).toEqual({
      singleCount: 21,
      singleRanges: { 2: 16, 3: 5 },
      multipleCount: 3,
      multipleRanges: { 1: 1, 2: 2 },
      multipleLengths: [2, 2, 3],
      blowCounts: { 2: 5, 4: 1 },
      missingStatuses: [],
    });
  });

  test('uses the combat-start snapshot and applies enemy-only shells exactly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const units = [...game.units.values()]
        .filter((unit: any) => !unit.tags.includes('Tile'))
        .slice(0, 6);
      if (units.length < 6) throw new Error('Need six units for Savage shell test');
      const [actor, target, nearEnemy, edgeEnemy, outsideEnemy, nearAlly] = units;
      const old = units.map((unit: any) => ({
        unit,
        position: unit.position ? [...unit.position] : null,
        team: unit.team,
        skills: unit.skills,
        hp: unit.currentHp,
        dead: unit.dead,
      }));
      for (const unit of units) game.board.removeUnit(unit);

      const offsets = [
        [0, -2],
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [0, 1],
      ];
      let origin: [number, number] | null = null;
      for (let y = 2; y < game.board.height && !origin; y++) {
        for (let x = 0; x < game.board.width && !origin; x++) {
          const positions = offsets.map(
            ([dx, dy]) => [x + dx, y + dy] as [number, number],
          );
          if (positions.every(([px, py]) =>
            game.board.inBounds(px, py) && !game.board.getUnit(px, py))) {
            origin = [x, y];
          }
        }
      }
      if (!origin) throw new Error('No open Savage shell test cluster');
      units.forEach((unit: any, index: number) => {
        const [dx, dy] = offsets[index];
        game.board.setUnit(origin![0] + dx, origin![1] + dy, unit);
      });
      actor.team = 'player';
      target.team = 'enemy';
      nearEnemy.team = 'enemy';
      edgeEnemy.team = 'enemy';
      outsideEnemy.team = 'enemy';
      nearAlly.team = 'player';
      target.skills = [];
      nearEnemy.skills = [];
      edgeEnemy.skills = [];
      outsideEnemy.skills = [];
      nearAlly.skills = [];
      target.currentHp = 25;
      nearEnemy.currentHp = 19;
      edgeEnemy.currentHp = 4;
      outsideEnemy.currentHp = 19;
      nearAlly.currentHp = 19;
      for (const unit of units) unit.dead = false;

      const savage = new SkillObject({
        nid: '_EotfSavageFamily',
        name: 'EotF Savage Family',
        desc: '',
        components: [
          ['combat_condition', "mode == 'attack'"],
          ['savage_status', { status: 'Burning', range: 2 }],
          ['savage_statuses', {
            statuses: ['Dazzled_Short', 'Chilled'],
            range: 1,
          }],
          ['savage_blow_fates', 2],
        ],
      });
      actor.skills = [savage];
      const item = new ItemObject({
        nid: '_EotfSavageWeapon',
        name: 'EotF Savage Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = {
        attacker: actor,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };

      savage.data.set('_combat_condition', false);
      const inactiveBefore = game.actionLog.actionIndex;
      const inactiveApplied = applyCombatSkillEndHooks(
        game,
        [strike],
        actor,
        target,
      );
      const inactiveActions = game.actionLog.actionIndex - inactiveBefore;
      const inactiveSnapshotCleared = !savage.data.has('_combat_condition');

      savage.data.set('_combat_condition', true);
      const beforeIndex = game.actionLog.actionIndex;
      const applied = applyCombatSkillEndHooks(
        game,
        [strike],
        actor,
        target,
      );
      const afterIndex = game.actionLog.actionIndex;
      const granted = [...nearEnemy.skills, ...edgeEnemy.skills];
      const snapshot = () => ({
        target: {
          hp: target.currentHp,
          statuses: target.skills.map((skill: any) => skill.nid),
        },
        nearEnemy: {
          hp: nearEnemy.currentHp,
          statuses: nearEnemy.skills.map((skill: any) => skill.nid),
        },
        edgeEnemy: {
          hp: edgeEnemy.currentHp,
          statuses: edgeEnemy.skills.map((skill: any) => skill.nid),
        },
        outsideEnemy: {
          hp: outsideEnemy.currentHp,
          statuses: outsideEnemy.skills.map((skill: any) => skill.nid),
        },
        nearAlly: {
          hp: nearAlly.currentHp,
          statuses: nearAlly.skills.map((skill: any) => skill.nid),
        },
      });
      const changed = snapshot();
      const initiators = granted.map((skill: any) => skill.initiatorNid ?? null);
      const activeSnapshotCleared = !savage.data.has('_combat_condition');
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = snapshot();
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = snapshot();
      const sameSkills = granted.every((skill: any) =>
        nearEnemy.skills.includes(skill) || edgeEnemy.skills.includes(skill));

      for (const unit of units) game.board.removeUnit(unit);
      for (const entry of old) {
        entry.unit.team = entry.team;
        entry.unit.skills = entry.skills;
        entry.unit.currentHp = entry.hp;
        entry.unit.dead = entry.dead;
        if (entry.position) {
          game.board.setUnit(entry.position[0], entry.position[1], entry.unit);
        }
      }
      return {
        inactiveApplied,
        inactiveActions,
        inactiveSnapshotCleared,
        applied,
        changed,
        reversed,
        redone,
        initiators,
        activeSnapshotCleared,
        sameSkills,
        actorNid: actor.nid,
      };
    });

    expect(result.inactiveApplied).toBe(0);
    expect(result.inactiveActions).toBe(0);
    expect(result.inactiveSnapshotCleared).toBe(true);
    expect(result.applied).toBe(6);
    expect(result.changed).toEqual({
      target: { hp: 25, statuses: [] },
      nearEnemy: {
        hp: 16,
        statuses: ['Burning', 'Dazzled_Short', 'Chilled'],
      },
      edgeEnemy: { hp: 4, statuses: ['Burning'] },
      outsideEnemy: { hp: 19, statuses: [] },
      nearAlly: { hp: 19, statuses: [] },
    });
    expect(result.reversed).toEqual({
      target: { hp: 25, statuses: [] },
      nearEnemy: { hp: 19, statuses: [] },
      edgeEnemy: { hp: 4, statuses: [] },
      outsideEnemy: { hp: 19, statuses: [] },
      nearAlly: { hp: 19, statuses: [] },
    });
    expect(result.redone).toEqual(result.changed);
    expect(result.initiators).toEqual([
      result.actorNid,
      result.actorNid,
      result.actorNid,
      result.actorNid,
    ]);
    expect(result.activeSnapshotCleared).toBe(true);
    expect(result.sameSkills).toBe(true);
  });

  test('retains solver snapshots until external end-combat hooks finish', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } =
        await import('/src/combat/combat-solver.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        defenderTeam: defender.team,
      };
      const skill = new SkillObject({
        nid: '_EotfSavageSnapshot',
        name: 'EotF Savage Snapshot',
        desc: '',
        components: [
          ['combat_condition', "mode == 'attack'"],
          ['savage_blow_fates', 0],
        ],
      });
      attacker.skills = [skill];
      defender.skills = [];
      defender.team = 'enemy';
      const item = new ItemObject({
        nid: '_EotfSavageSnapshotWeapon',
        name: 'EotF Savage Snapshot Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 0],
          ['hit', 100],
        ],
      });
      const strikes = new CombatPhaseSolver(() => 0, game).resolve(
        attacker,
        item,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['hit1', 'end'],
      );
      const retained = skill.data.get('_combat_condition');
      const applied = applyCombatSkillEndHooks(
        game,
        strikes,
        attacker,
        defender,
      );
      const cleared = !skill.data.has('_combat_condition');
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      defender.team = old.defenderTeam;
      return { retained, applied, cleared };
    });

    expect(result).toEqual({ retained: true, applied: 0, cleared: true });
  });
});
