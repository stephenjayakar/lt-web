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

import { ItemObject, createItemTree, setNextItemUid } from '../../../src/objects/item';
import { SkillObject, setNextSkillUid } from '../../../src/objects/skill';
import { UnitObject } from '../../../src/objects/unit';
import { RECORDS } from '../../../src/engine/records';
import { isCantoSkill } from '../../../src/combat/skill-system';
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
  startup_events?: boolean;
  start_game_vars?: Record<string, unknown>;
  /** Level sweep: start each level from the same state, one snapshot each. */
  levels?: string[];
  /** Press Fight when a level settles in preparations. */
  through_prep?: boolean;
  /** Sweep: actions run on every turn-based level after it starts. */
  level_actions?: Action[];
  /** Captured run state (capture_run_state.py), inlined by web-driver.mjs. */
  run_state?: RunState;
}

/** tools/oracle/capture_run_state.py output (Python save dicts as JSON). */
interface RunState {
  game_vars?: Record<string, any>;
  records?: Record<string, any>;
  current_party?: string;
  parties?: { nid: string; money: number; convoy: number[]; bexp?: number }[];
  level_cap_modifier?: number;
  already_triggered?: string[];
  units?: any[];
  items?: any[];
  skills?: any[];
}

const REST_STATES = new Set([
  'free', 'menu', 'move', 'canto_wait', 'weapon_choice', 'spell_choice',
  'combat_targeting', 'targeting', 'item', 'item_child', 'item_targeting', 'item_use',
  'trade', 'option_menu', 'option_child', 'free_roam', 'prep_main',
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
    // Free roam keeps the roam unit's movement live (as in Python).
    if (g.movementSystem?.isMoving?.() && this.top() !== 'free_roam') return true;
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
    // ui/menu ChoiceMenu rows carry label/value; ui/prep-ui Choice rows wrap
    // a typed entry (text or item).
    const label = (o: any): string => String(o.label ?? o.entry?.text ?? o.entry?.item?.nid ?? '');
    const value = (o: any): string => String(o.value ?? o.entry?.item?.nid ?? '');
    const index = (m: any): number => (typeof m.selectedIndex === 'number' ? m.selectedIndex : m.currentIndex);
    let idx = -1;
    if (items) idx = items.findIndex((it: any) => it?.nid === want);
    if (idx < 0) {
      idx = opts.findIndex((o: any) => label(o).toLowerCase() === lw || value(o).toLowerCase() === lw);
    }
    if (idx < 0) {
      throw new OracleError(`option ${want} not in ${this.top()} menu ${JSON.stringify(opts.map(label))}`);
    }
    for (let n = 0; n < opts.length + 2 && index(menu) !== idx; n++) {
      this.press(idx > index(menu) ? 'DOWN' : 'UP');
      menu = this.activeMenu().menu;
    }
    if (index(menu) !== idx) throw new OracleError(`could not reach option ${want} in ${this.top()}`);
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
  private e: WebEngine;

  constructor(e: WebEngine) {
    this.e = e;
  }

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
    if (e.top() === 'move') throw new OracleError(`${a.unit} cannot move to ${JSON.stringify(a.to)}`);
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
    // Staves land in item_targeting on the web, combat_targeting in Python.
    e.expect('targeting', 'combat_targeting', 'item_targeting');
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
    // Back to the player phase, or a level whose turn ended in free roam or
    // a game over (stop there rather than pressing on into the title).
    await e.settle({
      until: (en) => (['free', 'free_roam'].includes(en.top() ?? '') && en.game.phase.getCurrent() === 'player') ||
        en.top() === 'game_over',
      maxFrames: a.max_frames ?? 20000,
    });
  }

  /** First unoccupied tile inside the board's movement bounds (py_driver). */
  private emptyTile(): [number, number] {
    const g = this.e.game;
    const [minX, minY, maxX, maxY] = g.board.bounds ?? [0, 0, g.tilemap.width - 1, g.tilemap.height - 1];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
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

  /**
   * py_driver do_attack_or_wait: `unit` (default Player) attacks with its
   * first weapon the nearest valid target (Manhattan distance, then x, then
   * y) if its menu offers Attack, else waits in place.
   */
  async do_attack_or_wait(a: Action): Promise<void> {
    const e = this.e;
    const nid = a.unit ?? 'Player';
    const u = e.game.units.get(nid);
    if (!u || !u.position || u.finished || u.team !== 'player') return;
    await this.inMenuFor(nid);
    const { menu } = e.activeMenu();
    const labels: string[] = menu.options.map((o: any) => String(o.label ?? o.entry?.text ?? ''));
    if (labels.includes('Attack')) {
      e.choose('Attack');
      await e.settle();
      if (e.top() === 'weapon_choice') {
        e.press('SELECT');
        await e.settle();
      }
      e.expect('targeting', 'combat_targeting');
      const st: any = e.game.state.getCurrentState();
      const [ux, uy] = u.position;
      const positions: [number, number][] = (st.targets ?? []).map((t: any) => t?.position ?? t)
        .filter((p: any) => Array.isArray(p));
      positions.sort((p, q) =>
        (Math.abs(p[0] - ux) + Math.abs(p[1] - uy)) - (Math.abs(q[0] - ux) + Math.abs(q[1] - uy)) ||
        p[0] - q[0] || p[1] - q[1]);
      if (!positions.length) throw new OracleError('Attack offered but no targets');
      await this.targetAndFire(positions[0]);
    } else {
      e.choose('Wait');
      await e.settle();
    }
  }

  /** Pick a named option in whatever menu the top state shows. */
  async do_choose(a: Action): Promise<void> {
    this.e.choose(a.option);
    await this.e.settle({ skip: a.skip, maxFrames: a.max_frames });
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

/** The three LCG streams; the web keeps them in game vars (seed-tagged). */
function rngSnap(g: any): Json {
  const seed = Math.trunc(Number(g.gameVars.get('_random_seed') ?? 0)) || 0;
  const otherSeed = Number(g.gameVars.get('_other_random_seed'));
  const otherState = Number(g.gameVars.get('_other_random_state'));
  return {
    combat: getCombatRandomState(g),
    growth: getGrowthRandomState(g) ?? seed + 1,
    other: otherSeed === seed && Number.isInteger(otherState) ? otherState : seed + 2,
  };
}

/**
 * AI decision trace, matching py_driver.install_ai_trace: one entry per AI
 * decision (Python AIController.think finishing a unit), per canto retreat
 * and per AI group ping. Python pings inside think, before the decision is
 * recorded, and a unit whose group is not ready ends with no goal; the web
 * pings and checks the group after getAction, so those entries are fixed up.
 */
const aiTrace: any[] = [];

function installAiTrace(g: any): void {
  aiTrace.length = 0;
  const ai = g.aiController;
  if (ai.__oracleTraced) return;
  ai.__oracleTraced = true;
  const here = (u: any) => (u?.position ? pos(u.position) : null);
  const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
  const getAction = ai.getAction.bind(ai);
  const boardHp = () => [...g.units.values()]
    .filter((u: any) => u.position && !u.dead)
    .map((u: any) => [u.nid, u.currentHp])
    .sort((a: any, b: any) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  ai.getAction = (unit: any) => {
    const start = here(unit);
    const hp = boardHp();
    const action = getAction(unit);
    let move: Json = action.targetPosition ? pos(action.targetPosition) : null;
    if (same(move, start)) move = null;
    // Python: a SecondaryAI goal on the unit's own tile is not success (an
    // Interact there still triggers, but the unit did nothing).
    const did = action.type !== 'wait' && !((action.type === 'move' || action.type === 'interact') && move === null);
    aiTrace.push({
      unit: unit.nid,
      from: start,
      did,
      move: did ? move : null,
      // Python's goal_target is set only by the PrimaryAI (attack, steal,
      // support use); a SecondaryAI move toward a unit has none.
      target: did && ['attack', 'steal', 'use_item'].includes(action.type) && action.targetUnit?.position
        ? pos(action.targetUnit.position) : null,
      item: did ? action.item?.nid ?? null : null,
      hp,
    });
    return action;
  };
  const canto = ai.getCantoRetreatAction.bind(ai);
  ai.getCantoRetreatAction = (unit: any) => {
    const start = here(unit);
    const action = canto(unit);
    let goal: Json = action?.targetPosition ? pos(action.targetPosition) : null;
    if (same(goal, start)) goal = null;
    aiTrace.push({ unit: unit.nid, canto: goal });
    return action;
  };
  if (g.__oracleTracedGroups) return;
  g.__oracleTracedGroups = true;
  const trigger = g.triggerAiGroup.bind(g);
  g.triggerAiGroup = (groupId: string, unitNid: string) => {
    const ok = trigger(groupId, unitNid);
    let last = -1;
    for (let i = aiTrace.length - 1; i >= 0; i--) {
      if (aiTrace[i].unit === unitNid && 'did' in aiTrace[i]) { last = i; break; }
    }
    if (ok) {
      aiTrace.splice(last < 0 ? aiTrace.length : last, 0, { group: groupId, by: unitNid });
    } else if (last >= 0) {
      Object.assign(aiTrace[last], { did: false, move: null, target: null, item: null });
    }
    return ok;
  };
}

/** The song on top of the music stack (as the Python side reports it). */
function currentMusic(g: any): Json {
  const am = g.audioManager;
  const stack = am?.music?.songStack;
  if (Array.isArray(stack)) return stack.length ? stack[stack.length - 1].nid : null;
  // No music controller (no audio context in this page): replay the
  // recorded music calls onto a song stack the way Python's sound thread
  // keeps one.
  const songs: string[] = [];
  for (const call of am?.calls ?? []) {
    if (['play', 'push', 'fadeIn', 'battleFadeIn'].includes(call.op) && call.nid) {
      const at = songs.indexOf(call.nid);
      if (at >= 0) songs.splice(at, 1);
      songs.push(call.nid);
    } else if (call.op === 'pop' || call.op === 'battleFadeBack') {
      songs.pop();
    } else if (call.op === 'stop') {
      songs.length = 0;
    }
  }
  return songs.length ? songs[songs.length - 1] : null;
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
      max_hp: u.maxHp ?? u.stats.HP,
      level: u.level,
      exp: u.exp,
      klass: u.klass,
      stats: Object.fromEntries(Object.entries(u.stats).map(([k, v]) => [k, Number(v)])),
      growth_points: jsonable(nonzero(u.growthPoints)),
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
      generic: !!u.generic,
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
    objective: g.currentLevel?.objective ? jsonable(g.currentLevel.objective) : null,
    music: currentMusic(g),
    events: (em?.eventQueue ?? []).map((ev: any) => ev.nid),
    already_triggered: [...(em?.getOnceTriggered?.() ?? [])].sort(),
    rng: rngSnap(g),
    ai_trace: aiTrace.splice(0, aiTrace.length),
  };
}

/**
 * Load a captured run state into a fresh game, as py_driver.apply_run_state
 * does on the Python side: Python save dicts for the persistent units, their
 * items and skills, plus game vars, records, parties and spent only_once
 * events. Units start off the map without terrain statuses; loadLevel then
 * carries them into the level like a real level transition.
 */
function applyRunState(g: any, state: RunState): void {
  for (const [k, v] of Object.entries(state.game_vars ?? {})) {
    if (k !== '_random_seed') g.gameVars.set(k, v);
  }
  for (const [nid, value] of Object.entries(state.records ?? {})) {
    if (RECORDS.has(nid)) RECORDS.update(nid, value);
    else RECORDS.create(nid, value);
  }
  const items = new Map<number, ItemObject>();
  for (const d of state.items ?? []) {
    const prefab = g.db.items.get(d.nid) ?? { nid: d.nid, name: d.name, desc: d.desc, components: d.components };
    const item = new ItemObject(prefab);
    item.uid = d.uid;
    item.name = d.name ?? item.name;
    item.desc = d.desc ?? item.desc;
    item.droppable = !!d.droppable;
    (item as any).components = new Map<string, any>(d.components ?? []);
    item.data.clear();
    for (const [k, v] of Object.entries(d.data ?? {})) item.data.set(k, v);
    const uses = d.data?.uses ?? d.data?.c_uses;
    if (typeof uses === 'number') item.uses = uses;
    items.set(d.uid, item);
  }
  for (const d of state.items ?? []) {
    const parent = items.get(d.uid)!;
    parent.subitems = (d.subitems ?? []).map((uid: number) => items.get(uid)).filter(Boolean) as ItemObject[];
    for (const child of parent.subitems) child.parentItem = parent;
  }
  const skills = new Map<number, any>();
  for (const d of state.skills ?? []) skills.set(d.uid, d);
  let maxItem = 99;
  let maxSkill = 99;
  for (const uid of items.keys()) maxItem = Math.max(maxItem, uid);
  for (const uid of skills.keys()) maxSkill = Math.max(maxSkill, uid);
  setNextItemUid(maxItem + 1);
  setNextSkillUid(maxSkill + 1);
  const persistent: Map<string, any> = g.persistentUnits;
  for (const d of state.units ?? []) {
    const klass = g.db.classes.get(d.klass);
    if (!klass) throw new OracleError(`run state: unknown class ${d.klass} for ${d.nid}`);
    const unit = new UnitObject({
      nid: d.nid, name: d.name, desc: d.desc ?? '', variant: d.variant ?? null, level: d.level,
      klass: d.klass, tags: d.tags ?? [], bases: d.stats, growths: d.growths, starting_items: [],
      learned_skills: [], wexp_gain: {}, portrait_nid: d.portrait_nid, affinity: d.affinity,
    } as any, klass);
    unit.team = d.team;
    unit.party = d.party ?? '';
    unit.faction = d.faction ?? null;
    unit.generic = !!d.generic;
    unit.persistent = d.persistent ?? !d.generic;
    unit.notes = (d.notes ?? []).map(([k, v]: [string, string]) => [k, v]);
    unit.fields = new Map(Object.entries(d._fields ?? {}));
    unit.level = d.level;
    unit.exp = d.exp;
    unit.stats = { ...d.stats };
    unit.growths = { ...d.growths };
    unit.growthPoints = { ...(d.growth_points ?? {}) };
    unit.statCapModifiers = { ...unit.statCapModifiers, ...(d.stat_cap_modifiers ?? {}) };
    unit.wexp = { ...d.wexp };
    unit.ai = d.ai ?? 'None';
    (unit as any).roamAi = d.roam_ai ?? null;
    unit.aiGroup = d.ai_group ?? '';
    unit.portraitNid = d.portrait_nid ?? '';
    unit.affinity = d.affinity ?? '';
    unit.startingPosition = d.starting_position ?? null;
    unit.currentHp = d.current_hp;
    if (typeof d.current_mana === 'number') (unit as any).currentMana = d.current_mana;
    if (typeof d.current_fatigue === 'number') (unit as any).currentFatigue = d.current_fatigue;
    unit.traveler = d.traveler ?? null;
    unit.dead = !!d.dead;
    unit.position = null;
    unit.items = [];
    for (const uid of d.items ?? []) {
      const item = items.get(uid);
      if (!item) continue;
      item.owner = unit;
      unit.items.push(item);
    }
    unit.skills = [];
    for (const [uid, source, sourceType] of d.skills ?? []) {
      if (sourceType === 'terrain') continue;
      const sd = skills.get(uid);
      if (!sd) continue;
      const prefab = g.db.skills.get(sd.nid) ?? { nid: sd.nid, name: sd.nid, desc: '', components: sd.components };
      const skill = new SkillObject(prefab);
      skill.uid = uid;
      (skill as any).components = new Map<string, any>(sd.components ?? []);
      skill.data.clear();
      for (const [k, v] of Object.entries(sd.data ?? {})) skill.data.set(k, v);
      skill.data.set('sourceType', sourceType);
      if (source !== null && source !== undefined) skill.data.set('sourceNid', source);
      skill.ownerNid = unit.nid;
      skill.initiatorNid = sd.initiator_nid ?? null;
      unit.skills.push(skill);
      if (isCantoSkill(skill)) unit.hasCanto = true;
    }
    unit.equippedWeapon = d.equipped_weapon != null ? items.get(d.equipped_weapon) ?? null : null;
    unit.equippedAccessory = d.equipped_accessory != null ? items.get(d.equipped_accessory) ?? null : null;
    persistent.set(unit.nid, unit);
  }
  for (const p of state.parties ?? []) {
    const party = g.getParty(p.nid);
    if (!party) continue;
    party.money = p.money;
    party.bexp = p.bexp ?? 0;
    party.convoy = p.convoy.map((uid) => items.get(uid)).filter(Boolean);
  }
  if (state.current_party) g.currentParty = state.current_party;
  if (state.level_cap_modifier) g.gameVars.set('_global_level_cap_bonus', state.level_cap_modifier);
  g.eventManager?.restoreOnceTriggered(state.already_triggered ?? []);
}

/** Start one level the way py_driver.start_level does, then settle. */
async function startLevel(e: WebEngine, scn: Scenario, level: string): Promise<void> {
  const g = e.game;
  if (scn.run_state) {
    // Python build_new: a fresh game (registries, parties, spent events).
    g.buildNew();
    g.eventManager?.restoreOnceTriggered([]);
  }
  // Python build_new: fresh game vars holding only the seed.
  g.gameVars.clear();
  g.gameVars.set('_random_seed', scn.seed ?? 0);
  // Fresh difficulty mode with the scenario overrides, set before the level
  // builds so generic autolevels use them (loadLevel keeps an existing
  // mode). Same defaults as py_driver.py: Python's own default mode object
  // pins True Hit; growths default to Fixed so level-ups are seed independent.
  g.currentMode = null;
  g.initDifficulty();
  if (g.currentMode) {
    g.currentMode.rng_mode = scn.rng_mode ?? 'True Hit';
    g.currentMode.growths = scn.growths ?? 'Fixed';
  }
  if (scn.run_state) applyRunState(g, scn.run_state);
  // Run state a real playthrough would have set before this level.
  for (const [k, v] of Object.entries(scn.start_game_vars ?? {})) g.gameVars.set(k, v);
  await g.loadLevel(level);
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
  if (scn.through_prep && e.top() === 'prep_main') {
    // Leave preparations like a player: the first player phase (turn 1
    // events) only starts after Fight.
    e.choose('Fight');
    // prep_main fades out before it leaves (as in Python).
    await e.settle({ until: (en) => en.top() !== 'prep_main', maxFrames: 600 });
    await e.settle({ skip: scn.skip, maxFrames: scn.start_frames ?? 20000 });
  }
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
    // main.ts queues on_startup at boot, but the harness's clean level load
    // drains it before it runs. Run it here, before the level, as Python's
    // title screen does (EOtF creates its persistent records there).
    if (scn.startup_events !== false) {
      const ctx = { game: g, gameVars: g.gameVars, levelVars: g.levelVars };
      if (g.eventManager.trigger({ type: 'on_startup' }, ctx)) {
        g.state.change('event');
        await e.settle({ until: (en) => !en.game.eventManager.hasActiveEvents() && en.top() !== 'event' });
      }
    }
    if (scn.levels) {
      // Level sweep: same run state for every level, failures per level.
      const baseline = RECORDS.save();
      for (const level of scn.levels) {
        const step: any = { action: { do: 'level', level: String(level) } };
        try {
          RECORDS.restore(baseline);
          await startLevel(e, scn, String(level));
          installAiTrace(e.game);
          new Runner(e).setup(scn.setup ?? []);
        } catch (err: any) {
          console.error(err);
          step.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
        }
        try {
          step.snapshot = snapshot(e);
        } catch (err: any) {
          step.error ??= `snapshot failed: ${err?.message ?? err}`;
        }
        out.steps.push(step);
        // The same actions on every level that settled into a turn-based
        // phase (free roam levels have no turns to end), as py_driver does.
        if (!step.error && e.top() !== 'free_roam') {
          const runner = new Runner(e);
          for (const a of scn.level_actions ?? []) {
            const act: any = { action: { ...a, level: String(level) } };
            try {
              await runner.run(a);
            } catch (err: any) {
              console.error(err);
              act.error = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
            }
            try {
              act.snapshot = snapshot(e);
            } catch (err: any) {
              act.error ??= `snapshot failed: ${err?.message ?? err}`;
            }
            out.steps.push(act);
            if (act.error) break;
          }
        }
      }
      const failed = out.steps.filter((st: any) => st.error).map((st: any) => st.action.level);
      if (failed.length) out.level_errors = failed;
      return out;
    }
    await startLevel(e, scn, String(scn.level));
    installAiTrace(g);
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
