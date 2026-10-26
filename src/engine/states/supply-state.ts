/**
 * supply-state.ts — Supply/Convoy player states.
 *
 * SupplyItemsState ('supply_items'): give items to / take items from the
 * party convoy. Port of Python's prep.PrepItemsState (state 'supply_items').
 * Simplifications (documented in PLAN.md): a single flat sorted list
 * (weapons grouped by weapon type first, then non-weapons, alphabetical
 * tiebreak) instead of the Python multi-tab convoy menu; no restock/trade
 * sub-flows.
 *
 * ItemDiscardState ('item_discard'): forced discard/store when a unit is
 * over inventory capacity. Port of Python's
 * general_states.ItemDiscardState:
 * - STORAGE mode (item goes to convoy via StoreItem) when `_convoy` is
 *   enabled and (long_range_storage, or the unit has no position i.e.
 *   prep/base, or the map Supply ability is available to the unit);
 *   otherwise DISCARD mode (item removed from the unit; Python
 *   action.RemoveItem — reversible remove, no convoy).
 * - BACK is refused (Error sfx) while over capacity; the state pops itself
 *   automatically once the unit is back under capacity.
 * - Locked items cannot be selected; when locked items alone exceed
 *   capacity the last locked one is auto-stored/removed (Python
 *   _check_locked_inventory).
 * - Only items of the same accessory-class as the newly gained item can be
 *   chosen (Python take_input SELECT gate).
 *
 * All transfers go through reversible actions (StoreItemAction,
 * TakeItemFromConvoy, RemoveItemFromUnitAction) so they are turnwheel- and
 * save-safe. Python has no save-blocking list for 'item_discard'
 * (state_machine.py has no such concept); saving mid-discard is not a
 * supported entry point in Python either, so no special handling exists
 * here.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { isForkEngine } from '../engine-flavor';
import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import { Pennant } from '../../ui/menu-chrome';
import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import {
  HasTradedAction,
  MoveItemBetweenUnitsAction,
  StoreItemAction,
  TakeItemFromConvoy,
  TradeAction,
  TradeItemWithConvoy,
  RemoveItemFromUnitAction,
} from '../action';
import {
  Choice,
  ConvoyMenu,
  ScrollingBackground,
  WINHEIGHT,
  WINWIDTH,
  checkTrade,
  isFirstPush,
  preloadPrepSprites,
  screenOrigin,
} from '../../ui/prep-ui';
import { canUseBaseItem, useItemInBase } from './game-states';
import { canRestock, restock } from './manage-state';
import { inventoryCapacity, inventoryFull } from '../../combat/item-system';
import { unitHasTag } from '../../combat/skill-system';

function sfx(name: string): void {
  getGame()?.audioManager?.playSfx?.(name);
}

// Lazy game reference (same pattern as prep-state.ts)
let _game: any = null;
export function setSupplyGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for supply states');
  return _game;
}

// ============================================================================
// Helpers
// ============================================================================

/** Python item_funcs.too_much_in_inventory: separate accessory/normal caps. */
export function tooMuchInInventory(unit: UnitObject, db: any): boolean {
  const numItems = inventoryCapacity(unit, false, db);
  const numAccessories = inventoryCapacity(unit, true, db);
  const accessories = unit.items.filter((i) => i.isAccessory()).length;
  const normal = unit.items.length - accessories;
  return normal > numItems || accessories > numAccessories;
}

/**
 * Python abilities.SupplyAbility.targets: the map 'Supply' command is
 * available when `_convoy` is enabled and the unit itself has the 'Convoy'
 * tag, or an adjacent same-team ally has the 'AdjConvoy' tag. Tags are the
 * full UnitObject.tags union (EOtF grants Convoy/AdjConvoy via skill
 * has_tags), and the fork also refuses 'Temporary' units (summons).
 */
export function supplyAvailableOnMap(unit: UnitObject, game: any): boolean {
  if (!game.gameVars?.get('_convoy')) return false;
  if (!unit.position) return false;
  if (isForkEngine() && unitHasTag(unit, 'Temporary', game)) return false;
  if (unitHasTag(unit, 'Convoy', game)) return true;
  const [ux, uy] = unit.position;
  const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (const [dx, dy] of deltas) {
    const ally = game.board?.getUnit(ux + dx, uy + dy);
    if (ally && ally.team === unit.team && unitHasTag(ally, 'AdjConvoy', game)) {
      return true;
    }
  }
  return false;
}

/** Python item_system.storeable/discardable: locked items cannot leave the unit. */
function isLockedToUnit(item: ItemObject): boolean {
  return item.hasComponent('locked');
}

/**
 * Sort helper approximating Python's convoy weapon-type ordering: weapons
 * first, grouped by weapon type (db.weapons order when available, else
 * alphabetical), then non-weapons; alphabetical name tiebreak.
 */
export function sortSupplyItems(items: ItemObject[], db: any): ItemObject[] {
  const typeOrder = new Map<string, number>();
  const weaponTypes = db?.weapons;
  if (Array.isArray(weaponTypes)) {
    weaponTypes.forEach((w: any, i: number) => typeOrder.set(w?.nid ?? String(i), i));
  }
  const rank = (item: ItemObject): [number, number, string] => {
    const wtype = item.getComponent<string>('weapon_type') ?? '';
    const isWeapon = item.isWeapon?.() || !!wtype;
    if (isWeapon) {
      return [0, typeOrder.get(wtype) ?? 999, item.name];
    }
    return [1, 0, item.name];
  };
  return [...items].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return ra[2].localeCompare(rb[2]);
  });
}

// ============================================================================
// SupplyItemsState — give/take with the party convoy
// ============================================================================

/** Python prep.PrepItemsState (shared by supply_items and prep_items). */
abstract class ConvoyItemsState extends State {
  override readonly showMap = false;
  override readonly inLevel = false;

  unit: UnitObject | null = null;
  menu: ConvoyMenu | null = null;
  subMenu: Choice | null = null;
  /** Python PrepItemsState.state. */
  mode: 'free' | 'owner_item' | 'convoy_item' | 'trade_convoy' | 'trade_inventory' = 'free';
  private bg: { draw(surf: Surface): void } | null = null;

  override start(): StateResult {
    const game = getGame();
    preloadPrepSprites();
    this.bg = game.memory.get('prep_bg') ?? new ScrollingBackground(game, 'rune_background');
    this.unit = game.memory.get('supply_unit') ?? null;
    const includeOthers = !!game.memory.get('include_other_units') || this.name !== 'supply_items';
    game.memory.set('include_other_units', false);
    if (this.unit) {
      this.menu = new ConvoyMenu(game, this.unit, [WINWIDTH - 116, 40], { includeOtherUnits: includeOthers });
    }
    this.mode = 'free';
    this.subMenu = null;
  }

  override begin(): StateResult {
    const game = getGame();
    if (!this.unit || !this.menu || !game.gameVars?.get('_convoy')) {
      game.memory.delete('supply_unit');
      game.state.back();
      return 'repeat';
    }
    this.menu.updateOptions();
  }

  private act(action: any): void {
    getGame().actionLog.doAction(action);
  }

  private useItem(item: ItemObject): void {
    const game = getGame();
    this.act(new HasTradedAction(this.unit!));
    useItemInBase(game, this.unit!, item, 'base_use');
    this.mode = 'free';
  }

  /** Python convoy_funcs.trade_items. */
  private tradeItems(convoyItem: ItemObject | null, unitItem: ItemObject | null): void {
    const unit = this.unit!;
    if (!unitItem && convoyItem) {
      if (convoyItem.owner) this.act(new MoveItemBetweenUnitsAction(convoyItem.owner, unit, convoyItem));
      else this.act(new TakeItemFromConvoy(unit, convoyItem));
    } else if (!convoyItem && unitItem) {
      this.act(new StoreItemAction(unit, unitItem));
    } else if (convoyItem && unitItem && convoyItem.owner) {
      const other = convoyItem.owner;
      this.act(new TradeAction(unit, unit.items.indexOf(unitItem), other, other.items.indexOf(convoyItem)));
    } else if (convoyItem && unitItem) {
      this.act(new TradeItemWithConvoy(unit, convoyItem, unitItem));
    }
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    const unit = this.unit;
    if (!menu || !unit) return;
    const [ox, oy] = screenOrigin();
    const mouseMoved = !!game.input?.mouseMoved;
    const click = game.input?.mouseClick ?? null;
    const pos: [number, number] = game.input?.getGameMousePos ? game.input.getGameMousePos() : [0, 0];
    const target: { handleMouse(x: number, y: number, ox: number, oy: number): number } | null =
      this.mode === 'free' || this.mode === 'trade_convoy' || this.mode === 'trade_inventory' ? menu : this.subMenu;
    if (target) {
      if (mouseMoved) target.handleMouse(pos[0], pos[1], ox, oy);
      if (click === 'SELECT' && target.handleMouse(pos[0], pos[1], ox, oy) >= 0) event = 'SELECT';
      else if (click === 'BACK') event = 'BACK';
    }

    if (this.mode === 'free' || this.mode === 'trade_convoy' || this.mode === 'trade_inventory') {
      if (event === 'DOWN') { if (menu.moveDown(isFirstPush(game, 'DOWN'))) sfx('Select 6'); }
      else if (event === 'UP') { if (menu.moveUp(isFirstPush(game, 'UP'))) sfx('Select 6'); }
      else if (event === 'LEFT') { if (menu.moveLeft(isFirstPush(game, 'LEFT'))) sfx('TradeRight'); }
      else if (event === 'RIGHT') { if (menu.moveRight(isFirstPush(game, 'RIGHT'))) sfx('TradeRight'); }
    } else if (this.subMenu) {
      if (event === 'DOWN') { if (this.subMenu.moveDown(isFirstPush(game, 'DOWN'))) sfx('Select 6'); }
      else if (event === 'UP') { if (this.subMenu.moveUp(isFirstPush(game, 'UP'))) sfx('Select 6'); }
    }

    if (event === 'SELECT') {
      sfx('Select 1');
      this.select();
    } else if (event === 'BACK' && menu.infoFlag) {
      // Python PrepItemsState: BACK first closes the help box.
      menu.toggleInfo();
      sfx('Info Out');
    } else if (event === 'INFO') {
      if (this.mode === 'free' || this.mode === 'trade_convoy' || this.mode === 'trade_inventory') {
        menu.toggleInfo();
        sfx(menu.infoFlag ? 'Info In' : 'Info Out');
      }
    } else if (event === 'BACK') {
      if (this.mode === 'free') {
        sfx('Select 4');
        game.memory.delete('supply_unit');
        game.state.back();
      } else if (this.mode === 'owner_item' || this.mode === 'convoy_item') {
        this.subMenu = null;
        this.mode = 'free';
      } else if (this.mode === 'trade_convoy') {
        menu.moveToInventory();
        menu.unlock();
        menu.updateOptions();
        this.mode = 'free';
      } else if (this.mode === 'trade_inventory') {
        menu.moveToConvoy();
        menu.unlock();
        menu.updateOptions();
        this.mode = 'free';
      }
    }
  }

  private select(): void {
    const game = getGame();
    const menu = this.menu!;
    const unit = this.unit!;
    if (this.mode === 'free') {
      const current = menu.getCurrent();
      if (menu.getContext() === 'inventory') {
        if (!current) { menu.moveToConvoy(); return; }
        const options: string[] = [];
        if (!current.hasComponent('locked')) options.push('Store', 'Trade');
        if (this.name !== 'supply_items' && canUseBaseItem(unit, current, game)) options.push('Use');
        if (canRestock(game, current)) options.push('Restock');
        if (!options.length) options.push('Nothing');
        let top = menu.getCurrentIndex() * 16 + 68 - 8 * options.length;
        top = Math.min(top, WINHEIGHT - 4 - 16 * options.length);
        this.subMenu = new Choice(game, options, [96, top]);
        this.mode = 'owner_item';
      } else if (current) {
        if (this.name !== 'supply_items' && canUseBaseItem(unit, current, game)) {
          const top = (menu.getCurrentIndex() - menu.getScrolledIndex()) * 16 + 36;
          const options = inventoryFull(unit, current, game.db) ? ['Trade', 'Use'] : ['Take', 'Use'];
          this.subMenu = new Choice(game, options, [80, top]);
          this.mode = 'convoy_item';
        } else {
          this.act(new HasTradedAction(unit));
          if (inventoryFull(unit, current, game.db)) {
            this.mode = 'trade_inventory';
            menu.moveToInventory();
          } else {
            this.tradeItems(current, null);
            menu.updateOptions();
          }
        }
      }
    } else if (this.mode === 'owner_item') {
      const choice = this.subMenu?.getCurrentText();
      const item = menu.getCurrent();
      this.subMenu = null;
      this.mode = 'free';
      if (!item) return;
      if (choice === 'Store') {
        this.act(new HasTradedAction(unit));
        this.act(new StoreItemAction(unit, item));
        menu.updateOptions();
        menu.moveToItemType(item);
      } else if (choice === 'Trade') {
        this.mode = 'trade_convoy';
        menu.moveToConvoy();
        menu.updateOptions();
      } else if (choice === 'Use') {
        this.useItem(item);
        menu.updateOptions();
      } else if (choice === 'Restock') {
        this.act(new HasTradedAction(unit));
        restock(game, item);
        menu.updateOptions();
      }
    } else if (this.mode === 'convoy_item') {
      const choice = this.subMenu?.getCurrentText();
      const item = menu.getCurrent();
      this.subMenu = null;
      this.mode = 'free';
      if (!item) return;
      if (choice === 'Take') {
        this.act(new HasTradedAction(unit));
        this.tradeItems(item, null);
      } else if (choice === 'Trade') {
        this.mode = 'trade_inventory';
        menu.moveToInventory();
      } else if (choice === 'Use') {
        this.useItem(item);
      }
      menu.updateOptions();
    } else if (this.mode === 'trade_convoy' || this.mode === 'trade_inventory') {
      const unitItem = menu.getInventoryCurrent();
      const convoyItem = menu.getConvoyCurrent();
      if (checkTrade(game, unitItem, unit, convoyItem, null)) {
        this.act(new HasTradedAction(unit));
        this.tradeItems(convoyItem, unitItem);
        menu.unlock();
        menu.updateOptions();
        this.mode = 'free';
      } else {
        sfx('Error');
      }
    }
  }

  override update(): StateResult {
    this.menu?.update();
    this.subMenu?.update();
  }

  override draw(surf: Surface): Surface {
    const [ox, oy] = screenOrigin();
    this.bg?.draw(surf);
    this.menu?.draw(surf, ox, oy);
    this.subMenu?.draw(surf, ox, oy);
    if (this.menu?.infoFlag) this.menu.drawInfo(surf, ox, oy);
    return surf;
  }
}

/** Map Supply (Python 'supply_items'): convoy only, no Use. */
export class SupplyItemsState extends ConvoyItemsState {
  readonly name = 'supply_items';
}

/** Prep/base Items (Python 'prep_items'): includes other units' items and Use. */
export class PrepItemsState extends ConvoyItemsState {
  readonly name = 'prep_items';
}

// ============================================================================
// ItemDiscardState — forced discard/store when over capacity
// ============================================================================

interface PendingDiscard {
  unit: UnitObject;
  item: ItemObject | null;
}

export class ItemDiscardState extends State {
  readonly name = 'item_discard';
  private pennant: Pennant | null = null;
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private unit: UnitObject | null = null;
  private newItem: ItemObject | null = null;
  private mode: 'storage' | 'discard' = 'discard';

  override begin(): StateResult {
    const game = getGame();

    // Load the current over-capacity unit: direct memory keys first
    // (Python's item_discard_current_unit contract), else the queue set by
    // combat pickup overflow.
    if (!this.unit) {
      if (!this.loadNext()) {
        game.state.back();
        return 'repeat';
      }
    }

    // Once under capacity the state resolves itself (Python begin()).
    while (this.unit && !tooMuchInInventory(this.unit, game.db)) {
      this.unit = null;
      this.newItem = null;
      if (!this.loadNext()) {
        game.state.back();
        return 'repeat';
      }
    }

    // Auto-resolve the locked-inventory edge case (Python _check_locked_inventory).
    if (this.unit && this.autoResolveLocked()) {
      return this.begin();
    }

    this.buildMenu();
  }

  /** Pull the next over-capacity unit from memory keys or the queue. */
  private loadNext(): boolean {
    const game = getGame();
    const direct = game.memory.get('item_discard_current_unit');
    if (direct) {
      this.unit = direct;
      this.newItem = game.memory.get('item_discard_new_item') ?? null;
      game.memory.delete('item_discard_current_unit');
      game.memory.delete('item_discard_new_item');
      game.memory.delete('item_discard_force_give');
      this.computeMode();
      return true;
    }
    const queue: PendingDiscard[] = game.memory.get('item_discard_queue') ?? [];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (tooMuchInInventory(next.unit, game.db)) {
        this.unit = next.unit;
        this.newItem = next.item;
        this.computeMode();
        if (queue.length === 0) game.memory.delete('item_discard_queue');
        return true;
      }
    }
    game.memory.delete('item_discard_queue');
    return false;
  }

  /** Python ItemDiscardState.start mode selection. */
  private computeMode(): void {
    const game = getGame();
    const unit = this.unit!;
    const convoyEnabled = !!game.gameVars?.get('_convoy');
    // EOtF fork: storage mode whenever the convoy is on. Upstream gates it on
    // long_range_storage (default True), position, or a supply unit.
    if (convoyEnabled && (isForkEngine() || game.db.getConstant('long_range_storage', true))) {
      this.mode = 'storage';
    } else if (convoyEnabled && !unit.position) {
      this.mode = 'storage';
    } else if (convoyEnabled && supplyAvailableOnMap(unit, game)) {
      this.mode = 'storage';
    } else {
      this.mode = 'discard';
    }
  }

  /**
   * Python _check_locked_inventory: if locked items alone exceed capacity,
   * force-store/remove the last locked one automatically. Returns true if
   * an auto-resolution happened.
   */
  private autoResolveLocked(): boolean {
    const game = getGame();
    const unit = this.unit!;
    const numItems = inventoryCapacity(unit, false, game.db);
    const numAccessories = inventoryCapacity(unit, true, game.db);
    const locked = unit.items.filter((i) => this.isRowLocked(i));
    const lockedNormal = locked.filter((i) => !i.isAccessory());
    const lockedAccessories = locked.filter((i) => i.isAccessory());
    let target: ItemObject | null = null;
    if (lockedNormal.length > numItems) target = lockedNormal[lockedNormal.length - 1];
    else if (lockedAccessories.length > numAccessories) target = lockedAccessories[lockedAccessories.length - 1];
    if (!target) return false;
    if (this.mode === 'storage') {
      game.actionLog.doAction(new StoreItemAction(unit, target));
    } else {
      game.actionLog.doAction(new RemoveItemFromUnitAction(unit, target));
    }
    return true;
  }

  /** Locked to the unit, or the newly gained item itself (force_give). */
  private isRowLocked(item: ItemObject): boolean {
    if (isLockedToUnit(item)) return true;
    // The EOtF fork only greys out locked items.
    if (isForkEngine()) return false;
    if (this.newItem && item === this.newItem) return true;
    return false;
  }

  private buildMenu(): void {
    const unit = this.unit!;
    const newAccessory = this.newItem?.isAccessory() ?? null;
    const options: MenuOption[] = unit.items.map((item, index) => ({
      label: item.name,
      value: `item_${index}`,
      enabled: !this.isRowLocked(item) &&
        // Python: only items of the same accessory-class as the new item
        // (the EOtF fork has no such filter).
        (newAccessory === null || isForkEngine() || item.isAccessory() === newAccessory),
    }));
    this.menu = new ChoiceMenu(options, 12, 24);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || !this.unit) return;
    const game = getGame();

    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      // Cannot cancel while over capacity (Python plays Error sfx only).
      return;
    }

    if ('selected' in result && result.selected.startsWith('item_')) {
      const index = Number(result.selected.slice(5));
      const item = this.unit.items[index];
      if (!item || this.isRowLocked(item)) return;
      if (this.mode === 'storage') {
        game.actionLog.doAction(new StoreItemAction(this.unit, item));
      } else {
        game.actionLog.doAction(new RemoveItemFromUnitAction(this.unit, item));
      }
      this.menu = null;
      return this.begin();
    }
  }

  override draw(surf: Surface): Surface {
    // Python ItemDiscardState: banner.Pennant along the bottom (top when the
    // cursor sits on the map's last row).
    const label = this.mode === 'storage'
      ? 'Choose item to send to storage'
      : 'Choose item to discard';
    const game = getGame();
    const text = game.db?.translate?.(label) ?? label;
    if (!this.pennant) this.pennant = new Pennant(text);
    else this.pennant.changeTextIfNeeded(text);
    const cursorY = game.cursor?.getPosition?.()?.[1] ?? 0;
    const mapHeight = game.tilemap?.height ?? game.currentLevel?.tilemap?.height ?? Infinity;
    this.pennant.draw(surf, cursorY >= mapHeight - 1);
    if (this.menu) this.menu.draw(surf);
    return surf;
  }

  override end(): StateResult {
    this.menu = null;
    this.unit = null;
    this.newItem = null;
    this.pennant = null;
  }
}
