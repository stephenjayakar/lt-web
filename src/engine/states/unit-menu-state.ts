/**
 * unit-menu-state.ts: the option menu's Unit chart. Port of lt-maker's
 * game_menus/menu_states/unit_menu_state.py with
 * menu_components/unit_menu/unit_menu.py and unit_table.py, on the
 * ui-framework subset in src/ui/ui-framework.ts.
 *
 * A page title box, a "Sort:" box with a bobbing arrow, the page number,
 * and a table: the unit names (with their map sprites) beside a strip of
 * stat columns that scrolls a page (65% of the table) at a time: Character,
 * Vital Statistics (six stats a page), Equipment and Weapon Level (eight
 * weapon types a page). SELECT on a header sorts by it (again: reverses);
 * SELECT on a unit closes the chart and the option menu with the cursor on
 * the unit. The EOtF fork only skins the sort box and the table body with
 * the window_display skin, which create_base_surf does for every window.
 */

import { State, type StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { ANIMATION_COUNTERS, WINHEIGHT, WINWIDTH, getFrameCount } from '../constants';
import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import { MenuBackground, MenuScene, ScrollArrow, ScrollBar } from '../../ui/menu-chrome';
import { currentWindowSkin, getSprite, makeTranslucent, preloadSprites } from '../../ui/sprites';
import { getMenuBackground, getMenuBackgroundSync } from '../../ui/base-surf';
import { drawIcon16, getIconSheet, loadIconSheet } from '../../ui/icons';
import {
  HeaderList,
  IconRow,
  PlainTextLine,
  UIComponent,
  UIMetric,
  componentScrollAnim,
  type HAlignment,
} from '../../ui/ui-framework';
import { accuracy, avoid, damage } from '../../combat/combat-calcs';
import { weaponType } from '../../combat/item-system';

let _game: any = null;

export function setUnitMenuGameRef(game: any): void {
  _game = game;
}

function getGame(): any {
  if (!_game) throw new Error('UnitMenuState: game reference not set.');
  return _game;
}

const CURSOR_PERTURBATION = [0, 1, 2, 3, 4, 3, 2, 1];

const UNIT_MENU_SPRITES = [
  'world_map_location_box', 'sort_arrow', 'header_shadow', 'equipment_highlight',
  'menu_hand', 'scroll_bar', 'page_arrows',
];

/**
 * Python's SPRITES are loaded before any menu opens; the web loads the
 * chart's sprites and windows when Unit is chosen (the transitions cover
 * it) and builds the chart once they are in.
 */
let loadedSkin: unknown = null;

/** Icon sheets the chart draws: weapon types and the units' weapons. */
function chartIconNids(units: UnitObject[]): string[] {
  const nids = new Set<string>();
  for (const wtype of _game?.db?.weapons ?? []) if (wtype.icon_nid) nids.add(wtype.icon_nid);
  for (const unit of units) {
    const nid = (weaponOf(unit) as any)?.iconNid;
    if (nid) nids.add(nid);
  }
  return [...nids];
}

export function preloadUnitMenuAssets(units: UnitObject[] = []): Promise<unknown> {
  const skin = currentWindowSkin();
  return Promise.all([
    preloadSprites(UNIT_MENU_SPRITES),
    getMenuBackground(WINWIDTH - 8, 28, 'menu_bg_white'),
    getMenuBackground(WINWIDTH - 8, WINHEIGHT * 0.75, 'menu_bg_base'),
    getMenuBackground(72, 24, 'menu_bg_base'),
    ...chartIconNids(units).map((nid) => loadIconSheet(nid)),
  ]).then(() => { loadedSkin = skin; });
}

/** Whether the chart's windows (in the current skin), sprites and icons are in. */
function unitMenuAssetsLoaded(units: UnitObject[]): boolean {
  return loadedSkin !== null && loadedSkin === currentWindowSkin() &&
    chartIconNids(units).every((nid) => getIconSheet(nid) !== null);
}
const ICON_SIZE: [number, number] = [16, 16];

/** Python game_counters simplecounter, updated when read (as its properties are). */
class LazyCounter {
  count = 0;
  private lastUpdate = 0;
  private readonly times: number;
  private readonly length: number;

  constructor(times: number, length: number) {
    this.times = times;
    this.length = length;
  }

  read(now: number): number {
    if (now - this.lastUpdate > this.times) {
      this.count = (this.count + 1) % this.length;
      this.lastUpdate = now;
    }
    return this.count;
  }
}

/** frames2ms(6) and frames2ms(2) steps over 360 counts. */
const FPS6_360 = new LazyCounter(Math.trunc(16.67 * 6), 360);
const FPS2_360 = new LazyCounter(Math.trunc(16.67 * 2), 360);

/** engine.get_time(): the frame clock in integer milliseconds. */
function engineTime(): number {
  return Math.trunc(performance.now());
}

function blank(w: number, h: number): Surface {
  return new Surface(w, h);
}

/** create_base_surf(width, height, base) (the window skin applies). */
function baseSurf(width: number, height: number, nid: string): Surface {
  return getMenuBackgroundSync(width, height, nid);
}

/** image_mods.make_white: add int(255 * white) to RGB, alpha untouched. */
function makeWhite(src: Surface, white: number): Surface {
  const out = src.copy();
  const add = Math.max(0, Math.min(255, Math.trunc(255 * white)));
  if (add === 0) return out;
  const data = out.getImageData();
  for (let i = 0; i < data.data.length; i += 4) {
    if (data.data[i + 3] === 0) continue;
    data.data[i] = Math.min(255, data.data[i] + add);
    data.data[i + 1] = Math.min(255, data.data[i + 1] + add);
    data.data[i + 2] = Math.min(255, data.data[i + 2] + add);
  }
  out.putImageData(data);
  return out;
}

/** base_surf.create_highlight_surf: equipment_highlight stretched to width. */
function createHighlightSurf(width: number): Surface | null {
  const sprite = getSprite('equipment_highlight');
  if (!sprite) return null;
  const h = sprite.height;
  const surf = new Surface(width, h);
  surf.blitFrom(sprite, 0, 0, 2, h, 0, 0);
  for (let x = 2; x < width - 2; x++) surf.blitFrom(sprite, 3, 0, 1, h, x, 0);
  surf.blitFrom(sprite, sprite.width - 2, 0, 2, h, width - 2, 0);
  return surf;
}

/** engine.transform_scale (nearest neighbour). */
function scaled(src: Surface, w: number, h: number): Surface {
  const out = new Surface(w, h);
  out.ctx.imageSmoothingEnabled = false;
  out.ctx.drawImage(src.canvas, 0, 0, src.width, src.height, 0, 0, w, h);
  return out;
}

function iconSurf(iconNid: string | null | undefined, iconIndex: [number, number] | null | undefined): Surface {
  const surf = blank(16, 16);
  if (iconNid && iconIndex) drawIcon16(surf, iconNid, iconIndex, 0, 0);
  return surf;
}

/** The unit's passive map sprite frame (create_image('passive')). */
function passiveImage(unit: UnitObject): Surface | null {
  const sprite: any = (unit as any).sprite;
  const frames: Surface[] | undefined = sprite?.getStandFrames?.('passive');
  if (!frames?.length) return null;
  return frames[ANIMATION_COUNTERS.passive % frames.length] ?? frames[0];
}

// ---------------------------------------------------------------------------
// Columns (unit_table.get_formatted_stat_pages)
// ---------------------------------------------------------------------------

type SortKey = string | number | (string | number)[];

interface Column {
  width: string;
  statName: string;
  headerAlign: HAlignment;
  headerIcon: Surface | null;
  getStat: (unit: UnitObject) => string;
  getIcon: ((unit: UnitObject) => Surface | null) | null;
  sortBy: (unit: UnitObject) => SortKey;
  getFont: (unit: UnitObject) => string;
}

function column(width: string, statName: string, headerAlign: HAlignment, headerIcon: Surface | null,
  getStat: (unit: UnitObject) => string | number | null, getIcon: ((unit: UnitObject) => Surface | null) | null,
  opts: { sortBy?: (unit: UnitObject) => SortKey; font?: string; getFont?: (unit: UnitObject) => string } = {}): Column {
  const asText = (unit: UnitObject) => {
    const value = getStat(unit);
    return value === null || value === undefined ? 'None' : String(value);
  };
  const font = opts.font ?? 'text-blue';
  return {
    width, statName, headerAlign, headerIcon, getStat: asText, getIcon,
    sortBy: opts.sortBy ?? ((unit) => {
      const value = getStat(unit);
      return typeof value === 'number' ? value : value === null ? '' : String(value);
    }),
    getFont: opts.getFont ?? (() => font),
  };
}

function weaponOf(unit: UnitObject): ItemObject | null {
  return (unit as any).getWeapon?.() ?? unit.equippedWeapon ?? null;
}

function usableWtypes(unit: UnitObject): Set<string> {
  const game = getGame();
  const klass = game.db.classes.get(unit.klass);
  const usable = new Set<string>(Object.entries(klass?.wexp_gain ?? {})
    .filter(([, entry]: [string, any]) => Array.isArray(entry) ? !!entry[0] : !!entry?.usable)
    .map(([nid]) => nid));
  for (const skill of unit.skills ?? []) {
    const granted = skill.getComponent?.<unknown>('wexp_usable_skill');
    if (Array.isArray(granted)) for (const nid of granted) usable.add(String(nid));
  }
  for (const skill of unit.skills ?? []) {
    const banned = skill.getComponent?.<unknown>('wexp_unusable_skill');
    if (Array.isArray(banned)) for (const nid of banned) usable.delete(String(nid));
  }
  return usable;
}

/** weapon_ranks.get_rank_from_wexp / get_next_rank_from_wexp. */
function rankFromWexp(wexp: number): { rank: string } | null {
  const ranks = [...(getGame().db.weaponRanks ?? [])].sort((a: any, b: any) => a.requirement - b.requirement);
  let found: any = null;
  for (const rank of ranks) if (wexp >= rank.requirement) found = rank;
  return found;
}

function nextRankFromWexp(wexp: number): { rank: string } | null {
  const ranks = [...(getGame().db.weaponRanks ?? [])].sort((a: any, b: any) => a.requirement - b.requirement);
  return ranks.find((rank: any) => wexp < rank.requirement) ?? null;
}

function getFormattedStatPages(): [string, Column[]][] {
  const game = getGame();
  const db = game.db;
  const pages: [string, Column[]][] = [];
  pages.push(['Character', [
    column('30%', 'Class', 'left', null, (unit) => db.classes.get(unit.klass)?.name ?? unit.klass, null, { font: 'text' }),
    column('16%', 'Lv', 'right', null, (unit) => unit.level, null, {
      sortBy: (unit) => (unit as any).getInternalLevel?.() ?? unit.level,
    }),
    column('16%', 'Exp', 'right', null, (unit) => unit.exp, null),
    column('16%', 'HP', 'right', null, (unit) => unit.currentHp, null),
    column('16%', 'Max', 'left', null, (unit) => `/${unit.maxHp}`, null),
  ]]);

  const stats = (db.stats ?? []).filter((stat: any) => stat.position !== 'hidden');
  let page: Column[] = [];
  stats.forEach((stat: any, idx: number) => {
    const value = (unit: UnitObject) => (unit as any).getStat?.(stat.nid) ?? unit.stats[stat.nid] ?? 0;
    page.push(column('16%', String(stat.name).slice(0, 5), 'right', null, value, null, {
      getFont: (unit) => value(unit) < unit.getStatCap(stat.nid) ? 'text-blue' : 'text-yellow',
    }));
    if (page.length === 6 || idx === stats.length - 1) {
      pages.push(['Vital Statistics', page]);
      page = [];
    }
  });

  pages.push(['Equipment', [
    column('50%', 'Equip', 'left', blank(16, 16),
      (unit) => weaponOf(unit)?.name ?? null,
      (unit) => {
        const weapon = weaponOf(unit);
        return weapon ? iconSurf((weapon as any).iconNid, (weapon as any).iconIndex) : null;
      },
      {
        sortBy: (unit) => {
          const weapon = weaponOf(unit);
          return [weapon ? weaponType(unit, weapon) ?? '' : '', weapon ? weapon.name : ''];
        },
        font: 'text',
      }),
    column('16%', 'Atk', 'right', null, (unit) => {
      const weapon = weaponOf(unit);
      const value = weapon ? damage(unit, weapon, db, game) : 0;
      return value ? String(value) : '--';
    }, null),
    column('16%', 'Hit', 'right', null, (unit) => {
      const weapon = weaponOf(unit);
      const value = weapon ? accuracy(unit, weapon, db, game) : 0;
      return value ? String(value) : '--';
    }, null),
    column('16%', 'Avoid', 'right', null, (unit) => {
      const value = avoid(unit, db, game.board, null, game, null, 'defense', [0, 0], weaponOf(unit));
      return value ? String(value) : '--';
    }, null),
  ]]);

  const wtypes = (db.weapons ?? []).filter((wtype: any) => wtype.nid !== 'Default');
  page = [];
  wtypes.forEach((wtype: any, idx: number) => {
    const rankOf = (unit: UnitObject) => {
      const wexp = Number(unit.wexp?.[wtype.nid] ?? 0);
      const rank = rankFromWexp(wexp);
      return rank && usableWtypes(unit).has(wtype.nid) ? rank.rank : '-';
    };
    page.push(column('12%', '', 'left', iconSurf(wtype.icon_nid, wtype.icon_index), rankOf, null, {
      getFont: (unit) => {
        const wexp = Number(unit.wexp?.[wtype.nid] ?? 0);
        return !rankFromWexp(wexp) || nextRankFromWexp(wexp) !== null ? 'text-blue' : 'text-yellow';
      },
    }));
    if (page.length === 8 || idx === wtypes.length - 1) {
      pages.push(['Weapon Level', page]);
      page = [];
    }
  });
  return pages;
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// UnitStatisticsTable
// ---------------------------------------------------------------------------

class UnitStatisticsTable extends UIComponent {
  readonly statPages: [string, Column[]][];
  readonly maxPages: number;
  table: HeaderList[] = [];
  page = 0;
  private data: UnitObject[];
  private owner: UnitInformationTable;

  constructor(name: string, parent: UnitInformationTable, data: UnitObject[]) {
    super(name, parent);
    this.owner = parent;
    this.statPages = getFormattedStatPages();
    this.maxPages = this.statPages.length;
    this.size = ['65%', '100%'];
    this.overflow = [0, 0, 0, 0];
    this.maxWidth = '65%';
    this.maxHeight = '100%';
    this.padding = [0, 0, 0, 0];
    this.data = data;
    this.props.layout = 'list';
    this.props.listStyle = 'row';
    this.recreateTable();
    this.width = this.maxWidth * this.maxPages;
  }

  get cursorPos(): [number, number] {
    return this.owner.cursorPos;
  }

  private recreateTable(): void {
    this.children = [];
    for (const [, columns] of this.statPages) {
      let soFar = 0;
      columns.forEach((col, idx) => {
        let rightMargin = 0;
        const colWidth = UIMetric.parse(col.width).toPixels(this.width);
        if (idx !== columns.length - 1) {
          soFar += colWidth;
        } else {
          rightMargin = this.width - colWidth - soFar;
        }
        const header = new IconRow('', null, { text: col.statName, textAlign: col.headerAlign, icon: col.headerIcon });
        const list = new HeaderList(col.statName, this, {
          headerRow: header,
          dataRows: this.getRows(col),
          height: this.height - 4,
          width: colWidth,
          listOverflow: 0,
        });
        list.margin = [0, rightMargin, 0, 0];
        list.overflow = [list.overflow[0], list.overflow[1], 0, 0];
        this.table.push(list);
      });
    }
    for (const col of this.table) this.addChild(col);
  }

  colIndicesForPage(pageNum: number): number[] {
    let soFar = 1;
    for (let p = 0; p < pageNum; p++) soFar += this.statPages[p][1].length;
    return Array.from({ length: this.statPages[pageNum][1].length }, (_, i) => soFar + i);
  }

  numColsTotal(): number {
    return this.table.length;
  }

  private getRows(col: Column): IconRow[] {
    return this.data.map((unit) => new IconRow(unit.name, null, {
      text: col.getStat(unit),
      icon: col.getIcon ? col.getIcon(unit) : null,
      textAlign: col.headerAlign,
      font: col.getFont(unit),
      data: unit,
    }));
  }

  sortRows(order: (row: IconRow) => number): void {
    for (const list of this.table) list.sortRows(order);
  }

  isScrolling(): boolean {
    return this.isAnimating();
  }

  scrollRight(): void {
    if (this.page < this.maxPages) {
      const scroll = this.scroll;
      this.queueAnimation([componentScrollAnim(scroll, [Math.min(scroll[0] + this.width, this.twidth - this.width), scroll[1]], 250)]);
      this.page += 1;
    }
  }

  scrollLeft(): void {
    if (this.page > 0) {
      const scroll = this.scroll;
      this.queueAnimation([componentScrollAnim(scroll, [scroll[0] - this.width, scroll[1]], 250)]);
      this.page -= 1;
    }
  }

  scrollDown(): void {
    for (const list of this.table) list.scrollDown();
  }

  scrollUp(): void {
    for (const list of this.table) list.scrollUp();
  }

  getPageTitle(): string {
    return this.statPages[this.page][0];
  }

  getColumnFormatByIndex(index: number): Column {
    return this.statPages.flatMap(([, cols]) => cols)[index];
  }

  cursorHover(): [string, (unit: UnitObject) => SortKey] | null {
    const [cx, cy] = this.cursorPos;
    if (cy === 0 && cx > 0) {
      const col = this.getColumnFormatByIndex(cx - 1);
      return [col.statName, col.sortBy];
    }
    return null;
  }

  getCursorDrawPositionHorizontal(): number | null {
    const [cx, cy] = this.cursorPos;
    if (cy !== 0 || cx <= 0) return null;
    let left = this.generateChildPositions().get(cx - 1)?.[0] ?? 0;
    const header = this.table[cx - 1].headerRow as IconRow;
    left += header.text.text ? header.getTextTopleft()[0] : 0;
    return left - this.scroll[0];
  }
}

// ---------------------------------------------------------------------------
// UnitInformationTable
// ---------------------------------------------------------------------------

const MENU_BOTTOM_BORDER_THICKNESS = 8;

class UnitInformationTable extends UIComponent {
  data: UnitObject[];
  cursorPos: [number, number] = [0, 0];
  headerRow!: IconRow;
  nameRows: IconRow[] = [];
  leftUnitNameList!: HeaderList;
  rightUnitDataGrid!: UnitStatisticsTable;
  private lscrollArrow: ScrollArrow;
  private rscrollArrow: ScrollArrow;
  private scrollBar = new ScrollBar();
  private scrollBarTopright: [number, number];
  private highlightSurf: Surface | null = null;
  private highlightCycleTime = 30;

  constructor(name: string, parent: UIComponent | null, data: UnitObject[]) {
    super(name, parent);
    this.data = data;
    this.size = [WINWIDTH - 8, WINHEIGHT * 0.75];
    this.overflow = [16, 16, 16, 0];
    this.margin = [0, 0, 0, 3];
    this.padding = [0, 0, 3, 0];
    this.props.vAlignment = 'bottom';
    this.props.hAlignment = 'center';
    this.initializeBackground();
    this.props.layout = 'list';
    this.props.listStyle = 'row';
    this.initializeComponents();
    const ov = this.overflow;
    this.lscrollArrow = new ScrollArrow('left', 0 + ov[0], 3 + ov[2]);
    this.rscrollArrow = new ScrollArrow('right', this.width - 8 + ov[0], 3 + ov[2]);
    this.scrollBarTopright = [this.width - 1 + ov[0], 15 + ov[2]];
  }

  get tableSize(): [number, number] {
    return [this.rightUnitDataGrid.numColsTotal(), this.data.length];
  }

  private initializeComponents(): void {
    this.headerRow = new IconRow('', null, { text: 'Name', icon: blank(...ICON_SIZE) });
    this.nameRows = this.generateNameRows();
    this.leftUnitNameList = new HeaderList('unit_names', this, {
      headerRow: this.headerRow,
      dataRows: this.nameRows,
      height: this.height - MENU_BOTTOM_BORDER_THICKNESS,
      width: '30%',
    });
    this.leftUnitNameList.padding = [3, 0, 0, 0];
    const ov = this.leftUnitNameList.overflow;
    this.leftUnitNameList.overflow = [ov[0], ov[1], ov[2], 0];
    this.rightUnitDataGrid = new UnitStatisticsTable('unit_statistics', this, this.data);
    this.children = [];
    this.addChild(this.leftUnitNameList);
    this.addChild(this.rightUnitDataGrid);
  }

  sortData(data: UnitObject[]): void {
    this.data = data;
    const order = new Map(data.map((unit, i) => [unit.nid, i]));
    const sortFunc = (row: IconRow) => order.get((row.data as UnitObject).nid) ?? 0;
    this.nameRows = [...this.nameRows].sort((a, b) => sortFunc(a) - sortFunc(b));
    this.leftUnitNameList.sortRows(sortFunc);
    this.rightUnitDataGrid.sortRows(sortFunc);
  }

  private initializeBackground(): void {
    const [w, h] = this.size;
    const background = new Surface(w, h);
    const headerThickness = 20;
    const header = makeTranslucent(
      baseSurf(w, headerThickness + MENU_BOTTOM_BORDER_THICKNESS, 'menu_bg_white'), 0.1,
    ).subsurface(0, 0, w, headerThickness);
    const shadow = getSprite('header_shadow');
    if (shadow) header.blit(scaled(makeTranslucent(shadow, 0.7), w - 8, shadow.height), 0, 10);
    const body = makeTranslucent(baseSurf(w, h, 'menu_bg_base'), 0.1).subsurface(0, headerThickness, w, h - headerThickness);
    background.blit(header, 0, 0);
    background.blit(body, 0, headerThickness);
    this.setBackground(background);
  }

  private generateNameRows(): IconRow[] {
    return this.data.map((unit) => {
      const icon = new UIComponent();
      icon.size = ICON_SIZE;
      icon.overflow = [12, 0, 12, 0];
      const image = passiveImage(unit);
      if (image) icon.addSurf(image, [-24, -24]);
      const row = new IconRow(unit.nid, null, { text: unit.name, icon, data: unit });
      row.overflow = [12, 0, 12, 0];
      return row;
    });
  }

  scrollDown(): void {
    if (this.cursorPos[1] >= this.nameRows.length - 1) return;
    this.leftUnitNameList.scrollDown();
    this.rightUnitDataGrid.scrollDown();
  }

  scrollUp(): void {
    if (this.cursorPos[1] <= 1) return;
    this.leftUnitNameList.scrollUp();
    this.rightUnitDataGrid.scrollUp();
  }

  scrollRight(): void {
    if (this.cursorPos[0] === this.rightUnitDataGrid.numColsTotal()) return;
    this.rightUnitDataGrid.scrollRight();
  }

  scrollLeft(): void {
    if (this.cursorPos[0] === 0 && this.getPageNum() === 0) return;
    this.rightUnitDataGrid.scrollLeft();
  }

  getPageNum(): number {
    return this.rightUnitDataGrid.page;
  }

  getNumPages(): number {
    return this.rightUnitDataGrid.maxPages;
  }

  getPageTitle(): string {
    return this.rightUnitDataGrid.getPageTitle();
  }

  private updateUnitIcons(): void {
    const scrolled = this.leftUnitNameList.scrolledIndex;
    this.nameRows.forEach((row, idx) => {
      if (row.enabled && row.onScreen && idx > scrolled - 1) {
        const image = passiveImage(this.data[idx]);
        row.icon.clearSurfs();
        if (image) row.icon.addSurf(image, [-24, -24]);
      }
    });
  }

  private updateHighlight(): void {
    const [cx, cy] = this.cursorPos;
    const now = engineTime();
    this.clearSurfs();
    if (cx < 0 || cy < 0) return;
    const cursor = getSprite('menu_hand');
    if (cy > 0) {
      this.highlightSurf ??= createHighlightSurf(this.width - 8);
      if (!this.highlightSurf) return;
      const cycle = this.highlightCycleTime;
      const flicker = Math.abs((FPS2_360.read(now) % cycle) - cycle / 2) / (cycle * 1.25);
      const colored = makeWhite(this.highlightSurf, flicker);
      const rowHeight = this.leftUnitNameList.rowHeight;
      const pos: [number, number] = [4, (0.75 + cy - this.leftUnitNameList.scrolledIndex) * rowHeight];
      this.addSurf(colored, pos, -1);
    } else if (cx === 0 && cy === 0) {
      if (!cursor) return;
      const perturbation = CURSOR_PERTURBATION[FPS6_360.read(now) % 8];
      this.addSurf(cursor, [1 + perturbation, this.padding[2] + 2], 1);
    } else if (cy === 0) {
      if (!cursor) return;
      const perturbation = CURSOR_PERTURBATION[FPS6_360.read(now) % 8];
      const cursorX = this.rightUnitDataGrid.getCursorDrawPositionHorizontal() ?? 0;
      this.addSurf(cursor, [cursorX + this.leftUnitNameList.width + perturbation - cursor.width, this.padding[2] + 2], 1);
    }
  }

  moveCursor(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'): boolean {
    let next: [number, number] = [this.cursorPos[0], this.cursorPos[1]];
    const [cx, cy] = this.cursorPos;
    const grid = this.rightUnitDataGrid;
    const tableCols = grid.colIndicesForPage(grid.page);
    if (direction === 'UP') {
      if (cy <= this.leftUnitNameList.scrolledIndex + 2) {
        if (this.leftUnitNameList.isScrolling()) return false;
        this.scrollUp();
      }
      next = [cx, cy - 1];
    } else if (direction === 'DOWN') {
      if (cy >= this.leftUnitNameList.scrolledIndex + 5) {
        if (this.leftUnitNameList.isScrolling()) return false;
        this.scrollDown();
      }
      next = [cx, cy + 1];
    } else if (direction === 'LEFT') {
      this.lscrollArrow.pulse();
      if (cx === 0 || cy > 0) {
        if (grid.page === 0) return false;
        if (grid.isScrolling()) return false;
        this.scrollLeft();
        next = cy > 0 ? [0, cy] : [tableCols[0] - 1, cy];
      } else if (cx > 0 && cy === 0) {
        next = cx === tableCols[0] ? [0, 0] : [cx - 1, cy];
      }
    } else {
      this.rscrollArrow.pulse();
      if (cx === tableCols[tableCols.length - 1] || cy > 0) {
        if (grid.page === grid.maxPages - 1) return false;
        if (grid.isScrolling()) return false;
        this.scrollRight();
        next = [0, cy];
      } else if (cy === 0) {
        next = cx === 0 ? [tableCols[0], cy] : [cx + 1, cy];
      }
    }
    const [maxX, maxY] = this.tableSize;
    const clamped: [number, number] = [Math.max(0, Math.min(maxX, next[0])), Math.max(0, Math.min(maxY, next[1]))];
    this.cursorPos = clamped;
    return clamped[0] === next[0] && clamped[1] === next[1];
  }

  cursorHover(): UnitObject | [string, (unit: UnitObject) => SortKey] | null {
    const [cx, cy] = this.cursorPos;
    if (cy > 0) return this.data[cy - 1];
    if (cx === 0 && cy === 0) return [this.headerRow.text.text, (unit: UnitObject) => unit.name];
    if (cy === 0 && cx > 0) return this.rightUnitDataGrid.cursorHover();
    return null;
  }

  override shouldRedraw(): boolean {
    return true;
  }

  override toSurf(noCull = false): Surface {
    this.updateUnitIcons();
    this.updateHighlight();
    const surf = super.toSurf(noCull);
    this.lscrollArrow.draw(surf);
    this.rscrollArrow.draw(surf);
    if (this.data.length > 6) {
      this.scrollBar.draw(surf, this.scrollBarTopright[0], this.scrollBarTopright[1],
        this.leftUnitNameList.scrolledIndex, 6, this.data.length);
    }
    return surf;
  }
}

// ---------------------------------------------------------------------------
// UnitMenuUI
// ---------------------------------------------------------------------------

const SORT_ARROW_WIGGLE = [6, 7, 6, 5];

class UnitMenuUI {
  sortBy = 'Name';
  sortAscending = false;
  private sortArrowWiggleIndex = 0;
  private data: UnitObject[];
  private unitInfoBox: UIComponent;
  private pageTitle: PlainTextLine;
  private sortBox: UIComponent;
  private sortByText: PlainTextLine;
  private ascSortArrow: UIComponent;
  private descSortArrow: UIComponent;
  private pageNumberText: PlainTextLine;
  readonly table: UnitInformationTable;
  private base: UIComponent;

  constructor(data: UnitObject[]) {
    this.data = data;
    const locationBox = getSprite('world_map_location_box') ?? blank(104, 28);
    this.unitInfoBox = new UIComponent('page type box');
    this.unitInfoBox.setBackground(locationBox);
    this.unitInfoBox.size = [locationBox.width, locationBox.height];
    this.unitInfoBox.props.vAlignment = 'top';
    this.unitInfoBox.props.hAlignment = 'left';
    this.unitInfoBox.margin = [0, 0, 0, 0];

    this.pageTitle = new PlainTextLine('page type text', this.unitInfoBox, '');
    this.pageTitle.props.hAlignment = 'center';
    this.pageTitle.props.vAlignment = 'center';
    // Python sets props.font = FONT['chapter-grey'], but TextProperties reads
    // `font` from font_name ('text'), so the title (and the page number's
    // 'text-blue') draw in the plain 'text' font.
    this.pageTitle.setText('Character');
    this.unitInfoBox.addChild(this.pageTitle);

    this.sortBox = new UIComponent('sort box');
    this.sortBox.setBackground(makeTranslucent(baseSurf(72, 24, 'menu_bg_base'), 0.15));
    this.sortBox.size = [72, 24];
    this.sortBox.props.vAlignment = 'top';
    this.sortBox.props.hAlignment = 'right';
    this.sortBox.margin = [0, 4, 5, 0];

    this.sortByText = new PlainTextLine('sort by', this.sortBox, '');
    this.sortByText.props.hAlignment = 'left';
    this.sortByText.props.vAlignment = 'center';
    this.sortByText.props.fontName = 'text';
    this.sortByText.margin = [3, 0, 0, 0];
    this.sortByText.padding = [0, 0, 0, 2];
    this.sortByText.setText('Sort: ');
    this.sortBox.addChild(this.sortByText);

    const arrow = getSprite('sort_arrow') ?? blank(8, 8);
    this.ascSortArrow = UIComponent.fromExistingSurf(arrow);
    this.ascSortArrow.props.hAlignment = 'right';
    this.ascSortArrow.margin = [0, 2, 5, 0];
    this.sortBox.addChild(this.ascSortArrow);
    this.ascSortArrow.disable();
    this.descSortArrow = UIComponent.fromExistingSurf(arrow.flipV());
    this.descSortArrow.props.hAlignment = 'right';
    this.descSortArrow.margin = [0, 2, 5, 0];
    this.sortBox.addChild(this.descSortArrow);

    this.pageNumberText = new PlainTextLine('page_num', null, '0 / 0');
    this.pageNumberText.props.hAlignment = 'right';
    const bottomOfSortBox = this.sortBox.margin[2] + this.sortBox.height;
    this.pageNumberText.margin = [0, 5, bottomOfSortBox - 5, 0];

    this.table = new UnitInformationTable('unit_box', null, this.data);

    this.base = UIComponent.createBaseComponent();
    this.base.name = 'base';
    this.base.addChild(this.unitInfoBox);
    this.base.addChild(this.sortBox);
    this.base.addChild(this.table);
    this.base.addChild(this.pageNumberText);
  }

  private updateSortBox(): void {
    const text = `Sort: ${this.sortBy}`;
    if (this.sortByText.text !== text) this.sortByText.setText(text);
    let arrow: UIComponent;
    if (this.sortAscending) {
      this.descSortArrow.disable();
      this.ascSortArrow.enable();
      arrow = this.ascSortArrow;
    } else {
      this.ascSortArrow.disable();
      this.descSortArrow.enable();
      arrow = this.descSortArrow;
    }
    arrow.margin = [0, 2, SORT_ARROW_WIGGLE[Math.floor(this.sortArrowWiggleIndex / 8) % SORT_ARROW_WIGGLE.length], 0];
    this.sortArrowWiggleIndex += 1;
  }

  cursorHover(): UnitObject | [string, (unit: UnitObject) => SortKey] | null {
    return this.table.cursorHover();
  }

  moveCursor(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'): boolean {
    return this.table.moveCursor(direction);
  }

  sortData(sortBy: [string, (unit: UnitObject) => SortKey]): void {
    if (this.sortBy === sortBy[0]) this.sortAscending = !this.sortAscending;
    const reverse = this.sortAscending;
    this.sortBy = sortBy[0];
    // Python sorted(): stable; reverse keeps equal keys in their order.
    const keyed = this.data.map((unit, index) => ({ unit, key: sortBy[1](unit), index }));
    keyed.sort((a, b) => {
      const c = compareKeys(a.key, b.key);
      return (reverse ? -c : c) || a.index - b.index;
    });
    this.data = keyed.map((entry) => entry.unit);
    this.table.sortData(this.data);
  }

  private lastDrawFrame = -1;
  private lastDraw: Surface | null = null;

  draw(surf: Surface): Surface {
    // Python draws a state once per frame; the web may draw again on a
    // 'repeat' in the same frame, which must not advance the animations.
    const frame = getFrameCount();
    if (frame === this.lastDrawFrame && this.lastDraw) {
      surf.blit(this.lastDraw, 0, 0);
      return surf;
    }
    this.lastDrawFrame = frame;
    this.updateSortBox();
    const title = this.table.getPageTitle();
    if (this.pageTitle.text !== title) this.pageTitle.setText(title);
    const pageNum = `${this.table.getPageNum() + 1} / ${this.table.getNumPages()}`;
    if (this.pageNumberText.text !== pageNum) this.pageNumberText.setText(pageNum);
    this.lastDraw = this.base.toSurf();
    surf.blit(this.lastDraw, 0, 0);
    return surf;
  }
}

// ---------------------------------------------------------------------------
// UnitMenuState
// ---------------------------------------------------------------------------

export class UnitMenuState extends State {
  readonly name = 'unit_menu';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  /** Python in_level: a level is loaded (deployed units), else party units. */
  private levelLoaded = false;
  ui: UnitMenuUI | null = null;
  private units: UnitObject[] = [];
  private assetsReady = false;

  override start(): StateResult {
    const game = getGame();
    this.bg = new MenuBackground('settings_background', game.resources);
    this.levelLoaded = !!game.currentLevel;
    let units: UnitObject[];
    if (this.levelLoaded) {
      // game.get_player_units_and_travelers()
      const onMap = (game.getAllUnits() as UnitObject[])
        .filter((unit) => unit.team === 'player' && !!unit.position && !unit.isDead());
      const travelers = onMap
        .map((unit) => (unit as any).traveler ? game.getUnit((unit as any).traveler) : null)
        .filter((unit: UnitObject | null): unit is UnitObject => !!unit && unit.team === 'player');
      units = [...onMap, ...travelers];
    } else {
      units = [];
      for (const partyNid of game.parties?.keys?.() ?? []) units.push(...(game.getUnitsInParty?.(partyNid) ?? []));
    }
    this.units = units;
    this.assetsReady = false;
    this.ui = new UnitMenuUI(units);
    if (!unitMenuAssetsLoaded(units)) void preloadUnitMenuAssets(units).then(() => { this.assetsReady = true; });
    game.state.change('transition_in');
    return 'repeat';
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const ui = this.ui;
    if (!ui) return;
    if (event === 'DOWN' || event === 'UP' || event === 'LEFT' || event === 'RIGHT') {
      if (ui.moveCursor(event)) game.audioManager?.playSfx?.('Select 6');
    }
    if (event === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      if (!game.roamInfo?.roam) {
        const selected = ui.cursorHover();
        if (selected && !Array.isArray(selected) && this.levelLoaded) this.focusUnit(selected);
      }
      game.state.change('transition_pop');
    } else if (event === 'SELECT') {
      game.audioManager?.playSfx?.('Select 2');
      const selected = ui.cursorHover();
      if (selected && !Array.isArray(selected)) {
        if (this.levelLoaded) {
          this.focusUnit(selected);
          game.state.back();
          game.state.back();
        }
      } else if (Array.isArray(selected)) {
        ui.sortData(selected);
      }
    }
  }

  /** cursor.set_pos at the unit, or its rescuer. */
  private focusUnit(unit: UnitObject): void {
    const game = getGame();
    let pos = unit.position;
    if (!pos) {
      const rescuer = (game.getAllUnits() as UnitObject[]).find((u) => (u as any).traveler === unit.nid);
      pos = rescuer?.position ?? null;
    }
    if (pos) {
      game.cursor.setPos(pos[0], pos[1]);
      game.camera?.trackTile?.(pos[0], pos[1]);
    }
  }

  override update(): StateResult {
    this.bg?.update();
    if (this.assetsReady) {
      // Rebuilt once with the loaded windows and sprites.
      this.assetsReady = false;
      this.ui = new UnitMenuUI(this.units);
    }
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const scene = this.scene.begin();
    this.ui?.draw(scene);
    this.scene.present(surf);
    return surf;
  }
}
