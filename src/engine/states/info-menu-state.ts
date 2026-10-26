/**
 * InfoMenuState — port of lt-maker/app/engine/info_menu/info_menu_state.py.
 *
 * Panorama background (info_menu_background), the additive info_menu_flash,
 * a portrait column (info_unit / status_platform sprites, bitmap-font name,
 * class, level, exp, HP), and a sliding right page: personal data (stat
 * grooves, AUX toggles growths), equipment (item rows + battle_info), weapon
 * ranks / supports / skills, and notes. LEFT/RIGHT slide pages with the
 * gui.Logo title swap; UP/DOWN fade between units like Python.
 */

import { State } from '../state';
import type { StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { FRAMETIME, WINHEIGHT, WINWIDTH } from '../constants';
import type { UnitObject } from '../../objects/unit';
import { drawIcon16, getIconSheet } from '../../ui/icons';
import {
  accuracy,
  attackSpeed,
  avoid,
  critAccuracy,
  damage,
  evaluateEquation,
  getEquippedWeapon,
} from '../../combat/combat-calcs';
import { FONT } from '../../rendering/bmp-font';
import {
  growthChange,
  modifiedMaximumRange,
  modifiedMinimumRange,
  skillConditionActive,
} from '../../combat/skill-system';
import { available as itemAvailable, inventoryCapacity } from '../../combat/item-system';
import type { SkillObject } from '../../objects/skill';
import type { ItemObject } from '../../objects/item';
import { drawStyledText, measureStyledText } from '../../ui/styled-text';
import {
  HelpDialog,
  SkillHelpDialog,
  StatDialog,
  itemHelpBox,
  setHelpMenuGameRef,
  type HelpBox,
} from '../../ui/help-menu';
import {
  MenuBackground,
  MenuCursor,
  MenuScene,
  ScrollArrow,
  blitSprite,
  blitSub,
  blitText,
  blitTextCenter,
  blitTextRight,
  getKeyedImage,
  getPortrait,
  getSprite,
  preloadSprites,
  textWidth,
} from '../../ui/menu-chrome';

// ---------------------------------------------------------------------------
// Lazy game reference — matches the pattern from game-states.ts
// ---------------------------------------------------------------------------

let _game: any = null;

export function setInfoMenuGameRef(g: any): void {
  _game = g;
}

export type SkillInfoPresentation = 'hidden' | 'grey' | 'normal';

/** Python info-menu hidden_if_inactive / grey_if_inactive policy. */
export function skillInfoPresentation(
  skill: SkillObject,
  unit: UnitObject,
  game: any,
): SkillInfoPresentation {
  if (skill.hasComponent('hidden') ||
      skill.hasComponent('is_terrain') ||
      skill.data.get('multiSkillSourceType') === 'multi_skill') return 'hidden';
  const parent = skill.data.get('multiSkillSource');
  if (parent && skillInfoPresentation(parent, unit, game) !== 'normal') {
    return skill.hasComponent('hidden_if_inactive') ? 'hidden' : 'grey';
  }
  let active = true;
  if (skill.hasComponent('build_charge')) {
    active &&= Number(skill.data.get('charge') ?? 0) >=
      Number(skill.data.get('total_charge') ?? skill.getComponent('build_charge') ?? 0);
  }
  if (skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
    active &&= Number(skill.data.get('charge') ?? 0) > 0;
  }
  const manaRequirement = skill.getComponent<number>('cost_mana') ??
    skill.getComponent<number>('check_mana');
  if (typeof manaRequirement === 'number') {
    active &&= Number(unit.currentMana ?? 0) >= manaRequirement;
  }
  active &&= skillConditionActive(skill, unit, { game });
  if (!active && skill.hasComponent('hidden_if_inactive')) return 'hidden';
  if (!active && skill.hasComponent('grey_if_inactive')) return 'grey';
  return 'normal';
}

/** Python info-menu visibility and stable class-skill-first ordering. */
export function visibleSkillsForInfoMenu(
  unit: UnitObject,
  game: any,
): SkillObject[] {
  return unit.skills
    .filter((skill) => skillInfoPresentation(skill, unit, game) !== 'hidden')
    .map((skill, index) => ({ skill, index }))
    .sort((left, right) =>
      Number(right.skill.hasComponent('class_skill')) -
        Number(left.skill.hasComponent('class_skill')) ||
      left.index - right.index)
    .map(({ skill }) => skill);
}


function getGame(): any {
  if (!_game) throw new Error('InfoMenuState: game reference not set.');
  return _game;
}

// ---------------------------------------------------------------------------
// Python helpers
// ---------------------------------------------------------------------------

const INFO_STATES = ['personal_data', 'equipment', 'support_skills', 'notes'] as const;
type InfoPage = typeof INFO_STATES[number];
const PORTRAIT_WIDTH = 128;

function translate(text: string): string {
  return _game?.db?.translate?.(text) ?? text;
}

function constant(name: string, fallback: unknown = false): any {
  return _game?.db?.getConstant?.(name, fallback) ?? fallback;
}

/** Sum of SubtleStatChange entries for a stat (unit.subtle_stat_bonus). */
function subtleStatBonus(unit: UnitObject, stat: string): number {
  let total = 0;
  for (const skill of unit.skills) {
    const changes = skill.getComponent<any>('subtle_stat_change');
    if (!Array.isArray(changes)) continue;
    for (const entry of changes) {
      if (Array.isArray(entry) && entry[0] === stat && typeof entry[1] === 'number') total += entry[1];
    }
  }
  return total;
}

function growthRate(unit: UnitObject, stat: string): number {
  const game = getGame();
  const klass = game.db.classes.get(unit.klass);
  const difficulty = game.currentMode && game.mode
    ? game.currentMode.getGrowthBonus(unit, game.getAlliedTeams(), game.mode)
    : {};
  return (unit.growths[stat] ?? 0) + growthChange(unit, stat) +
    (klass?.growth_bonus?.[stat] ?? 0) + (difficulty?.[stat] ?? 0);
}

function baseGrowthRate(unit: UnitObject, stat: string): number {
  const klass = getGame().db.classes.get(unit.klass);
  return (unit.growths[stat] ?? 0) + (constant('alt_growth_format') ? (klass?.growth_bonus?.[stat] ?? 0) : 0);
}

/** InfoMenuState.growth_colors */
function growthColor(value: number): string {
  if (value >= 0 && value <= 20) return 'red-orange';
  if (value > 20 && value <= 30) return 'light-red';
  if (value > 30 && value <= 40) return 'pink-orange';
  if (value > 40 && value <= 50) return 'light-orange';
  if (value > 50 && value <= 60) return 'corn-yellow';
  if (value > 60 && value <= 70) return 'light-green';
  if (value > 70 && value <= 80) return 'olive-green';
  if (value > 80 && value <= 90) return 'soft-green';
  if (value > 90) return 'yellow-green';
  return 'yellow';
}

/** icons.draw_glow: text pulsing towards white over 1.6 s. */
function blitGlow(
  surf: Surface, font: string, text: string, x: number, y: number, timeMs: number, align: 'left' | 'right' = 'left',
): void {
  const width = textWidth(font, text);
  const left = align === 'right' ? x - width : x;
  const white = (Math.sin(((timeMs % 1600) / 800) * Math.PI) + 1) / 2;
  const tmp = new Surface(Math.max(1, width + 2), 16);
  blitText(tmp, font, text, 0, 0);
  const ctx = tmp.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = `rgba(255,255,255,${white.toFixed(3)})`;
  ctx.fillRect(0, 0, tmp.canvas.width, tmp.canvas.height);
  ctx.restore();
  surf.blit(tmp, left, y);
}

/** icons.draw_stat (full display). */
function drawStat(surf: Surface, stat: string, unit: UnitObject, x: number, y: number, timeMs: number): void {
  const game = getGame();
  if (!game.db.stats.some((s: any) => s.nid === stat)) {
    blitTextRight(surf, 'text-yellow', '--', x, y);
    return;
  }
  const base = unit.stats[stat] ?? 0;
  const subtle = subtleStatBonus(unit, stat);
  const value = base + subtle;
  const bonus = unit.getStatValue(stat) - base - subtle;
  if (value >= unit.getStatCap(stat)) blitGlow(surf, 'text-green', String(value), x, y, timeMs, 'right');
  else blitTextRight(surf, 'text-blue', String(value), x, y);
  if (bonus > 0) blitGlow(surf, 'small-green', `+${bonus}`, x, y, timeMs);
  else if (bonus < 0) blitGlow(surf, 'small-red', String(bonus), x, y, timeMs);
}

/** icons.draw_growth (full display). */
function drawGrowth(surf: Surface, stat: string, unit: UnitObject, x: number, y: number): void {
  const game = getGame();
  if (!game.db.stats.some((s: any) => s.nid === stat)) {
    blitTextRight(surf, 'text-yellow', '--', x, y);
    return;
  }
  const value = baseGrowthRate(unit, stat);
  const bonus = growthRate(unit, stat) - value;
  blitTextRight(surf, 'text-blue', String(value), x, y);
  if (bonus > 0) blitText(surf, 'small-green', `+${bonus}`, x, y);
  else if (bonus < 0) blitText(surf, 'small-red', String(bonus), x, y);
}

/** build_groove.build_groove */
function buildGroove(surf: Surface, x: number, y: number, width: number, fill: number): void {
  const back = getSprite('info_menu/groove_back');
  const fg = getSprite('info_menu/groove_fill');
  if (!back) return;
  surf.blitImage(back, 0, 0, 2, 5, x, y);
  for (let i = 0; i < width - 2; i++) surf.blitImage(back, 2, 0, 1, 5, x + 2 + i, y);
  surf.blitImage(back, 3, 0, 2, 5, x + width, y);
  if (!fg) return;
  const needed = Math.floor(fill * (width - 1));
  for (let i = 0; i < needed; i++) blitSprite(surf, fg, x + 1 + i, y + 1);
}

function drawItemIconAt(surf: Surface, obj: { iconNid?: string; iconIndex?: [number, number] }, x: number, y: number): void {
  if (obj.iconNid) drawIcon16(surf, obj.iconNid, obj.iconIndex ?? [0, 0], x, y);
}

/** Skill text shown beside an icon (charge / time components' text()). */
function skillText(skill: SkillObject): string | null {
  if (skill.hasComponent('build_charge') || skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
    return String(skill.data.get('charge') ?? 0);
  }
  if (skill.hasComponent('combined_time')) return String(Math.ceil(Number(skill.data.get('turns') ?? 0) / 2));
  if (skill.hasComponent('time') || skill.hasComponent('end_time')) return String(skill.data.get('turns') ?? 0);
  return null;
}

/** skill_system.get_cooldown */
function skillCooldown(skill: SkillObject): number | null {
  const total = Number(skill.data.get('total_charge') ?? 0);
  if (skill.hasComponent('build_charge')) return total ? Number(skill.data.get('charge') ?? 0) / total : 1;
  if (skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
    return total ? Number(skill.data.get('charge') ?? 0) / total : null;
  }
  return null;
}

/** icons.draw_skill(compact=False) */
function drawSkill(surf: Surface, skill: SkillObject, x: number, y: number, grey: boolean): void {
  if (!skill.iconNid) return;
  if (grey) {
    const tmp = new Surface(16, 16);
    drawIcon16(tmp, skill.iconNid, skill.iconIndex, 0, 0);
    surf.blit(tmp.makeGray(), x, y);
  } else {
    drawIcon16(surf, skill.iconNid, skill.iconIndex, x, y);
  }
  const frac = skillCooldown(skill);
  const cooldown = getSprite('icon_cooldown');
  if (frac !== null && frac < 1 && cooldown) {
    const index = Math.max(0, Math.min(7, Math.floor(8 * frac)));
    const ctx = surf.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    surf.blitImage(cooldown, 16 * index, 0, 16, 16, x, y);
    ctx.restore();
  }
  const text = skillText(skill);
  if (text !== null) blitText(surf, 'text-blue', text, x + 16, y);
}

/** gui.Logo: an 8-frame title strip that squashes out/in when switched. */
class InfoLogo {
  private path: string;
  private nextPath: string | null = null;
  private counter = 0;
  private elapsed = 0;
  private state: 'idle' | 'out' | 'in' = 'idle';
  private transition = 0;
  private readonly anim = [0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1];

  constructor(path: string) {
    this.path = path;
  }

  switchImage(path: string): void {
    const img = getSprite(this.path);
    this.nextPath = path;
    this.transition = img ? Math.floor(img.height / 8) : 0;
    this.state = 'out';
  }

  update(): void {
    this.elapsed += FRAMETIME;
    if (this.elapsed > 64) {
      this.counter = (this.counter + 1) % this.anim.length;
      this.elapsed -= 64;
    }
    const img = getSprite(this.path);
    const height = img ? Math.floor(img.height / 8) : 0;
    if (this.state === 'out') {
      this.transition = Math.max(this.transition - 3, 0);
      if (this.transition === 0) {
        this.state = 'in';
        if (this.nextPath) this.path = this.nextPath;
        this.nextPath = null;
      }
    } else if (this.state === 'in') {
      this.transition = Math.min(this.transition + 3, height);
      if (height && this.transition === height) this.state = 'idle';
    }
  }

  draw(surf: Surface, cx: number, cy: number): void {
    const img = getSprite(this.path);
    if (!img) return;
    const height = Math.floor(img.height / 8);
    const drawH = this.state === 'idle' ? height : this.transition;
    if (drawH <= 0) return;
    const sy = this.anim[this.counter] * height;
    const s = surf.scale;
    const dx = cx - Math.floor(img.width / 2);
    const dy = cy - Math.floor(drawH / 2);
    surf.ctx.imageSmoothingEnabled = false;
    surf.ctx.drawImage(img, 0, sy, img.width, height,
      Math.round(dx * s), Math.round(dy * s), Math.round(img.width * s), Math.round(drawH * s));
  }
}

const LOGO_FOR: Record<InfoPage, string> = {
  personal_data: 'info_menu/info_title_personal_data',
  equipment: 'info_menu/info_title_items',
  support_skills: 'info_menu/info_title_weapon',
  notes: 'info_menu/info_title_notes',
};

/** Python info_graph.BoundingBox */
interface InfoBox {
  aabb: [number, number, number, number];
  make: () => HelpBox;
  box?: HelpBox;
  first: boolean;
}

function helpOf(info: InfoBox): HelpBox {
  if (!info.box) info.box = info.make();
  return info.box;
}

/** info_graph.find_closest (direction-weighted top-left distance). */
function findClosest(current: InfoBox, boxes: InfoBox[], horiz: boolean): InfoBox | null {
  const [hp, vp] = horiz ? [1, 10] : [10, 1];
  let best: InfoBox | null = null;
  let max = 1e6;
  for (const bb of boxes) {
    const d = hp * (current.aabb[0] - bb.aabb[0]) ** 2 + vp * (current.aabb[1] - bb.aabb[1]) ** 2;
    if (d < max) {
      max = d;
      best = bb;
    }
  }
  if (!best) {
    const cx = current.aabb[0] + current.aabb[2] / 2;
    const cy = current.aabb[1] + current.aabb[3] / 2;
    for (const bb of boxes) {
      const d = (cx - bb.aabb[0] - bb.aabb[2] / 2) ** 2 + (cy - bb.aabb[1] - bb.aabb[3] / 2) ** 2;
      if (d < max) {
        max = d;
        best = bb;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// InfoMenuState
// ---------------------------------------------------------------------------

export class InfoMenuState extends State {
  readonly name = 'info_menu';
  override readonly transparent = false;
  override readonly showMap = false;
  override readonly inLevel = false;

  private unit: UnitObject | null = null;
  private scrollUnits: UnitObject[] = [];
  private page: InfoPage = 'personal_data';
  private growthFlag = false;
  private leftStats: string[] = [];
  private rightStats: string[] = [];
  private extraStatRow = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private leftArrow = new ScrollArrow('left', 103, 3);
  private rightArrow = new ScrollArrow('right', 217, 3, 0.5);
  private logo: InfoLogo | null = null;
  private time = 0;

  // Python InfoGraph: help boxes registered per info state as pages draw.
  private portraitBoxes: InfoBox[] | null = null;
  private registry = new Map<string, InfoBox[]>();
  /** The info state whose boxes the current draw pass is registering. */
  private collecting: string | null = null;
  private currentBB: InfoBox | null = null;
  private lastBB: InfoBox | null = null;
  private infoFlag = false;
  private infoCursor = new MenuCursor();

  // Transitions (InfoMenuState.update)
  private rescuer: UnitObject | null = null;
  private nextUnit: UnitObject | null = null;
  private nextPage: InfoPage | null = null;
  private transition: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN' | null = null;
  private transitionCounter = 0;
  private scrollOffsetX = 0;
  private scrollOffsetY = 0;
  private transparency = 0;

  // InfoMenuPortrait blink (generic3counter)
  private blinkCount = 0;
  private blinkLast = 1;
  private blinkUpdate = 0;
  private blinkFirst = 7000;

  /** Index of the current page in Python's info_states (tests/inspection). */
  get currentPage(): number {
    return INFO_STATES.indexOf(this.page);
  }

  override start(): StateResult {
    const game = getGame();
    this.initStats();
    this.bg = new MenuBackground('info_menu_background', game.resources, false);
    preloadSprites([
      'info_menu/info_menu_flash', 'info_menu/info_unit', 'info_menu/status_platform', 'info_menu/info_title_background',
      'info_menu/info_title_personal_data', 'info_menu/info_title_items', 'info_menu/info_title_weapon',
      'info_menu/info_title_notes', 'info_menu/groove_back', 'info_menu/groove_fill', 'info_menu/battle_info',
      'info_menu/equipment_logo', 'info_menu/equipment_highlight', 'info_menu/status_logo', 'info_menu/aid_icons',
      'page_arrows', 'icon_cooldown',
    ]);
    for (const weapon of game.db.weapons ?? []) if (weapon.icon_nid) getIconSheet(weapon.icon_nid);
    this.unit = game.infoMenuUnit ?? game.memory?.get?.('current_unit') ?? null;
    if (!this.unit) {
      game.state.back();
      return;
    }
    const memoryUnits = game.memory?.get?.('scroll_units') as UnitObject[] | null | undefined;
    let units: UnitObject[];
    if (memoryUnits) {
      units = memoryUnits;
    } else {
      const unit = this.unit;
      units = [...game.units.values()].filter((u: UnitObject) =>
        !u.dead && !u.isDead() && u.team === unit.team && u.party === unit.party);
      if (unit.position) {
        units = units.filter((u) => u.position && (game.board?.inVision?.(u.position) ?? true));
      }
    }
    this.scrollUnits = units.filter((u) => !(u.tags ?? []).includes('Tile'));
    if (!this.scrollUnits.includes(this.unit)) this.scrollUnits.unshift(this.unit);
    game.memory?.set?.('scroll_units', null);

    const remembered = game.memory?.get?.('info_menu_state') as InfoPage | undefined;
    this.page = remembered && INFO_STATES.includes(remembered) ? remembered : 'personal_data';
    if (this.page === 'notes' && !this.hasNotes(this.unit)) this.page = 'personal_data';
    this.growthFlag = false;
    this.logo = new InfoLogo(LOGO_FOR[this.page]);
    this.rescuer = null;
    this.nextUnit = null;
    this.nextPage = null;
    this.transition = null;
    this.transitionCounter = 0;
    this.scrollOffsetX = 0;
    this.scrollOffsetY = 0;
    this.transparency = 0;
    this.resetBlink();
    setHelpMenuGameRef(game);
    this.resetGraph();
    this.infoFlag = false;
    this.lastBB = null;
  }

  /** InfoGraph.clear (new unit): boxes rebuild as pages are drawn again. */
  private resetGraph(): void {
    this.portraitBoxes = null;
    this.registry = new Map();
    this.currentBB = null;
  }

  private infoState(): string {
    return this.page === 'personal_data' && this.growthFlag ? 'growths' : this.page;
  }

  private boxesFor(state: string): InfoBox[] {
    return [...(this.portraitBoxes ?? []), ...(this.registry.get(state) ?? [])];
  }

  /** InfoGraph.register for the page currently being built. */
  private register(aabb: [number, number, number, number], help: string | (() => HelpBox), first = false): void {
    if (!this.collecting) return;
    const make = typeof help === 'string' ? () => new HelpDialog(help) : help;
    const list = this.registry.get(this.collecting) ?? [];
    list.push({ aabb, make, first });
    this.registry.set(this.collecting, list);
  }

  /** InfoGraph.set_transition_in */
  private graphIn(): void {
    const boxes = this.boxesFor(this.infoState());
    if (!boxes.length) return;
    const last = this.lastBB && boxes.includes(this.lastBB) ? this.lastBB : null;
    this.currentBB = last ?? boxes.find((bb) => bb.first) ?? boxes[0];
    helpOf(this.currentBB).setTransitionIn();
  }

  /** InfoGraph._move toward `dir`. */
  private graphMove(dir: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN'): boolean {
    const cur = this.currentBB;
    if (!cur) return false;
    const all = this.boxesFor(this.infoState());
    const boxes = all.filter((bb) => dir === 'LEFT' ? bb.aabb[0] < cur.aabb[0]
      : dir === 'RIGHT' ? bb.aabb[0] > cur.aabb[0]
        : dir === 'UP' ? bb.aabb[1] < cur.aabb[1] : bb.aabb[1] > cur.aabb[1]);
    if (!boxes.length) return false;
    const next = findClosest(cur, boxes, dir === 'LEFT' || dir === 'RIGHT');
    if (!next || next === cur) return false;
    this.currentBB = next;
    return true;
  }

  /** InfoMenuState._init: left/right stat columns from DB.stats positions. */
  private initStats(): void {
    const stats: any[] = getGame().db.stats ?? [];
    const left = stats.filter((s) => s.position === 'left').map((s) => s.nid as string);
    this.extraStatRow = left.length >= 7;
    let right = this.extraStatRow ? left.slice(7) : left.slice(6);
    right = right.concat(stats.filter((s) => s.position === 'right').map((s) => s.nid as string));
    const rows = this.extraStatRow ? 7 : 6;
    this.leftStats = left.slice(0, rows);
    this.rightStats = right.slice(0, rows);
  }

  private hasNotes(unit: UnitObject | null): boolean {
    return !!(constant('unit_notes') && unit?.notes?.length);
  }

  private resetBlink(): void {
    this.blinkCount = 0;
    this.blinkLast = 1;
    this.blinkUpdate = this.time;
    const offsets: number[] = [];
    for (let v = -2000; v < 2000; v += 125) offsets.push(v);
    this.blinkFirst = 7000 + offsets[Math.floor(Math.random() * offsets.length)];
  }

  /** counters.generic3counter.update with (first, 50, 50) ms timings. */
  private updateBlink(): void {
    const t = this.time;
    const wait = this.blinkCount === 0 ? this.blinkFirst : 50;
    if (t - this.blinkUpdate <= wait) return;
    this.blinkUpdate = t;
    if (this.blinkCount === 0) {
      this.blinkCount = 1;
      this.blinkLast = 0;
    } else if (this.blinkCount === 2) {
      this.blinkCount = 1;
      this.blinkLast = 2;
    } else if (this.blinkLast === 0) {
      this.blinkCount = 2;
      this.blinkLast = 1;
    } else {
      this.blinkCount = 0;
      this.blinkLast = 1;
    }
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  override takeInput(event: InputEvent): StateResult {
    if (event === null) return;
    const game = getGame();
    const unit = this.unit;
    if (!unit) return;
    if (this.infoFlag) {
      if (event === 'INFO' || event === 'BACK') {
        game.audioManager?.playSfx?.('Info Out');
        if (this.currentBB) helpOf(this.currentBB).setTransitionOut();
        this.lastBB = this.currentBB;
        this.currentBB = null;
        this.infoFlag = false;
      } else if (event === 'LEFT' || event === 'RIGHT' || event === 'UP' || event === 'DOWN') {
        if (this.graphMove(event)) game.audioManager?.playSfx?.('Select 6');
      }
      return;
    }
    if (this.transition) return;
    if (event === 'INFO') {
      game.audioManager?.playSfx?.('Info In');
      this.graphIn();
      this.infoFlag = true;
      return;
    }
    if (event === 'AUX') {
      if (this.page === 'personal_data' && unit.team === 'player' && constant('growth_info')) {
        game.audioManager?.playSfx?.('Select 3');
        this.growthFlag = !this.growthFlag;
      }
    } else if (event === 'BACK') {
      if (this.rescuer) this.moveUp();
      else this.back();
    } else if (event === 'SELECT') {
      if (unit.traveler) this.moveTraveler();
    } else if (event === 'RIGHT') {
      this.moveHorizontal(1);
    } else if (event === 'LEFT') {
      this.moveHorizontal(-1);
    } else if (event === 'DOWN') {
      this.moveDown();
    } else if (event === 'UP') {
      this.moveUp();
    }
  }

  private back(): void {
    const game = getGame();
    game.audioManager?.playSfx?.('Select 4');
    game.memory?.set?.('info_menu_state', this.page);
    // Python back(): memory['current_unit'] lets the caller re-select the unit.
    game.memory?.set?.('current_unit', this.unit);
    game.infoMenuUnit = this.unit;
    if (this.unit?.position && !game.roamInfo?.roam) game.cursor?.setPos?.(this.unit.position[0], this.unit.position[1]);
    game.state.back();
  }

  private moveHorizontal(dir: 1 | -1): void {
    const game = getGame();
    game.audioManager?.playSfx?.('Status_Page_Change');
    const n = INFO_STATES.length;
    let index = (INFO_STATES.indexOf(this.page) + dir + n) % n;
    if (INFO_STATES[index] === 'notes' && !this.hasNotes(this.unit)) index = (index + dir + n) % n;
    this.nextPage = INFO_STATES[index];
    this.transition = dir > 0 ? 'RIGHT' : 'LEFT';
    (dir > 0 ? this.rightArrow : this.leftArrow).pulse();
    this.logo?.switchImage(LOGO_FOR[this.nextPage]);
  }

  private moveToUnit(next: UnitObject, transition: 'UP' | 'DOWN'): void {
    this.nextUnit = next;
    if (this.page === 'notes' && !this.hasNotes(next)) {
      this.page = 'personal_data';
      this.logo?.switchImage(LOGO_FOR.personal_data);
    }
    this.transition = transition;
  }

  private moveDown(): void {
    getGame().audioManager?.playSfx?.('Status_Character');
    let index: number;
    if (this.rescuer) {
      index = this.scrollUnits.indexOf(this.rescuer);
      this.rescuer = null;
    } else if (this.scrollUnits.length > 1) {
      index = (this.scrollUnits.indexOf(this.unit as UnitObject) + 1) % this.scrollUnits.length;
    } else {
      return;
    }
    this.moveToUnit(this.scrollUnits[index], 'UP');
  }

  private moveUp(): void {
    getGame().audioManager?.playSfx?.('Status_Character');
    let index: number;
    if (this.rescuer) {
      index = this.scrollUnits.indexOf(this.rescuer);
      this.rescuer = null;
    } else if (this.scrollUnits.length > 1) {
      const n = this.scrollUnits.length;
      index = (this.scrollUnits.indexOf(this.unit as UnitObject) - 1 + n) % n;
    } else {
      return;
    }
    this.moveToUnit(this.scrollUnits[index], 'DOWN');
  }

  private moveTraveler(): void {
    const game = getGame();
    const traveler = this.unit?.traveler ? game.units.get(this.unit.traveler) : null;
    if (!traveler) return;
    game.audioManager?.playSfx?.('Status_Character');
    this.rescuer = this.unit;
    this.moveToUnit(traveler, 'DOWN');
  }

  // -----------------------------------------------------------------------
  // Update (Python InfoMenuState.update)
  // -----------------------------------------------------------------------

  override update(): StateResult {
    this.time += FRAMETIME;
    this.bg?.update();
    this.updateBlink();
    if (this.nextUnit) {
      this.transitionCounter += 1;
      const down = this.transition === 'DOWN';
      if (this.nextUnit === this.unit) {
        const c = this.transitionCounter;
        if (c === 1) { this.transparency = 0.75; this.scrollOffsetY = down ? -80 : 80; }
        else if (c === 2) { this.transparency = 0.6; this.scrollOffsetY = down ? -32 : 32; }
        else if (c === 3) { this.transparency = 0.48; this.scrollOffsetY = down ? -16 : 16; }
        else if (c === 4) { this.transparency = 0.15; this.scrollOffsetY = down ? -4 : 4; }
        else if (c === 5) { this.scrollOffsetY = 0; }
        else {
          this.transition = null;
          this.transparency = 0;
          this.nextUnit = null;
          this.transitionCounter = 0;
        }
      } else {
        const c = this.transitionCounter;
        if (c === 1) this.transparency = 0.15;
        else if (c === 2) this.transparency = 0.48;
        else if (c === 3) { this.transparency = 0.6; this.scrollOffsetY = down ? 8 : -8; }
        else if (c === 4) { this.transparency = 0.75; this.scrollOffsetY = down ? 16 : -16; }
        else if (c < 8) { this.transparency = 1; this.scrollOffsetY = down ? 160 : -160; }
        else {
          this.unit = this.nextUnit;
          getGame().infoMenuUnit = this.unit;
          this.resetBlink();
          this.resetGraph();
          this.transitionCounter = 0;
        }
      }
    } else if (this.nextPage !== null) {
      this.transitionCounter += 1;
      const right = this.transition === 'RIGHT';
      const counter = this.transitionCounter - 1;
      if (this.nextPage === this.page) {
        const idxs = [104, 72, 56, 40, 24, 8];
        if (counter >= 0 && counter < idxs.length) {
          this.scrollOffsetX = right ? idxs[counter] : -idxs[counter];
        } else {
          this.transition = null;
          this.scrollOffsetX = 0;
          this.nextPage = null;
          this.transitionCounter = 0;
        }
      } else {
        const idxs = [-32, -56, -80, -96, -112];
        if (counter >= 0 && counter < idxs.length) {
          this.scrollOffsetX = right ? idxs[counter] : -idxs[counter];
        } else {
          this.scrollOffsetX = right ? -140 : 140;
          this.page = this.nextPage;
          this.transitionCounter = 0;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------

  override draw(surf: Surface): Surface {
    if (!this.unit) return surf;
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const s = this.scene.begin();

    // info_menu_flash: additive, 8-step triangle wave every 134 ms.
    const flash = getSprite('info_menu/info_menu_flash');
    if (flash) {
      const blend = Math.abs(8 - ((this.time / 134) % 16)) / 8;
      const ctx = s.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (128 * blend) / 255;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(flash, Math.round(98 * s.scale), 0, Math.round(flash.width * s.scale), Math.round(flash.height * s.scale));
      ctx.restore();
    }

    this.drawPortrait(s);
    this.drawSlide(s);
    // InfoGraph.draw: menu hand on the box, help window below it.
    if (this.currentBB) {
      const [bx, by] = this.currentBB.aabb;
      this.infoCursor.update();
      this.infoCursor.draw(s, Math.max(0, bx - 4), by);
      helpOf(this.currentBB).draw(s, Math.max(0, bx - 32), by + 13);
    }
    this.scene.present(surf);
    return surf;
  }

  /** draw_portrait + create_portrait_section */
  private drawPortrait(target: Surface): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const p = new Surface(96, WINHEIGHT);
    blitSprite(p, getSprite('info_menu/info_unit'), 8, 122);
    blitTextCenter(p, 'text', unit.name, 48, 80);
    const klass = game.db.classes.get(unit.klass);
    blitText(p, 'text', klass?.name ?? unit.klass, 8, 104);
    blitTextRight(p, 'text-blue', String(unit.level), 39, 120);
    blitTextRight(p, 'text-blue', String(unit.exp), 63, 120);
    const hp = String(unit.currentHp);
    const maxHp = String(unit.maxHp);
    const hpFont = textWidth('text', hp) > 14 || textWidth('text', maxHp) > 14 ? 'narrow-blue' : 'text-blue';
    blitTextRight(p, hpFont, hp, 39, 136);
    blitTextRight(p, hpFont, maxHp, 63, 136);
    blitSprite(p, getSprite('info_menu/status_platform'), 66, 131);
    const affinity = game.db.affinities?.get?.(unit.affinity);
    if (affinity?.icon_nid) drawIcon16(p, affinity.icon_nid, affinity.icon_index ?? [0, 0], 78, 81);
    if (!this.portraitBoxes) {
      const boxes: InfoBox[] = [];
      const add = (aabb: [number, number, number, number], text: string): void => {
        boxes.push({ aabb, make: () => new HelpDialog(text), first: false });
      };
      add([24, 80, 52, 24], unit.desc ?? '');
      add([8, 104, 72, 16], klass?.desc ?? '');
      add([8, 120, 30, 16], 'Level_desc');
      add([38, 120, 30, 16], 'Exp_desc');
      add([8, 136, 72, 16], 'HP_desc');
      if (affinity) add([76, 80, 16, 16], affinity.desc ?? '');
      this.portraitBoxes = boxes;
    }

    // Portrait (InfoMenuPortrait) or the class card fallback.
    const meta = game.db.portraits?.get?.(unit.portraitNid);
    const sheet = getPortrait(game.resources, unit.portraitNid);
    if (sheet) {
      const face = new Surface(96, 80);
      face.blitImage(sheet, 0, 0, 96, 80, 0, 0);
      if (constant('info_menu_blink') && this.blinkCount > 0) {
        const blinkY = this.blinkCount === 1 ? 48 : 64;
        const off = meta?.blinking_offset ?? [24, 32];
        face.blitImage(sheet, PORTRAIT_WIDTH - 32, blinkY, 32, 16, off[0], off[1]);
      }
      const smile = meta?.smiling_offset ?? [16, 48];
      face.blitImage(sheet, PORTRAIT_WIDTH - 32, 80, 32, 16, smile[0], smile[1]);
      p.blitFrom(face, 8, Number(meta?.info_offset ?? 0), 80, 72, 8, 8);
    } else if (!unit.portraitNid || !meta) {
      const card = klass?.icon_nid ? getKeyedImage(game.resources, `resources/icons80/${klass.icon_nid}.png`) : null;
      const idx = klass?.icon_index ?? [0, 0];
      if (card) p.blitImage(card, idx[0] * 80, idx[1] * 72, 80, 72, 8, 8);
    }

    if (this.transparency) p.setAlpha(1 - this.transparency);
    target.blit(p, 0, this.scrollOffsetY);

    if (!this.transparency) {
      const frames = (unit.sprite as any)?.getStandFrames?.('active') as Surface[] | undefined;
      if (frames && frames.length) {
        // active_sprite_counter: back-and-forth [20, 4, 20] frames.
        const cycle = Math.floor(this.time / FRAMETIME) % 48;
        const idx = cycle < 20 ? 0 : cycle < 24 ? 1 : cycle < 44 ? 2 : 1;
        const frame = frames[Math.min(idx, frames.length - 1)];
        target.blit(frame, 81 - Math.floor(frame.width / 2), WINHEIGHT - 61 + this.scrollOffsetY);
      }
    }
  }

  /** draw_slide */
  private drawSlide(target: Surface): void {
    const unit = this.unit as UnitObject;
    const top = new Surface(WINWIDTH, WINHEIGHT);
    const main = new Surface(WINWIDTH, WINHEIGHT);

    blitSprite(top, getSprite('info_menu/info_title_background'), 112, 8);
    if (this.logo) {
      this.logo.update();
      this.logo.draw(top, 164, 10);
    }
    const numStates = this.hasNotes(unit) ? INFO_STATES.length : INFO_STATES.length - 1;
    blitTextRight(top, 'small', `${INFO_STATES.indexOf(this.page) + 1}/${numStates}`, 235, 12);
    if (numStates > 1) {
      this.leftArrow.draw(top);
      this.rightArrow.draw(top);
    }

    const state = this.infoState();
    this.collecting = this.registry.has(state) ? null : state;
    if (this.collecting) this.registry.set(state, []);
    if (this.page === 'personal_data') {
      this.drawPersonalData(main, this.growthFlag);
      this.drawClassSkills(main);
      if (constant('fatigue') && unit.team === 'player' && getGame().gameVars?.get?.('_fatigue')) {
        this.drawFatigue(main);
      }
    } else if (this.page === 'equipment') {
      this.drawEquipment(main);
    } else if (this.page === 'support_skills') {
      blitSprite(main, getSprite('info_menu/status_logo'), 100, WINHEIGHT - 42);
      this.drawSkills(main);
      this.drawWexp(main);
      this.drawSupports(main);
    } else {
      this.drawNotes(main);
    }
    this.collecting = null;

    const offsetX = Math.max(96, 96 - this.scrollOffsetX);
    target.blitFrom(main, offsetX, 0, WINWIDTH - offsetX, WINHEIGHT,
      Math.max(96, 96 + this.scrollOffsetX), this.scrollOffsetY);
    if (this.transparency) top.setAlpha(1 - this.transparency);
    target.blit(top, 0, this.scrollOffsetY);
  }

  /** help_menu.StatDialog with stat_contribution / growth_contribution. */
  private statHelp(nid: string, growths: boolean): HelpBox {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const def = game.db.stats.find((st: any) => st.nid === nid);
    const desc = def?.desc || `${nid}_desc`;
    const bonuses: Record<string, number> = {};
    if (growths) {
      const klass = game.db.classes.get(unit.klass);
      bonuses['Base Value'] = unit.growths[nid] ?? 0;
      const klassBonus = klass?.growth_bonus?.[nid] ?? 0;
      if (klassBonus) bonuses[klass?.name ?? 'Class'] = klassBonus;
      const skill = growthChange(unit, nid);
      if (skill) bonuses.Skills = skill;
    } else {
      const base = (unit.stats[nid] ?? 0) + subtleStatBonus(unit, nid);
      bonuses['Base Value'] = base;
      const bonus = unit.getStatValue(nid) - base;
      if (bonus) bonuses.Bonus = bonus;
    }
    return new StatDialog(desc, bonuses);
  }

  /** create_personal_data_surf + draw_stat_surf, drawn at x = 96. */
  private drawPersonalData(surf: Surface, growths: boolean): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const ox = 96;
    const statDef = (nid: string): any => game.db.stats.find((st: any) => st.nid === nid);
    const nameColor = (nid: string): string =>
      statDef(nid)?.growth_colors && unit.team === 'player' ? growthColor(growthRate(unit, nid)) : 'yellow';

    this.leftStats.forEach((nid, idx) => {
      const def = statDef(nid);
      const y = 16 * idx + 24;
      if (growths) {
        drawGrowth(surf, nid, unit, ox + 47, y);
      } else {
        const highest = Number(def?.maximum ?? 0);
        const maxStat = unit.getStatCap(nid);
        if (maxStat > 0 && highest > 0) {
          const total = Math.floor((maxStat / highest) * 42);
          const base = (unit.stats[nid] ?? 0) + subtleStatBonus(unit, nid);
          buildGroove(surf, ox + 27, 16 * idx + 32, total, Math.max(0, Math.min(1, base / maxStat)));
        }
        drawStat(surf, nid, unit, ox + 47, y, this.time);
      }
      blitText(surf, `text-${nameColor(nid)}`, def?.name ?? nid, ox + 8, y);
      this.register([96 + 8, y, 64, 16], () => this.statHelp(nid, growths), idx === 0);
    });

    this.rightStats.forEach((nid, idx) => {
      const def = statDef(nid);
      const y = 16 * idx + 24;
      blitText(surf, `text-${nameColor(nid)}`, def?.name ?? nid, ox + 72, y);
      if (growths) drawGrowth(surf, nid, unit, ox + 111, y);
      else drawStat(surf, nid, unit, ox + 111, y, this.time);
      this.register([96 + 72, y, 64, 16], () => this.statHelp(nid, growths));
    });

    const other: string[] = ['RAT'];
    if (constant('talk_display')) other.unshift('TALK');
    if (!(constant('pairup') && constant('attack_stance_only'))) other.unshift('TRV', 'AID');
    const manaExpr = game.db.getEquation?.('MANA');
    let maxMana = 0;
    if (manaExpr) {
      try {
        maxMana = evaluateEquation(manaExpr, unit, { db: game.db });
      } catch {
        maxMana = 0;
      }
    }
    if (maxMana > 0) other.unshift('MANA');
    if (constant('pairup') && !constant('attack_stance_only')) other.splice(2, 0, 'GAUGE');
    if (constant('lead')) other.push('LEAD');

    other.slice(0, Math.max(0, 6 - this.rightStats.length)).forEach((stat, idx) => {
      const y = 16 * (idx + this.rightStats.length) + 24;
      const label = (text: string): void => blitText(surf, 'text-yellow', translate(text), ox + 72, y);
      const descKey: Record<string, string> = {
        TRV: 'Trv_desc', AID: growths ? 'HP_desc' : 'Aid_desc', RAT: 'Rating_desc', MANA: 'MANA_desc',
        GAUGE: 'GAUGE_desc', TALK: 'Talk_desc', LEAD: 'Lead_desc',
      };
      if (descKey[stat]) this.register([96 + 72, y, 64, 16], descKey[stat]);
      const equation = (nid: string): number => {
        const expr = game.db.getEquation?.(nid);
        if (!expr) return 0;
        try {
          return evaluateEquation(expr, unit, { db: game.db });
        } catch {
          return 0;
        }
      };
      if (stat === 'TRV') {
        const traveler = unit.traveler ? game.units.get(unit.traveler) : null;
        if (traveler) blitText(surf, 'text-blue', traveler.name, ox + 96, y);
        else blitTextRight(surf, 'text-blue', '--', ox + 111, y);
        label('Trv');
      } else if (stat === 'AID') {
        if (growths) {
          drawGrowth(surf, 'HP', unit, ox + 111, y);
          blitText(surf, `text-${nameColor('HP')}`, translate('HP'), ox + 72, y);
        } else {
          blitTextRight(surf, 'text-blue', String(equation('RESCUE_AID')), ox + 111, y);
          const tags: string[] = unit.tags ?? [];
          const icons = getSprite('info_menu/aid_icons');
          const row = tags.includes('Dragon') ? 3 : tags.includes('Flying') ? 2 : tags.includes('Mounted') ? 1 : 0;
          blitSub(surf, icons, 0, row * 16, 16, 16, ox + 112, y);
          label('Aid');
        }
      } else if (stat === 'RAT') {
        blitTextRight(surf, 'text-blue', String(equation('RATING')), ox + 111, y);
        label('Rat');
      } else if (stat === 'MANA') {
        blitTextRight(surf, 'text-blue', String(unit.currentMana ?? 0), ox + 111, y);
        label('MANA');
      } else if (stat === 'GAUGE') {
        blitTextRight(surf, 'text-blue', String(unit.getGuardGauge()), ox + 111, y);
        label('GAUGE');
      } else if (stat === 'TALK') {
        blitTextRight(surf, 'text-blue', '--', ox + 111, y);
        label('Talk');
      } else if (stat === 'LEAD') {
        label('Lead');
        if (growths) drawGrowth(surf, 'LEAD', unit, ox + 111, y);
        else {
          drawStat(surf, 'LEAD', unit, ox + 111, y, this.time);
          blitSub(surf, getSprite('info_menu/lead_star'), 0, 0, 16, 16, ox + 111, y);
        }
      }
    });
  }

  private uniqueSkills(classSkills: boolean): { skill: SkillObject; count: number }[] {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const counts = new Map<string, { skill: SkillObject; count: number }>();
    for (const skill of unit.skills) {
      if (skill.hasComponent('class_skill') !== classSkills) continue;
      if (skillInfoPresentation(skill, unit, game) === 'hidden') continue;
      const entry = counts.get(skill.nid);
      if (entry) entry.count += 1;
      else counts.set(skill.nid, { skill, count: 1 });
    }
    return [...counts.values()].slice(0, 6);
  }

  private drawSkillRow(surf: Surface, classSkills: boolean, y: number, iconY: number): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    this.uniqueSkills(classSkills).forEach(({ skill, count }, idx) => {
      const left = 96 + idx * 24;
      drawSkill(surf, skill, left + 8, y + iconY, skillInfoPresentation(skill, unit, game) === 'grey');
      this.register([left + 8, classSkills ? (this.extraStatRow ? WINHEIGHT - 22 : WINHEIGHT - 32) : WINHEIGHT - 28, 16, 16],
        () => new SkillHelpDialog(skill));
      if (count > 1) {
        const text = String(count);
        blitText(surf, 'small-white', text, left + 20 - 4 * text.length, y + 6);
      }
    });
  }

  /** create_class_skill_surf / draw_class_skill_surf */
  private drawClassSkills(surf: Surface): void {
    this.drawSkillRow(surf, true, this.extraStatRow ? WINHEIGHT - 26 : WINHEIGHT - 36, 8);
  }

  /** create_skill_surf / draw_skill_surf */
  private drawSkills(surf: Surface): void {
    this.drawSkillRow(surf, false, WINHEIGHT - 32, 4);
  }

  /** create_fatigue_surf */
  private drawFatigue(surf: Surface): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const expr = game.db.getEquation?.('MAX_FATIGUE');
    let maxFatigue = 1;
    if (expr) {
      try {
        maxFatigue = Math.max(1, evaluateEquation(expr, unit, { db: game.db }));
      } catch {
        maxFatigue = 1;
      }
    }
    const fatigue = unit.currentFatigue ?? 0;
    buildGroove(surf, 96 + 27, WINHEIGHT - 9, 88, Math.max(0, Math.min(1, fatigue / maxFatigue)));
    const text = `${fatigue}/${maxFatigue}`;
    const x = 96 + 27 + 44 - Math.floor(textWidth('text', text) / 2);
    blitText(surf, 'text-blue', text, x, WINHEIGHT - 17);
    if (fatigue >= maxFatigue) blitText(surf, 'text-red', String(fatigue), x, WINHEIGHT - 17);
    blitText(surf, 'text-yellow', translate('Ftg'), 96 + 8, WINHEIGHT - 17);
  }

  /** BasicItemOption.draw in FULL_USES mode (width 120). */
  private drawItemOption(surf: Surface, item: ItemObject, x: number, y: number): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const owner = item.owner ?? unit;
    const ok = !owner || itemAvailable(owner, item, game.db, game);
    const textColor = item.getComponent?.<string>('text_color');
    let main = 'grey';
    let uses = 'grey';
    if (textColor) {
      main = textColor;
      if (ok) uses = 'blue';
    } else if (item.droppable) {
      main = 'green';
      uses = 'green';
    } else if (ok) {
      main = 'white';
      uses = 'blue';
    }
    const width = 120;
    drawItemIconAt(surf, item, x + 2, y);
    const font = measureStyledText(item.name, 'text') > width - 56 ? 'narrow' : 'text';
    drawStyledText(surf, item.name, x + 20, y, main, font);
    let a = '--';
    let b = '--';
    const pick = (obj: ItemObject | null, key: string): boolean => {
      if (!obj || obj.data.get(key) == null) return false;
      a = String(obj.data.get(key));
      b = String(obj.data.get(`starting_${key}`) ?? a);
      return true;
    };
    if (!pick(item, 'uses') && !pick(item, 'c_uses') && !pick(item.parentItem, 'uses') &&
        !pick(item.parentItem, 'c_uses')) pick(item, 'cooldown');
    blitTextRight(surf, `text-${uses}`, a, x + width - 24, y);
    blitTextRight(surf, 'text', '/', x + width - 16, y);
    blitTextRight(surf, `text-${uses}`, b, x + width, y);
  }

  /** create_equipment_surf, drawn at x = 96. */
  private drawEquipment(surf: Surface): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const ox = 96;
    const weapon = getEquippedWeapon(unit, game.db, game);
    const accessory = unit.equippedAccessory;
    const highlight = getSprite('info_menu/equipment_highlight');
    const nonAccessories = unit.items.filter((item) => !item.isAccessory());
    const accessories = unit.items.filter((item) => item.isAccessory());
    const drawEntry = (item: ItemObject, idx: number, equipped: ItemObject | null): void => {
      const y = idx * 16 + 24;
      const sub = item.subitems.find((child) => child === equipped);
      if (sub || item === equipped) blitSprite(surf, highlight, ox + 8, y + 8);
      this.drawItemOption(surf, sub ?? item, ox + 8, y);
      this.register([96 + 8, y, 120, 16], () => itemHelpBox(sub ?? item, unit), this.registry.get('equipment')?.length === 0);
    };
    nonAccessories.forEach((item, idx) => drawEntry(item, idx, weapon));
    const numItems = inventoryCapacity(unit, false, game.db);
    accessories.forEach((item, idx) => drawEntry(item, numItems + idx, accessory));

    const top = 104;
    const left = 12;
    blitSprite(surf, getSprite('info_menu/battle_info'), ox + left, top);
    blitSprite(surf, getSprite('info_menu/equipment_logo'), ox + 14, top + 4);
    blitText(surf, 'text-yellow', translate('Rng'), ox + 78, top);
    blitText(surf, 'text-yellow', translate('Atk'), ox + 22, top + 16);
    blitText(surf, 'text-yellow', translate('Hit'), ox + 22, top + 32);
    const crit = !!constant('crit');
    blitText(surf, 'text-yellow', translate(crit ? 'Crit' : 'AS'), ox + 78, top + 16);
    blitText(surf, 'text-yellow', translate('Avoid'), ox + 78, top + 32);
    this.register([96 + 78, top, 56, 16], 'Rng_desc');
    this.register([96 + 14, top + 16, 64, 16], 'Atk_desc');
    this.register([96 + 14, top + 32, 64, 16], 'Hit_desc');
    this.register([96 + 78, top + 16, 56, 16], crit ? 'Crit_desc' : 'AS_desc');
    this.register([96 + 78, top + 32, 56, 16], 'Avoid_desc');

    let rng = '--';
    let dam = '--';
    let acc = '--';
    let crt = '--';
    let as = '--';
    if (weapon) {
      const minR = modifiedMinimumRange(unit, weapon, game);
      const maxR = modifiedMaximumRange(unit, weapon, game);
      if (maxR >= 99) rng = `${minR}+`;
      else if (maxR < 0) rng = translate('Varies');
      else rng = minR !== maxR ? `${minR}-${maxR}` : String(maxR);
      dam = String(damage(unit, weapon, game.db, game));
      acc = String(accuracy(unit, weapon, game.db, game));
      if (weapon.hasComponent('crit')) crt = String(critAccuracy(unit, weapon, game.db, game));
      as = String(attackSpeed(unit, weapon, game.db, game));
    } else {
      as = String(unit.getStatValue('SPD'));
    }
    const avo = String(avoid(unit, game.db, game.board, null, game));
    blitTextRight(surf, 'text-blue', rng, ox + 127, top);
    blitTextRight(surf, 'text-blue', dam, ox + 71, top + 16);
    blitTextRight(surf, 'text-blue', acc, ox + 71, top + 32);
    blitTextRight(surf, 'text-blue', crit ? crt : as, ox + 127, top + 16);
    blitTextRight(surf, 'text-blue', avo, ox + 127, top + 32);
  }

  /** Usable, visible weapon types with positive WEXP (create_wexp_surf). */
  private wexpEntries(): [string, number][] {
    const unit = this.unit as UnitObject;
    const game = getGame();
    const klass = game.db.classes.get(unit.klass);
    const usable = new Set(Object.entries(klass?.wexp_gain ?? {})
      .filter(([, entry]) => Array.isArray(entry) ? entry[0] : (entry as any)?.usable)
      .map(([nid]) => nid));
    for (const skill of unit.skills) {
      const granted = skill.getComponent<unknown>('wexp_usable_skill');
      if (Array.isArray(granted)) for (const nid of granted) usable.add(String(nid));
      const forbidden = skill.getComponent<unknown>('wexp_unusable_skill');
      if (Array.isArray(forbidden)) for (const nid of forbidden) usable.delete(String(nid));
    }
    const visible = new Set((game.db.weapons ?? []).filter((w: any) => !w.hide_from_display).map((w: any) => w.nid));
    return Object.entries(unit.wexp)
      .filter(([nid, value]) => value > 0 && usable.has(nid) && visible.has(nid));
  }

  private drawWexp(surf: Surface): void {
    const game = getGame();
    const entries = this.wexpEntries().slice(0, 4);
    const width = Math.floor((WINWIDTH - 102) / 2);
    const ranks = [...(game.db.weaponRanks ?? [])].sort((a: any, b: any) => a.requirement - b.requirement);
    entries.forEach(([wtype, value], counter) => {
      const x = counter % 2;
      const y = Math.floor(counter / 2) * 16;
      let rank: any = null;
      let next: any = null;
      for (const r of ranks) {
        if (value >= r.requirement) rank = r;
        else if (!next) next = r;
      }
      const perc = !rank ? 0 : !next ? 1 : (value - rank.requirement) / (next.requirement - rank.requirement);
      const offset = 96 + 8 + x * width;
      const def = (game.db.weapons ?? []).find((w: any) => w.nid === wtype);
      if (def?.icon_nid) drawIcon16(surf, def.icon_nid, def.icon_index ?? [0, 0], offset, 24 + 4 + y);
      buildGroove(surf, offset + 18, 24 + 10 + y, width - 24, perc);
      const rankFont = FONT['rank'] ? 'rank-blue' : 'text-blue';
      blitTextCenter(surf, rankFont, rank?.rank ?? '', offset + 7 + Math.floor(width / 2), 24 + 4 + y);
      this.register([offset - 1, 24 + 4 + y, width, 16],
        `${def?.name ?? wtype} mastery level: ${value}`, counter === 0);
    });
  }

  /** create_support_surf */
  private drawSupports(surf: Surface): void {
    const unit = this.unit as UnitObject;
    const game = getGame();
    if (!game.gameVars?.get?.('_supports') || !game.supports) return;
    const width = Math.floor((WINWIDTH - 102) / 2);
    const pairs = game.supports.getPairsForUnit(unit.nid)
      .filter((pair: any) => pair.unlockedRanks?.length)
      .slice(0, 6);
    const top = 16 * 2 + 4 + 24;
    pairs.forEach((pair: any, idx: number) => {
      const x = idx % 2;
      const y = Math.floor(idx / 2);
      const otherNid = pair.unit1Nid === unit.nid ? pair.unit2Nid : pair.unit1Nid;
      const other = game.units.get(otherNid);
      if (!other) return;
      const affinity = game.db.affinities?.get?.(other.affinity);
      if (affinity?.icon_nid) drawIcon16(surf, affinity.icon_nid, affinity.icon_index ?? [0, 0], 96 + x * width + 8, y * 16 + top);
      if (affinity) this.register([96 + x * width + 8, y * 16 + top, WINWIDTH - 120, 16], affinity.desc ?? '');
      blitText(surf, 'narrow', other.name, 96 + x * width + 22, y * 16 + top);
      const highest = pair.unlockedRanks[pair.unlockedRanks.length - 1];
      blitTextRight(surf, 'text-yellow', highest, 96 + x * width + Math.floor((WINWIDTH - 96) / 2) - 2, y * 16 + top);
    });
  }

  /** create_notes_surf */
  private drawNotes(surf: Surface): void {
    const unit = this.unit as UnitObject;
    let total = 24;
    let helpOffset = 0;
    (unit.notes ?? []).forEach(([category, text], idx) => {
      this.register([96, 16 * helpOffset + 24, 64, 16], `${category}_desc`, idx === 0);
      helpOffset += String(text).split(',').length;
    });
    for (const [category, text] of unit.notes ?? []) {
      blitText(surf, 'text-blue', category, 96 + 10, total);
      const catW = textWidth('text', category);
      const left = catW <= 64 ? 64 : catW + 8;
      for (const entry of String(text).split(',')) {
        drawStyledText(surf, entry, 96 + left, total, 'white', 'text');
        total += 16;
      }
    }
  }
}
