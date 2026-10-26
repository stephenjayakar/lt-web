/**
 * promotion-state.ts: port of lt-maker/app/engine/promotion.py with the
 * ExpState 'promote' / 'class_change' level screen it hands off to.
 *
 * - PromotionChoiceState ('promotion_choice') / ClassChangeChoiceState
 *   ('class_change_choice'): a settings_background screen with the class
 *   menu (Choice at 14,13, five rows), each class's unarmed battle animation
 *   swooping in on its platform, the class name in the 'class' font, its
 *   usable weapon icons, and the class description typed into the
 *   promotion_description box. SELECT opens Change/Cancel.
 * - PromotionState ('promotion') / ClassChangeState ('class_change'): the
 *   old class on the right platform plays Promotion1, the new class on the
 *   left plays Promotion2, then the level screen shows the stat changes.
 *   With no battle animation for either class it goes straight to the
 *   level screen, as Python does.
 *
 * Mechanics go through performPromotionOrClassChange when the level screen
 * starts (Python ExpState applies action.Promote there). A promotion item's
 * use (resource hooks, uses, wait) wraps the same span, so turnwheel undoes
 * the item and the promotion together.
 */

import { State } from '../state';
import type { StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { WINHEIGHT, WINWIDTH } from '../constants';
import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import {
  GiveItemAction,
  MarkActionGroupEnd,
  MarkActionGroupStart,
  RemoveItemFromUnitAction,
  SetMovementLeftAction,
} from '../action';
import { applyItemStartResourceHooks } from '../../combat/item-resource-lifecycle';
import { BattleAnimation, fillScreen, type BattleAnimOwner } from '../../combat/battle-animation';
import type { CombatEffectData, PaletteData, WeaponAnimData } from '../../combat/battle-anim-types';
import {
  convertSpritesheetToFrames,
  loadAndConvertWeaponAnim,
  loadPlatformImage,
  selectPalette,
} from '../../combat/sprite-loader';
import { loadEffectSpritesheet } from '../../data/loaders/combat-anim-loader';
import { changeVariant } from '../../combat/skill-system';
import { Dialog } from '../../ui/dialog';
import { drawIcon16 } from '../../ui/icons';
import { Choice } from '../../ui/prep-ui';
import { LevelUpScreen } from '../../ui/exp-display';
import {
  MenuBackground,
  MenuScene,
  blitSprite,
  blitText,
  getSprite,
  preloadSprites,
  textWidth,
} from '../../ui/menu-chrome';
import {
  createPixelAnimation,
  finishCoreItemUse,
  itemUseCantoMovement,
  performPromotionOrClassChange,
  runEventsBeforeWaiting,
} from './game-states';

let _game: any = null;

export function setPromotionGameRef(game: any): void {
  _game = game;
}

function getGame(): any {
  if (!_game) throw new Error('PromotionState: game reference not set.');
  return _game;
}

function sfx(name: string): void {
  getGame().audioManager?.playSfx?.(name);
}

type Color = [number, number, number];
export type PromotionKind = 'promote' | 'class_change';

/** A promotion/class change waiting for its screens. */
export interface PromotionRequest {
  unit: UnitObject;
  kind: PromotionKind;
  /** Python memory['promo_options']; empty means the class's own options. */
  options: string[];
  /** Python memory['next_class'] (set directly or by the choice screen). */
  nextClass: string | null;
  /** Python memory['can_go_back']: BACK leaves the choice (item uses). */
  canGoBack: boolean;
  /** States under the choice to pop with it on Change (item targeting). */
  popBelow: number;
  /** Python memory['combat_item']: the promotion item's use to complete. */
  itemUse: { actor: UnitObject; item: ItemObject; baseUse: boolean } | null;
}

const REQUEST_KEY = 'promotion_request';

/**
 * Start the Python promotion flow: 'promotion'/'class_change' when the class
 * is known, else the matching choice screen.
 */
export function requestPromotion(game: any, request: PromotionRequest): void {
  game.memory.set(REQUEST_KEY, request);
  const promote = request.kind === 'promote';
  if (request.nextClass) game.state.change(promote ? 'promotion' : 'class_change');
  else game.state.change(promote ? 'promotion_choice' : 'class_change_choice');
}

function currentRequest(): PromotionRequest | null {
  return getGame().memory.get(REQUEST_KEY) ?? null;
}

// ---------------------------------------------------------------------------
// Battle animations (battle_animation.get_battle_anim with item=None)
// ---------------------------------------------------------------------------

/** get_battle_anim(unit, None, klass=klass): the class's Unarmed animation. */
export function getUnarmedBattleAnim(game: any, unit: UnitObject, klassNid: string | null = null): BattleAnimation | null {
  const db = game.db;
  const klass = db.classes.get(klassNid ?? unit.klass);
  if (!klass || !db.combatAnims?.size) return null;
  // The web combat path falls back to the class nid when combat_anim_nid
  // is unset; keep the same lookup here.
  const animNid: string = klass.combat_anim_nid ?? klass.nid;
  const variant = changeVariant(unit, game);
  const res = (variant ? db.combatAnims.get(animNid + variant) : null) ?? db.combatAnims.get(animNid);
  if (!res) return null;
  const palettes = db.combatPalettes as Map<string, PaletteData>;
  const palette = selectPalette(res, unit, palettes);
  if (!palette) return null;
  const weaponAnim = res.weapon_anims.find((anim: WeaponAnimData) => anim.nid === 'Unarmed');
  if (!weaponAnim) return null;
  const anim = new BattleAnimation(weaponAnim, new Map());
  void loadAndConvertWeaponAnim(game.resources, res.nid, weaponAnim, palette).then((frames) => {
    if (frames) for (const [nid, canvas] of frames) anim.frameImages.set(nid, canvas);
  }).catch(() => undefined);
  return anim;
}

/**
 * The MockCombat side of BattleAnimOwner that a promotion needs: sounds,
 * screen flashes, and child-effect data. Shakes, pans and darkening are
 * accepted but not drawn, since PromotionState.draw never calls draw_ui.
 */
class PromotionAnimOwner implements BattleAnimOwner {
  foregroundColor: Color | null = null;
  foregroundFrames = 0;
  foregroundFadeOut = false;
  foregroundFadeFrames = 0;
  private effectFrames = new Map<string, Map<string, ImageBitmap | HTMLCanvasElement>>();

  playSound(name: string): void { sfx(name); }
  stopSound(name: string): void { getGame().audioManager?.stopSfx?.(name); }
  shake(): void { /* draw_ui only */ }
  rawShake(): void { /* draw_ui only */ }
  startHit(): void { /* no strikes */ }
  spellHit(): void { /* no strikes */ }
  hitModifiers(): void { /* no strikes */ }
  platformShake(): void { /* draw_ui only */ }
  panAway(): void { /* draw_ui only */ }
  panBack(): void { /* draw_ui only */ }
  darken(): void { /* draw_ui only */ }
  lighten(): void { /* draw_ui only */ }
  setBrightness(): void { /* draw_ui only */ }
  hitSpark(): void { /* no strikes */ }
  critSpark(): void { /* no strikes */ }
  spellEffectNid(): string | null { return null; }

  /** MockCombat.screen_flash -> Foreground.flash */
  screenFlash(numFrames: number, color: Color, fadeOut: number = 0): void {
    this.foregroundFrames = numFrames;
    this.foregroundColor = color;
    this.foregroundFadeFrames = fadeOut;
    this.foregroundFadeOut = false;
  }

  /** Foreground.draw: additive full-screen colour, faded by make_translucent_blend. */
  drawForeground(surf: Surface): void {
    if (!this.foregroundColor && !this.foregroundFadeFrames) return;
    if (this.foregroundColor) {
      const strength = this.foregroundFadeOut && this.foregroundFadeFrames
        ? this.foregroundFrames / this.foregroundFadeFrames
        : 1;
      fillScreen(surf, this.foregroundColor, 'add', Math.max(0, Math.min(1, strength)));
    }
    this.foregroundFrames -= 1;
    if (this.foregroundFrames <= 0) {
      if (this.foregroundFadeFrames && !this.foregroundFadeOut) {
        this.foregroundFrames = this.foregroundFadeFrames;
        this.foregroundFadeOut = true;
      } else {
        this.foregroundFadeFrames = 0;
        this.foregroundFrames = 0;
        this.foregroundColor = null;
        this.foregroundFadeOut = false;
      }
    }
  }

  getEffectData(effectNid: string): CombatEffectData | null {
    return getGame().db.combatEffects?.get(effectNid) ?? null;
  }

  getEffectFrameImages(effectNid: string): Map<string, ImageBitmap | HTMLCanvasElement> {
    let frames = this.effectFrames.get(effectNid);
    if (frames) return frames;
    frames = new Map();
    this.effectFrames.set(effectNid, frames);
    const target = frames;
    const game = getGame();
    const data = this.getEffectData(effectNid);
    if (data) {
      void loadEffectSpritesheet(game.resources, effectNid).then((img) => {
        if (!img) return;
        const palettes = game.db.combatPalettes as Map<string, PaletteData> | undefined;
        const palette = data.palettes.length ? palettes?.get(data.palettes[0][1]) ?? null : null;
        for (const [nid, canvas] of convertSpritesheetToFrames(img, data.frames, palette)) target.set(nid, canvas);
      }).catch(() => undefined);
    }
    return frames;
  }
}

function flipped(img: HTMLImageElement): Surface {
  const surf = new Surface(img.width, img.height);
  surf.ctx.save();
  surf.ctx.translate(img.width, 0);
  surf.ctx.scale(-1, 1);
  surf.ctx.drawImage(img, 0, 0);
  surf.ctx.restore();
  return surf;
}

// ---------------------------------------------------------------------------
// PromotionChoiceState / ClassChangeChoiceState
// ---------------------------------------------------------------------------

export class PromotionChoiceState extends State {
  readonly name: string = 'promotion_choice';
  override readonly transparent = false;
  override readonly showMap = false;

  protected request: PromotionRequest | null = null;
  classOptions: string[] = [];
  menu: Choice | null = null;
  childMenu: Choice | null = null;
  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private owner = new PromotionAnimOwner();
  private animations: (BattleAnimation | null)[] = [];
  private weaponIcons: string[][] = [];
  private leftPlatform: HTMLImageElement | null = null;
  private rightPlatform: Surface | null = null;
  animOffset = 120;
  private targetAnimOffset = false;
  currentDesc: Dialog | null = null;

  /** _get_choices */
  protected getChoices(unit: UnitObject, request: PromotionRequest): string[] {
    const game = getGame();
    return request.options.length ? [...request.options] : [...(game.db.classes.get(unit.klass)?.turns_into ?? [])];
  }

  protected nextState(): string {
    return 'promotion';
  }

  override start(): StateResult {
    const game = getGame();
    this.request = currentRequest();
    const request = this.request;
    if (!request) {
      game.state.back();
      return 'repeat';
    }
    const unit = request.unit;
    this.classOptions = this.getChoices(unit, request);
    request.options = [];
    if (!this.classOptions.length) {
      game.state.back();
      return 'repeat';
    }
    this.bg = new MenuBackground('settings_background', game.resources, true);
    preloadSprites(['promotion_description', 'menu_hand', 'menu_highlight', 'menu_gem_small', 'scroll_bar']);
    const names = this.classOptions.map((nid) => game.db.classes.get(nid)?.name ?? nid);
    this.menu = new Choice(game, names, [14, 13]);
    this.menu.setLimit(5);
    this.childMenu = null;

    this.animations = [];
    this.weaponIcons = [];
    for (const option of this.classOptions) {
      const anim = getUnarmedBattleAnim(game, unit, option);
      if (anim) anim.pair(this.owner, null, true, 0);
      this.animations.push(anim);
      const klass = game.db.classes.get(option);
      this.weaponIcons.push(Object.entries(klass?.wexp_gain ?? {})
        .filter(([, gain]) => Array.isArray(gain) && !!gain[0])
        .map(([nid]) => nid));
    }

    let platformType = 'Floor';
    if (game.tilemap && unit.position) {
      const terrainNid = game.tilemap.getTerrain(unit.position[0], unit.position[1]);
      platformType = game.db.terrain?.get(terrainNid)?.platform || 'Floor';
    }
    this.leftPlatform = null;
    this.rightPlatform = null;
    void loadPlatformImage(platformType, true).then((img) => {
      this.leftPlatform = img;
      this.rightPlatform = img ? flipped(img) : null;
    });

    this.animOffset = 120;
    this.targetAnimOffset = false;
    this.currentDesc = this.getDesc();
  }

  /** _get_desc: the class description typed into the description box. */
  private getDesc(): Dialog | null {
    const game = getGame();
    const klass = game.db.classes.get(this.classOptions[this.menu?.currentIndex ?? 0]);
    const desc = String(klass?.desc ?? '').replace(/\n/g, '{br}');
    return new Dialog(desc, '', undefined, undefined, undefined, false, {
      position: [6, 112],
      textWidth: WINWIDTH - 28,
      background: null,
      fontType: 'convo',
      fontColor: 'white',
      drawCursor: false,
      messageTail: null,
    });
  }

  private changed(): void {
    this.targetAnimOffset = true;
    this.currentDesc = this.getDesc();
  }

  /** menus.Choice(selection, ['Change', 'Cancel'], self.menu) placement. */
  private childTopleft(): [number, number] {
    const menu = this.menu as Choice;
    const [px, py] = menu.getTopleft();
    if (px < WINWIDTH / 2) {
      return [px - 20 + menu.getMenuWidth(), py + menu.currentIndex * 16 + 4 - menu.scroll * 16];
    }
    return [WINWIDTH - 40 - menu.getMenuWidth(), py + menu.currentIndex * 16 + 8 - menu.scroll * 16];
  }

  /** _proceed: memory next_class, transition_to_with_pop into 'promotion'. */
  protected proceed(nextClass: string): void {
    const game = getGame();
    const request = this.request as PromotionRequest;
    request.nextClass = nextClass;
    game.memory.set(REQUEST_KEY, request);
    if (request.popBelow) game.memory.delete('item_use_item');
    game.state.back();
    for (let i = 0; i < request.popBelow; i++) game.state.back();
    game.state.change(this.nextState());
  }

  override takeInput(event: InputEvent): StateResult {
    const menu = this.menu;
    if (!menu || !this.request) return;
    const game = getGame();
    if (game.input?.mouseMoved && !this.childMenu) {
      const [gx, gy] = game.input.getGameMousePos();
      const before = menu.currentIndex;
      const origin = MenuScene.origin();
      menu.handleMouse(gx, gy, origin.x, origin.y);
      if (menu.currentIndex !== before) this.changed();
    }
    if (event === 'DOWN') {
      if (this.childMenu) {
        if (this.childMenu.moveDown(true)) sfx('Select 6');
      } else {
        if (menu.moveDown(true)) sfx('Select 6');
        this.changed();
      }
    } else if (event === 'UP') {
      if (this.childMenu) {
        if (this.childMenu.moveUp(true)) sfx('Select 6');
      } else {
        if (menu.moveUp(true)) sfx('Select 6');
        this.changed();
      }
    } else if (event === 'BACK') {
      if (this.childMenu) {
        sfx('Select 4');
        this.childMenu = null;
      } else if (this.request.canGoBack) {
        // Python opens the choice from Promote.end_combat, after the item's
        // combat spent the use (a broken item is removed), applied
        // HasAttacked and ran handle_state_stack: Canto pushed 'move' with
        // SetMovementLeft(canto_movement), otherwise the stack cleared to
        // free + wait. BACK pops to that state with HasNotAttacked +
        // reverse_use, so the unit can still act and reverse_use gives the
        // broken item back at the end of the inventory. The web spends
        // nothing before Change; it replays those net effects. A base (prep)
        // use returns to its screen.
        sfx('Select 4');
        game.memory.delete(REQUEST_KEY);
        game.state.back();
        if (this.request.popBelow) {
          const use = this.request.itemUse;
          const unit = use?.actor ?? this.request.unit;
          const canto = use ? itemUseCantoMovement(game, unit, this.request.unit) : null;
          if (use && use.item.maxUses > 0 && use.item.uses <= 1 &&
              !use.item.hasComponent('no_break_out_of_uses') && unit.items.includes(use.item)) {
            game.actionLog.doAction(new RemoveItemFromUnitAction(unit, use.item));
            game.actionLog.doAction(new GiveItemAction(unit, use.item));
          }
          game.memory.delete('item_use_item');
          game.highlight?.clear?.();
          game._moveOrigin = null;
          game._moveAction = null;
          game.selectedUnit = null;
          if (unit.position) game.cursor?.setPos?.(unit.position[0], unit.position[1]);
          game.state.clear();
          game.state.change('free');
          if (canto !== null) {
            game.actionLog.doAction(new SetMovementLeftAction(unit, canto));
            game.selectedUnit = unit;
            game.state.change('move');
          }
          game.actionLog.doAction(new MarkActionGroupEnd('menu'));
        }
      } else {
        sfx('Error');
      }
    } else if (event === 'SELECT') {
      if (this.childMenu) {
        if (this.childMenu.getCurrentText() === 'Change') {
          sfx('Select 1');
          this.proceed(this.classOptions[menu.currentIndex]);
        } else {
          sfx('Select 4');
          this.childMenu = null;
        }
      } else {
        sfx('Select 1');
        this.childMenu = new Choice(game, ['Change', 'Cancel'], this.childTopleft());
      }
    }
  }

  override update(): StateResult {
    this.menu?.update();
    this.childMenu?.update();
    this.currentDesc?.update();
    this.bg?.update();
    if (this.targetAnimOffset) {
      this.animOffset += 8;
      if (this.animOffset >= 120) {
        this.targetAnimOffset = false;
        this.animOffset = 120;
      }
    } else if (this.animOffset > 0) {
      this.animOffset = Math.max(0, this.animOffset - 8);
    }
    this.animations[this.menu?.currentIndex ?? 0]?.update();
  }

  override draw(surf: Surface): Surface {
    if (!this.menu) return surf;
    const game = getGame();
    this.bg?.draw(surf);
    const scene = this.scene.begin();
    const top = WINHEIGHT - 72;
    const index = this.menu.currentIndex;
    if (this.leftPlatform && this.rightPlatform) {
      scene.blitImage(this.leftPlatform, 0, 0, this.leftPlatform.width, this.leftPlatform.height,
        WINWIDTH / 2 - this.leftPlatform.width + this.animOffset + 52, top);
      scene.blit(this.rightPlatform, WINWIDTH / 2 + this.animOffset + 52, top);
    }
    this.animations[index]?.draw(scene, [this.animOffset + 12, 0]);

    // Class reel ('class' font; the fork's class-purple is the same sheet).
    blitText(scene, 'class', this.menu.getCurrentText() ?? '', 114, 5);
    this.weaponIcons[index]?.forEach((weapon, idx) => {
      const wdef = (game.db.weapons ?? []).find((w: any) => w.nid === weapon);
      if (wdef?.icon_nid) drawIcon16(scene, wdef.icon_nid, wdef.icon_index ?? [0, 0], 130 + 16 * idx, 32);
    });

    this.menu.draw(scene);
    this.childMenu?.draw(scene);
    blitSprite(scene, getSprite('promotion_description'), 6, 112);
    this.currentDesc?.draw(scene);
    this.scene.present(surf);
    return surf;
  }
}

export class ClassChangeChoiceState extends PromotionChoiceState {
  override readonly name: string = 'class_change_choice';

  /** ClassChangeChoiceState._get_choices */
  protected override getChoices(unit: UnitObject, request: PromotionRequest): string[] {
    const game = getGame();
    let options: string[];
    if (request.options.length) {
      options = [...request.options];
    } else if (!unit.generic) {
      const prefab = game.db.units.get(unit.nid) as any;
      options = (Array.isArray(prefab?.alternate_classes) ? prefab.alternate_classes : [])
        .filter((nid: string) => nid !== unit.klass);
    } else {
      options = [...game.db.classes.keys()].filter((nid: string) => nid !== unit.klass);
    }
    if (game.db.getConstant('class_change_same_tier', false)) {
      const tier = game.db.classes.get(unit.klass)?.tier;
      options = options.filter((nid) => game.db.classes.get(nid)?.tier === tier);
    }
    return options;
  }

  protected override nextState(): string {
    return 'class_change';
  }
}

// ---------------------------------------------------------------------------
// PromotionState / ClassChangeState (+ ExpState 'promote' level screen)
// ---------------------------------------------------------------------------

type PromotionPhase = 'init' | 'right' | 'left' | 'wait' | 'level_screen' | 'leave' | 'done';

export class PromotionState extends State {
  readonly name: string = 'promotion';
  override readonly transparent = false;
  override readonly showMap = false;

  protected request: PromotionRequest | null = null;
  phase: PromotionPhase = 'init';
  private phaseFrames = 0;
  private owner = new PromotionAnimOwner();
  rightBattleAnim: BattleAnimation | null = null;
  leftBattleAnim: BattleAnimation | null = null;
  currentBattleAnim: BattleAnimation | null = null;
  private platform: HTMLImageElement | null = null;
  private platformFlipped: Surface | null = null;
  private nameTag: Surface | null = null;
  private bgImage: HTMLImageElement | null = null;
  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private darkenUiBackground = 0;
  private song: Promise<unknown> | null = null;
  private portrait: HTMLImageElement | null = null;
  /** The map item use's Canto, decided before the class changes (Python handle_state_stack). */
  private itemUseCanto: number | null = null;
  /** Mirrors EventState's level presentation for diagnostics/tests. */
  levelUpPresentation: { screen: LevelUpScreen; statChanges: Record<string, number>; source: string } | null = null;

  protected kind(): PromotionKind {
    return 'promote';
  }

  override start(): StateResult {
    const game = getGame();
    this.request = currentRequest();
    const request = this.request;
    game.memory.delete(REQUEST_KEY);
    if (!request?.nextClass) {
      game.state.back();
      return 'repeat';
    }
    const unit = request.unit;
    this.levelUpPresentation = null;
    this.darkenUiBackground = 0;

    // MockCombat.create_background: a static promotion_background, else the
    // scrolling default_background.
    this.bgImage = null;
    this.bg = null;
    void game.resources?.loadImage?.('resources/panoramas/promotion_background.png')
      .then((img: HTMLImageElement) => { this.bgImage = img; })
      .catch(() => { this.bg = new MenuBackground('default_background', game.resources, true); });

    // Music: '_music_promotion' game var, else the music_promotion constant.
    const musicKey = this.kind() === 'promote' ? 'music_promotion' : 'music_class_change';
    const song = game.gameVars?.get?.(`_${musicKey}`) || game.db.getConstant(musicKey, null);
    this.song = song && game.audioManager?.battleFadeIn ? game.audioManager.battleFadeIn(song, 50) : null;

    this.rightBattleAnim = getUnarmedBattleAnim(game, unit);
    this.leftBattleAnim = getUnarmedBattleAnim(game, unit, request.nextClass);
    this.currentBattleAnim = this.rightBattleAnim;

    this.platform = null;
    this.platformFlipped = null;
    void loadPlatformImage('Floor', true).then((img) => {
      this.platform = img;
      this.platformFlipped = img ? flipped(img) : null;
    });

    const color = game.db.teams?.defs?.find((team: { nid: string }) => team.nid === unit.team)?.combatColor ?? 'blue';
    preloadSprites([`combat_name_right_${color}`, 'bg_black']);
    this.nameTag = null;
    this.buildNameTag(color);
    void game.resources?.loadPortrait?.(unit.portraitNid ?? unit.nid)
      ?.then?.((img: HTMLImageElement) => { this.portrait = img; })?.catch?.(() => undefined);

    this.phase = 'init';
    this.phaseFrames = 0;
    if (!this.rightBattleAnim || !this.leftBattleAnim) {
      this.finalize();
    } else {
      this.leftBattleAnim.pair(this.owner, this.rightBattleAnim, false, 0);
      this.rightBattleAnim.pair(this.owner, this.leftBattleAnim, true, 0);
    }
  }

  private buildNameTag(color: string): void {
    const sprite = getSprite(`combat_name_right_${color}`);
    const unit = this.request?.unit;
    if (!sprite || !unit) return;
    const tag = new Surface(sprite.width, sprite.height);
    tag.blitImage(sprite, 0, 0, sprite.width, sprite.height, 0, 0);
    blitText(tag, 'text-brown', unit.name, 36 - Math.floor(textWidth('text-brown', unit.name) / 2), 8);
    this.nameTag = tag;
  }

  /** start_anim: the effect on the current animation's Attack pose. */
  private startAnim(effectNid: string): void {
    const anim = this.currentBattleAnim;
    const effect = anim?.getEffect(effectNid, false, 'Attack');
    if (anim && effect) anim.addEffect(effect);
  }

  /** _finalize: on to the level screen (ExpState 'promote'/'class_change'). */
  private finalize(): void {
    this.phase = 'level_screen';
    this.phaseFrames = 0;
    this.applyPromotion();
  }

  /** ExpState 'promote': apply the class change, then show the level screen. */
  private applyPromotion(): void {
    const game = getGame();
    const request = this.request as PromotionRequest;
    const unit = request.unit;
    const use = request.itemUse;
    if (use) {
      if (use.baseUse) game.actionLog.doAction(new MarkActionGroupStart(use.actor, 'item_use'));
      applyItemStartResourceHooks(game, use.actor, use.item);
      // Python decides Canto at combat end, before Promote.end_combat opens
      // these screens, so the old class's skills count.
      this.itemUseCanto = use.baseUse ? null : itemUseCantoMovement(game, use.actor, unit);
    }
    const oldLevel = unit.level;
    const { statChanges } = performPromotionOrClassChange(
      unit,
      request.nextClass as string,
      game,
      this.kind() === 'promote' ? 'promote' : 'change_class',
    );
    void game.loadMapSpriteForUnit?.(unit);
    this.darkenUiBackground = 1;
    const screen = new LevelUpScreen(
      unit,
      statChanges,
      oldLevel,
      unit.level,
      game.db?.stats ?? [],
      game.audioManager,
      this.portrait,
      game.db.classes?.get(unit.klass)?.name ?? unit.klass,
      createPixelAnimation,
    );
    this.levelUpPresentation = { screen, statChanges: { ...statChanges }, source: this.kind() };
  }

  /** Trigger a level-screen hook; queued events run above this state. */
  private fireLevelUpTrigger(type: 'during_unit_level_up' | 'unit_level_up'): void {
    const game = getGame();
    const presentation = this.levelUpPresentation;
    const queue = game.eventManager?.eventQueue as unknown[] | undefined;
    if (!presentation || !queue || !this.request) return;
    const before = queue.length;
    game.eventManager.trigger(
      {
        type,
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: this.request.unit.nid,
        unit1: this.request.unit,
        statChanges: { ...presentation.statChanges },
        source: presentation.source,
      },
      { game, unit1: this.request.unit, gameVars: game.gameVars, levelVars: game.levelVars },
    );
    const events = queue.splice(before);
    runEventsBeforeWaiting(game, events as any[], true);
  }

  override update(): StateResult {
    const game = getGame();
    this.bg?.update();
    if (this.phase === 'level_screen') {
      const presentation = this.levelUpPresentation;
      if (!presentation) return;
      const result = presentation.screen.update(performance.now());
      if (result === 'entered_level_up_wait') {
        this.fireLevelUpTrigger('during_unit_level_up');
      } else if (result === 'done') {
        const use = this.request?.itemUse;
        if (use && this.request) {
          finishCoreItemUse(
            use.actor, use.item, [this.request.unit], new Map(), use.baseUse, true,
            new Map(), use.baseUse ? undefined : this.itemUseCanto,
          );
        }
        this.fireLevelUpTrigger('unit_level_up');
        this.levelUpPresentation = null;
        this.darkenUiBackground = -3;
        this.phase = 'leave';
        this.phaseFrames = 0;
      }
      return;
    }

    this.phaseFrames += 1;
    if (this.phase === 'init') {
      if (this.phaseFrames > 25) {
        this.phase = 'right';
        this.phaseFrames = 0;
        this.startAnim('Promotion1');
      }
    } else if (this.phase === 'right') {
      if (!this.currentBattleAnim?.childEffects.length) {
        this.currentBattleAnim = this.leftBattleAnim;
        this.phase = 'left';
        this.phaseFrames = 0;
        this.startAnim('Promotion2');
      }
    } else if (this.phase === 'left') {
      if (!this.currentBattleAnim?.childEffects.length) {
        this.phase = 'wait';
        this.phaseFrames = 0;
      }
    } else if (this.phase === 'wait') {
      if (this.phaseFrames > 100) this.finalize();
    } else if (this.phase === 'leave') {
      if (this.phaseFrames > 10) {
        this.phase = 'done';
        if (this.song) {
          const pending = this.song;
          this.song = null;
          void pending.then((song: any) => { if (song) void game.audioManager?.battleFadeBack?.(song); });
        }
        game.state.back();
        return 'repeat';
      }
    }
    this.currentBattleAnim?.update();
  }

  /** MockCombat.color_ui on the platforms/name-tag layer. */
  private colorUi(surf: Surface): void {
    if (!this.darkenUiBackground) return;
    this.darkenUiBackground = Math.min(this.darkenUiBackground, 4);
    const color = 255 - Math.abs(this.darkenUiBackground * 24);
    const ctx = surf.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${color},${color},${color})`;
    ctx.fillRect(0, 0, surf.canvas.width, surf.canvas.height);
    ctx.restore();
    this.darkenUiBackground += 1;
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    if (this.bgImage) {
      surf.fill(0, 0, 0);
      const bgOrigin = MenuScene.origin();
      surf.blitImage(this.bgImage, 0, 0, this.bgImage.width, this.bgImage.height,
        bgOrigin.x + Math.floor((WINWIDTH - this.bgImage.width) / 2), bgOrigin.y + Math.floor((WINHEIGHT - this.bgImage.height) / 2));
    } else if (this.bg) {
      this.bg.draw(surf);
    } else {
      surf.fill(0, 0, 0);
    }
    // Additive effect frames and screen flashes blend with the background,
    // so the scene starts from the background under it.
    const scene = this.scene.begin();
    const origin = MenuScene.origin();
    scene.blitFrom(surf, origin.x, origin.y, WINWIDTH, WINHEIGHT, 0, 0);
    const combat = new Surface(WINWIDTH, WINHEIGHT);
    const top = WINHEIGHT - 72;
    if (this.platform && this.platformFlipped) {
      combat.blitImage(this.platform, 0, 0, this.platform.width, this.platform.height, WINWIDTH / 2 - this.platform.width, top);
      combat.blit(this.platformFlipped, WINWIDTH / 2, top);
    }
    if (!this.nameTag) {
      const color = game.db.teams?.defs?.find((team: { nid: string }) => team.nid === this.request?.unit.team)?.combatColor ?? 'blue';
      this.buildNameTag(color);
    }
    if (this.nameTag) combat.blit(this.nameTag, WINWIDTH + 3 - this.nameTag.width, 0);
    // Darken only drawn pixels, as BLEND_RGB_MULT leaves alpha alone.
    if (this.darkenUiBackground) {
      const tinted = new Surface(WINWIDTH, WINHEIGHT);
      tinted.blit(combat, 0, 0);
      this.colorUi(tinted);
      const ctx = tinted.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(combat.canvas, 0, 0);
      ctx.restore();
      scene.blit(tinted, 0, 0);
    } else {
      scene.blit(combat, 0, 0);
    }
    this.currentBattleAnim?.draw(scene);
    this.owner.drawForeground(scene);
    this.scene.present(surf);
    this.levelUpPresentation?.screen.draw(surf, performance.now());
    return surf;
  }
}

export class ClassChangeState extends PromotionState {
  override readonly name: string = 'class_change';

  protected override kind(): PromotionKind {
    return 'class_change';
  }
}
