/**
 * QA tools entry point (dev server and LT_QA=1 builds only; never in player
 * builds — see vite.config.ts `__LT_QA__` and docs/qa-tools.md).
 *
 * Opened with `?qa` on the URL. The page boots like the harness (no rAF
 * game loop) and this module steps frames itself:
 *
 * - turbo: many update frames per real millisecond (`speed`, 0 = as fast as
 *   the CPU allows), under a virtual clock so time-based presentation keeps
 *   pace with frames;
 * - fast presentation: fastest unit speed, instant text, events in skip
 *   mode, optional map combat instead of battle animations — presentation
 *   only, never the game's rules or RNG;
 * - jump: a realistic EOtF mid-run state (qa-jump.ts);
 * - play: the QA driver auto-plays rooms, events and battles (qa-driver.ts)
 *   and logs every floor, warning and error.
 *
 * The API lives on `window.__qa` (see QaApi below); scripts/qa-run.mjs drives
 * it from a headless browser.
 */

import type { GameButton } from '../engine/input';
import { GameEvent } from '../events/event-manager';
import { RECORDS } from '../engine/records';
import { qaSettingOverrides, setSetting } from '../engine/states/settings-state';
import { FRAMETIME, updateAnimationCounters } from '../engine/constants';
import type { Surface } from '../engine/surface';
import { updateUnitSounds } from '../audio/unit-sound';
import { qaDraw } from '../engine/state-machine';
import { advanceVirtualClock, installVirtualClock, realDate, realNow, virtualNow } from './qa-clock';
import { QaLog, type QaContext, type QaLogEntry } from './qa-log';
import { Policy, type PolicyOptions } from './qa-policy';
import { QaDriver, registerQaAiPresets, type FloorRecord, type HubTourOptions } from './qa-driver';
import { jumpEotf, type JumpResult, type JumpSpec } from './qa-jump';

export interface FastOptions {
  /** Frames per real 1/60 s; 0 = unlimited (default). 1 = normal speed. */
  speed?: number;
  /** Events in skip mode (dialogue, waits and cutscenes skipped). */
  skipEvents?: boolean;
  /** 'map' = map combat instead of battle animations (presentation only). */
  combat?: 'animation' | 'map';
  /** Silence console.log/info (warnings and errors are still collected). */
  quietLog?: boolean;
  /**
   * Draw (render) only every Nth frame; the others run update logic only.
   * 1 = draw every frame (default). Presentation timers that Python also
   * advances while drawing (portraits, some animations) then take more
   * frames, but rules, RNG and outcomes are unchanged.
   */
  drawEvery?: number;
}

export interface PerfSample { ms: number; phase: string; state: string; draw: boolean }
export interface PerfStats {
  frames: number; avg: number; p50: number; p95: number; p99: number; max: number;
  /** Frames whose work alone exceeded one 60 Hz frame (16.7 ms). */
  over16: number;
  totalMs: number;
}
export type PerfReport = Record<string, PerfStats>;

export interface QaDisplay {
  surface: () => Surface;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export interface PlayOptions {
  /** Stop after this many floors have been completed. */
  floors?: number;
  /** Stop once this floor is reached (exclusive). */
  toFloor?: number;
  /** Stop after the current battle level ends. */
  oneLevel?: boolean;
  /** Turn limit per battle map. */
  maxTurns?: number;
  /** At the turn limit, force a win (win_game) instead of stopping. */
  forceWin?: boolean;
  /** Real-time budget in ms (default 30 min). */
  maxRealMs?: number;
  policy?: Partial<PolicyOptions>;
  /** Run the player phase with the QA AI (default true). */
  autoplay?: boolean;
  /** QA: enemies get the 'None' AI each player phase (walk a boss's event script). */
  passiveEnemies?: boolean;
  /** In the hub (X): visit every NPC and event region, then stop. */
  hubTour?: Partial<HubTourOptions>;
  /** Without autoplay: move the cursor over a unit every 30 frames (HUD, HP bars). */
  hover?: boolean;
}

export interface QaStatus {
  phase: 'idle' | 'jumping' | 'playing' | 'done';
  result: string | null;
  reason: string | null;
  level: string | null;
  floor: unknown;
  turn: number;
  state: string;
  stack: string;
  frames: number;
  realMs: number;
  fps: number;
  warnings: number;
  errors: number;
}

export interface QaReport {
  status: QaStatus;
  jump: JumpResult | null;
  floors: FloorRecord[];
  log: QaLogEntry[];
  party: { nid: string; klass: string; level: number; hp: number; maxHp: number; dead: boolean }[];
  options: { fast: FastOptions; play: PlayOptions | null };
  startedAt: number;
}

class QaController {
  readonly game: any;
  readonly display: QaDisplay;
  readonly log: QaLog;
  readonly driver: QaDriver;
  ready = false;

  private fast: Required<FastOptions> = { speed: 1, skipEvents: false, combat: 'animation', quietLog: false, drawEvery: 1 };
  private credit = 0;
  private lastPump = 0;
  private frames = 0;
  private fpsWindow: { real: number; frames: number } = { real: 0, frames: 0 };
  private fps = 0;
  private phase: QaStatus['phase'] = 'idle';
  private result: string | null = null;
  private reason: string | null = null;
  private playOptions: PlayOptions | null = null;
  private playStartReal = 0;
  private playStartFloor: number | null = null;
  private oneLevelNid: string | null = null;
  private jumpResult: JumpResult | null = null;
  private startedAt = realDate();
  private waiters: { pred: () => boolean; resolve: () => void; reject: (e: Error) => void; deadline: number; what: string }[] = [];
  private channel = new MessageChannel();
  private scheduled = false;
  private scriptCounter = 0;
  private loopErrors = 0;

  constructor(game: any, display: QaDisplay) {
    this.game = game;
    this.display = display;
    this.log = new QaLog(() => this.context());
    this.log.install();
    this.driver = new QaDriver(game, this.log, new Policy({}));
    this.driver.runScript = (lines, nid) => this.runScript(lines, nid);
    this.channel.port1.onmessage = () => {
      this.scheduled = false;
      this.pump();
    };
  }

  start(): void {
    installVirtualClock();
    registerQaAiPresets(this.game);
    this.lastPump = realNow();
    this.fpsWindow = { real: realNow(), frames: 0 };
    this.schedule(0);
    this.ready = true;
  }

  // -------------------------------------------------------------------------
  // Frame pump
  // -------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.scheduled) return;
    this.scheduled = true;
    if (delayMs <= 0) this.channel.port2.postMessage(0);
    else setTimeout(() => { this.scheduled = false; this.pump(); }, delayMs);
  }

  private pump(): void {
    const t0 = realNow();
    let allowed = Number.POSITIVE_INFINITY;
    if (this.fast.speed > 0) {
      this.credit += ((t0 - this.lastPump) / FRAMETIME) * this.fast.speed;
      this.credit = Math.min(this.credit, this.fast.speed * 4);
      allowed = Math.floor(this.credit);
    }
    this.lastPump = t0;
    let stepped = 0;
    try {
      while (stepped < allowed && realNow() - t0 < 30) {
        const input = this.driver.tick();
        this.stepFrame(input);
        stepped += 1;
        if (this.phase === 'playing' && this.checkPlayDone()) break;
      }
      this.loopErrors = 0;
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.log.record('error', `QA frame loop: ${message}`);
      // An exception every frame means the game cannot progress: stop the
      // run instead of waiting for the stuck detector.
      this.loopErrors += 1;
      if (this.loopErrors >= 120 && this.phase === 'playing') {
        this.finish('error', `engine exception every frame: ${message.split(/\r?\n/)[0]}`);
      }
    }
    if (this.fast.speed > 0) this.credit -= stepped;
    const now = realNow();
    if (now - this.fpsWindow.real >= 1000) {
      this.fps = Math.round(((this.frames - this.fpsWindow.frames) * 1000) / (now - this.fpsWindow.real));
      this.fpsWindow = { real: now, frames: this.frames };
    }
    this.resolveWaiters();
    this.schedule(stepped < allowed || this.fast.speed <= 0 ? 0 : FRAMETIME / Math.max(1, this.fast.speed));
  }

  /**
   * One engine frame, as the harness steps it (main.ts gameLoop minus the
   * real-time pacing), drawing and blitting only every `drawEvery` frames.
   */
  private stepFrame(input: GameButton | null): void {
    const game = this.game;
    const perfStart = this.perfSamples ? realNow() : 0;
    const draw = this.fast.drawEvery <= 1 || this.frames % this.fast.drawEvery === 0;
    const surface = this.display.surface();
    game.frameDeltaMs = FRAMETIME;
    // Keyboard/pointer input still works (a headed QA tab can be played by
    // hand after a jump); driver input takes precedence.
    const manual = game.input?.processInput?.(FRAMETIME) ?? null;
    if (input === null) input = manual;
    if (draw) surface.clear();
    qaDraw.skip = !draw;
    try {
      let repeat = true;
      let iterations = 0;
      while (repeat && iterations < 10) {
        // main.ts gameLoop: repeat iterations see no stale frame events.
        if (iterations > 0) game.input?.clearFrameEvents?.();
        const [, again] = game.state.update(iterations === 0 ? input : null, surface);
        repeat = again;
        iterations += 1;
      }
    } finally {
      qaDraw.skip = false;
    }
    game.input?.endFrame?.();
    updateAnimationCounters();
    game.movementSystem.update(FRAMETIME);
    updateUnitSounds(game.units.values(), !!game.roamInfo?.roam, game.camera?.getCullRect?.() ?? null);
    if (draw) {
      const { canvas, ctx } = this.display;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(surface.canvas, 0, 0);
    }
    advanceVirtualClock(FRAMETIME);
    this.frames += 1;
    if (this.perfSamples) {
      this.perfSamples.push({
        ms: realNow() - perfStart,
        phase: String(game.phase?.getCurrent?.() ?? ''),
        state: game.state.getCurrentState()?.name ?? '',
        draw,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Frame-time sampling (scripts/perf-frames.mjs)
  // -------------------------------------------------------------------------

  private perfSamples: PerfSample[] | null = null;

  perfStart(): void {
    this.perfSamples = [];
  }

  /** Stop sampling; per-frame update+draw time, grouped by phase and top state. */
  perfStop(): PerfReport {
    const samples = this.perfSamples ?? [];
    this.perfSamples = null;
    const groups = new Map<string, number[]>();
    const add = (key: string, ms: number) => {
      const list = groups.get(key) ?? [];
      list.push(ms);
      groups.set(key, list);
    };
    for (const s of samples) {
      add('all', s.ms);
      add(`phase:${s.phase || '-'}`, s.ms);
      add(`state:${s.state}`, s.ms);
    }
    const stats = (list: number[]): PerfStats => {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      const total = sorted.reduce((sum, ms) => sum + ms, 0);
      return {
        frames: sorted.length,
        avg: total / Math.max(1, sorted.length),
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: sorted[sorted.length - 1] ?? 0,
        over16: sorted.filter((ms) => ms > FRAMETIME).length,
        totalMs: total,
      };
    };
    const out: PerfReport = {};
    for (const [key, list] of groups) out[key] = stats(list);
    return out;
  }

  private resolveWaiters(): void {
    if (this.waiters.length === 0) return;
    const now = realNow();
    this.waiters = this.waiters.filter((w) => {
      let done = false;
      try {
        done = w.pred();
      } catch {
        done = false;
      }
      if (done) {
        w.resolve();
        return false;
      }
      if (now > w.deadline) {
        w.reject(new Error(`timed out waiting for ${w.what} (state ${this.game.state.getStackNames().join('>')}, level ${this.game.currentLevel?.nid})`));
        return false;
      }
      return true;
    });
  }

  waitFor(pred: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ pred, resolve, reject, deadline: realNow() + timeoutMs, what });
    });
  }

  // -------------------------------------------------------------------------
  // Fast mode
  // -------------------------------------------------------------------------

  setFast(options: FastOptions): Required<FastOptions> {
    this.fast = { ...this.fast, ...options };
    this.credit = 0;
    this.driver.options.skipEvents = this.fast.skipEvents;
    this.log.quiet = this.fast.quietLog;
    // Real settings a player can pick: fastest walk, instant text, no boops.
    if (this.fast.speed !== 1 || this.fast.skipEvents) {
      setSetting('unit_speed', 15);
      setSetting('text_speed', 0);
      setSetting('talk_boop', 0);
      setSetting('confirm_end', 0);
      setSetting('autoend_turn', 1);
      setSetting('music_volume', 0);
      setSetting('sound_volume', 0);
    }
    if (qaSettingOverrides) {
      if (this.fast.combat === 'map') qaSettingOverrides.animation = 'Never';
      else delete qaSettingOverrides.animation;
    }
    return { ...this.fast };
  }

  // -------------------------------------------------------------------------
  // Scripts, jump, play
  // -------------------------------------------------------------------------

  /** Queue an ad-hoc event script (event-command lines) to run now. */
  runScript(lines: string[], nid?: string): void {
    const game = this.game;
    this.scriptCounter += 1;
    const eventNid = nid ?? `QA_Script_${this.scriptCounter}`;
    const prefab = {
      nid: eventNid, name: eventNid, trigger: 'qa', level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: lines,
    };
    const event = new GameEvent(prefab as any, { type: 'qa' } as any, () => game);
    game.eventManager.eventQueue.push(event);
    const top = game.state.getCurrentState()?.name;
    // free / free_roam pick queued events up themselves.
    if (top !== 'event' && top !== 'free' && top !== 'free_roam') game.state.change('event');
  }

  async jump(spec: JumpSpec): Promise<JumpResult> {
    this.phase = 'jumping';
    this.driver.mode = 'jump';
    const t0 = realNow();
    try {
      this.jumpResult = await jumpEotf({
        game: this.game,
        records: RECORDS as any,
        waitFor: (pred, what, timeout) => this.waitFor(pred, what, timeout),
        runScript: (lines, nid) => this.runScript(lines, nid),
        setSortie: (nids) => {
          this.driver.policy.options.sortie = nids;
          this.driver.policy.resetSortie();
        },
        note: (text) => this.log.print(`[QA] ${text}`),
      }, spec);
      this.log.print(`[QA] jump done in ${Math.round(realNow() - t0)} ms: ${this.jumpResult.level} floor ${String(this.jumpResult.floor)}`);
      return this.jumpResult;
    } finally {
      this.phase = 'idle';
      this.driver.mode = 'off';
    }
  }

  play(options: PlayOptions = {}): QaStatus {
    this.playOptions = options;
    this.driver.policy = new Policy({ ...this.driver.policy.options, ...(options.policy ?? {}) });
    this.driver.options = {
      skipEvents: this.fast.skipEvents,
      maxTurns: options.maxTurns ?? 40,
      forceWin: options.forceWin ?? false,
      autoplay: options.autoplay ?? true,
      passiveEnemies: options.passiveEnemies ?? false,
      hover: options.hover ?? false,
    };
    this.result = null;
    this.reason = null;
    this.phase = 'playing';
    this.driver.hubTour = options.hubTour
      ? { passes: options.hubTour.passes ?? 1, skip: options.hubTour.skip ?? ['Keeper'], only: options.hubTour.only }
      : null;
    this.driver.hubDone = false;
    this.driver.mode = 'play';
    this.playStartReal = realNow();
    this.oneLevelNid = null;
    const floor = this.game.gameVars.get('Floor');
    this.playStartFloor = typeof floor === 'number' ? floor : null;
    this.driver.beginTracking();
    return this.status();
  }

  stop(reason = 'stopped'): QaStatus {
    if (this.phase === 'playing') this.finish('stopped', reason);
    return this.status();
  }

  private checkPlayDone(): boolean {
    const options = this.playOptions ?? {};
    const game = this.game;
    const floor = game.gameVars.get('Floor');
    const top = game.state.getCurrentState()?.name ?? '';
    const settled = (top === 'free_roam' || top === 'prep_main' || top === 'free') && !game.eventManager?.hasActiveEvents();
    if (this.driver.stopReason) {
      const reason = this.driver.stopReason;
      const lost = /game over|title/.test(reason);
      if (lost) this.driver.markLoss('lost');
      this.finish(lost ? 'defeat' : 'stuck', reason);
      return true;
    }
    if (options.hubTour && this.driver.hubDone && settled) {
      this.finish('ok', 'hub tour complete');
      return true;
    }
    if (options.oneLevel) {
      const nid: string | undefined = game.currentLevel?.nid;
      const prefab = nid ? game.db.levels.get(nid) : null;
      if (prefab && !prefab.roam && !this.oneLevelNid) this.oneLevelNid = nid ?? null;
      if (this.oneLevelNid && nid !== this.oneLevelNid && settled) {
        this.finish('ok', `level ${this.oneLevelNid} finished`);
        return true;
      }
    }
    if (typeof floor === 'number' && this.playStartFloor !== null && settled) {
      if (options.floors !== undefined && floor >= this.playStartFloor + options.floors) {
        this.finish('ok', `completed ${options.floors} floor(s)`);
        return true;
      }
      if (options.toFloor !== undefined && floor >= options.toFloor) {
        this.finish('ok', `reached floor ${options.toFloor}`);
        return true;
      }
    }
    if (realNow() - this.playStartReal > (options.maxRealMs ?? 30 * 60_000)) {
      this.finish('timeout', 'real-time budget exhausted');
      return true;
    }
    return false;
  }

  private finish(result: string, reason: string): void {
    this.result = result;
    this.reason = reason;
    this.phase = 'done';
    this.driver.finishTracking(result === 'defeat' ? 'lost' : result === 'ok' ? 'won' : result);
    this.driver.mode = 'off';
    this.log.print(`[QA] play ${result}: ${reason}`);
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  context(): QaContext {
    const game = this.game;
    let event: string | null = null;
    try {
      event = game.eventManager?.getCurrentEvent?.()?.nid ?? null;
    } catch {
      event = null;
    }
    const stack: string[] = game.state?.getStackNames?.() ?? [];
    return {
      level: game.currentLevel?.nid ?? null,
      floor: game.gameVars?.get?.('Floor') ?? null,
      turn: Number(game.turnCount ?? 0),
      phase: String(game.phase?.getCurrent?.() ?? ''),
      state: stack[stack.length - 1] ?? '',
      stack: stack.join('>'),
      event,
      frame: this.frames,
    };
  }

  status(): QaStatus {
    const ctx = this.context();
    const entries = this.log.list();
    return {
      phase: this.phase,
      result: this.result,
      reason: this.reason,
      level: ctx.level,
      floor: ctx.floor,
      turn: ctx.turn,
      state: ctx.state,
      stack: ctx.stack,
      frames: this.frames,
      realMs: Math.round(realNow() - this.playStartReal),
      fps: this.fps,
      warnings: entries.filter((e) => e.kind === 'warn').length,
      errors: entries.filter((e) => e.kind !== 'warn' && e.kind !== 'qa').length,
    };
  }

  report(): QaReport {
    const units = (this.game.getAllUnitsInParty?.() ?? []) as any[];
    return {
      status: this.status(),
      jump: this.jumpResult,
      floors: this.driver.floors,
      log: this.log.list(),
      party: units.map((u) => ({
        nid: u.nid, klass: u.klass, level: u.level, hp: u.currentHp, maxHp: u.maxHp, dead: !!u.isDead?.(),
      })),
      options: { fast: { ...this.fast }, play: this.playOptions },
      startedAt: this.startedAt,
    };
  }

  /** Step `count` frames synchronously (for focused checks). */
  step(count: number, input: GameButton | null = null): void {
    for (let i = 0; i < count; i += 1) {
      const tick = this.driver.tick();
      this.stepFrame(i === 0 && input ? input : tick);
    }
  }
}

export interface QaApi {
  readonly ready: boolean;
  game: any;
  setFast(options: FastOptions): Required<FastOptions>;
  jump(spec: JumpSpec): Promise<JumpResult>;
  play(options?: PlayOptions): QaStatus;
  stop(reason?: string): QaStatus;
  status(): QaStatus;
  report(): QaReport;
  context(): QaContext;
  runScript(lines: string[], nid?: string): void;
  step(count: number, input?: GameButton | null): void;
  virtualNow(): number;
  realNow(): number;
  perfStart(): void;
  perfStop(): PerfReport;
}

export function installQa(game: any, params: URLSearchParams, display: QaDisplay): QaApi {
  const controller = new QaController(game, display);
  const api: QaApi = {
    get ready() { return controller.ready; },
    game,
    setFast: (options) => controller.setFast(options),
    jump: (spec) => controller.jump(spec),
    play: (options) => controller.play(options),
    stop: (reason) => controller.stop(reason),
    status: () => controller.status(),
    report: () => controller.report(),
    context: () => controller.context(),
    runScript: (lines, nid) => controller.runScript(lines, nid),
    step: (count, input) => controller.step(count, input ?? null),
    virtualNow,
    realNow,
    perfStart: () => controller.perfStart(),
    perfStop: () => controller.perfStop(),
  };
  (window as any).__qa = api;
  const speed = Number(params.get('qa'));
  if (Number.isFinite(speed) && params.get('qa') !== '') {
    controller.setFast({ speed, skipEvents: speed !== 1, quietLog: speed !== 1 });
  }
  controller.start();
  console.info('[QA] tools ready: window.__qa (docs/qa-tools.md)');
  return api;
}
