/**
 * exp-state.ts: Python level_up.ExpState for exp granted outside combat
 * (a non-silent event `give_exp`). Combat keeps its own merged copy of these
 * phases in CombatState.
 *
 * init -> exp_wait (466 ms) -> exp0 (one frame per point, 'Experience Gain'
 * loop) -> [exp100 | exp-100 -> level_up (logo) -> level_screen] or
 * [prepare_promote -> promotion] -> exp_leave (bar closes, GainExp).
 * Timing reads the frame clock (performance.now), like Python's
 * engine.get_time().
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import { TILEHEIGHT, TILEWIDTH } from '../constants';
import { viewport } from '../viewport';
import type { UnitObject } from '../../objects/unit';
import { SkillObject } from '../../objects/skill';
import {
  AddSkillAction,
  ApplyStatChangesAction,
  GrowthPointChangeAction,
  SetUnitExpAction,
  SetUnitLevelAction,
  UpdateRecordsAction,
} from '../action';
import {
  autoLevelFrom,
  getEffectiveLevelCap,
  getInternalLevel,
  hasAutoPromote,
  canGiveExp,
} from '../leveling';
import { ExpBar, LevelUpScreen } from '../../ui/exp-display';
import type { MapAnimation } from '../../rendering/map-animation';
import { Banner, colored, skillIcon } from '../../ui/banner';
import { requestPromotion } from './promotion-state';
import { createPixelAnimation, pushAlert, runEventsBeforeWaiting } from './game-states';

let _game: any = null;

export function setExpStateGameRef(game: any): void {
  _game = game;
}

function getGame(): any {
  if (!_game) throw new Error('ExpState: game reference not set.');
  return _game;
}

/** Python game.exp_instance entry: (unit, exp, combat_object, starting_state). */
export interface ExpRequest {
  unit: UnitObject;
  exp: number;
  startingState: 'init';
}

const EXP_INSTANCE = 'exp_instance';

const LEVEL_UP_ANIMATIONS = [
  'LevelUpMap', 'StatUpSpark', 'LevelUpArrow', 'LevelDownArrow',
  ...[1, 2, 3, 4, 5].flatMap((n) => [`LevelUpNumber${n}`, `LevelDownNumber${n}`]),
];

/** Python `game.exp_instance.append(...)` then `game.state.change('exp')`. */
export function requestExp(game: any, request: ExpRequest): void {
  const queue: ExpRequest[] = game.memory.get(EXP_INSTANCE) ?? [];
  queue.push(request);
  game.memory.set(EXP_INSTANCE, queue);
  game.state.change('exp');
}

/** utils.frames2ms: int(16.67 * frames). */
function frames2ms(frames: number): number {
  return Math.trunc(16.67 * frames);
}

type ExpPhase =
  | 'init' | 'exp_wait' | 'exp0' | 'exp100' | 'exp-100' | 'exp_leave'
  | 'level_up' | 'level_screen' | 'prepare_promote' | 'wait';

export class ExpState extends State {
  readonly name = 'exp';
  override readonly transparent = true;

  private unit: UnitObject | null = null;
  private expGain = 0;
  private oldExp = 0;
  private oldLevel = 0;
  private autoPromote = false;
  private source = 'exp_gain';
  /** Python SimpleStateMachine: a stack of phases. */
  private phases: ExpPhase[] = [];
  private startTime = 0;
  private totalTimeForExp = 1;
  private expBar: ExpBar | null = null;
  private levelUpAnimation: MapAnimation | null = null;
  private levelUpScreen: LevelUpScreen | null = null;
  private levelUpSoundPlayed = false;
  private statChanges: Record<string, number> | null = null;
  private portrait: HTMLImageElement | null = null;

  /** The phase on top (Python self.state.get_state()); for tests. */
  get phase(): ExpPhase | null {
    return this.phases[this.phases.length - 1] ?? null;
  }

  override start(): StateResult {
    const game = getGame();
    const queue: ExpRequest[] = game.memory.get(EXP_INSTANCE) ?? [];
    const request = queue.pop();
    if (!request) {
      this.phases = [];
      game.state.back();
      return 'repeat';
    }
    const unit = request.unit;
    this.unit = unit;
    this.expGain = request.exp;
    this.oldExp = unit.exp;
    this.oldLevel = unit.level;
    this.autoPromote = hasAutoPromote(unit, game);
    this.phases = [request.startingState];
    this.startTime = performance.now();
    this.expBar = null;
    this.levelUpAnimation = null;
    this.levelUpScreen = null;
    this.statChanges = null;
    this.levelUpSoundPlayed = false;
    this.source = 'exp_gain';

    if (!this.autoPromote) {
      const maxExp = 100 * (getEffectiveLevelCap(unit, game) - this.oldLevel) - this.oldExp;
      this.expGain = Math.min(this.expGain, maxExp);
    }
    this.totalTimeForExp = Math.max(1, frames2ms(Math.abs(this.expGain)));

    if (!canGiveExp(unit, this.expGain, game)) {
      // At the level cap with nothing to lose: done here.
      this.phases = [];
      game.state.back();
      return 'repeat';
    }

    // Load the level-up animations now (Python's RESOURCES are preloaded).
    for (const nid of LEVEL_UP_ANIMATIONS) {
      if (game.db.mapAnimations?.get(nid)) {
        void game.resources?.loadImage?.(`resources/animations/${nid}.png`)?.catch?.(() => undefined);
      }
    }
    this.portrait = null;
    void game.resources?.loadPortrait?.(unit.portraitNid ?? unit.nid)
      ?.then?.((img: HTMLImageElement) => { this.portrait = img; })?.catch?.(() => undefined);
  }

  override begin(): StateResult {
    getGame().cursor.visible = false;
  }

  override end(): StateResult {
    getGame().audioManager?.stopSfx?.('Experience Gain');
  }

  private change(phase: ExpPhase): void {
    this.phases.push(phase);
  }

  private clear(): void {
    this.phases = [];
  }

  /** create_level_up_logo without a combat object: LevelUpMap over the unit. */
  private createLevelUpLogo(): void {
    const game = getGame();
    const unit = this.unit as UnitObject;
    if (unit.position) {
      const [cx, cy] = game.camera.getPosition();
      this.levelUpAnimation = createPixelAnimation('LevelUpMap',
        (unit.position[0] - cx / TILEWIDTH - 2) * TILEWIDTH,
        (unit.position[1] - cy / TILEHEIGHT - 1) * TILEHEIGHT);
    } else {
      this.levelUpAnimation = createPixelAnimation('LevelUpMap',
        Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
    }
  }

  /** IncLevel / SetLevel with get_next_level_up's (clamped) stat changes. */
  private applyLevelChange(direction: 1 | -1): void {
    const game = getGame();
    const unit = this.unit as UnitObject;
    const internal = getInternalLevel(unit, game.db);
    const result = autoLevelFrom(unit, direction > 0 ? internal : internal - 1, 1, undefined, game);
    const changes: Record<string, number> = {};
    for (const [nid, value] of Object.entries(result.statChanges)) changes[nid] = direction * value;
    this.statChanges = changes;
    game.actionLog.doAction(new GrowthPointChangeAction(unit, unit.growthPoints, result.growthPoints));
    game.actionLog.doAction(new SetUnitLevelAction(unit, unit.level + direction));
    game.actionLog.doAction(new ApplyStatChangesAction(unit, changes, unit, false));
    if (direction > 0) {
      game.actionLog.doAction(new UpdateRecordsAction('level_gain', unit.nid, unit.level, unit.klass));
    }
    this.createLevelUpLogo();
  }

  override update(): StateResult {
    const game = getGame();
    const unit = this.unit;
    if (!unit) return;
    const now = performance.now();
    const audio = game.audioManager;

    switch (this.phase) {
      case 'init': {
        this.expBar = new ExpBar(this.oldExp, true);
        this.startTime = now;
        this.change('exp_wait');
        break;
      }

      case 'exp_wait': {
        this.expBar?.update(this.oldExp);
        if (now - this.startTime > 466) {
          this.change('exp0');
          this.startTime = now;
          audio?.playSfxLoop?.('Experience Gain');
        }
        break;
      }

      case 'exp0': {
        const progress = Math.max(0, Math.min(1, (now - this.startTime) / this.totalTimeForExp));
        const expValue = this.oldExp + progress * this.expGain;
        this.expBar?.update(expValue);
        const expSet = Math.trunc(expValue);
        if (expSet >= this.oldExp + this.expGain) audio?.stopSfx?.('Experience Gain');

        if (expSet >= 100) {
          if (unit.level >= getEffectiveLevelCap(unit, game)) {
            audio?.stopSfx?.('Experience Gain');
            if (this.autoPromote) {
              this.expBar?.update(100);
              audio?.playSfx?.('Level Up');
            } else {
              this.expBar?.update(99);
            }
            this.clear();
            this.change('prepare_promote');
            this.change('exp_leave');
            this.expBar?.fadeOut();
            this.startTime = now;
          } else {
            this.change('exp100');
          }
        }

        if (expSet < 0 && this.expGain < 0) {
          if (unit.level > 1) this.change('exp-100');
          else audio?.stopSfx?.('Experience Gain');
        }

        if (now - this.startTime >= this.totalTimeForExp + 500) {
          audio?.stopSfx?.('Experience Gain');
          this.clear();
          this.change('exp_leave');
          this.expBar?.fadeOut();
          this.startTime = now;
        }
        break;
      }

      case 'exp_leave': {
        const done = this.expBar?.update() ?? true;
        if (done) {
          // GainExp: (old_exp + gain) % 100, Python modulo.
          game.actionLog.doAction(new SetUnitExpAction(unit, (((this.oldExp + this.expGain) % 100) + 100) % 100));
          game.actionLog.doAction(new UpdateRecordsAction('exp_gain', unit.nid, this.expGain, unit.klass));
          this.phases.pop();
          this.startTime = now;
          if (this.phases.length <= 0) {
            game.state.back();
            return 'repeat';
          }
        }
        break;
      }

      case 'exp100': {
        const progress = (now - this.startTime) / this.totalTimeForExp;
        const expValue = Math.min(this.oldExp + this.expGain - 100,
          this.oldExp + this.expGain * progress - 100);
        this.expBar?.update(expValue);
        if (Math.trunc(expValue) >= this.oldExp + this.expGain - 100) audio?.stopSfx?.('Experience Gain');
        if (now - this.startTime >= this.totalTimeForExp + 333) {
          this.applyLevelChange(1);
          this.clear();
          this.change('level_up');
          this.change('exp_leave');
          this.expBar?.fadeOut();
          this.startTime = now;
        }
        break;
      }

      case 'exp-100': {
        const progress = (now - this.startTime) / this.totalTimeForExp;
        const expValue = Math.max(100 + this.oldExp + this.expGain,
          100 + this.oldExp + this.expGain * progress);
        this.expBar?.update(expValue);
        if (Math.trunc(expValue) <= 100 + this.oldExp + this.expGain) audio?.stopSfx?.('Experience Gain');
        if (now - this.startTime >= this.totalTimeForExp + 333) {
          this.applyLevelChange(-1);
          this.clear();
          this.change('level_up');
          this.change('exp_leave');
          this.expBar?.fadeOut();
          this.startTime = now;
        }
        break;
      }

      case 'level_up': {
        if (!this.levelUpSoundPlayed) {
          audio?.playSfx?.('Level Up');
          this.levelUpSoundPlayed = true;
        }
        // No logo resource: nothing to wait for.
        if (!this.levelUpAnimation || this.levelUpAnimation.update()) {
          this.change('level_screen');
          this.startTime = now;
        }
        break;
      }

      case 'level_screen': {
        if (!this.levelUpScreen) {
          this.levelUpScreen = new LevelUpScreen(
            unit,
            this.statChanges ?? {},
            this.oldLevel,
            unit.level,
            game.db?.stats ?? [],
            game.audioManager,
            this.portrait,
            game.db.classes?.get(unit.klass)?.name ?? unit.klass,
            createPixelAnimation,
          );
        }
        const result = this.levelUpScreen.update(now);
        if (result === 'entered_level_up_wait') {
          this.fireLevelUpTrigger('during_unit_level_up');
        } else if (result === 'done') {
          game.state.back();
          this.fireLevelUpTrigger('unit_level_up');
          this.giveNewPersonalSkills(unit);
          this.giveNewClassSkills(unit);
          return 'repeat';
        }
        break;
      }

      case 'prepare_promote': {
        this.expBar?.update();
        if (now - this.startTime > 100) {
          const options: string[] = game.db.classes.get(unit.klass)?.turns_into ?? [];
          if (this.autoPromote && options.length > 0) {
            this.expBar?.update(0);
            requestPromotion(game, {
              unit, kind: 'promote', options: [], nextClass: options.length === 1 ? options[0] : null,
              canGoBack: false, popBelow: 0, itemUse: null,
            });
            game.state.change('transition_out');
            this.clear();
            this.change('wait');
            this.startTime = now;
          } else {
            game.actionLog.doAction(new SetUnitExpAction(unit, 99));
            game.state.back();
            return 'repeat';
          }
        }
        break;
      }

      case 'wait': {
        if (now - this.startTime > 1000) {
          game.state.back();
          return 'repeat';
        }
        break;
      }
    }
  }

  /** UnitLevelUp / DuringUnitLevelUp: their events run above this state. */
  private fireLevelUpTrigger(type: 'during_unit_level_up' | 'unit_level_up'): void {
    const game = getGame();
    const unit = this.unit;
    const queue = game.eventManager?.eventQueue as unknown[] | undefined;
    if (!unit || !queue || !this.statChanges) return;
    const before = queue.length;
    game.eventManager.trigger(
      {
        type,
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: unit.nid,
        unit1: unit,
        statChanges: { ...this.statChanges },
        source: this.source,
      },
      { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars },
    );
    const events = queue.splice(before);
    runEventsBeforeWaiting(game, events as any[], true);
  }

  /** ExpState._give_skills: AddSkill plus a GiveSkill alert for visible skills. */
  private giveSkills(unit: UnitObject, available: [number, string][], learns: (level: number) => boolean,
    source: { nid: string; type: string }): void {
    const game = getGame();
    for (const [levelNeeded, skillNid] of available) {
      if (!learns(levelNeeded)) continue;
      // 'Feat' opens feat_choice, which the web has no screen for.
      if (skillNid === 'Feat') continue;
      if (unit.skills.some((skill) => skill.nid === skillNid)) continue;
      const prefab = game.db.skills.get(skillNid);
      if (!prefab) continue;
      const skill = new SkillObject(prefab);
      skill.data.set('sourceNid', source.nid);
      skill.data.set('sourceType', source.type);
      game.actionLog.doAction(new AddSkillAction(unit, skill));
      if (unit.skills.includes(skill) && !skill.hasComponent?.('hidden')) {
        pushAlert(game, new Banner(`${colored(unit.name)} got ${colored(skill.name)}.`, skillIcon(skill), 3000, { sound: 'Item' }));
      }
    }
  }

  /** give_new_class_skills: the class's skills learned at exactly this level. */
  private giveNewClassSkills(unit: UnitObject): void {
    const klass = getGame().db.classes.get(unit.klass);
    this.giveSkills(unit, klass?.learned_skills ?? [], (level) => unit.level === level,
      { nid: unit.klass, type: 'klass' });
  }

  /** give_new_personal_skills: the unit's own skills at its internal level. */
  private giveNewPersonalSkills(unit: UnitObject): void {
    const game = getGame();
    const prefab = game.db.units.get(unit.nid);
    if (!prefab) return;
    const internal = getInternalLevel(unit, game.db);
    this.giveSkills(unit, prefab.learned_skills ?? [], (level) => internal === level,
      { nid: unit.nid, type: 'personal' });
  }

  override draw(surf: Surface): Surface {
    switch (this.phase) {
      case 'init': case 'exp_wait': case 'exp_leave': case 'exp0': case 'exp100': case 'exp-100':
      case 'prepare_promote':
        this.expBar?.draw(surf);
        break;
      case 'level_up':
        // dark_fuzz_background: bg_black at 0.66 translucency.
        surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(0,0,0,0.34)');
        // Python ExpState.draw advances the logo a second time per frame.
        this.levelUpAnimation?.update();
        this.levelUpAnimation?.draw(surf, 0, 0);
        break;
      case 'level_screen':
        this.levelUpScreen?.draw(surf, performance.now());
        break;
      default:
        break;
    }
    return surf;
  }
}
