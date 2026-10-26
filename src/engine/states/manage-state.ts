/**
 * manage-state.ts — Unit management screens (lt-maker/app/engine/prep.py).
 *
 * ManageState              base_manage          PrepManageState / base_manage
 * ManageSelectState        prep_manage_select   PrepManageSelectState
 * TradeSelectState         prep_trade_select    PrepTradeSelectState
 * RestockState             prep_restock         PrepRestockState
 * OptimizeAllChoiceState   optimize_all_choice  OptimizeAllChoiceState
 *
 * Also the convoy_funcs helpers (restock, optimize, optimize_all) they use.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import { StoreItemAction, TakeItemFromConvoy, TradeAction } from '../action';
import { available as itemAvailable, inventoryFull } from '../../combat/item-system';
import { noTrade } from '../../combat/skill-system';
import { canUseBaseItem } from './game-states';
import {
  Choice,
  CustomAlert,
  ScrollingBackground,
  Table,
  TradeMenu,
  baseSurf,
  checkTrade,
  blitTranslucent,
  drawFunds,
  drawQuickDisp,
  drawText,
  drawUnitItems,
  isFirstPush,
  preloadPrepSprites,
  screenOrigin,
  textWidth,
  type ChoiceEntry,
} from '../../ui/prep-ui';

let _game: any = null;
export function setManageGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for manage states');
  return _game;
}
function sfx(name: string): void {
  getGame().audioManager?.playSfx?.(name);
}

// ============================================================================
// convoy_funcs
// ============================================================================

function convoyOf(game: any): ItemObject[] {
  return game.getParty?.()?.convoy ?? [];
}

/** Python item_system.storeable / tradeable: only Locked blocks them. */
export function storeableItems(unit: UnitObject): ItemObject[] {
  return unit.items.filter((item) => !item.hasComponent('locked'));
}
export const tradeableItems = storeableItems;

/** Python convoy_funcs.can_restock. */
export function canRestock(game: any, item: ItemObject | null): boolean {
  if (!item || !(item.maxUses > 0) || item.uses >= item.maxUses) return false;
  return convoyOf(game).some((other) => other !== item && other.nid === item.nid);
}

/** Python convoy_funcs.restock (mutates uses directly, as Python does). */
export function restock(game: any, item: ItemObject): void {
  if (!canRestock(game, item)) return;
  const convoy = convoyOf(game);
  const others = convoy.filter((i) => i.nid === item.nid && i !== item).sort((a, b) => a.uses - b.uses);
  for (const other of others) {
    const needed = item.maxUses - item.uses;
    if (needed <= 0) break;
    if (other.uses >= needed) {
      other.setUses(other.uses - needed);
      item.setUses(item.uses + needed);
      if (other.uses <= 0) convoy.splice(convoy.indexOf(other), 1);
    } else {
      item.setUses(item.uses + other.uses);
      other.setUses(0);
      convoy.splice(convoy.indexOf(other), 1);
    }
  }
}

function restockConvoy(game: any): void {
  const items = convoyOf(game).filter((i) => canRestock(game, i)).sort((a, b) => b.uses - a.uses);
  for (const item of [...items]) if (item.uses > 0) restock(game, item);
}

function isWeaponItem(item: ItemObject): boolean { return item.isWeapon(); }
function isSpellItem(item: ItemObject): boolean { return item.isSpell(); }
function healValue(item: ItemObject): number | null {
  const heal = item.components?.get?.('heal');
  return heal === undefined || heal === null ? null : Number(heal) || 0;
}
function rankKey(item: ItemObject): [string, number] {
  return [item.getWeaponRank() ?? '', 1000 - (item.uses ?? 0)];
}
function byRank(a: ItemObject, b: ItemObject): number {
  const [ra, ua] = rankKey(a);
  const [rb, ub] = rankKey(b);
  return ra < rb ? -1 : ra > rb ? 1 : ua - ub;
}
function canWield(game: any, unit: UnitObject, item: ItemObject): boolean {
  try { return itemAvailable(unit, item, game.db, game); } catch { return false; }
}
function store(game: any, unit: UnitObject, item: ItemObject): void {
  game.actionLog.doAction(new StoreItemAction(unit, item));
}
function take(game: any, unit: UnitObject, item: ItemObject): void {
  game.actionLog.doAction(new TakeItemFromConvoy(unit, item));
}

/** Python convoy_funcs.optimize. */
export function optimize(game: any, unit: UnitObject): void {
  for (const item of storeableItems(unit)) store(game, unit, item);
  const convoy = () => convoyOf(game);
  const weapons = convoy().filter((i) => isWeaponItem(i) && canWield(game, unit, i)).sort(byRank);
  const spells = convoy().filter((i) => isSpellItem(i) && canWield(game, unit, i)).sort(byRank);
  let numWeapons = 2;
  const has = (nid: string) => unit.items.some((i) => i.nid === nid);
  if (spells.length) {
    for (let n = 0; n < 2; n++) {
      const spell = spells.find((s) => convoy().includes(s) && !inventoryFull(unit, s, game.db) && !has(s.nid));
      if (spell) take(game, unit, spell);
    }
  } else {
    numWeapons = 4;
  }
  for (let n = 0; n < numWeapons; n++) {
    const weapon = weapons.find((w) => convoy().includes(w) && !inventoryFull(unit, w, game.db) && !has(w.nid));
    if (weapon) take(game, unit, weapon);
  }
  const healing = convoy().filter((i) => healValue(i) !== null)
    .sort((a, b) => (healValue(a)! - healValue(b)!) || ((1000 - a.uses) - (1000 - b.uses)));
  for (const item of [...healing].reverse()) {
    if (!inventoryFull(unit, item, game.db) && !has(item.nid)) {
      take(game, unit, item);
      break;
    }
  }
}

/** Python convoy_funcs.optimize_all. */
export function optimizeAll(game: any, party: UnitObject[]): void {
  for (const unit of party) for (const item of storeableItems(unit)) store(game, unit, item);
  restockConvoy(game);
  const units = party.filter((u) => u.position || [...game.units.values()].some((o: any) => o.traveler === u.nid));
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [units[i], units[j]] = [units[j], units[i]];
  }
  const distribute = (items: ItemObject[]) => {
    for (const item of items) {
      const candidates = units
        .filter((u) => !inventoryFull(u, item, game.db) && canWield(game, u, item) && !u.items.some((i) => i.nid === item.nid))
        .sort((a, b) => b.items.length - a.items.length);
      const unit = candidates.pop();
      if (unit) take(game, unit, item);
    }
  };
  distribute(convoyOf(game).filter(isWeaponItem).sort(byRank));
  distribute(convoyOf(game).filter(isSpellItem).sort(byRank));
  const healing = convoyOf(game).filter((i) => healValue(i) !== null)
    .sort((a, b) => (healValue(a)! - healValue(b)!) || (b.uses - a.uses));
  for (const item of [...healing].reverse()) {
    const candidates = units
      .filter((u) => !inventoryFull(u, item, game.db) && !u.items.some((i) => healValue(i) !== null))
      .sort((a, b) => (a.getStatValue?.('HP') ?? 0) - (b.getStatValue?.('HP') ?? 0));
    const unit = candidates.pop();
    if (unit) take(game, unit, item);
  }
}

// ============================================================================
// Shared helpers
// ============================================================================

function partyUnits(game: any): UnitObject[] {
  const units: UnitObject[] = typeof game.getUnitsInParty === 'function'
    ? game.getUnitsInParty()
    : [...game.units.values()].filter((u: UnitObject) => u.team === 'player' && !u.dead);
  const order: string[] = game.parties?.get?.(game.currentParty)?.partyPrepManageSortOrder ?? [];
  const rank = (u: UnitObject) => { const i = order.indexOf(u.nid); return i < 0 ? 999999 : i; };
  return [...units].sort((a, b) => rank(a) - rank(b));
}

/** True when management was opened from preparations (Python prep_manage). */
function inPrep(game: any): boolean {
  const names: string[] = game.state.stack.map((s: State) => s.name);
  const prepIdx = names.lastIndexOf('prep_main');
  const baseIdx = names.lastIndexOf('base_main');
  return prepIdx >= 0 && prepIdx > baseIdx;
}

/** Python menus.Inventory option list: items, empty slots, accessories, empty slots. */
export function inventoryEntries(game: any, unit: UnitObject): ChoiceEntry[] {
  const numItems = Number(game.db?.getConstant?.('num_items', 5) ?? 5);
  const numAccessories = Number(game.db?.getConstant?.('num_accessories', 0) ?? 0);
  const items = unit.items.filter((i) => !i.isAccessory());
  const accessories = unit.items.filter((i) => i.isAccessory());
  const entries: ChoiceEntry[] = items.map((item) => ({ kind: 'item', item }));
  for (let n = items.length; n < numItems; n++) entries.push({ kind: 'empty' });
  for (const item of accessories) entries.push({ kind: 'item', item });
  for (let n = accessories.length; n < numAccessories; n++) entries.push({ kind: 'empty' });
  return entries;
}

function mouse(game: any): { moved: boolean; click: string | null; pos: [number, number] } {
  const input = game.input;
  return {
    moved: !!input?.mouseMoved,
    click: input?.mouseClick ?? null,
    pos: input?.getGameMousePos ? input.getGameMousePos() : [0, 0],
  };
}

/** Directional input for a Table; returns true if a move happened. */
function moveTable(game: any, menu: Table, event: InputEvent, sound: string): boolean {
  let moved = false;
  if (event === 'DOWN') moved = menu.moveDown(isFirstPush(game, 'DOWN'));
  else if (event === 'UP') moved = menu.moveUp(isFirstPush(game, 'UP'));
  else if (event === 'LEFT') moved = menu.moveLeft(isFirstPush(game, 'LEFT'));
  else if (event === 'RIGHT') moved = menu.moveRight(isFirstPush(game, 'RIGHT'));
  if (moved) sfx(sound);
  return moved;
}

/** Translate mouse hover/click on a menu into the Python handle_mouse flow. */
function mouseEvent(game: any, menu: { handleMouse(x: number, y: number, ox: number, oy: number): number }, event: InputEvent): InputEvent {
  const [ox, oy] = screenOrigin();
  const m = mouse(game);
  if (m.moved) menu.handleMouse(m.pos[0], m.pos[1], ox, oy);
  if (m.click === 'SELECT' && menu.handleMouse(m.pos[0], m.pos[1], ox, oy) >= 0) return 'SELECT';
  if (m.click === 'BACK') return 'BACK';
  return event;
}

function openInfo(game: any, unit: UnitObject | null): void {
  if (!unit) return;
  sfx('Select 1');
  game.memory.set('scroll_units', partyUnits(game));
  game.memory.set('current_unit', unit);
  game.infoMenuUnit = unit;
  game.state.change('info_menu');
}

type Background = { draw(surf: Surface): void };

// ============================================================================
// ManageState — Python PrepManageState (prep_manage / base_manage)
// ============================================================================

export class ManageState extends State {
  readonly name = 'base_manage';
  override readonly showMap = false;
  override readonly inLevel = false;

  units: UnitObject[] = [];
  menu: Table | null = null;
  bg: Background | null = null;
  private alert: CustomAlert | null = null;

  override start(): StateResult {
    const game = getGame();
    preloadPrepSprites();
    const party = partyUnits(game);
    this.units = [...party.filter((u) => !!u.position), ...party.filter((u) => !u.position)];
    this.menu = new Table(game, this.units.map((unit) => ({ kind: 'unit' as const, unit })), [4, 3], [6, 0]);
    const prep = inPrep(game);
    this.menu.setMode(prep ? 'prep_manage' : 'unit');
    const baseBg = game.memory.get('base_bg');
    if (!prep && baseBg) {
      this.bg = typeof baseBg === 'string' ? new ScrollingBackground(game, baseBg) : baseBg;
    } else {
      this.bg = new ScrollingBackground(game, 'rune_background');
    }
    game.memory.set('prep_bg', this.bg);
    game.memory.set('manage_menu', this.menu);
  }

  override begin(): StateResult {
    const game = getGame();
    // Units can leave (or join) the party through events triggered from
    // sub-screens; keep the table in sync without losing the cursor.
    const unit = game.memory.get('current_unit');
    if (unit && this.menu) {
      const idx = this.units.indexOf(unit);
      if (idx >= 0) this.menu.moveTo(idx);
    }
    game.memory.set('current_unit', null);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    if (!menu) return;
    if (this.alert) { this.alert.takeInput(event); return; }
    event = mouseEvent(game, menu, event);
    moveTable(game, menu, event, 'Select 5');

    if (event === 'SELECT') {
      const unit = menu.getCurrentUnit();
      if (!unit) return;
      game.memory.set('current_unit', unit);
      game.state.change('prep_manage_select');
      sfx('Select 1');
    } else if (event === 'BACK') {
      game.state.back();
      sfx('Select 4');
    } else if (event === 'INFO') {
      openInfo(game, menu.getCurrentUnit());
    } else if (event === 'START') {
      sfx('Select 1');
      if (game.gameVars.get('_convoy')) game.state.change('optimize_all_choice');
      else this.alert = new CustomAlert('Convoy not available');
    }
  }

  override update(): StateResult {
    this.menu?.update();
    if (this.alert) {
      this.alert.update();
      if (this.alert.done) this.alert = null;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const [ox, oy] = screenOrigin();
    this.bg?.draw(surf);
    this.menu?.draw(surf, ox, oy);
    drawUnitItems(surf, game, ox + 6, oy + 72, this.menu?.getCurrentUnit() ?? null, { includeFace: true, shimmer: 2 });
    drawQuickDisp(surf, ox + 120 + 10, oy + 80 + 9);
    drawFunds(surf, game, ox, oy);
    this.alert?.draw(surf);
    return surf;
  }
}

// ============================================================================
// ManageSelectState — Python PrepManageSelectState
// ============================================================================

export class ManageSelectState extends State {
  readonly name = 'prep_manage_select';
  override readonly showMap = false;
  override readonly inLevel = false;

  unit: UnitObject | null = null;
  selectMenu: Table | null = null;
  private menu: Table | null = null;
  private bg: Background | null = null;
  private currentIndex = 0;

  override start(): StateResult {
    const game = getGame();
    this.bg = game.memory.get('prep_bg') ?? null;
    this.menu = game.memory.get('manage_menu') ?? null;
    this.unit = game.memory.get('current_unit') ?? null;
    this.currentIndex = this.menu?.currentIndex ?? 0;
    const options = ['Trade', 'Restock', 'Give all', 'Optimize', 'Use', 'Market'];
    if (game.db?.getConstant?.('repair_shop', false)) options[3] = 'Repair';
    if (game.gameVars.get('_convoy')) options[4] = 'Items';
    this.selectMenu = new Table(game, options.map((text) => ({ kind: 'text' as const, text })), [3, 2], [120, 80]);
    this.selectMenu.setIgnore(this.getIgnore());
  }

  /** Python PrepManageSelectState.get_ignore. */
  getIgnore(): boolean[] {
    const game = getGame();
    const unit = this.unit;
    if (!unit) return [true, true, true, true, true, true];
    let ignore = [false, true, true, true, true, true];
    if (game.gameVars.get('_convoy')) {
      ignore = [false, true, true, false, false, true];
      const tradeable = tradeableItems(unit);
      if (tradeable.length) ignore[2] = false;
      if (tradeable.some((item) => canRestock(game, item))) ignore[1] = false;
    } else if (unit.items.some((item) => canUseBaseItem(unit, item, game))) {
      ignore[4] = false;
    }
    const marketVar = inPrep(game) ? '_prep_market' : '_base_market';
    const market: Map<string, number> | undefined = game.marketItems;
    if (game.gameVars.get(marketVar) && market && market.size > 0) ignore[5] = false;
    if (game.db?.getConstant?.('repair_shop', false)) {
      ignore[3] = !(game.gameVars.get('_repair_shop') ?? true) ||
        !unit.items.some((i) => i.maxUses > 0 && i.uses < i.maxUses && !i.hasComponent('unrepairable'));
    }
    if (noTrade(unit, game)) ignore[0] = true;
    return ignore;
  }

  override begin(): StateResult {
    const game = getGame();
    if (!this.unit || !this.selectMenu) { game.state.back(); return; }
    const current = this.selectMenu.currentIndex;
    this.selectMenu.setIgnore(this.getIgnore());
    if (!this.selectMenu.options[current]?.ignore) this.selectMenu.currentIndex = current;
    this.menu?.moveTo(this.currentIndex);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const select = this.selectMenu;
    const unit = this.unit;
    if (!select || !unit) return;
    event = mouseEvent(game, select, event);
    moveTable(game, select, event, 'Select 6');

    if (event === 'SELECT') {
      sfx('Select 1');
      const choice = select.getCurrentText();
      if (choice === 'Trade') {
        game.state.change('prep_trade_select');
      } else if (choice === 'Give all') {
        for (const item of tradeableItems(unit)) store(game, unit, item);
        select.setIgnore(this.getIgnore());
      } else if (choice === 'Items') {
        game.memory.set('supply_unit', unit);
        game.memory.set('include_other_units', true);
        game.state.change('supply_items');
      } else if (choice === 'Restock') {
        game.state.change('prep_restock');
      } else if (choice === 'Optimize') {
        optimize(game, unit);
        select.setIgnore(this.getIgnore());
        select.moveTo(3);
      } else if (choice === 'Market') {
        game.state.change('prep_market');
      } else if (choice === 'Repair') {
        game.state.change('repair_shop');
      } else if (choice === 'Use') {
        game.selectedUnit = unit;
        game.memory.set('base_use_unit', unit);
        game.state.change('base_use');
      }
    } else if (event === 'BACK') {
      sfx('Select 4');
      game.state.back();
    }
  }

  override update(): StateResult {
    this.menu?.update();
    this.selectMenu?.update();
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const [ox, oy] = screenOrigin();
    this.bg?.draw(surf);
    this.menu?.draw(surf, ox, oy);
    drawUnitItems(surf, game, ox + 6, oy + 72, this.unit, { includeFace: true, includeTop: true, shimmer: 2 });
    this.selectMenu?.draw(surf, ox, oy);
    drawFunds(surf, game, ox, oy);
    return surf;
  }
}

// ============================================================================
// TradeSelectState — Python PrepTradeSelectState
// ============================================================================

export class TradeSelectState extends State {
  readonly name = 'prep_trade_select';
  override readonly showMap = false;
  override readonly inLevel = false;

  private menu: Table | null = null;
  private bg: Background | null = null;
  unit: UnitObject | null = null;

  override start(): StateResult {
    const game = getGame();
    this.menu = game.memory.get('manage_menu') ?? null;
    this.bg = game.memory.get('prep_bg') ?? null;
    this.unit = game.memory.get('current_unit') ?? null;
    if (this.menu) this.menu.fakeCursorIdx = this.menu.currentIndex;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    if (!menu || !this.unit) return;
    event = mouseEvent(game, menu, event);
    moveTable(game, menu, event, 'Select 5');

    if (event === 'SELECT') {
      const partner = menu.getCurrentUnit();
      if (!partner || noTrade(partner, game)) {
        sfx('Error');
      } else {
        game.memory.set('unit1', this.unit);
        game.memory.set('unit2', partner);
        game.state.change('prep_trade');
      }
    } else if (event === 'BACK') {
      sfx('Select 4');
      game.state.back();
    } else if (event === 'INFO') {
      openInfo(game, menu.getCurrentUnit());
    }
  }

  override update(): StateResult {
    this.menu?.update();
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const [ox, oy] = screenOrigin();
    this.bg?.draw(surf);
    drawUnitItems(surf, game, ox + 6, oy + 72, this.unit, { includeFace: true, shimmer: 2 });
    drawUnitItems(surf, game, ox + 126, oy + 72, this.menu?.getCurrentUnit() ?? null, { includeFace: true, right: false, shimmer: 2 });
    this.menu?.draw(surf, ox, oy);
    return surf;
  }

  override finish(): void {
    if (this.menu) this.menu.fakeCursorIdx = null;
  }
}

// ============================================================================
// RestockState — Python PrepRestockState
// ============================================================================

export class RestockState extends State {
  readonly name = 'prep_restock';
  override readonly showMap = false;
  override readonly inLevel = false;

  private unit: UnitObject | null = null;
  private unitMenu: Table | null = null;
  private bg: Background | null = null;
  menu: Choice | null = null;

  override start(): StateResult {
    const game = getGame();
    this.bg = game.memory.get('prep_bg') ?? null;
    this.unit = game.memory.get('current_unit') ?? null;
    this.unitMenu = game.memory.get('manage_menu') ?? null;
    if (!this.unit) return;
    this.menu = new Choice(game, inventoryEntries(game, this.unit), [6, 72]);
    this.menu.setIgnore(this.ignore());
  }

  private ignore(): boolean[] {
    const game = getGame();
    return this.menu!.options.map((o) => o.entry.kind !== 'item' || !canRestock(game, o.entry.item));
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    if (!menu || !this.unit) { game.state.back(); return; }
    event = mouseEvent(game, menu, event);
    if (event === 'DOWN') { sfx('Select 5'); menu.moveDown(isFirstPush(game, 'DOWN')); }
    else if (event === 'UP') { sfx('Select 5'); menu.moveUp(isFirstPush(game, 'UP')); }

    if (event === 'SELECT') {
      sfx('Select 1');
      const item = menu.getCurrentItem();
      if (item) restock(game, item);
      const trueIgnore = this.unit.items.map((i) => !canRestock(game, i));
      const current = menu.currentIndex;
      menu.setIgnore(this.ignore());
      if (trueIgnore.every(Boolean)) game.state.back();
      else if (!menu.options[current].ignore) menu.currentIndex = current;
    } else if (event === 'BACK') {
      sfx('Select 4');
      game.state.back();
    }
  }

  override update(): StateResult {
    this.menu?.update();
    this.unitMenu?.update();
  }

  override draw(surf: Surface): Surface {
    const [ox, oy] = screenOrigin();
    this.bg?.draw(surf);
    this.unitMenu?.draw(surf, ox, oy);
    this.menu?.draw(surf, ox, oy);
    return surf;
  }
}

// ============================================================================
// OptimizeAllChoiceState — Python OptimizeAllChoiceState
// ============================================================================

export class OptimizeAllChoiceState extends State {
  readonly name = 'optimize_all_choice';
  override readonly transparent = true;
  override readonly showMap = false;
  override readonly inLevel = false;

  menu: Choice | null = null;

  override start(): StateResult {
    const game = getGame();
    this.menu = new Choice(game, ['Yes', 'No'], 'center', null);
    this.menu.horizontal = true;
  }

  private boxWidth(): number {
    const width = this.menu!.getMenuWidth();
    const owidth = textWidth('Optimize All?') + 8;
    return Math.max(width, owidth);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    if (!menu) return;
    event = mouseEvent(game, menu, event);
    if (event === 'RIGHT') { if (menu.moveDown()) sfx('Select 6'); }
    else if (event === 'LEFT') { if (menu.moveUp()) sfx('Select 6'); }
    else if (event === 'BACK') {
      sfx('Select 4');
      game.state.back();
    } else if (event === 'SELECT') {
      if (menu.getCurrentText() === 'Yes') {
        sfx('Select 1');
        optimizeAll(game, partyUnits(game));
      } else {
        sfx('Select 4');
      }
      game.state.back();
    }
  }

  override update(): StateResult {
    this.menu?.update();
  }

  override draw(surf: Surface): Surface {
    const [ox, oy] = screenOrigin();
    if (!this.menu) return surf;
    const width = this.boxWidth();
    const box = baseSurf(width, 40, 'menu_bg_base');
    const bx = ox + 120 - Math.floor(box.width / 2);
    const by = oy + 80 - 28;
    blitTranslucent(surf, box, bx, by, 0);
    const owidth = textWidth('Optimize All?') + 8;
    drawText(surf, 'Optimize All?', bx + Math.floor(box.width / 2) - Math.floor(owidth / 2) + 4, by + 4);
    this.menu.draw(surf, ox, oy);
    return surf;
  }
}

// ============================================================================
// PrepTradeState — Python trade.PrepTradeState (menus.Trade over prep_bg)
// ============================================================================

export class PrepTradeState extends State {
  readonly name = 'prep_trade';
  override readonly showMap = false;
  override readonly inLevel = false;

  menu: TradeMenu | null = null;
  private bg: Background | null = null;

  override start(): StateResult {
    const game = getGame();
    this.bg = game.memory.get('prep_bg') ?? null;
    const unit1: UnitObject | null = game.memory.get('unit1') ?? null;
    const unit2: UnitObject | null = game.memory.get('unit2') ?? null;
    if (unit1 && unit2) this.menu = new TradeMenu(game, unit1, unit2);
  }

  /** Python TradeState.do_trade (prep trades do not set has_traded). */
  private doTrade(): boolean {
    const game = getGame();
    const menu = this.menu!;
    const selected = menu.selectedItem();
    if (!selected) return false;
    const [owner1, item1] = selected;
    const [owner2, item2] = menu.currentItem();
    if (!checkTrade(game, item1, owner1, item2, owner2)) {
      menu.unsetSelectedOption();
      return false;
    }
    const index1 = item1 ? owner1.items.indexOf(item1) : owner1.items.length;
    const index2 = item2 ? owner2.items.indexOf(item2) : owner2.items.length;
    game.actionLog.doAction(new TradeAction(owner1, index1, owner2, index2));
    menu.unsetSelectedOption();
    menu.updateOptions();
    return true;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    if (!menu) { game.state.back(); return; }
    event = mouseEvent(game, menu, event);
    if (event === 'DOWN') { if (menu.moveDown(isFirstPush(game, 'DOWN'))) sfx('Select 6'); }
    else if (event === 'UP') { if (menu.moveUp(isFirstPush(game, 'UP'))) sfx('Select 6'); }
    else if (event === 'RIGHT') { if (menu.moveRight()) sfx('TradeRight'); }
    else if (event === 'LEFT') { if (menu.moveLeft()) sfx('TradeRight'); }
    else if (event === 'BACK') {
      sfx('Select 4');
      if (menu.hasSelection()) menu.unsetSelectedOption();
      else game.state.back();
    } else if (event === 'SELECT') {
      if (menu.hasSelection()) {
        sfx(this.doTrade() ? 'Select 1' : 'Error');
      } else {
        sfx('Select 1');
        menu.setSelectedOption();
      }
    }
  }

  override update(): StateResult {
    this.menu?.update();
  }

  override draw(surf: Surface): Surface {
    const [ox, oy] = screenOrigin();
    this.bg?.draw(surf);
    this.menu?.draw(surf, ox, oy);
    return surf;
  }
}
