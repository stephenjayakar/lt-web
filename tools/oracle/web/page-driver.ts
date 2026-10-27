/**
 * Oracle web driver, in-page half. Loaded by tools/oracle/web-driver.mjs into
 * a `?harness=true` page through Vite, it replays an oracle scenario through
 * the web engine's own states, menus and actions and returns the same
 * canonical snapshot schema as tools/oracle/py_driver.py.
 *
 * Mirrors py_driver.py action by action; where the two UIs differ (target
 * cycling, the trade partner menu, merged states) the difference is noted at
 * the call site.
 */

import { ItemObject, createItemTree } from '../../../src/objects/item';
import { SkillObject } from '../../../src/objects/skill';
import {
  AddSkillAction, ArriveOnMapAction, ChangeTeamAction, GiveItemAction, LeaveMapAction,
  RegisterItemTreeAction, RemoveItemFromUnitAction, RemoveSkillAction, SetCurrentHpAction,
  SetGameVarAction, SetLevelVarAction, WarpUnitAction, DeathAction,
} from '../../../src/engine/action';
import { enterStartedLevel } from '../../../src/engine/states/game-states';
import { setSetting } from '../../../src/engine/states/settings-state';
import { GameEvent } from '../../../src/events/event-manager';
import { getCombatRandomState, getGrowthRandomState } from '../../../src/engine/static-random';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Action = { do: string; [k: string]: any };
export interface Scenario {
  name?: string;
  project?: string;
  level: string;
  events?: boolean;
  seed?: number;
  rng_mode?: string;
  growths?: string;
  settings?: Record<string, unknown>;
  setup?: any[];
  actions?: Action[];
  skip?: string;
  start_frames?: number;
}

const REST_STATES = new Set([
  'free', 'menu', 'move', 'canto_wait', 'weapon_choice', 'spell_choice',
  'combat_targeting', 'targeting', 'item', 'item_child', 'item_targeting', 'item_use',
  'trade', 'option_menu', 'option_child',
]);

class OracleError extends Error {}

const w = window as any;

class WebEngine {
  game: any = w.__gameRef;
  h: any = w.__harness;
  frame = 0;
  suppressEvents = false;

  step(button: string | null = null): void {
    this.frame++;
    this.h.stepFrames(1, button);
  }

  press(button: string): void {
    this.step(button);
    this.step(null);
  }

  top(): string | undefined {
    return this.game.state.getCurrentState()?.name;
  }

  stack(): string[] {
    return this.game.state.getStackNames();
  }

  busy(): boolean {
    const g = this.game;
    if ((g.state as any).tempState?.length) return true;
    if (g.movementSystem?.isMoving?.()) return true;
    if (g.eventManager?.hasActiveEvents?.()) return true;
    return false;
  }

  async settle(opts: { maxFrames?: number; until?: (e: WebEngine) => boolean; skip?: string } = {}): Promise<void> {
    const maxFrames = opts.maxFrames ?? 6000;
    const skip = opts.skip ?? 'SELECT';
    let stable = 0;
    let last: string | undefined;
    let stuck = 0;
    for (let i = 0; i < maxFrames; i++) {
      if (i % 20 === 19) await new Promise<void>((r) => setTimeout(r, 0));
      const top = this.top();
      const rest = opts.until ? opts.until(this) : (top !== undefined && REST_STATES.has(top));
      if (rest && !this.busy()) {
        stable++;
        if (stable >= 3) return;
        this.step(null);
        continue;
      }
      stable = 0;
      if (top === last && !['ai', 'movement', 'combat', 'phase_change'].includes(top ?? '')) stuck++;
      else stuck = 0;
      last = top;
      if ((top === 'event' || top === 'dialog' || top === 'transition') && stuck >= 2 && stuck % 2 === 0) {
        this.press(skip);
      } else if (stuck > 600 && stuck % 60 === 0) {
        this.press('SELECT');
      } else {
        this.step(null);
      }
    }
    throw new OracleError(`settle timed out; stack=${JSON.stringify(this.stack())}`);
  }

  cursor(pos: [number, number]): void {
    this.game.cursor.setPos(pos[0], pos[1]);
  }

  expect(...states: string[]): void {
    const top = this.top();
    if (!top || !states.includes(top)) {
      throw new OracleError(`expected state ${states.join('|')}, got ${top} (stack ${JSON.stringify(this.stack())})`);
    }
  }

  /** The menu currently receiving input in the top state. */
  activeMenu(): { menu: any; items: any[] | null } {
    const st: any = this.game.state.getCurrentState();
    if (!st) throw new OracleError('no state');
    if (st.confirm) return { menu: st.confirm, items: null };
    if (st.child) return { menu: st.child, items: null };
    if (st.targetMenu) return { menu: st.targetMenu, items: null };
    if (st.menu && Array.isArray(st.menu.options)) {
      return { menu: st.menu, items: st.weapons ?? st.items ?? null };
    }
    throw new OracleError(`state ${st.name} has no menu`);
  }

  /** Python Engine.choose: walk the cursor with UP/DOWN, then SELECT. */
  choose(want: string): void {
    let { menu, items } = this.activeMenu();
    const opts: any[] = menu.options;
    const lw = want.toLowerCase();
    let idx = -1;
    if (items) idx = items.findIndex((it: any) => it?.nid === want);
    if (idx < 0) {
      idx = opts.findIndex((o: any) =>
        String(o.label ?? '').toLowerCase() === lw || String(o.value ?? '').toLowerCase() === lw);
    }
    if (idx < 0) {
      throw new OracleError(`option ${want} not in ${this.top()} menu ${JSON.stringify(opts.map((o: any) => o.label))}`);
    }
    for (let n = 0; n < opts.length + 2 && menu.selectedIndex !== idx; n++) {
      this.press(idx > menu.selectedIndex ? 'DOWN' : 'UP');
      menu = this.activeMenu().menu;
    }
    if (menu.selectedIndex !== idx) throw new OracleError(`could not reach option ${want} in ${this.top()}`);
    this.press('SELECT');
  }

  unit(nid: string): any {
    const u = this.game.units.get(nid);
    if (!u) throw new OracleError(`unknown unit ${nid}`);
    return u;
  }

  targetPos(target: string | [number, number]): [number, number] {
    if (Array.isArray(target)) return [target[0], target[1]];
    const u = this.unit(target);
    if (!u.position) throw new OracleError(`target ${target} is off the map`);
    return [u.position[0], u.position[1]];
  }
}

class Runner {
  constructor(private e: WebEngine) {}

  setup(ops: any[]): void {
    const e = this.e;
    const g = e.game;
    const log = g.actionLog;
    for (const op of ops) {
      if ('unit' in op) {
        const u = e.unit(op.unit);
        if ('team' in op) log.doAction(new ChangeTeamAction(u, op.team));
        if ('level' in op) u.level = Number(op.level);
        if ('exp' in op) u.exp = Number(op.exp);
        if ('stats' in op) for (const [k, v] of Object.entries(op.stats)) u.stats[k] = Number(v);
        if ('growths' in op) for (const [k, v] of Object.entries(op.growths)) u.growths[k] = Number(v);
        if ('items' in op) {
          for (const item of [...u.items]) log.doAction(new RemoveItemFromUnitAction(u, item));
          for (const nid of op.items) this.give(u, nid);
        }
        for (const nid of op.add_items ?? []) this.give(u, nid);
        for (const nid of op.add_skills ?? []) {
          const prefab = g.db.skills.get(nid);
          if (!prefab) throw new OracleError(`unknown skill ${nid}`);
          log.doAction(new AddSkillAction(u, new SkillObject(prefab)));
        }
        for (const nid of op.remove_skills ?? []) {
          const skill = u.skills.find((s: any) => s.nid === nid);
          if (skill) log.doAction(new RemoveSkillAction(u, skill));
        }
        if ('position' in op) {
          if (op.position === null) log.doAction(new LeaveMapAction(g, u));
          else if (u.position) log.doAction(new WarpUnitAction(u, [op.position[0], op.position[1]], g.board));
          else log.doAction(new ArriveOnMapAction(g, u, [op.position[0], op.position[1]]));
        }
        if ('stats' in op && !('hp' in op)) u.currentHp = u.stats.HP;
        if ('hp' in op) log.doAction(new SetCurrentHpAction(u, Number(op.hp)));
        g.refreshAuras?.();
      } else if ('game_var' in op) {
        log.doAction(new SetGameVarAction(g.gameVars, op.game_var, op.value));
      } else if ('level_var' in op) {
        log.doAction(new SetLevelVarAction(g.levelVars, op.level_var, op.value));
      } else if ('kill' in op) {
        log.doAction(new DeathAction(e.unit(op.kill), g.board, g.initiative ?? null));
      } else {
        throw new OracleError(`unknown setup op ${JSON.stringify(op)}`);
      }
    }
  }

  private give(u: any, nid: string): void {
    const g = this.e.game;
    const prefab = g.db.items.get(nid);
    if (!prefab) throw new OracleError(`unknown item ${nid}`);
    const item: ItemObject = createItemTree(prefab, (n: string) => g.db.items.get(n));
    g.actionLog.doAction(new RegisterItemTreeAction(g.items, item, `oracle_${item.uid}_${item.nid}`));
    g.actionLog.doAction(new GiveItemAction(u, item));
  }

  async inMenuFor(nid: string): Promise<void> {
    const e = this.e;
    if (e.top() === 'menu' && e.game.selectedUnit?.nid === nid) return;
    const u = e.unit(nid);
    await this.do_move({ do: 'move', unit: nid, to: [u.position[0], u.position[1]] });
  }

  async do_move(a: Action): Promise<void> {
    const e = this.e;
    e.expect('free');
    const u = e.unit(a.unit);
    e.cursor(u.position);
    e.press('SELECT');
    await e.settle({ until: (en) => en.top() === 'move' });
    e.cursor(a.to);
    e.press('SELECT');
    await e.settle();
  }

  async do_wait(a: Action): Promise<void> {
    const e = this.e;
    if (a.unit) await this.inMenuFor(a.unit);
    e.expect('menu', 'canto_wait');
    e.choose('Wait');
    await e.settle();
  }

  /**
   * Python teleports the cursor onto the target; the web TargetingState keeps
   * its own target index, so cycle it with RIGHT presses like a player.
   */
  private async targetAndFire(target: string | [number, number]): Promise<void> {
    const e = this.e;
    const pos = e.targetPos(target);
    const st: any = e.game.state.getCurrentState();
    const list: any[] | undefined = st.targets;
    if (Array.isArray(list) && list.length) {
      const hit = (t: any) => {
        const p = t?.position ?? t;
        return Array.isArray(p) && p[0] === pos[0] && p[1] === pos[1];
      };
      for (let n = 0; n <= list.length && !hit(st.targets[st.targetIndex]); n++) e.press('RIGHT');
      if (!hit(st.targets[st.targetIndex])) throw new OracleError(`target ${JSON.stringify(target)} not selectable`);
    } else {
      e.cursor(pos);
    }
    e.press('SELECT');
    await e.settle();
  }

  async do_attack(a: Action): Promise<void> {
    const e = this.e;
    await this.inMenuFor(a.unit);
    e.choose('Attack');
    await e.settle();
    if (e.top() === 'weapon_choice') {
      if (a.item) e.choose(a.item); else e.press('SELECT');
      await e.settle();
    }
    e.expect('targeting', 'combat_targeting');
    await this.targetAndFire(a.target);
  }

  async do_spell(a: Action): Promise<void> {
    const e = this.e;
    await this.inMenuFor(a.unit);
    e.choose('Spells');
    await e.settle();
    if (e.top() === 'weapon_choice' || e.top() === 'spell_choice') {
      if (a.item) e.choose(a.item); else e.press('SELECT');
      await e.settle();
    }
    e.expect('targeting', 'combat_targeting');
    await this.targetAndFire(a.target);
  }

  async do_use_item(a: Action): Promise<void> {
    const e = this.e;
    await this.inMenuFor(a.unit);
    e.choose('Item');
    await e.settle();
    e.expect('item');
    e.choose(a.item);
    await e.settle();
    e.choose(a.option ?? 'Use');
    await e.settle();
    if (['item_targeting', 'targeting'].includes(e.top() ?? '') && a.target != null) {
      await this.targetAndFire(a.target);
    }
  }

  async do_trade(a: Action): Promise<void> {
    const e = this.e;
    await this.inMenuFor(a.unit);
    e.choose('Trade');
    await e.settle();
    e.expect('trade');
    let st: any = e.game.state.getCurrentState();
    // Web deviation: several partners are picked from a menu instead of
    // Python's map targeting state.
    if (st.targetMenu) {
      e.choose(a.with);
      await e.settle();
      st = e.game.state.getCurrentState();
    }
    const menu = st.menu;
    if (!menu) throw new OracleError('trade menu did not open');
    const seek = (hand: number, nid: string): void => {
      const choice = hand === 0 ? menu.menu1 : menu.menu2;
      const n = choice.options?.length ?? 8;
      for (let i = 0; i < n; i++) {
        menu.selectingHand = [hand, i];
        if ('currentIndex' in choice) choice.currentIndex = i;
        if (menu.currentItem()?.[1]?.nid === nid) return;
      }
      throw new OracleError(`${nid} not in trade hand ${hand}`);
    };
    for (const nid of a.give ?? []) { seek(0, nid); e.press('SELECT'); e.press('SELECT'); }
    for (const nid of a.take ?? []) { seek(1, nid); e.press('SELECT'); e.press('SELECT'); }
    e.press('BACK');
    await e.settle();
  }

  async do_end_turn(a: Action): Promise<void> {
    const e = this.e;
    e.expect('free');
    e.cursor(this.emptyTile());
    e.press('SELECT');
    await e.settle({ until: (en) => en.top() === 'option_menu' });
    e.choose('End');
    await e.settle({
      until: (en) => en.top() === 'free' && en.game.phase.getCurrent() === 'player',
      maxFrames: a.max_frames ?? 20000,
    });
  }

  private emptyTile(): [number, number] {
    const g = this.e.game;
    for (let y = 0; y < g.tilemap.height; y++) {
      for (let x = 0; x < g.tilemap.width; x++) {
        if (!g.board.getUnit(x, y)) return [x, y];
      }
    }
    throw new OracleError('no empty tile');
  }

  async do_event(a: Action): Promise<void> {
    const e = this.e;
    const g = e.game;
    const was = e.suppressEvents;
    e.suppressEvents = false;
    try {
      const levelNid = g.currentLevel?.nid ?? '';
      if (a.script != null) {
        const lines: string[] = Array.isArray(a.script) ? a.script : String(a.script).split('\n');
        const unit1 = a.unit1 ? e.unit(a.unit1) : undefined;
        const prefab = {
          name: a.nid ?? 'oracle_script', nid: a.nid ?? 'oracle_script', trigger: '',
          level_nid: null, condition: 'True', only_once: false, priority: 20, _source: lines,
        };
        const event = new GameEvent(prefab, { type: 'generic', levelNid, unit1 } as any, () => g);
        g.eventManager.eventQueue.push(event);
        g.state.change('event');
      } else if (a.nid) {
        if (!g.eventManager.triggerSpecific(a.nid, { type: 'generic', levelNid }, !!a.force)) {
          throw new OracleError(`event ${a.nid} did not trigger`);
        }
        g.state.change('event');
      } else if (a.trigger) {
        const ctx = { game: g, gameVars: g.gameVars, levelVars: g.levelVars };
        if (g.eventManager.trigger({ type: a.trigger_web ?? a.trigger, levelNid, ...(a.args ?? {}) }, ctx)) {
          g.state.change('event');
        }
      }
      await e.settle({ skip: a.skip, maxFrames: a.max_frames });
    } finally {
      e.suppressEvents = was;
    }
  }

  async do_frames(a: Action): Promise<void> {
    for (let i = 0; i < Number(a.n ?? 1); i++) this.e.step(null);
  }

  async do_press(a: Action): Promise<void> {
    this.e.press(a.button);
    if (a.settle !== false) await this.e.settle();
  }

  async do_settle(a: Action): Promise<void> {
    await this.e.settle({ skip: a.skip, maxFrames: a.max_frames });
  }

  async run(a: Action): Promise<void> {
    const fn = (this as any)['do_' + a.do];
    if (typeof fn !== 'function') throw new OracleError(`unknown action ${a.do}`);
    await fn.call(this, a);
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function jsonable(v: any): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6;
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), jsonable(x)]));
  if (v instanceof Set) return [...v].map(jsonable).sort() as Json;
  if (Array.isArray(v)) return v.map(jsonable);
  if (typeof v === 'object') {
    if ('nid' in v && typeof v.nid === 'string' && Object.keys(v).length > 3) return { $ref: v.nid };
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonable(x)]));
  }
  return String(v);
}

const pos = (p: any): Json => (p ? [Number(p[0]), Number(p[1])] : null);

function itemSnap(it: any): Json {
  const hasUses = it.components?.has?.('uses');
  const hasCUses = !hasUses && it.components?.has?.('c_uses');
  return {
    nid: it.nid,
    uses: hasUses ? it.uses : (it.data?.get?.('uses') ?? null),
    c_uses: hasCUses ? it.uses : (it.data?.get?.('c_uses') ?? null),
    droppable: !!it.droppable,
  };
}

export function snapshot(e: WebEngine): Json {
  const g = e.game;
  const units: Record<string, Json> = {};
  for (const u of g.units.values()) {
    const skillData: Record<string, Json> = {};
    for (const s of u.skills) {
      const d = s.data instanceof Map ? jsonable(s.data) : {};
      if (d && typeof d === 'object' && Object.keys(d).length) skillData[s.nid] = d;
    }
    const nonzero = (r: Record<string, number> | undefined) =>
      Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => v));
    units[u.nid] = {
      team: u.team,
      party: u.party ?? null,
      position: pos(u.position),
      dead: !!u.dead,
      hp: u.currentHp,
      max_hp: u.getMaxHp ? u.getMaxHp() : u.stats.HP,
      level: u.level,
      exp: u.exp,
      klass: u.klass,
      stats: Object.fromEntries(Object.entries(u.stats).map(([k, v]) => [k, Number(v)])),
      growth_points: nonzero(u.growthPoints),
      wexp: jsonable(nonzero(u.wexp)),
      items: u.items.map(itemSnap),
      equipped_weapon: u.equippedWeapon?.nid ?? null,
      skills: u.skills.map((s: any) => s.nid),
      skill_data: skillData,
      finished: !!u.finished,
      has_attacked: !!u.hasAttacked,
      has_traded: !!u.hasTraded,
      has_moved: !!u.hasMoved,
      ai: u.ai ?? null,
      ai_group: u.aiGroup ?? null,
      traveler: u.traveler ?? null,
    };
  }
  const regions = (g.currentLevel?.regions ?? []).map((r: any) => ({
    nid: r.nid,
    region_type: r.region_type,
    position: pos(r.position),
    size: jsonable(r.size),
    sub_nid: r.sub_nid ?? null,
    time_left: r.time_left ?? null,
    only_once: !!r.only_once,
  }));
  const em = g.eventManager;
  return {
    frame: e.frame,
    level: g.currentLevel?.nid ?? null,
    turn: g.turnCount,
    phase: g.phase?.getCurrent?.() ?? null,
    state: e.top() ?? null,
    stack: e.stack(),
    money: g.getParty?.()?.money ?? null,
    units,
    game_vars: jsonable(g.gameVars),
    level_vars: jsonable(g.levelVars),
    regions,
    events: (em?.eventQueue ?? []).map((ev: any) => ev.nid),
    already_triggered: [...(em?.getOnceTriggered?.() ?? [])].sort(),
    rng: { combat: getCombatRandomState(g), growth: getGrowthRandomState(g) ?? Number(g.gameVars.get('_random_seed') ?? 0) + 1 },
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Record<string, unknown> = {
  animation: 'Never', autoend_turn: 0, confirm_end: 0, text_speed: 0, mouse: 0,
  show_terrain: 0, show_objective: 0, autocursor: 1, talk_boop: 0,
};

export async function runScenario(scn: Scenario): Promise<Json> {
  const out: any = { engine: 'web', scenario: scn.name ?? null, steps: [], error: null };
  const e = new WebEngine();
  try {
    for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...(scn.settings ?? {}) })) setSetting(k, v);
    const g = e.game;
    // Python build_new: fresh game vars holding only the seed.
    g.gameVars.clear();
    g.gameVars.set('_random_seed', scn.seed ?? 0);
    g.currentMode = null;
    await g.loadLevel(String(scn.level));
    g.initDifficulty?.();
    // Same defaults as py_driver.py (Python's own default mode object pins
    // True Hit; growths default to Fixed so level-ups are seed independent).
    if (g.currentMode) {
      g.currentMode.rng_mode = scn.rng_mode ?? 'True Hit';
      g.currentMode.growths = scn.growths ?? 'Fixed';
    }
    if (scn.events === false) {
      // loadLevel already queued (and once-marked) the level_start events;
      // Python never triggers them at all in this mode.
      while (g.eventManager?.hasActiveEvents()) g.eventManager.dequeueCurrentEvent();
      g.eventManager.restoreOnceTriggered([]);
      e.suppressEvents = true;
      const real = g.eventManager.trigger.bind(g.eventManager);
      g.eventManager.trigger = (t: any, c: any) => (e.suppressEvents ? false : real(t, c));
    }
    enterStartedLevel(g);
    await e.settle({ skip: scn.skip, maxFrames: scn.start_frames ?? 20000 });
    const r = new Runner(e);
    r.setup(scn.setup ?? []);
    out.steps.push({ action: { do: 'start' }, snapshot: snapshot(e) });
    for (const a of scn.actions ?? []) {
      try {
        await r.run(a);
      } catch (err: any) {
        out.steps.push({ action: a, error: `${err?.name ?? 'Error'}: ${err?.message ?? err}`, snapshot: snapshot(e) });
        out.error = `step ${out.steps.length - 1} (${a.do}) failed`;
        console.error(err);
        break;
      }
      out.steps.push({ action: a, snapshot: snapshot(e) });
    }
  } catch (err: any) {
    console.error(err);
    out.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}\n${err?.stack ?? ''}`;
  }
  return out;
}
