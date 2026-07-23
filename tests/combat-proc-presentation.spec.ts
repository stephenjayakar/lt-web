import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('combat proc presentation', () => {
  test('uses Python cue timing, hides opted-out skills, and orders full-animation cues', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const { AnimationCombat } = await import('/src/combat/animation-combat.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { PROC_CUE_DURATION_MS, procCueMotion } =
        await import('/src/combat/proc-presentation.ts');

      const unit = (nid: string) => ({ nid, skills: [] as any[] });
      const skill = (nid: string, hidden = false) => ({
        nid,
        name: nid,
        iconNid: '',
        iconIndex: [0, 0],
        hasComponent: (component: string) =>
          hidden && component === 'hide_skill_icon_in_combat',
      });
      const attacker = unit('attacker');
      const defender = unit('defender');
      const attackSkill = skill('Astra');
      const hiddenSkill = skill('Hidden', true);
      const defenseSkill = skill('Pavise');
      const marks = [
        { kind: 'attack_pre_proc', unit: attacker, parentSkill: attackSkill, procSkill: attackSkill },
        { kind: 'defense_pre_proc', unit: defender, parentSkill: hiddenSkill, procSkill: hiddenSkill },
      ];

      const animation: any = Object.create(AnimationCombat.prototype);
      Object.assign(animation, {
        attacker,
        defender,
        procPlayback: marks,
        pendingProcCues: [],
        activeProcCue: null,
        state: 'init_pause',
        stateTimer: 1000,
        stateFrameCount: 0,
        leftIsAttacker: true,
        leftAnim: { effects: [], underEffects: [], spawnEffect() {} },
        rightAnim: { effects: [], underEffects: [], spawnEffect() {} },
        db: { combatEffects: new Map() },
      });
      animation.updateInitPause();
      const preState = animation.state;
      const preName = animation.activeProcCue?.skill.name;
      animation.stateTimer = PROC_CUE_DURATION_MS - 1;
      animation.updateProcCue();
      const stillShowing = animation.state;
      animation.stateTimer = PROC_CUE_DURATION_MS;
      animation.updateProcCue();
      const afterPre = animation.state;

      const strike = {
        attacker,
        defender,
        attackProcs: [
          { kind: 'attack_proc', unit: attacker, parentSkill: attackSkill, procSkill: attackSkill },
        ],
        defenseProcs: [
          { kind: 'defense_proc', unit: defender, parentSkill: defenseSkill, procSkill: defenseSkill },
        ],
      };
      Object.assign(animation, {
        strikes: [strike],
        currentStrikeIndex: 0,
        state: 'begin_phase',
        stateTimer: 0,
      });
      animation.updateBeginPhase();
      const attackState = animation.state;
      const attackName = animation.activeProcCue?.skill.name;
      animation.stateTimer = PROC_CUE_DURATION_MS;
      animation.updateProcCue();
      const defenseState = animation.state;
      const defenseName = animation.activeProcCue?.skill.name;

      const map: any = Object.create(MapCombat.prototype);
      Object.assign(map, {
        procPlayback: marks,
        participants: [attacker, defender],
        activeProcCues: [],
      });
      map.showFirstPhaseProcCues();
      map.showStrikeProcCues(strike);

      return {
        duration: PROC_CUE_DURATION_MS,
        alphaAtStart: procCueMotion({
          kind: 'display', unit: attacker, skill: attackSkill, elapsed: 0,
          duration: PROC_CUE_DURATION_MS,
        }).alpha,
        preState,
        preName,
        stillShowing,
        afterPre,
        attackState,
        attackName,
        defenseState,
        defenseName,
        mapNames: map.activeProcCues.map((cue: any) => cue.skill.name),
      };
    });

    expect(result).toEqual({
      duration: 1250,
      alphaAtStart: 0,
      preState: 'pre_proc',
      preName: 'Astra',
      stillShowing: 'pre_proc',
      afterPre: 'begin_phase',
      attackState: 'attack_proc',
      attackName: 'Astra',
      defenseState: 'defense_proc',
      defenseName: 'Pavise',
      mapNames: ['Astra', 'Astra', 'Pavise'],
    });
  });

  test('renders a compact readable proc badge in the 240x160 scene', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const pixels = await page.evaluate(async () => {
      const { Surface } = await import('/src/engine/surface.ts');
      const { CombatState } = await import('/src/engine/states/game-states.ts');
      const surf = new Surface(240, 160);
      surf.fill(18, 26, 42);
      const cue = {
        kind: 'attack_proc',
        unit: { nid: 'Eirika' },
        skill: { name: 'Astra', iconNid: '', iconIndex: [0, 0] },
        elapsed: 500,
        duration: 1250,
      };
      (CombatState.prototype as any).drawProcCue.call({}, surf, cue, 4, 32, false);
      const canvas = document.createElement('canvas');
      canvas.id = 'proc-cue-visual';
      canvas.width = 720;
      canvas.height = 480;
      canvas.style.imageRendering = 'pixelated';
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = false;
      context.drawImage(surf.canvas, 0, 0, 720, 480);
      document.body.replaceChildren(canvas);
      const data = surf.getImageData().data;
      let changed = 0;
      let gold = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 18 || data[i + 1] !== 26 || data[i + 2] !== 42) changed++;
        if (data[i] > 220 && data[i + 1] > 180 && data[i + 2] < 150) gold++;
      }
      return { changed, gold };
    });

    await expect(page.locator('#proc-cue-visual')).toBeVisible();
    expect(pixels.changed).toBeGreaterThan(300);
    expect(pixels.gold).toBeGreaterThan(10);
  });
});
