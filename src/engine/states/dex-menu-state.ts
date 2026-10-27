/**
 * DexMenuState: the unit dex ("Gallery") from the private engine fork that
 * Embrace of the Fog ships on. Port of app/engine/info_menu/
 * base_copy_info_menu.py (BaseCopyInfoMenu, state name 'base_info_menu') from
 * the fork's v1.90 build. Upstream Lex Talionis has no equivalent.
 *
 * Reached from the fork-only `show_pokedex` event command (EOtF's option-menu
 * "Gallery"), from INFO on a `type_dex_unit` choice, and from AUX on a
 * Playable unit in prep/base manage.
 *
 * Layout: a scrolling default_background, the unit_selector_glow ring, and a
 * wheel of every Playable unit as map-sprite options along an arc (the
 * selected one on the glowing unit_select bar). On the right a 96px panel
 * shows the portrait, name, class, creator and recruit status; SELECT slides
 * it open to five 96px detail pages (stats/growths, items, skills, upgrades,
 * seals). Units that are not recruited, not seen, and not the unit the dex
 * was opened on are drawn black with '???'.
 */

import { State } from '../state';
import type { StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { FRAMETIME, WINHEIGHT, WINWIDTH, getFrameCount } from '../constants';
import { RECORDS, isFavorited, setFavorited } from '../records';
import { UnitObject } from '../../objects/unit';
import { SkillObject } from '../../objects/skill';
import { createItemTree, type ItemObject } from '../../objects/item';
import { drawIcon16, drawIconByAlias, resolveIconAlias } from '../../ui/icons';
import {
  HelpDialog, ItemHelpDialog, drawHelpPageCounter, getLinkedHelpBoxes, type HelpBox,
} from '../../ui/help-menu';
import {
  MenuBackground,
  MenuCursor,
  MenuScene,
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
import { Choice } from '../../ui/prep-ui';
import { makeTranslucent } from '../../ui/sprites';
import { drawSkill, findClosest } from './info-menu-state';

let _game: any = null;

export function setDexMenuGameRef(game: any): void {
  _game = game;
}

function getGame(): any {
  if (!_game) throw new Error('DexMenuState: game reference not set.');
  return _game;
}

function sfx(name: string): void {
  getGame().audioManager?.playSfx?.(name);
}

/** utils.frames2ms(1) */
const FRAME_MS = FRAMETIME;
/** Module-level TRANSITION_DURATION (the window class's own 250 is unused). */
const TRANSITION_DURATION = 125;
const UNIT_CHOICE_HEIGHT = 41;
const UNIT_CHOICE_BONUS_HEIGHT = 25;
const MINIMIZED_LEFT = WINWIDTH - 96;
const EXPANDED_LEFT = WINWIDTH - 192;
const DETAIL_LEFT = WINWIDTH - 96;
/** BasicUnitOption.width() default. */
const OPTION_WIDTH = 104;

const PAGES = ['vital', 'items', 'skill', 'upgrade', 'seals'] as const;
type Page = typeof PAGES[number];

/** Gallery (alternate-version) units and the unit whose recruitment reveals each. */
const GALLERY_COUNTERPARTS: [string, string][] = [
  ['Gemini_M', 'Gemini_F'], ['Ayaka', 'Akane'], ['Lupus_P', 'Canes_P'], ['August', 'Reese'],
];

const WEAPON_ORDER = ['Sword', 'Lance', 'Axe', 'Bow', 'Knife', 'Anima', 'Light', 'Dark', 'Staff', 'Stone'];
/** Tag -> row of the 16px type_icons strip. */
const TYPE_ICON_ROWS: Record<string, number> = {
  Beast: 1, Horse: 2, Flying: 3, Armor: 4, Monster: 5, Infantry: 6,
  Wyvern: 7, Dragon: 8, Magical: 9, Female: 10, Chess: 11, Mech: 12,
};
const BOSS_NAMES = ['Bootes', 'Canes', 'Lovers', 'Loreia', 'Savior', 'Trinity', 'Serpens', 'Solfrid', 'Grigol', 'Libra'];
const BOSS_NIDS = ['Bootes', 'Canes', 'Fabien', 'Loreia', 'Machine', 'Trinity', 'Serpens', 'Solfrid', 'GrigolBoss', 'Final'];
/** The record each boss seal name is revealed by (create_seal_surf). */
const BOSS_RECORDS: Record<string, string> = {
  Bootes: 'forename', Canes: 'original_name', Fabien: 'fog_gate_opening', Loreia: 'loreia_defeated',
  Machine: 'sydney_assimilation', Trinity: 'trinity_boss', Serpens: 'serpens_defeated',
  Solfrid: 'solfrid_defeated', GrigolBoss: 'grigol_boss_defeated', Final: 'game_clear',
};

function record(nid: string): unknown {
  return RECORDS?.get(nid) ?? null;
}

function recordList(nid: string): unknown[] {
  const value = record(nid);
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Unit objects for display
// ---------------------------------------------------------------------------

const prefabUnits = new Map<string, UnitObject>();

/**
 * UnitObject.from_prefab for drawing only: the prefab's class and a player
 * palette map sprite, never registered with the game. Shared by the dex
 * panel (load_map_sprite(DB.units.get(nid))) and type_dex_unit choices.
 */
export function prefabDisplayUnit(game: any, nid: string): UnitObject | null {
  const cached = prefabUnits.get(nid);
  if (cached && cached.klass === game.db.units.get(nid)?.klass) return cached;
  const prefab = game.db.units.get(nid);
  const klass = prefab ? game.db.classes.get(prefab.klass) : null;
  if (!prefab || !klass) return null;
  const unit = new UnitObject(prefab, klass);
  unit.team = 'player';
  prefabUnits.set(nid, unit);
  void game.loadMapSpriteForUnit?.(unit);
  return unit;
}

/** BasicUnitOption.from_nid: the registry unit if loaded, else the prefab. */
export function dexOptionUnit(game: any, nid: string): UnitObject | null {
  const unit: UnitObject | undefined = game.units?.get?.(nid);
  if (unit) {
    if (!unit.sprite && !(unit as any)._dexSpriteRequested) {
      (unit as any)._dexSpriteRequested = true;
      void game.loadMapSpriteForUnit?.(unit);
    }
    return unit;
  }
  return prefabDisplayUnit(game, nid);
}

/** counters back-and-forth sprite counter frame for (durations). */
function backAndForthFrame(frameCount: number, durations: number[]): number {
  const lengths = [...durations, ...durations.slice(1, -1).reverse()];
  const order = [...durations.keys(), ...[...durations.keys()].slice(1, -1).reverse()];
  let t = frameCount % lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < order.length; i++) {
    if (t < lengths[i]) return order[i];
    t -= lengths[i];
  }
  return 0;
}

/** image_mods.make_black_colorkey: multiply RGB by (1 - black), alpha kept. */
export function makeBlackColorkey(surf: Surface, black: number): Surface {
  const keep = Math.max(0, Math.min(255, Math.trunc(255 * (1 - black)))) / 255;
  const out = surf.copy();
  out.setAlpha(surf.getAlpha());
  if (keep >= 1) return out;
  const data = out.getImageData();
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    px[i] = Math.trunc(px[i] * keep);
    px[i + 1] = Math.trunc(px[i + 1] * keep);
    px[i + 2] = Math.trunc(px[i + 2] * keep);
  }
  out.putImageData(data);
  return out;
}

/** UnitSprite.create_image(state, stationary) for a map sprite. */
function unitImage(unit: UnitObject | null, kind: 'passive' | 'active', stationary: boolean): Surface | null {
  const sprite: any = unit?.sprite;
  if (!sprite?.getStandFrames) return null;
  const frames: Surface[] = sprite.getStandFrames(kind) ?? [];
  if (!frames.length) return null;
  if (stationary) return frames[0];
  const index = backAndForthFrame(getFrameCount(), kind === 'active' ? [20, 4, 20] : [32, 4, 32]);
  return frames[index % frames.length];
}

/** BasicUnitOption.draw_option at (x, y). */
function drawUnitOption(
  surf: Surface, unit: UnitObject | null, text: string, color: string,
  x: number, y: number, active: boolean, stationary: boolean, darkened: boolean,
): void {
  let image = unitImage(unit, active ? 'active' : 'passive', stationary);
  if (image) {
    if (darkened) image = makeBlackColorkey(image, 1.0);
    surf.blit(image, Math.trunc(x - 20), Math.trunc(y - 24 - 1));
  }
  const font = textWidth('text', text) > OPTION_WIDTH - 20 ? 'narrow' : 'text';
  blitText(surf, font, text, Math.trunc(x + 20), Math.trunc(y), color);
}

// ---------------------------------------------------------------------------
// SlidingWindowUnitList
// ---------------------------------------------------------------------------

/** Python list slicing l[start:end]. */
function pySlice<T>(list: T[], start: number, end: number): T[] {
  const n = list.length;
  const norm = (i: number): number => Math.max(0, Math.min(n, i < 0 ? i + n : i));
  const a = norm(start);
  const b = norm(end);
  return a < b ? list.slice(a, b) : [];
}

export class SlidingWindowUnitList {
  readonly list: string[];

  constructor(list: string[]) {
    this.list = list;
  }

  get length(): number {
    return this.list.length;
  }

  at(idx: number): string {
    return this.list[idx];
  }

  index(nid: string): number {
    return this.list.indexOf(nid);
  }

  get(start: number, end: number): string[] {
    const n = this.list.length;
    while (end > n) end -= n;
    if ((start < 0 && end >= 0) || start >= end) {
      return [...pySlice(this.list, start, n), ...pySlice(this.list, 0, end)];
    }
    return pySlice(this.list, start, end);
  }

  getWindow(center: number, buffer: number): [string[], string[]] {
    const b = Math.min(buffer, this.list.length);
    return [this.get(center - b, center), this.get(center + 1, center + b + 1)];
  }
}

// ---------------------------------------------------------------------------
// The fork's InfoGraph (info_graph.py), keyed by detail page
// ---------------------------------------------------------------------------

interface DexBox {
  aabb: [number, number, number, number];
  boxes: HelpBox[];
  page: number;
  state: string;
}

class DexInfoGraph {
  registry = new Map<string, DexBox[]>();
  currentBB: DexBox | null = null;
  lastBB: DexBox | null = null;
  currentState = '';
  private cursor = new MenuCursor();

  setCurrentState(state: string): void {
    this.currentState = state;
    if (!this.registry.has(state)) this.registry.set(state, []);
  }

  register(aabb: [number, number, number, number], boxes: HelpBox[], state: string): void {
    const list = this.registry.get(state) ?? [];
    list.push({ aabb, boxes, page: 0, state });
    this.registry.set(state, list);
  }

  boxes(): DexBox[] {
    return this.registry.get(this.currentState) ?? [];
  }

  helpBox(bb: DexBox): HelpBox {
    return bb.boxes[bb.page] ?? bb.boxes[0];
  }

  setTransitionIn(): void {
    if (this.lastBB && this.lastBB.state === this.currentState) {
      this.currentBB = this.lastBB;
    } else {
      this.currentBB = this.boxes()[0] ?? null;
    }
    if (this.currentBB) this.helpBox(this.currentBB).setTransitionIn();
  }

  setTransitionOut(): void {
    if (this.currentBB) this.helpBox(this.currentBB).setTransitionOut();
    this.lastBB = this.currentBB;
    this.currentBB = null;
  }

  move(dir: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN'): void {
    const cur = this.currentBB;
    if (!cur) return;
    const boxes = this.boxes().filter((bb) => dir === 'LEFT' ? bb.aabb[0] < cur.aabb[0]
      : dir === 'RIGHT' ? bb.aabb[0] > cur.aabb[0]
        : dir === 'UP' ? bb.aabb[1] < cur.aabb[1] : bb.aabb[1] > cur.aabb[1]);
    if (!boxes.length) return;
    const next = findClosest(cur, boxes, dir === 'LEFT' || dir === 'RIGHT');
    if (!next) return;
    this.currentBB = next;
    next.page = 0;
  }

  switchInfo(): void {
    const bb = this.currentBB;
    if (!bb) return;
    bb.page = bb.page < bb.boxes.length - 1 ? bb.page + 1 : 0;
  }

  draw(surf: Surface): void {
    const bb = this.currentBB;
    if (!bb) return;
    const pos: [number, number] = [Math.max(0, bb.aabb[0] - 32), bb.aabb[1] + 13];
    this.cursor.update();
    this.cursor.draw(surf, Math.max(0, bb.aabb[0] - 4), bb.aabb[1]);
    const box = this.helpBox(bb);
    box.draw(surf, pos[0], pos[1], false);
    drawHelpPageCounter(surf, box, pos[0], pos[1], bb.page, bb.boxes.length);
  }
}

// ---------------------------------------------------------------------------
// DexOptionMenu
// ---------------------------------------------------------------------------

class DexOptionMenu {
  static readonly OPTIONS = ['Toggle Favorite'];
  static readonly INFO_DESC = ['Favorite a unit'];

  state: 'inactive' | 'active' = 'inactive';
  menu: Choice;
  private infoFlag = false;
  private helpBoxes: HelpBox[];
  private parent: DexDetailPanel;

  constructor(parent: DexDetailPanel) {
    this.parent = parent;
    this.menu = new Choice(getGame(), [...DexOptionMenu.OPTIONS], [0, 0]);
    this.menu.topleft = this.topleft();
    this.helpBoxes = DexOptionMenu.INFO_DESC.map((desc) => new HelpDialog(desc));
  }

  /** menus.Choice with topleft=None: beside the side the cursor is not on. */
  private topleft(): [number, number] {
    const game = getGame();
    const cursorX = Number(game.cursor?.getPosition?.()?.[0] ?? 0);
    const cameraX = Math.floor(Number(game.camera?.getPosition?.()?.[0] ?? 0) / 16);
    if (cursorX > Math.floor(15 / 2) + cameraX) return [14, 8];
    return [WINWIDTH - this.menu.getMenuWidth() - 14, 8];
  }

  open(): void {
    this.state = 'active';
  }

  update(): void {
    this.menu.update();
  }

  /** Returns true when the menu is closed and input should continue. */
  takeInput(event: InputEvent): boolean {
    if (this.state === 'inactive') return true;
    if (event === 'INFO') {
      this.infoFlag = !this.infoFlag;
    } else if (event === 'RIGHT' || event === 'DOWN') {
      sfx('Select 6');
      this.menu.moveDown(true);
    } else if (event === 'LEFT' || event === 'UP') {
      sfx('Select 6');
      this.menu.moveUp(true);
    } else if (event === 'BACK') {
      sfx('Info Out');
      this.state = 'inactive';
    } else if (event === 'SELECT') {
      if (this.menu.getCurrentText() === 'Toggle Favorite') {
        const nid = this.parent.currentUnitNid;
        if (nid) setFavorited(nid, !isFavorited(nid));
      }
    }
    return false;
  }

  draw(surf: Surface): void {
    if (this.state === 'inactive') return;
    this.menu.draw(surf);
    if (this.infoFlag) {
      const box = this.helpBoxes[this.menu.currentIndex];
      const rect = this.menu.getRects().find(([idx]) => idx === this.menu.currentIndex);
      if (box && rect) {
        if (this.menu.getTopleft()[0] < WINWIDTH / 2) box.draw(surf, rect[1] - 4, rect[2] + 16);
        else box.draw(surf, rect[1] + this.menu.getMenuWidth(), rect[2] + 16, true);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BaseCopyInfoWindow: the right-hand detail panel
// ---------------------------------------------------------------------------

class DexDetailPanel {
  currentUnitNid: string | null = null;
  leftSide = MINIMIZED_LEFT;
  transitionTime = 0;
  state: 'inactive' | 'expand' | 'active' | 'retract' = 'inactive';
  infoFlag = false;
  pageIdx = 0;
  mode: 'Stat' | 'Growth' = 'Stat';
  infoGraph = new DexInfoGraph();
  optionMenu: DexOptionMenu;
  private bg: HTMLImageElement | null = null;
  private registered = new Set<string>();
  private isHidden: (nid: string) => boolean;

  constructor(isHidden: (nid: string) => boolean) {
    this.isHidden = isHidden;
    this.optionMenu = new DexOptionMenu(this);
    const game = getGame();
    // PanoramaBackground(info_menu_background).panorama.images[0]
    void game.resources?.loadImage?.('resources/panoramas/info_menu_background.png')
      .then((img: HTMLImageElement) => { this.bg = img; })
      .catch(() => {
        void game.resources?.loadImage?.('resources/panoramas/info_menu_background0.png')
          .then((img: HTMLImageElement) => { this.bg = img; })
          .catch(() => undefined);
      });
  }

  page(): Page {
    return PAGES[this.pageIdx];
  }

  setCurrentUnit(nid: string): void {
    this.infoGraph = new DexInfoGraph();
    this.infoGraph.setCurrentState(this.page());
    this.currentUnitNid = nid;
    this.registered.clear();
    prefabDisplayUnit(getGame(), nid);
  }

  /** Returns true when UP/DOWN should fall through to the unit wheel. */
  takeInput(event: InputEvent): boolean {
    if (!this.optionMenu.takeInput(event)) return false;
    if (this.state !== 'active') return false;
    if (this.infoFlag) {
      if (event === 'RIGHT' || event === 'LEFT' || event === 'UP' || event === 'DOWN') {
        sfx('Select 6');
        this.infoGraph.move(event);
      }
      if (event === 'AUX') {
        sfx('Select 6');
        this.infoGraph.switchInfo();
      } else if (event === 'INFO' || event === 'BACK') {
        sfx('Info Out');
        this.infoGraph.setTransitionOut();
        this.infoFlag = false;
      }
      return false;
    }
    if (event === 'RIGHT') {
      this.pageIdx = (this.pageIdx + 1) % PAGES.length;
      this.infoGraph.setCurrentState(this.page());
    } else if (event === 'LEFT') {
      this.pageIdx = (this.pageIdx - 1 + PAGES.length) % PAGES.length;
      this.infoGraph.setCurrentState(this.page());
    } else if (event === 'UP' || event === 'DOWN') {
      return true;
    }
    if (event === 'BACK') {
      this.retract();
    } else if (event === 'INFO') {
      if (this.infoGraph.boxes().length) {
        sfx('Info In');
        this.infoGraph.setTransitionIn();
        this.infoFlag = true;
      }
    } else if (event === 'AUX') {
      sfx('Select 6');
      this.mode = this.mode === 'Stat' ? 'Growth' : 'Stat';
    } else if (event === 'SELECT') {
      this.optionMenu.open();
      sfx('Select 6');
    }
    return false;
  }

  update(): void {
    this.optionMenu.update();
    this.transitionTime = Math.max(this.transitionTime - FRAME_MS, 0);
    const t = this.transitionTime / TRANSITION_DURATION;
    if (this.state === 'expand') {
      this.leftSide = Math.trunc(EXPANDED_LEFT + (MINIMIZED_LEFT - EXPANDED_LEFT) * t);
      if (this.transitionTime === 0) this.state = 'active';
    } else if (this.state === 'retract') {
      this.leftSide = Math.trunc(MINIMIZED_LEFT + (EXPANDED_LEFT - MINIMIZED_LEFT) * t);
      if (this.transitionTime === 0) this.state = 'inactive';
    }
  }

  expand(): void {
    if (this.state === 'inactive') {
      this.transitionTime = TRANSITION_DURATION;
      this.state = 'expand';
    }
  }

  retract(): void {
    if (this.state === 'active') {
      this.transitionTime = TRANSITION_DURATION;
      this.state = 'retract';
    }
  }

  // --- create_portrait_surf ---
  private drawPortrait(surf: Surface, nid: string): void {
    const game = getGame();
    const unit = game.db.units.get(nid);
    if (!unit) return;
    const hidden = this.isHidden(nid);
    const meta = game.db.portraits?.get?.(unit.portrait_nid);
    const sheet = getPortrait(game.resources, unit.portrait_nid);
    if (sheet && meta) {
      // icons.get_portrait: the 96x80 main frame; x_pos = (96 - 80) // 2.
      const face = new Surface(80, 72);
      face.blitImage(sheet, 8, Number(meta.info_offset ?? 0), 80, 72, 0, 0);
      surf.blit(hidden ? makeBlackColorkey(face, 1.0) : face, 8, 8);
    } else if (!meta) {
      // Generic class card: icons80 at icon_index, 80x72.
      const klass = game.db.classes.get(unit.klass);
      const card = klass?.icon_nid ? getKeyedImage(game.resources, `resources/icons80/${klass.icon_nid}.png`) : null;
      if (card) {
        const face = new Surface(80, 72);
        const idx = klass.icon_index ?? [0, 0];
        face.blitImage(card, idx[0] * 80, idx[1] * 72, 80, 72, 0, 0);
        surf.blit(hidden ? makeBlackColorkey(face, 1.0) : face, 8, 8);
      }
    }

    blitTextCenter(surf, 'text', hidden ? ' ???' : unit.name, 48, 80, 'white');
    const klass = game.db.classes.get(unit.klass);
    blitText(surf, 'text', hidden ? '???' : (klass?.name ?? unit.klass), 5, 104, 'white');
    const fields = new Map<string, unknown>(unit.fields ?? []);
    blitText(surf, 'text', String(fields.get('Creator') ?? '???'), 5, 120, 'white');

    const recruited = recordList('Available_Units').includes(nid) ||
      (nid === 'Yasukage' && !!record('yasukage_unlocked'));
    // Gallery units (alternate versions) have no recruit status. The engine
    // asks for 'gray', which the text font lacks, so N/A prints in white.
    if ((unit.tags ?? []).includes('Gallery')) blitText(surf, 'text', 'N/A', 5, 136, 'white');
    else if (recruited) blitText(surf, 'text', 'Recruited!', 5, 136, 'green');
    else blitText(surf, 'text', 'Not Recruited', 5, 136, 'red');

    if (!hidden) {
      const affinity = game.db.affinities?.get?.(unit.affinity);
      if (affinity?.icon_nid) drawIcon16(surf, affinity.icon_nid, affinity.icon_index ?? [0, 0], 78, 80);
      if (isFavorited(nid)) drawIconByAlias(surf, 'event_hp', 5, 80);
    }
  }

  // --- create_detail_surf ---
  private drawDetail(surf: Surface, nid: string, page: Page): void {
    const game = getGame();
    const prefab = game.db.units.get(nid);
    const klass = prefab ? game.db.classes.get(prefab.klass) : null;
    if (!prefab || this.isHidden(nid)) {
      blitTextCenter(surf, 'text', 'Identity', 48, Math.floor(WINHEIGHT / 2) - 16, 'red');
      blitTextCenter(surf, 'text', 'unknown', 48, Math.floor(WINHEIGHT / 2), 'red');
      return;
    }
    const register = !this.registered.has(page);
    this.registered.add(page);
    if (page === 'vital') this.drawVital(surf, prefab, klass);
    else if (page === 'items') this.drawItems(surf, prefab, register);
    else if (page === 'skill') this.drawSkills(surf, prefab, register);
    else if (page === 'upgrade') this.drawUpgrades(surf, prefab);
    else this.drawSeals(surf, prefab);
  }

  private drawVital(surf: Surface, unit: any, klass: any): void {
    const write = (text: string | number, color: string, x: number, y: number): void =>
      blitText(surf, 'text', String(text), x, y, color);
    const bases: Record<string, number> = unit.bases ?? {};
    const growths: Record<string, number> = unit.growths ?? {};
    const stat = (nid: string, x: number, y: number): void => {
      write(nid, 'blue', x, y);
      write((this.mode === 'Stat' ? bases[nid] : growths[nid]) ?? 0, 'white', x + 24, y);
    };
    write('Stat Info', 'yellow', 5, 5);
    stat('HP', 5, 21); stat('LCK', 46, 21);
    stat('STR', 5, 37); stat('MAG', 46, 37);
    stat('SKL', 5, 53); stat('DEF', 46, 53);
    stat('SPD', 5, 69); stat('RES', 46, 69);
    stat('CON', 5, 85); stat('MOV', 46, 85);

    const fields = new Map<string, unknown>(unit.fields ?? []);
    const start = fields.has('Base_Weapons') ? String(fields.get('Base_Weapons') ?? '') : '';
    const end = fields.has('Upgrade_Weapons') ? String(fields.get('Upgrade_Weapons') ?? '') : '';
    if (start || end) {
      const startList = start ? start.split(',') : [];
      const endList = end ? end.split(',') : [];
      const game = getGame();
      let offset = 5;
      let count = 0;
      for (const weapon of WEAPON_ORDER) {
        const y = 105 + 16 * Math.floor(count / 5);
        if (startList.includes(weapon)) {
          const wdef = (game.db.weapons ?? []).find((w: any) => w.nid === weapon);
          if (wdef?.icon_nid) drawIcon16(surf, wdef.icon_nid, wdef.icon_index ?? [0, 0], offset, y);
        } else if (endList.includes(weapon)) {
          drawIconByAlias(surf, `promoted_${weapon}`, offset, y);
        } else {
          const alias = resolveIconAlias(weapon);
          if (alias) {
            const icon = new Surface(16, 16);
            drawIcon16(icon, alias.sheetNid, alias.index, 0, 0);
            surf.blit(makeBlackColorkey(icon, 0.5), offset, y);
          }
        }
        count += 1;
        offset = count % 5 === 0 ? 5 : offset + 16;
      }
    }

    const unitTags: string[] = unit.tags ?? [];
    const combined = [...unitTags, ...(klass?.tags ?? []).filter((t: string) => !unitTags.includes(t))];
    const icons = getSprite('type_icons');
    let counter = 0;
    for (const tag of combined) {
      const row = TYPE_ICON_ROWS[tag];
      if (row === undefined) continue;
      blitSub(surf, icons, 0, 16 * row, 16, 16, 5 + 16 * counter, 140);
      counter += 1;
      if (counter >= 5) break;
    }
  }

  private upgrades(nid: string, type?: string): any[] {
    const rows = getGame().db.rawData?.get?.('Character_Upgrades');
    if (!Array.isArray(rows)) return [];
    return rows.filter((row: any) => row?.unit_nid === nid && (!type || row.upgrade_type === type));
  }

  private registerBox(x: number, y: number, boxes: HelpBox[], page: Page, register: boolean): void {
    if (register) this.infoGraph.register([DETAIL_LEFT + x + 2, y + 4, 16, 16], boxes, page);
  }

  private drawItems(surf: Surface, unit: any, register: boolean): void {
    const game = getGame();
    blitText(surf, 'text', 'Base Items', 5, 5, 'yellow');
    blitText(surf, 'text', 'Upgrade Items', 5, 72, 'yellow');
    const add = (itemNid: string, x: number, y: number): void => {
      const prefab = game.db.items.get(itemNid);
      if (!prefab) return;
      const item: ItemObject = createItemTree(prefab, (n: string) => game.db.items.get(n));
      if (item.iconNid) drawIcon16(surf, item.iconNid, item.iconIndex ?? [0, 0], x + 2, y + 4);
      if (register) {
        this.registerBox(x, y, [new ItemHelpDialog(item, null, false), ...this.getHelpBoxes(item.desc ?? '')], 'items', true);
      }
    };
    const starting: [string, boolean][] = unit.starting_items ?? [];
    starting.forEach(([nid], count) => add(nid, (count % 4) * 24 + 1, Math.floor(count / 4) * 24 + 21));
    this.upgrades(unit.nid, 'Item').forEach((row, idx) =>
      add(String(row.value_1), (idx % 4) * 24 + 1, Math.floor(idx / 4) * 24 + 93));
  }

  private drawSkills(surf: Surface, unit: any, register: boolean): void {
    const game = getGame();
    blitText(surf, 'text', 'Base Skills', 5, 5, 'yellow');
    blitText(surf, 'text', 'Upgrade Skills', 5, 72, 'yellow');
    const visible = (nid: string): boolean => {
      const prefab = game.db.skills.get(nid);
      return !!prefab && !(prefab.components ?? []).some((c: any) => c?.[0] === 'hidden');
    };
    const add = (skillNid: string, x: number, y: number): void => {
      const skill = new SkillObject(game.db.skills.get(skillNid));
      drawSkill(surf, skill, x + 2, y + 4, false);
      if (register) {
        this.registerBox(x, y, [new HelpDialog(skill.desc ?? '', skill.name), ...this.getHelpBoxes(skill.desc ?? '')], 'skill', true);
      }
    };
    let count = 0;
    for (const [, nid] of (unit.learned_skills ?? []) as [number, string][]) {
      if (!visible(nid)) continue;
      add(nid, (count % 4) * 24 + 1, Math.floor(count / 4) * 24 + 21);
      count += 1;
    }
    let count2 = 0;
    for (const row of this.upgrades(unit.nid, 'Skill')) {
      const nid = String(row.value_1);
      if (!visible(nid)) continue;
      add(nid, (count2 % 4) * 24 + 1, Math.floor(count2 / 4) * 24 + 93);
      count2 += 1;
    }
  }

  private drawUpgrades(surf: Surface, unit: any): void {
    blitText(surf, 'text', 'Upgrades', 5, 5, 'yellow');
    const seal = resolveIconAlias('Master_Seal');
    this.upgrades(unit.nid).forEach((row, offset) => {
      const y = 21 + 16 * offset;
      blitText(surf, 'narrow', String(row.upgrade_name ?? ''), 5, y, 'white');
      if (seal) drawIcon16(surf, seal.sheetNid, seal.index, 66, y);
      if (record(String(row.nid))) blitText(surf, 'narrow', 'B', 82, y, 'green');
      else blitText(surf, 'narrow', `x${row.cost ?? ''}`, 82, y, 'red');
    });
  }

  private drawSeals(surf: Surface, unit: any): void {
    blitText(surf, 'text', 'Earned Seals', 5, 5, 'yellow');
    const seal = resolveIconAlias('Master_Seal');
    BOSS_NIDS.forEach((boss, offset) => {
      const even = offset % 2 === 0;
      const y = even ? 21 + 10 * offset : 21 + 10 * (offset - 1);
      const revealed = !!record(BOSS_RECORDS[boss]);
      blitText(surf, 'narrow', revealed ? BOSS_NAMES[offset] : '???', even ? 5 : 50, y, 'white');
      if (record(unit.nid + boss) && seal) drawIcon16(surf, seal.sheetNid, seal.index, even ? 33 : 70, y);
    });
  }

  /** get_help_boxes: a help box per lore/item/skill colour tag in `desc`. */
  private getHelpBoxes(desc: string): HelpBox[] {
    return getLinkedHelpBoxes(desc);
  }

  draw(surf: Surface): void {
    const game = getGame();
    const nid = this.currentUnitNid;
    if (!nid) return;
    if (this.bg) surf.blitImage(this.bg, 0, 0, this.bg.width, this.bg.height, this.leftSide, 0);
    const portrait = new Surface(96, WINHEIGHT);
    this.drawPortrait(portrait, nid);
    surf.blit(portrait, this.leftSide, 0);

    blitSprite(surf, getSprite('status_platform'), this.leftSide + 66, 131);
    const active = unitImage(prefabDisplayUnit(game, nid), 'active', false);
    if (active) surf.blit(active, this.leftSide + 81 - Math.floor(active.width / 2), WINHEIGHT - 61);
    if (this.state !== 'inactive') {
      blitTextRight(surf, 'small', `${this.pageIdx + 1}/${PAGES.length}`, this.leftSide + 96 + 84, 4);
      const detail = new Surface(96, WINHEIGHT);
      this.drawDetail(detail, nid, this.page());
      surf.blit(detail, this.leftSide + 96, 0);
    }
    if (this.infoFlag && this.infoGraph.currentBB) this.infoGraph.draw(surf);
    this.optionMenu.draw(surf);
  }
}

// ---------------------------------------------------------------------------
// BaseCopyInfoMenu
// ---------------------------------------------------------------------------

/** glow_timer: clamp(2 sin(i), -1, 1) / 2 + 0.5 for i in range(0, 360, 3). */
const GLOW_TIMER: number[] = [];
for (let i = 0; i < 360; i += 3) {
  GLOW_TIMER.push(Math.max(-1, Math.min(1, 2 * Math.sin((i * Math.PI) / 180))) / 2 + 0.5);
}

export class DexMenuState extends State {
  readonly name = 'base_info_menu';
  override readonly transparent = false;
  override readonly showMap = false;
  override readonly inLevel = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  allUnits = new SlidingWindowUnitList([]);
  selectedIdx = 0;
  private initialUnit: string | null = null;
  private transitionTime = 0;
  private transitionDirection = 0;
  private queuedDirection: 'UP' | 'DOWN' | null = null;
  phase: 'unit_select' | 'detail' | 'scroll_transition' = 'unit_select';
  detailPanel: DexDetailPanel | null = null;
  private glowIdx = 0;
  /** faded_unit_surf_cache (per visit, so late-loading sprites appear). */
  private fadedCache = new Map<string, Surface>();
  private wheelCache: { key: string; surf: Surface } | null = null;

  override start(): StateResult {
    const game = getGame();
    this.bg = new MenuBackground('default_background', game.resources, true);
    this.bg.scrollSpeed = 25; // ScrollingBackground's own speed (not create_background's 50)
    preloadSprites(['unit_selector_glow', 'unit_select_base', 'unit_select_glow', 'buttons',
      'status_platform', 'type_icons', 'menu_highlight', 'menu_hand']);
    // Playable and Gallery units in DB order; Libra_P and Samael_P join after
    // Density 10 is cleared, then Samael_P waits for Density 15.
    const excluded = !record('Density_10_Cleared') ? ['Libra_P', 'Samael_P']
      : !record('Density_15_Cleared') ? ['Samael_P'] : [];
    const nids: string[] = [...game.db.units.values()]
      .filter((u: any) => (u.tags ?? []).includes('Playable') || (u.tags ?? []).includes('Gallery'))
      .map((u: any) => u.nid)
      .filter((nid: string) => !excluded.includes(nid));
    this.allUnits = new SlidingWindowUnitList(nids);
    this.initialUnit = game.memory?.get?.('curr_unit_info') ?? null;
    const unitNid = this.initialUnit ?? nids[0];
    this.selectedIdx = Math.max(0, this.allUnits.index(unitNid));
    this.transitionTime = 0;
    this.transitionDirection = 0;
    this.queuedDirection = null;
    this.phase = 'unit_select';
    this.glowIdx = 0;
    this.fadedCache = new Map();
    this.wheelCache = null;
    this.detailPanel = new DexDetailPanel((nid) => this.isHidden(nid));
    if (nids.length) this.detailPanel.setCurrentUnit(this.currentUnit());
  }

  currentUnit(): string {
    return this.allUnits.at(this.selectedIdx);
  }

  isHidden(nid: string): boolean {
    if (nid === this.initialUnit) return false;
    const available = recordList('Available_Units');
    const seen = recordList('Seen_Units');
    if ((getGame().db.units.get(nid)?.tags ?? []).includes('Gallery')) {
      // An alternate version shows once its counterpart is recruited. The
      // engine's `nid == X and P in Available or P in Seen` binds as
      // `(... and ...) or ...`, so any counterpart in Seen_Units reveals
      // every Gallery unit; kept as the game plays.
      for (const [alt, counterpart] of GALLERY_COUNTERPARTS) {
        if ((nid === alt && available.includes(counterpart)) || seen.includes(counterpart)) return false;
      }
    }
    if (available.includes(nid)) return false;
    if (recordList('Seen_Units').includes(nid)) return false;
    if (record('yasukage_unlocked') && nid === 'Yasukage') return false;
    return true;
  }

  private back(): void {
    sfx('Select 4');
    getGame().state.back();
  }

  override takeInput(event: InputEvent): StateResult {
    const panel = this.detailPanel;
    if (!panel || !this.allUnits.length) {
      if (event === 'BACK') this.back();
      return;
    }
    if (panel.state === 'active' && !panel.takeInput(event)) return;

    if (this.phase === 'unit_select') {
      let direction: string | null = event;
      if (this.queuedDirection) {
        direction = this.queuedDirection;
        this.queuedDirection = null;
      }
      if (event === 'SELECT') {
        panel.expand();
        this.phase = 'detail';
      } else if (event === 'BACK') {
        this.back();
      } else if (event === 'AUX') {
        getGame().memory.set('text_entry', ['Dex_Search', 'Enter a character name', 20, [], false]);
        getGame().state.change('text_entry');
      } else if (direction === 'UP') {
        sfx('Select 6');
        this.move(-1);
      } else if (direction === 'DOWN') {
        sfx('Select 6');
        this.move(1);
      }
    } else if (this.phase === 'scroll_transition') {
      // Buffered for fluidity: applied on the first unit_select frame.
      if (event === 'UP' || event === 'DOWN') this.queuedDirection = event;
    }
  }

  private move(dir: 1 | -1): void {
    const n = this.allUnits.length;
    this.selectedIdx = (this.selectedIdx + dir + n) % n;
    this.detailPanel?.setCurrentUnit(this.currentUnit());
    this.transitionTime = TRANSITION_DURATION;
    this.transitionDirection = dir;
    this.phase = 'scroll_transition';
  }

  override update(): StateResult {
    this.performSearch();
    this.bg?.update();
    this.detailPanel?.update();
    this.glowIdx = (this.glowIdx + 1) % GLOW_TIMER.length;
    this.transitionTime = Math.max(this.transitionTime - FRAME_MS, 0);
    if (this.transitionTime === 0) this.phase = 'unit_select';
  }

  /** perform_search: jump to a seen unit whose name or nid was typed. */
  private performSearch(): void {
    const game = getGame();
    const value = game.gameVars?.get?.('Dex_Search');
    if (value) {
      const search = String(value).toLowerCase();
      for (const nid of this.allUnits.list) {
        const name = String(game.db.units.get(nid)?.name ?? '').toLowerCase();
        if (search === name || search === nid.toLowerCase()) {
          if (!this.isHidden(nid)) {
            this.selectedIdx = this.allUnits.index(nid);
            this.detailPanel?.setCurrentUnit(this.currentUnit());
          }
          break;
        }
      }
    }
    game.gameVars?.set?.('Dex_Search', null);
  }

  private fadedUnitChoice(nid: string): Surface {
    const cached = this.fadedCache.get(nid);
    if (cached) return cached;
    const game = getGame();
    const hidden = this.isHidden(nid);
    const id = this.allUnits.index(nid) + 1;
    const name = game.db.units.get(nid)?.name ?? nid;
    const unit = dexOptionUnit(game, nid);
    const surf = new Surface(OPTION_WIDTH, UNIT_CHOICE_HEIGHT);
    drawUnitOption(surf, unit, hidden ? `${id}: ???` : `${id}: ${name}`, hidden ? 'grey' : 'white',
      0, UNIT_CHOICE_BONUS_HEIGHT, false, true, hidden);
    if (unit?.sprite) this.fadedCache.set(nid, surf);
    return surf;
  }

  /** draw_passive_unit_wheel: options along an arc; returns the active point. */
  private drawWheel(surf: Surface, selected: number, units: string[], rotation: number): [number, number] {
    const size = units.length;
    const angles = units.map((_, i) => 90 - ((i + rotation) / (size - 1)) * 180);
    const center: [number, number] = [-8, Math.floor(WINHEIGHT / 2) - 16];
    const xRadius = 32;
    const yRadius = WINHEIGHT * 0.8;
    const rad = (deg: number): number => (deg * Math.PI) / 180;
    const xs = angles.map((a) => xRadius * Math.cos(rad(a)) + center[0]);
    const ys = angles.map((a) => -yRadius * Math.sin(rad(a / 2)) + center[1] - UNIT_CHOICE_BONUS_HEIGHT - 8);
    const active: [number, number] = [xs[selected] ?? 0, ys[selected] ?? 0];
    // lru_cache(1) on (selected_idx, unit_list, rotation); a late sprite
    // load (faded cache growth) rebuilds it.
    const key = `${selected}|${rotation}|${this.fadedCache.size}|${units.join(',')}`;
    if (this.wheelCache?.key === key) {
      this.drawSelection(surf, active[1]);
      surf.blit(this.wheelCache.surf, 0, 0);
      return active;
    }
    const wheel = new Surface(WINWIDTH, WINHEIGHT);
    const drawFaded = (idx: number): void => {
      const base = this.fadedUnitChoice(units[idx]);
      const amount = ((selected - idx) / 2) ** 2 / size;
      const faded = makeTranslucent(makeBlackColorkey(base, amount + 0.15), amount);
      wheel.blit(faded, Math.trunc(xs[idx]), Math.trunc(ys[idx]));
    };
    for (let idx = 0; idx < selected; idx++) drawFaded(idx);
    for (let idx = size - 1; idx > selected; idx--) drawFaded(idx);
    this.wheelCache = { key, surf: wheel };
    this.drawSelection(surf, active[1]);
    surf.blit(wheel, 0, 0);
    return active;
  }

  private drawSelection(surf: Surface, y: number): void {
    const bar = getSprite('unit_select_base');
    const glow = getSprite('unit_select_glow');
    blitSprite(surf, bar, 0, Math.trunc(y + 18));
    if (glow) {
      const glowSurf = new Surface(glow.width, glow.height);
      glowSurf.blitImage(glow, 0, 0, glow.width, glow.height, 0, 0);
      surf.blit(makeTranslucent(glowSurf, GLOW_TIMER[this.glowIdx]), 0, Math.trunc(y + 18));
    }
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const scene = this.scene.begin();
    const buttons = getSprite('buttons');
    blitSub(scene, buttons, 0, 66, 14, 13, WINWIDTH / 2, WINHEIGHT - 60);
    blitSub(scene, buttons, 1, 133, 16, 9, WINWIDTH / 2, WINHEIGHT - 30);
    blitTextCenter(scene, 'narrow', 'Expand', WINWIDTH / 2 + 7, WINHEIGHT - 50);
    blitTextCenter(scene, 'narrow', 'Search', WINWIDTH / 2 + 7, WINHEIGHT - 20);
    blitSprite(scene, getSprite('unit_selector_glow'), 0, 0);

    if (this.allUnits.length) {
      const game = getGame();
      const progress = (this.transitionTime / TRANSITION_DURATION) * this.transitionDirection;
      const [top, bottom] = this.allUnits.getWindow(this.selectedIdx, 9);
      const drawn = [...pySlice(top, -4, top.length), this.currentUnit(), ...pySlice(bottom, 0, 5)];
      const [ax, ay] = this.drawWheel(scene, 4, drawn, progress);
      const nid = this.currentUnit();
      const hidden = this.isHidden(nid);
      const name = game.db.units.get(nid)?.name ?? nid;
      drawUnitOption(scene, dexOptionUnit(game, nid),
        hidden ? `${this.selectedIdx + 1}: ???` : `${this.selectedIdx + 1}: ${name}`, 'white',
        ax, ay + UNIT_CHOICE_BONUS_HEIGHT, true, false, hidden);
      this.detailPanel?.draw(scene);
    }
    this.scene.present(surf);
    return surf;
  }
}
