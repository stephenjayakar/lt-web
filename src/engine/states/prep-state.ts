/**
 * prep-state.ts — Preparation screens (lt-maker/app/engine/prep.py).
 *
 * PrepMainState            prep_main              map + focus_fade + centred Choice
 * PrepPickUnitsState       prep_pick              PrepPickUnitsState (Table 6x2 at 110,24)
 * PrepFormationState       prep_formation         PrepFormationState
 * PrepFormationSelectState prep_formation_select  PrepFormationSelectState (hand marker)
 * PrepMapState             prep_map               PrepGBAMapState-style map view
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import type { UnitObject } from '../../objects/unit';
import {
  ArriveOnMapAction,
  LeaveMapAction,
  ResetAction,
  ResetAllAction,
} from '../action';
import {
  Choice,
  CustomAlert,
  ScrollingBackground,
  SpriteBackground,
  Table,
  baseSurf,
  drawFormationHand,
  drawText,
  drawUnitItems,
  getRescuer,
  inFormation,
  isFirstPush,
  preloadPrepSprites,
  screenOrigin,
  textWidth,
} from '../../ui/prep-ui';

// Lazy game reference (same pattern as game-states.ts)
let _game: any = null;
export function setPrepGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for prep states');
  return _game;
}

function sfx(name: string): void {
  getGame().audioManager?.playSfx?.(name);
}

// ============================================================================
// Helpers (Python game_state formation/party helpers)
// ============================================================================

/** Python game.get_units_in_party(): living party units in prep sort order. */
export function getPartyUnits(): UnitObject[] {
  const game = getGame();
  const units: UnitObject[] = typeof game.getUnitsInParty === 'function'
    ? game.getUnitsInParty()
    : [...game.units.values()].filter((u: UnitObject) => u.team === 'player' && !u.dead);
  const order: string[] = game.parties?.get?.(game.currentParty)?.partyPrepManageSortOrder ?? [];
  const rank = (u: UnitObject) => { const i = order.indexOf(u.nid); return i < 0 ? 999999 : i; };
  return [...units].sort((a, b) => rank(a) - rank(b));
}

/** Python game.get_all_formation_spots(). */
export function getFormationSpots(): [number, number][] {
  const game = getGame();
  const seen = new Set<string>();
  const spots: [number, number][] = [];
  for (const region of game.currentLevel?.regions ?? []) {
    if (region.region_type !== 'formation') continue;
    const [x, y] = region.position;
    const w = region.size?.[0] ?? 1;
    const h = region.size?.[1] ?? 1;
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        const key = `${x + dx},${y + dy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        spots.push([x + dx, y + dy]);
      }
    }
  }
  return spots;
}

/** Python game.get_next_formation_spot(): first open spot in sorted order. */
function getNextFormationSpot(): [number, number] | null {
  const game = getGame();
  const open = getFormationSpots()
    .filter(([x, y]) => !game.board?.getUnit(x, y))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return open[0] ?? null;
}

/** Python prep.setup_units. */
function setupUnits(): void {
  const game = getGame();
  if (!game.currentLevel) return;
  for (const unit of getPartyUnits()) {
    const spot = getNextFormationSpot();
    if (unit.tags?.includes('Required') && spot && !unit.position) {
      game.actionLog.doAction(new ArriveOnMapAction(game, unit, spot));
    }
  }
  game.actionLog.doAction(new ResetAllAction([...game.units.values()].filter((u: UnitObject) => !u.dead)));
}

/** Number of prep slots (`_prep_slots` level var, else every formation tile). */
function numPrepSlots(): number {
  const slots = getGame().levelVars?.get('_prep_slots');
  return slots === undefined || slots === null ? getFormationSpots().length : Number(slots);
}

/** Party units standing on formation tiles (Python on_map list). */
function unitsOnFormation(): UnitObject[] {
  const game = getGame();
  const party = new Set(getPartyUnits());
  return [...game.units.values()].filter((u: UnitObject) => u.position && party.has(u) && inFormation(game, u.position));
}

/** Python LevelCursor.autocursor: first Lord, else first placed player unit. */
function autocursor(): void {
  const game = getGame();
  const players = [...game.units.values()].filter((u: UnitObject) => u.team === 'player' && u.position);
  const target = players.find((u: UnitObject) => u.tags?.includes('Lord')) ?? players[0];
  if (!target?.position || !game.cursor) return;
  game.cursor.setPos(target.position[0], target.position[1]);
  game.camera?.focusTile?.(target.position[0], target.position[1]);
}

function mouseInput(game: any): { moved: boolean; click: string | null; pos: [number, number] } {
  const input = game.input;
  const pos: [number, number] = input?.getGameMousePos ? input.getGameMousePos() : [0, 0];
  return { moved: !!input?.mouseMoved, click: input?.mouseClick ?? null, pos };
}

// ============================================================================
// PrepMainState — Python PrepMainState (a MapState)
// ============================================================================

export class PrepMainState extends State {
  readonly name = 'prep_main';
  // A MapState in Python: the tactical map (drawn by the free state beneath)
  // shows through focus_fade.
  override readonly transparent = true;
  override readonly showMap = true;

  menu: Choice | null = null;
  bg: SpriteBackground | null = null;
  private eventsOnOptions: (string | null)[] = [];
  private fadeOut = false;
  private fadeOutStart = 0;
  private alert: CustomAlert | null = null;

  /** Option labels (kept for tests and tooling). */
  get options(): string[] {
    return this.menu?.options.map((o) => (o.entry.kind === 'text' ? o.entry.text : '')) ?? [];
  }

  /** Current option index (settable by tests/tooling). */
  get cursor(): number {
    return this.menu?.currentIndex ?? 0;
  }
  set cursor(value: number) {
    if (this.menu && value >= 0 && value < this.menu.options.length) this.menu.currentIndex = value;
  }

  /** Python PrepMainState.populate_options. */
  populateOptions(): { options: string[]; ignore: boolean[]; events: (string | null)[] } {
    const game = getGame();
    let options = ['Manage', 'Formation', 'Options', 'Save', 'Fight'];
    if (game.levelVars?.get('_prep_pick')) options.unshift('Pick Units');
    let ignore = options.map(() => false);
    if (getPartyUnits().length === 0) ignore[0] = true;
    let events: (string | null)[] = options.map(() => null);
    const additional: string[] = game.gameVars?.get('_prep_additional_options') ?? [];
    const additionalIgnore: boolean[] = (game.gameVars?.get('_prep_options_enabled') ?? []).map((e: boolean) => !e);
    const additionalEvents: (string | null)[] = game.gameVars?.get('_prep_options_events') ?? [];
    const optionIdx = options.indexOf('Options');
    options = [...options.slice(0, optionIdx), ...additional, ...options.slice(optionIdx)];
    ignore = [...ignore.slice(0, optionIdx), ...additionalIgnore, ...ignore.slice(optionIdx)];
    events = [...events.slice(0, optionIdx), ...additionalEvents, ...events.slice(optionIdx)];
    return { options, ignore, events };
  }

  private prepStart(): void {
    const game = getGame();
    const music = game.gameVars?.get('_prep_music');
    if (music) void game.audioManager?.fadeIn?.(music);
    if (game.cursor) game.cursor.visible = false;
    autocursor();
    this.bg = new SpriteBackground('focus_fade');
    const { options, ignore, events } = this.populateOptions();
    this.eventsOnOptions = events;
    this.menu = new Choice(game, options, 'center');
    this.menu.setLimit(8);
    this.menu.setIgnore(ignore);
    this.fadeOut = false;
    this.alert = null;
  }

  override start(): StateResult {
    const game = getGame();
    preloadPrepSprites();
    setupUnits();
    this.prepStart();
    // on_prep_start fires each time the player enters preps. Only push an
    // event state when this trigger queued a NEW event: hasActiveEvents()
    // also sees the parent event that opened prep.
    if (game.eventManager) {
      const levelNid = game.currentLevel?.nid ?? '';
      const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
      if (game.eventManager.trigger({ type: 'on_prep_start', levelNid }, ctx)) {
        game.state.change('event');
      }
    }
  }

  override begin(): StateResult {
    const game = getGame();
    const music = game.gameVars?.get('_prep_music');
    if (music) void game.audioManager?.fadeIn?.(music);
    if (game.cursor) game.cursor.visible = false;
    // Options added by an option event (or a reloaded save) refresh here.
    if (this.menu && !this.fadeOut) {
      const { options, ignore, events } = this.populateOptions();
      const current = this.menu.getCurrentText();
      if (options.join('|') !== this.options.join('|')) {
        this.menu.setOptions(options);
        this.menu.setIgnore(ignore);
        this.eventsOnOptions = events;
        const idx = current ? options.indexOf(current) : -1;
        if (idx >= 0) this.menu.currentIndex = idx;
      } else {
        const idx = this.menu.currentIndex;
        this.menu.setIgnore(ignore);
        this.menu.currentIndex = idx;
      }
    }
  }

  private leave(): void {
    this.bg?.fadeOut();
    this.menu = null;
    this.fadeOut = true;
    this.fadeOutStart = performance.now();
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (this.fadeOut || !this.menu) return;
    if (this.alert) {
      this.alert.takeInput(event);
      return;
    }
    const [ox, oy] = screenOrigin();
    const mouse = mouseInput(game);
    if (mouse.moved) this.menu.handleMouse(mouse.pos[0], mouse.pos[1], ox, oy);
    if (mouse.click === 'SELECT' && this.menu.handleMouse(mouse.pos[0], mouse.pos[1], ox, oy) >= 0) event = 'SELECT';
    else if (mouse.click === 'BACK') event = 'BACK';

    if (event === 'DOWN') {
      if (this.menu.moveDown(isFirstPush(game, 'DOWN'))) sfx('Select 6');
    } else if (event === 'UP') {
      if (this.menu.moveUp(isFirstPush(game, 'UP'))) sfx('Select 6');
    } else if (event === 'SELECT') {
      sfx('Select 1');
      const selection = this.menu.getCurrentText();
      if (selection === 'Pick Units') {
        game.state.change('prep_pick');
      } else if (selection === 'Manage') {
        game.state.change('base_manage');
      } else if (selection === 'Formation') {
        this.bg?.fadeOut();
        game.memory?.set?.('_prep_outline', this.bg);
        game.state.change('prep_formation');
      } else if (selection === 'Options') {
        game.state.change('settings_menu');
      } else if (selection === 'Save') {
        game.memory?.set?.('save_kind', 'prep');
        game.state.change('save_menu');
      } else if (selection === 'Fight') {
        this.tryFight();
      } else {
        const evName = this.eventsOnOptions[this.menu.currentIndex];
        if (evName) this.triggerOptionEvent(evName);
      }
    }
  }

  private tryFight(): void {
    const game = getGame();
    const party = getPartyUnits();
    const deployed = party.filter((u) => !!u.position).length;
    const minDeploy = Number(game.levelVars?.get('_minimum_deployment') ?? 0);
    if (minDeploy > 0) {
      if (deployed >= Math.min(minDeploy, party.length)) {
        this.leave();
      } else {
        sfx('Select 4');
        this.alert = new CustomAlert(minDeploy === 1
          ? 'Must select at least 1 unit!'
          : `Must select at least ${minDeploy} units!`);
      }
    } else if (deployed > 0) {
      this.leave();
    } else {
      sfx('Select 4');
      this.alert = new CustomAlert('Must select at least one unit!');
    }
  }

  private triggerOptionEvent(evName: string): void {
    const game = getGame();
    const levelNid = game.currentLevel?.nid;
    const matches = [...game.db.events.values()].filter((candidate: any) =>
      (candidate.nid === evName || candidate.name === evName) &&
      (!candidate.level_nid || candidate.level_nid === levelNid));
    let queued = false;
    for (const prefab of matches) {
      if (game.eventManager?.triggerSpecific(prefab.nid, { type: evName, levelNid }, true)) queued = true;
    }
    if (queued) game.state.change('event');
  }

  override update(): StateResult {
    if (this.alert) {
      this.alert.update();
      if (this.alert.done) this.alert = null;
    }
    if (this.fadeOut) {
      if (performance.now() - this.fadeOutStart > 300) {
        this.fadeOut = false;
        this.fight();
      }
    } else {
      this.menu?.update();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    if (!this.bg) this.bg = new SpriteBackground('focus_fade');
    // While Formation is on top, only the fading outline is drawn
    // (Python PrepFormationState draws memory['_prep_outline']).
    const top = game.state.getCurrentState?.();
    if (top !== this && top?.name !== 'event' && top?.name !== 'alert') {
      if (top?.name === 'prep_formation' || top?.name === 'prep_formation_select') this.bg.draw(surf);
      return surf;
    }
    this.bg.draw(surf);
    const [ox, oy] = screenOrigin();
    this.menu?.draw(surf, ox, oy);
    this.alert?.draw(surf);
    return surf;
  }

  /** Python leave() -> back(): resume the level-start stack underneath. */
  private fight(): void {
    const game = getGame();
    // Older prep saves and direct prep entry can predate the initial
    // TurnChangeState-equivalent dispatch. Ensure authored turn-one setup is
    // queued exactly once before resuming the level-start event.
    if (game.turnCount === 1 &&
        !game.levelVars.get('_initial_turn_events_after_level_start') &&
        game.eventManager) {
      game.levelVars.set('_initial_turn_events_after_level_start', true);
      const levelNid = game.currentLevel?.nid;
      const context = { game, gameVars: game.gameVars, levelVars: game.levelVars };
      // Same order as GameState.loadLevel: Python's stack runs turn_change
      // before the phase_change that was triggered ahead of it.
      game.eventManager.trigger(
        { type: 'turn_change', turnCount: game.turnCount, levelNid },
        context,
      );
      game.eventManager.trigger(
        { type: 'phase_change', team: game.phase?.getCurrent(), levelNid },
        context,
      );
    }

    const previous = game.state.stack[game.state.stack.length - 2];
    const hasTacticalBase = game.state.stack[0]?.name === 'free';
    if (previous?.name === 'free' || (previous?.name === 'event' && hasTacticalBase)) {
      game.state.back();
    } else if (previous?.name === 'event') {
      // Prep commonly blocks the level-start event. Rebuild the tactical
      // base underneath it before resuming so the event cannot finish by
      // popping the last state and leaving a black, empty stack.
      game.state.clear();
      game.state.change('free');
      game.state.change('status_upkeep');
      game.state.change('phase_change');
      game.state.change('event');
    } else {
      game.state.clear();
      game.state.change('free');
      game.state.change('status_upkeep');
      game.state.change('phase_change');
    }
  }
}

// ============================================================================
// PrepPickUnitsState — Python PrepPickUnitsState
// ============================================================================

export class PrepPickUnitsState extends State {
  readonly name = 'prep_pick';
  override readonly showMap = false;
  override readonly inLevel = false;

  units: UnitObject[] = [];
  menu: Table | null = null;
  bg: ScrollingBackground | null = null;

  /** The listed units (kept for older tooling). */
  get partyUnits(): UnitObject[] { return this.units; }

  override start(): StateResult {
    const game = getGame();
    preloadPrepSprites();
    const party = getPartyUnits();
    const stuck = party.filter((u) => u.position && !inFormation(game, u.position));
    const unstuck = party.filter((u) => !stuck.includes(u));
    // Python sorted(..., key=bool(position), reverse=True) is stable.
    const placed = unstuck.filter((u) => !!u.position);
    const unplaced = unstuck.filter((u) => !u.position);
    this.units = [...stuck, ...placed, ...unplaced];
    this.menu = new Table(game, this.units.map((unit) => ({ kind: 'unit' as const, unit })), [6, 2], [110, 24]);
    this.menu.setMode('position');
    this.bg = new ScrollingBackground(game, 'rune_background');
    game.memory?.set?.('prep_bg', this.bg);
  }

  override begin(): StateResult {
    const game = getGame();
    // Coming back from the info menu re-selects the viewed unit.
    const unit = game.memory?.get?.('current_unit');
    if (unit && this.menu) {
      const idx = this.units.indexOf(unit);
      if (idx >= 0) this.menu.moveTo(idx);
    }
    game.memory?.set?.('current_unit', null);
  }

  /** Python order_party: remember deployed-first order for the party. */
  private orderParty(): void {
    const game = getGame();
    const party = game.parties?.get?.(game.currentParty);
    if (!party) return;
    const order = [...this.units.filter((u) => !!u.position), ...this.units.filter((u) => !u.position)];
    party.partyPrepManageSortOrder = order.map((u) => u.nid);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.menu;
    if (!menu) return;
    const [ox, oy] = screenOrigin();
    const mouse = mouseInput(game);
    if (mouse.moved) menu.handleMouse(mouse.pos[0], mouse.pos[1], ox, oy);
    if (mouse.click === 'SELECT' && menu.handleMouse(mouse.pos[0], mouse.pos[1], ox, oy) >= 0) event = 'SELECT';
    else if (mouse.click === 'BACK') event = 'BACK';

    if (event === 'DOWN') { sfx('Select 5'); menu.moveDown(isFirstPush(game, 'DOWN')); }
    else if (event === 'UP') { sfx('Select 5'); menu.moveUp(isFirstPush(game, 'UP')); }
    else if (event === 'LEFT') { sfx('Select 5'); menu.moveLeft(isFirstPush(game, 'LEFT')); }
    else if (event === 'RIGHT') { sfx('Select 5'); menu.moveRight(isFirstPush(game, 'RIGHT')); }

    if (event === 'SELECT') {
      this.toggleUnit();
    } else if (event === 'BACK') {
      this.orderParty();
      sfx('Select 4');
      game.state.back();
    } else if (event === 'INFO') {
      sfx('Select 1');
      const unit = menu.getCurrentUnit();
      if (!unit) return;
      game.memory?.set?.('scroll_units', getPartyUnits());
      game.memory?.set?.('current_unit', unit);
      game.infoMenuUnit = unit;
      game.state.change('info_menu');
    }
  }

  private toggleUnit(): void {
    const game = getGame();
    const unit = this.menu?.getCurrentUnit();
    if (!unit) {
      sfx('Error');
      return;
    }
    if (unit.position && !inFormation(game, unit.position)) {
      sfx('Select 4'); // Locked/Lord character
    } else if (unit.position && unit.tags?.includes('Required')) {
      sfx('Select 4'); // Required unit, can't be removed
    } else if (unit.position) {
      sfx('Select 1');
      game.actionLog.doAction(new LeaveMapAction(game, unit));
    } else {
      const spot = getNextFormationSpot();
      let blocked = !!unit.tags?.includes('Blacklist');
      if (game.db?.getConstant?.('fatigue', false) && game.gameVars?.get('_fatigue') === 1 &&
          typeof (unit as any).getFatigue === 'function' &&
          (unit as any).getFatigue() >= (unit as any).getMaxFatigue()) blocked = true;
      if (!blocked && unitsOnFormation().length < numPrepSlots()) {
        if (spot) {
          sfx('Select 1');
          game.actionLog.doAction(new ArriveOnMapAction(game, unit, spot));
          game.actionLog.doAction(new ResetAction(unit));
        }
      } else if (blocked) {
        sfx('Select 4');
      }
    }
  }

  override update(): StateResult {
    this.menu?.update();
  }

  /** Python draw_pick_units_card. */
  private drawPickUnitsCard(surf: Surface, ox: number, oy: number): void {
    const slots = numPrepSlots();
    const onMap = unitsOnFormation().length;
    const words = ['Pick ', String(slots - onMap), ' units  ', String(onMap), '/', String(slots)];
    const fonts = ['text', 'text-blue', 'text', 'text-blue', 'text', 'text-blue'];
    surf.blit(baseSurf(132, 24, 'menu_bg_white'), ox + 110, oy + 4);
    let left = 8;
    words.forEach((word, i) => {
      drawText(surf, word, ox + 110 + left, oy + 4 + 4, null, fonts[i]);
      left += textWidth(word, fonts[i]);
    });
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    this.bg?.draw(surf);
    const [ox, oy] = screenOrigin();
    const unit = this.menu?.getCurrentUnit() ?? null;
    if (unit) drawUnitItems(surf, game, ox + 4, oy + 44, unit, { includeTop: true });
    this.drawPickUnitsCard(surf, ox, oy);
    this.menu?.draw(surf, ox, oy);
    return surf;
  }
}

// ============================================================================
// PrepFormationState — Python PrepFormationState
// ============================================================================

function showFormationHighlights(): void {
  const game = getGame();
  game.highlight?.clear();
  for (const [x, y] of getFormationSpots()) game.highlight?.addHighlight(x, y, 'formation');
}

function moveMapCursor(event: InputEvent): boolean {
  const game = getGame();
  if (event !== 'UP' && event !== 'DOWN' && event !== 'LEFT' && event !== 'RIGHT') return false;
  const dx = event === 'RIGHT' ? 1 : event === 'LEFT' ? -1 : 0;
  const dy = event === 'DOWN' ? 1 : event === 'UP' ? -1 : 0;
  game.cursor?.move(dx, dy);
  const hover = game.cursor?.getHover();
  if (hover) game.camera?.focusTile(hover.x, hover.y);
  sfx('Select 5');
  return true;
}

/** Python prep._handle_info. */
function handleInfo(): void {
  const game = getGame();
  const hover = game.cursor?.getHover();
  const unit = hover ? game.board?.getUnit(hover.x, hover.y) : null;
  if (unit) {
    sfx('Select 1');
    game.memory?.set?.('current_unit', unit);
    game.infoMenuUnit = unit;
    game.state.change('info_menu');
  } else {
    sfx('Select 3');
  }
}

export class PrepFormationState extends State {
  readonly name = 'prep_formation';
  override readonly transparent = true;
  override readonly showMap = true;
  override readonly inLevel = true;

  override start(): StateResult {
    showFormationHighlights();
  }

  override begin(): StateResult {
    const game = getGame();
    showFormationHighlights();
    if (game.cursor) game.cursor.visible = true;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (moveMapCursor(event)) return;

    if (event === 'INFO') {
      handleInfo();
    } else if (event === 'SELECT') {
      const hover = game.cursor?.getHover();
      if (!hover) return;
      const unit: UnitObject | null = game.board?.getUnit(hover.x, hover.y) ?? null;
      if (!unit) return;
      if (inFormation(game, [hover.x, hover.y]) && unit.team === 'player') {
        sfx('Select 3');
        game.memory?.set?.('formation_unit', unit);
        game.state.change('prep_formation_select');
      } else {
        sfx('Select 2');
        if (unit.team !== 'player') sfx('Select 3');
        else sfx('Error');
      }
    } else if (event === 'BACK') {
      sfx('Select 1');
      const outline: SpriteBackground | undefined = game.memory?.get?.('_prep_outline');
      outline?.fadeIn();
      game.state.back();
    } else if (event === 'START') {
      sfx('Select 5');
      game.state.change('minimap');
    }
  }

  override draw(surf: Surface): Surface {
    return surf;
  }

  override finish(): void {
    const game = getGame();
    if (game.cursor) game.cursor.visible = false;
    game.highlight?.clear();
  }
}

/** Python PrepFormationSelectState: pick a destination tile for a unit. */
export class PrepFormationSelectState extends State {
  readonly name = 'prep_formation_select';
  override readonly transparent = true;
  override readonly showMap = true;
  override readonly inLevel = true;

  unit: UnitObject | null = null;

  override start(): StateResult {
    const game = getGame();
    const hover = game.cursor?.getHover();
    this.unit = game.memory?.get?.('formation_unit') ?? (hover ? game.board?.getUnit(hover.x, hover.y) : null);
    // Python cursor.formation_show().
    if (game.cursor) game.cursor.drawState = 'formation';
  }

  private back(): void {
    const game = getGame();
    if (game.cursor) game.cursor.drawState = 'visible';
    game.state.back();
  }

  override finish(): void {
    const game = getGame();
    if (game.cursor?.drawState === 'formation') game.cursor.drawState = 'visible';
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (moveMapCursor(event)) return;
    const unit = this.unit;
    if (!unit) { this.back(); return; }

    if (event === 'SELECT') {
      const hover = game.cursor.getHover();
      const pos: [number, number] = [hover.x, hover.y];
      const hovered: UnitObject | null = game.board?.getUnit(hover.x, hover.y) ?? null;
      if (!inFormation(game, pos)) {
        sfx('Error');
        return;
      }
      sfx('FormationSelect');
      if (hovered && (hovered.team !== 'player' || hovered === unit)) {
        sfx('Error');
      } else if (hovered && unit.position) {
        // Solo swap: both leave, then arrive on each other's tile.
        const oldUnitPos = [...unit.position] as [number, number];
        const oldHoveredPos = [...hovered.position!] as [number, number];
        game.actionLog.doAction(new LeaveMapAction(game, unit));
        game.actionLog.doAction(new LeaveMapAction(game, hovered));
        game.actionLog.doAction(new ArriveOnMapAction(game, unit, oldHoveredPos));
        game.actionLog.doAction(new ArriveOnMapAction(game, hovered, oldUnitPos));
        this.back();
      } else if (hovered) {
        if (hovered.tags?.includes('Required')) {
          sfx('Error');
        } else {
          game.actionLog.doAction(new LeaveMapAction(game, hovered));
          game.actionLog.doAction(new ArriveOnMapAction(game, unit, pos));
          this.back();
        }
      } else {
        if (unit.position) game.actionLog.doAction(new LeaveMapAction(game, unit));
        game.actionLog.doAction(new ArriveOnMapAction(game, unit, pos));
        this.back();
      }
    } else if (event === 'BACK') {
      sfx('Select 4');
      this.back();
    } else if (event === 'AUX') {
      const pos = unit.position ?? getRescuer(game, unit)?.position;
      if (pos) {
        game.cursor?.setPos?.(pos[0], pos[1]);
        game.camera?.focusTile(pos[0], pos[1]);
      }
    } else if (event === 'INFO') {
      handleInfo();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const unit = this.unit;
    if (unit) {
      const pos = unit.position ?? getRescuer(game, unit)?.position ?? null;
      if (pos) drawFormationHand(surf, game, pos, false);
    }
    const hover = game.cursor?.getHover();
    if (hover && inFormation(game, [hover.x, hover.y])) {
      drawFormationHand(surf, game, [hover.x, hover.y], false);
    }
    return surf;
  }
}

// ============================================================================
// PrepMapState — map view with formation highlights (PrepGBAMapState)
// ============================================================================

export class PrepMapState extends State {
  readonly name = 'prep_map';
  override readonly transparent = true;
  override readonly showMap = true;
  override readonly inLevel = true;

  override begin(): StateResult {
    const game = getGame();
    showFormationHighlights();
    if (game.cursor) game.cursor.visible = true;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (moveMapCursor(event)) return;
    if (event === 'BACK' || event === 'START') {
      game.highlight?.clear();
      game.state.back();
    } else if (event === 'INFO') {
      handleInfo();
    }
  }

  override end(): StateResult {
    getGame().highlight?.clear();
  }
}
