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
import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import {
  StoreItemAction,
  TakeItemFromConvoy,
  RemoveItemFromUnitAction,
} from '../action';
import { inventoryFull } from '../../combat/item-system';

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
  const numItems = Number(db.getConstant('num_items', 5));
  const numAccessories = Number(db.getConstant('num_accessories', 0));
  const accessories = unit.items.filter((i) => i.isAccessory()).length;
  const normal = unit.items.length - accessories;
  return normal > numItems || accessories > numAccessories;
}

/**
 * Python abilities.SupplyAbility.targets: the map 'Supply' command is
 * available when `_convoy` is enabled and the unit itself has the 'Convoy'
 * tag, or an adjacent same-team ally has the 'AdjConvoy' tag.
 */
export function supplyAvailableOnMap(unit: UnitObject, game: any): boolean {
  if (!game.gameVars?.get('_convoy')) return false;
  if (!unit.position) return false;
  if (unit.tags?.includes('Convoy')) return true;
  const [ux, uy] = unit.position;
  const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (const [dx, dy] of deltas) {
    const ally = game.board?.getUnit(ux + dx, uy + dy);
    if (ally && ally.team === unit.team && ally.tags?.includes('AdjConvoy')) {
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

export class SupplyItemsState extends State {
  readonly name = 'supply_items';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private unit: UnitObject | null = null;
  /** Parallel array: for each menu option, the item + direction. */
  private rows: Array<{ item: ItemObject; kind: 'give' | 'take' }> = [];

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.memory.get('supply_unit') ?? null;
    if (!this.unit || !game.gameVars?.get('_convoy')) {
      game.state.back();
      return 'repeat';
    }
    this.buildMenu();
  }

  private buildMenu(): void {
    const game = getGame();
    const unit = this.unit!;
    const convoy: ItemObject[] = game.getParty()?.convoy ?? [];
    const options: MenuOption[] = [];
    this.rows = [];

    for (const item of sortSupplyItems(unit.items, game.db)) {
      options.push({
        label: `Give ${item.name}`,
        value: `row_${options.length}`,
        enabled: !isLockedToUnit(item),
      });
      this.rows.push({ item, kind: 'give' });
    }
    for (const item of sortSupplyItems(convoy, game.db)) {
      options.push({
        label: `Take ${item.name}`,
        value: `row_${options.length}`,
        // Capacity is enforced here: taking is a no-op (disabled) when the
        // unit's relevant slot class (accessory vs normal) is full.
        enabled: !inventoryFull(unit, item, game.db),
      });
      this.rows.push({ item, kind: 'take' });
    }
    if (options.length === 0) {
      options.push({ label: '(Nothing)', value: 'nothing', enabled: false });
    }
    this.menu = new ChoiceMenu(options, 12, 20);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
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
      game.memory.delete('supply_unit');
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result && result.selected.startsWith('row_')) {
      const index = Number(result.selected.slice(4));
      const row = this.rows[index];
      if (!row || !this.unit) return;
      if (row.kind === 'give') {
        game.actionLog.doAction(new StoreItemAction(this.unit, row.item));
      } else {
        if (inventoryFull(this.unit, row.item, game.db)) return; // no-op, like Python
        game.actionLog.doAction(new TakeItemFromConvoy(this.unit, row.item));
      }
      const previousIndex = this.menu.selectedIndex;
      this.buildMenu();
      if (this.menu) {
        this.menu.selectedIndex = Math.min(previousIndex, this.menu.options.length - 1);
      }
    }
  }

  override draw(surf: Surface): Surface {
    surf.fillRect(0, 0, viewport.width, 14, 'rgba(16,16,48,0.9)');
    const convoyCount = getGame().getParty()?.convoy?.length ?? 0;
    surf.drawText(
      `Supply — ${this.unit?.name ?? ''}  (convoy: ${convoyCount})`,
      4, 3, 'rgba(220,200,128,1)', '8px monospace',
    );
    if (this.menu) this.menu.draw(surf);
    return surf;
  }

  override end(): StateResult {
    this.menu = null;
  }
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
    if (convoyEnabled && game.db.getConstant('long_range_storage', false)) {
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
    const numItems = Number(game.db.getConstant('num_items', 5));
    const numAccessories = Number(game.db.getConstant('num_accessories', 0));
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
        // Python: only items of the same accessory-class as the new item.
        (newAccessory === null || item.isAccessory() === newAccessory),
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
    const label = this.mode === 'storage'
      ? 'Choose item to send to storage'
      : 'Choose item to discard';
    surf.fillRect(0, 0, viewport.width, 14, 'rgba(64,16,16,0.9)');
    surf.drawText(
      `${label} — ${this.unit?.name ?? ''}`,
      4, 3, 'rgba(255,220,180,1)', '8px monospace',
    );
    if (this.menu) this.menu.draw(surf);
    return surf;
  }

  override end(): StateResult {
    this.menu = null;
    this.unit = null;
    this.newItem = null;
  }
}
