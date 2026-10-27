/**
 * hud.ts — On-map UI. Port of lt-maker/app/engine/ui_view.py (UIView).
 *
 * Python draws this at the end of MapView.draw, on the 240x160 scene, built
 * from engine sprites (tile_info_quick_opaque, unit_info_bg, attack_info_*,
 * spell_window*, ...) and bitmap fonts. The web scene can be wider/taller
 * than 240x160 (src/engine/viewport.ts), so WINWIDTH/WINHEIGHT/TILEX/TILEY
 * read the live viewport; every offset is otherwise Python's.
 *
 * Elements:
 *   - unit info (top-left / bottom-left, slides 20 px per frame)
 *   - tile info (bottom corner opposite the cursor, 4-frame slide out/in)
 *   - simple objective (top-right / bottom-right, slides 10 px per frame)
 *   - initiative strip (when the `initiative` constant is on)
 *   - attack forecast (draw_attack_info) and spell forecast (draw_spell_info),
 *     drawn by the targeting states
 */

import { Surface } from '../engine/surface';
import { FRAMETIME, TILEWIDTH, TILEHEIGHT, getFrameCount } from '../engine/constants';
import { viewport } from '../engine/viewport';
import { FONT } from '../rendering/bmp-font';
import type { BmpFont } from '../rendering/bmp-font';
import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { ResourceManager } from '../data/resource-manager';
import { getSprite, makeTranslucent, preloadSprites, skinnedSpriteName } from './sprites';
import { isForkEngine } from '../engine/engine-flavor';
import { createBaseSurf, getMenuBgSpriteSync } from './base-surf';
import { drawItemIcon, getIconSheet } from './icons';
import { getSetting } from '../engine/states/settings-state';
import { getTerrainBonuses } from '../combat/terrain-bonuses';
import { evaluateTextTag, pythonStr } from '../events/event-manager';
import {
  canCounterattack, canDefenderDouble, canDouble, computeAssistDamage, computeBlitzPhases,
  computeCrit, computeDamage, computeExtraAttackPhases, computeHit, computeStrikeCount,
  getEquippedWeapon, damage as itemDamage, weaponTriangle,
} from '../combat/combat-calcs';
import { checkEnemy, unitHasTag } from '../combat/skill-system';
import { itemIconWhiteness } from '../combat/item-system';
import { drawItemOption, unitStandFrame } from './prep-ui';

/** Sprites the HUD needs on the first map frame (Python loads all at boot). */
const HUD_SPRITES = [
  'tile_info_quick_opaque', 'tile_info_destructible_opaque', 'icon_attackable_terrain',
  'unit_info_bg', 'unit_info_hp', 'unit_info_slash', 'health_bar2_bg', 'health_bar2', 'info_equipment_highlight',
  'menu_shimmer1', 'menu_shimmer2', 'combat_gem_blue', 'menu_gem_small',
  'attack_info_red', 'attack_info_crit_red', 'attack_info_purple', 'attack_info_crit_purple',
  'blue_100', 'arrow_advantage', 'x2', 'x3', 'x4', 'x5',
  'spell_window1', 'spell_window2', 'spell_window3', 'spell_window4', 'spell_window5',
  'initiative_platform', 'map_health_outline', 'map_health_bar', 'health_bar', 'phase_transition',
  'turnbanner_player', 'turnbanner_enemy', 'turnbanner_enemy2', 'turnbanner_other',
  ...['blue', 'red', 'green', 'purple'].flatMap((color) => [
    `health_${color}`, `combat_stats_${color}`, `combat_stats_guard_${color}`, `combat_gem_${color}`,
  ]),
  'Minimap_Tiles', 'Minimap_Sprites', 'Minimap_Cursor',
  'marker_talk', 'marker_interact', 'marker_warning', 'marker_danger', 'marker_steal',
  'trade_window', 'rescue_window', 'give_window', 'pennant_bg',
  // EOtF project sprites for its engine's weather window.
  'Weather_Window', 'Sun_Icon', 'Rain_Icon', 'Sand_Icon', 'Snow_Icon',
];

/** Weather names with an icon in EOtF's weather window (anything else shows the sun). */
const WEATHER_ICONS: Record<string, string> = {
  Sun: 'Sun_Icon', Rain: 'Rain_Icon', Sand: 'Sand_Icon', Snow: 'Snow_Icon',
};

type Game = any;

/** The distinct opaque colours of a sprite, in scan order. */
function opaqueColors(surf: Surface): [number, number, number][] {
  const data = surf.getImageData().data;
  const seen = new Set<number>();
  const colors: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) continue;
    const packed = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (seen.has(packed)) continue;
    seen.add(packed);
    colors.push([data[i], data[i + 1], data[i + 2]]);
  }
  return colors;
}

/** A copy of `surf` with each opaque pixel moved to its nearest palette colour. */
function snapToPalette(surf: Surface, palette: [number, number, number][]): Surface {
  const out = surf.copy();
  if (!palette.length) return out;
  const image = out.getImageData();
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let best = palette[0];
    let bestDist = Infinity;
    for (const color of palette) {
      const dr = color[0] - data[i];
      const dg = color[1] - data[i + 1];
      const db = color[2] - data[i + 2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = color;
      }
    }
    data[i] = best[0];
    data[i + 1] = best[1];
    data[i + 2] = best[2];
  }
  out.putImageData(image);
  return out;
}

/** Python utils.frames2ms. */
const frames2ms = (frames: number): number => frames * FRAMETIME;

function font(nid: string): BmpFont | null {
  return FONT[nid] ?? null;
}

function blit(surf: Surface, src: Surface | null, x: number, y: number): void {
  if (src) surf.blit(src, x, y);
}

/** Python LevelCursor.get_hover: a visible, non-Tile unit under the cursor. */
function cursorHover(game: Game): UnitObject | null {
  const [x, y] = game.cursor.getPosition();
  const unit: UnitObject | null = game.board?.getUnit(x, y) ?? null;
  if (!unit || unitHasTag(unit, 'Tile') || !unit.position) return null;
  return inVision(game, [x, y]) ? unit : null;
}

function inVision(game: Game, pos: [number, number]): boolean {
  if (!game.board) return false;
  return game.board.inVision(pos, 'player', game.getCurrentFogInfo?.(), game.db, game.getAllUnits?.());
}

/** Python camera.get_x()/get_y() in tiles, and TILEX/TILEY of the live scene. */
function cameraTiles(game: Game): [number, number] {
  const [cx, cy] = game.camera.getPosition();
  return [cx / TILEWIDTH, cy / TILEHEIGHT];
}

/** Python `cursor.position[0] > TILEX // 2 + camera.get_x() - 1`. */
export function cursorOnRight(game: Game): boolean {
  const tileX = Math.floor(viewport.width / TILEWIDTH);
  return game.cursor.getPosition()[0] > Math.floor(tileX / 2) + cameraTiles(game)[0] - 1;
}

/** Python `cursor.position[1] < TILEY // 2 + camera.get_y()`. */
export function cursorOnTop(game: Game): boolean {
  const tileY = Math.floor(viewport.height / TILEHEIGHT);
  return game.cursor.getPosition()[1] < Math.floor(tileY / 2) + cameraTiles(game)[1];
}

/** Python `game.rng_mode == RNGOption.GRANDMASTER`. */
function isGrandmaster(game: Game): boolean {
  return game.rngMode === 'grandmaster';
}

function itemUses(item: ItemObject): number {
  return item.hasComponent('uses') ? item.uses : 100;
}

/** Top-level balanced `{...}` blocks of `text`, braces included (str_utils.matched_expr). */
function topLevelBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) blocks.push(text.slice(start, index + 1));
    }
  }
  return blocks;
}

/**
 * TextEvaluator._evaluate_phrase for the tags objectives use: `{v:}`/`{var:}`
 * and `{e:}`/`{eval:}`. Like Python's `re.match(r'\{e:[^{}]*\}')`, a phrase
 * that still holds braces after its inner blocks were evaluated (a variable
 * whose text contains braces) is passed back unevaluated; anything else is
 * left as it is.
 */
function evaluatePhrase(phrase: string, game: Game): string {
  const tag = phrase.match(/^\{(v|var|e|eval):([^{}]*)\}/);
  if (!tag) return phrase;
  const pattern = tag[1] === 'v' || tag[1] === 'var'
    ? /\{(?:v|var):([^{}]*)\}/g
    : /\{(?:e|eval):([^{}]*)\}/g;
  if (tag[1] === 'v' || tag[1] === 'var') {
    return phrase.replace(pattern, (_match, key: string) => {
      if (game.levelVars?.has(key)) return pythonStr(game.levelVars.get(key));
      if (game.gameVars?.has(key)) return pythonStr(game.gameVars.get(key));
      return '??';
    });
  }
  return phrase.replace(pattern, (_match, body: string) => {
    try {
      return evaluateTextTag(body, { game, gameVars: game.gameVars, levelVars: game.levelVars });
    } catch {
      return '??';
    }
  });
}

/** One balanced block: evaluate its inner blocks first, then the block itself. */
function evaluateBlock(block: string, game: Game): string {
  const inner = block.slice(1, -1);
  let resolved = '';
  let depth = 0;
  let start = -1;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) resolved += evaluateBlock(inner.slice(start, index + 1), game);
    } else if (depth === 0) {
      resolved += character;
    }
  }
  return evaluatePhrase(`{${resolved}}`, game);
}

/**
 * Python TextEvaluator._evaluate_all for objective strings: each top-level
 * `{...}` block is resolved innermost-first, then substituted (longest
 * first, every occurrence). Python stores an upstream objective unevaluated
 * and runs this on every draw (ui_view) and when the objective menu opens,
 * so variable changes show up live.
 */
export function evaluateText(text: string, game: Game): string {
  const pairs = topLevelBlocks(text).map((block) => [block, evaluateBlock(block, game)] as const);
  pairs.sort((left, right) => right[0].length - left[0].length);
  let result = text;
  for (const [block, value] of pairs) result = result.split(block).join(value);
  return result;
}

export class HUD {
  static readonly legalStates = ['free', 'prep_formation', 'prep_formation_select'];
  static readonly initiativeStates = ['status_endstep', 'turn_change', 'ai', 'phase_change', 'menu', 'turnwheel'];
  static readonly xPositions = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 5, 4, 3, 2, 1];
  static readonly yPositions = [0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0];

  /** Extra web kill-switch (combat hides it); Python relies on legal states. */
  visible = true;

  private resourceManager: ResourceManager | null = null;
  private chibis: Map<string, Surface | null> = new Map();
  /** menu_bg_base (the EOtF window skin's copy on the fork); null while loading. */
  private get menuBg(): HTMLImageElement | null { return getMenuBgSpriteSync('menu_bg_base'); }

  private unitInfoDisp: Surface | null = null;
  private tileInfoDisp: Surface | null = null;
  private objInfoDisp: Surface | null = null;
  private objInfoKey = '';
  private attackInfoDisp: Surface | null = null;
  private spellInfoDisp: Surface | null = null;
  private initiativeInfoDisp: Surface | null = null;

  private cursorRight = false;
  private unitInfoOffset = 0;
  private objInfoOffset = 0;
  attackInfoOffset = 0;
  private initiativeInfoOffset = 0;

  private tileTransitionState: 'normal' | 'out' | 'in' = 'normal';
  private tileProgress = 0;
  private tileLastUpdate = 0;
  private currentTilePos: [number, number] | null = null;

  private removeUnitInfo = true;
  /** The unit panel was built before all of its images had loaded. */
  private unitInfoPending: UnitObject | null = null;
  private prevUnitInfoTop = false;
  private objTop = false;

  private lastFrame = -1;
  private weatherInfo: { key: string; surf: Surface } | null = null;

  /** Where each element was last drawn ([x, y, w, h]), for tests. */
  layout: Record<string, [number, number, number, number]> = {};

  private place(surf: Surface, name: string, src: Surface, x: number, y: number): void {
    surf.blit(src, x, y);
    this.layout[name] = [x, y, src.width, src.height];
  }
  private lastCursor = '';

  constructor() {
    void preloadSprites(HUD_SPRITES);
    void this.menuBg;
  }

  setResourceManager(rm: ResourceManager): void {
    this.resourceManager = rm;
  }

  /** Python remove_unit_display (cursor moved, state left, ...). */
  removeUnitDisplay(): void {
    this.removeUnitInfo = true;
  }

  /** Engine time in ms, advanced by whole frames like Python's clock. */
  private now(): number {
    return getFrameCount() * FRAMETIME;
  }

  private update(game: Game): void {
    const currentTime = this.now();
    if (this.cursorRight !== cursorOnRight(game)) {
      this.cursorRight = cursorOnRight(game);
      this.tileTransitionState = 'out';
      this.tileProgress = 0;
      this.tileLastUpdate = currentTime;
    }
    if (this.tileTransitionState !== 'normal') {
      const diff = currentTime - this.tileLastUpdate;
      this.tileProgress = Math.max(0, Math.min(1, diff / frames2ms(4)));
      if (this.tileProgress >= 1) {
        this.tileProgress = 0;
        this.tileLastUpdate = currentTime;
        if (this.tileTransitionState === 'out') {
          this.tileTransitionState = 'in';
          this.currentTilePos = game.cursor.getPosition();
        } else {
          this.tileTransitionState = 'normal';
        }
      }
    } else {
      this.currentTilePos = game.cursor.getPosition();
    }
  }

  /**
   * Python UIView.draw. Called at the end of every map draw; the per-frame
   * slide offsets advance once per engine frame even if the map is drawn
   * more than once in a frame.
   */
  draw(surf: Surface, game: Game): Surface {
    if (!game?.board || !game.cursor) return surf;
    const frame = getFrameCount();
    const newFrame = frame !== this.lastFrame;
    this.layout = {};
    this.lastFrame = frame;
    const current: string = game.state.getCurrentState()?.name ?? '';
    const legal = HUD.legalStates.includes(current) && this.visible;
    const winW = viewport.width;
    const winH = viewport.height;

    if (newFrame) {
      // Python LevelCursor.move/set_pos call remove_unit_display.
      const cursorKey = game.cursor.getPosition().join(',');
      if (cursorKey !== this.lastCursor) {
        this.lastCursor = cursorKey;
        this.removeUnitInfo = true;
      }
      this.update(game);

      // Unit info handling
      if (this.removeUnitInfo) {
        const hover = cursorHover(game);
        if (legal && hover) {
          this.removeUnitInfo = false;
          this.unitInfoDisp = this.createUnitInfo(hover, game);
          this.unitInfoOffset = Math.min(this.unitInfoDisp.width, this.unitInfoOffset);
        } else if (this.unitInfoDisp) {
          this.unitInfoOffset += 20;
          if (this.unitInfoOffset >= 200) this.unitInfoDisp = null;
        }
      } else {
        this.unitInfoOffset = Math.max(0, this.unitInfoOffset - 20);
        // Python loads every image at boot; rebuild until ours have arrived.
        if (this.unitInfoPending) this.unitInfoDisp = this.createUnitInfo(this.unitInfoPending, game);
      }

      // Objective info handling
      if (legal && this.settingOn('show_objective')) {
        this.objInfoDisp = this.createObjInfo(game);
        this.objInfoOffset = Math.max(0, this.objInfoOffset - 10);
      } else if (this.objInfoDisp) {
        this.objInfoOffset += 10;
        if (this.objInfoOffset >= 100) this.objInfoDisp = null;
      }

      const initiativeOn = !!game.db.getConstant('initiative', false);
      if ((legal || HUD.initiativeStates.includes(current)) && initiativeOn &&
          !game.isRoam?.() && game.initiative?.drawMe) {
        this.initiativeInfoDisp = this.createInitiativeInfo(game);
        this.initiativeInfoOffset = Math.max(0, this.initiativeInfoOffset);
      } else if (this.initiativeInfoDisp && this.initiativeInfoOffset >= 200) {
        this.initiativeInfoDisp = null;
      }
      if (initiativeOn && !game.initiative?.drawMe) this.initiativeInfoDisp = null;
    }

    const initiativeOn = !!game.db.getConstant('initiative', false);

    // === Final drawing
    if (legal && this.unitInfoDisp && (!initiativeOn || !game.initiative?.drawMe)) {
      const disp = this.unitInfoDisp;
      if (this.removeUnitInfo) {
        if (this.prevUnitInfoTop) this.place(surf, 'unit', disp, 0 - this.unitInfoOffset, 0);
        else this.place(surf, 'unit', disp, 0 - this.unitInfoOffset, winH - disp.height);
      } else if (cursorOnTop(game) && !cursorOnRight(game)) {
        this.prevUnitInfoTop = false;
        this.place(surf, 'unit', disp, 0 - this.unitInfoOffset, winH - disp.height);
      } else {
        this.prevUnitInfoTop = true;
        this.place(surf, 'unit', disp, 0 - this.unitInfoOffset, 0);
      }
    }

    // Terrain, with GBA / Thracia / Hybrid fog rules.
    const cursorPos: [number, number] = game.cursor.getPosition();
    if (legal && this.settingOn('show_terrain') &&
        game.board.terrainKnown(cursorPos, inVision(game, cursorPos), game.getCurrentFogInfo?.())) {
      this.tileInfoDisp = this.createTileInfo(this.currentTilePos ?? cursorPos, game);
      const disp = this.tileInfoDisp;
      if (disp) {
        let right = this.cursorRight;
        let offset = 0;
        if (this.tileTransitionState === 'out') {
          right = !right;
          offset = disp.width * this.tileProgress;
        } else if (this.tileTransitionState === 'in') {
          offset = disp.width * (1 - this.tileProgress);
        }
        const top = !!this.initiativeInfoDisp && cursorOnTop(game);
        const y = top ? 0 : winH - disp.height - 3;
        if (right) this.place(surf, 'tile', disp, 5 - offset, y);
        else this.place(surf, 'tile', disp, winW - disp.width - 5 + offset, y);
      }
    }

    // EOtF's engine adds a weather window (current -> next weather) just
    // above the terrain box, on the same side and sliding with it, whenever
    // the chapter's `current_weather` level var is set.
    const weather = game.levelVars?.get?.('current_weather') ?? 0;
    if (isForkEngine() && legal && this.settingOn('show_terrain') && weather !== 0) {
      const disp = this.createWeatherInfo(game);
      if (disp) {
        let right = this.cursorRight;
        let offset = 0;
        if (this.tileTransitionState === 'out') {
          right = !right;
          offset = disp.width * this.tileProgress;
        } else if (this.tileTransitionState === 'in') {
          offset = disp.width * (1 - this.tileProgress);
        }
        const y = winH - disp.height - 48;
        if (right) this.place(surf, 'weather', disp, 5 - offset, y);
        else this.place(surf, 'weather', disp, winW - disp.width - 5 + offset, y);
      }
    }

    // Only if we actually have a simple objective
    if (this.objInfoDisp && !this.initiativeInfoDisp && game.currentLevel?.objective?.simple) {
      const disp = this.objInfoDisp;
      if (cursorOnTop(game) && cursorOnRight(game)) {
        if (this.objTop) {
          this.objTop = false;
          this.objInfoOffset = disp.height;
        }
        this.place(surf, 'objective', disp, winW - 4 - disp.width, winH - 4 + this.objInfoOffset - disp.height);
      } else {
        if (!this.objTop) {
          this.objTop = true;
          this.objInfoOffset = disp.height;
        }
        this.place(surf, 'objective', disp, winW - 4 - disp.width, 1 - this.objInfoOffset);
      }
    }

    if (this.initiativeInfoDisp) {
      const disp = this.initiativeInfoDisp;
      if (cursorOnTop(game)) {
        this.initiativeInfoOffset = disp.height;
        this.place(surf, 'initiative', disp, 0, winH - disp.height);
      } else {
        this.place(surf, 'initiative', disp, 0, 0);
      }
    }
    return surf;
  }

  private settingOn(name: string): boolean {
    const value = getSetting(name);
    return value === undefined || value === 'ON' || value === 1 || value === true;
  }

  private createInitiativeInfo(game: Game): Surface {
    const xIncrement = 20;
    const surf = new Surface(viewport.width, 40);
    surf.fillRect(0, 0, viewport.width, 40, `rgba(0,0,0,${(255 - Math.trunc(255 * 0.75)) / 255})`);
    const initiative = game.initiative;
    const currentNid = initiative.getCurrentUnitNid?.() ?? null;
    const currentIdx: number = initiative.currentIdx ?? 0;
    const line: string[] = initiative.unitLine ?? [];
    const minScroll = Math.max(currentIdx - 9, 0);
    const maxScroll = Math.min(currentIdx + 10, line.length);
    const platform = getSprite('initiative_platform');
    line.slice(minScroll, maxScroll).forEach((nid, idx) => {
      const yOffset = nid === currentNid ? 10 : 0;
      blit(surf, platform, idx * xIncrement, 8 + yOffset);
      const frame = game.unitRenderer?.getSprite(nid)?.getCurrentFrame?.() as Surface | undefined;
      if (frame) surf.blit(frame, -17 + idx * xIncrement, -19 + yOffset);
    });
    return surf;
  }

  /** Python icons.get_chibi: the 32x32 at (width - 32, 16), colorkeyed. */
  private getChibi(nid: string): Surface | null {
    if (this.chibis.has(nid)) return this.chibis.get(nid) ?? null;
    this.chibis.set(nid, null);
    this.resourceManager?.loadPortrait(nid).then((img) => {
      const chibi = new Surface(32, 32);
      chibi.ctx.drawImage(img, img.width - 32, 16, 32, 32, 0, 0, 32, 32);
      const data = chibi.getImageData();
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i] === 128 && data.data[i + 1] === 160 && data.data[i + 2] === 128) data.data[i + 3] = 0;
      }
      chibi.putImageData(data);
      this.chibis.set(nid, chibi);

    }).catch(() => {
      // Missing portrait: draw nothing, but stop waiting for it.
      this.chibis.set(nid, new Surface(1, 1));
    });
    return null;
  }

  /**
   * EOtF engine fork's ui_view.create_unit_info: a taller unit_info_bg
   * (123x60) with HP on the bottom row, the name under a row of every item
   * icon, and info_equipment_highlight under the equipped weapon.
   */
  private createForkUnitInfo(unit: UnitObject, game: Game): Surface {
    const fnt = font('info-grey');
    let complete = !!fnt;
    const need = <T,>(value: T | null): T | null => {
      if (!value) complete = false;
      return value;
    };
    const bg = need(getSprite('unit_info_bg'));
    const surf = bg ? bg.copy() : new Surface(123, 60);
    const top = 4;
    const left = 6;
    if (unit.generic) {
      const faction = unit.faction ? game.db.factions?.get(unit.faction) : null;
      if (faction) {
        const sheet = need(getIconSheet(faction.icon_nid, '32'));
        if (sheet) {
          surf.blitImage(sheet as HTMLImageElement, faction.icon_index[0] * 32, faction.icon_index[1] * 32, 32, 32,
            left + 1, top + 4);
        }
      }
    } else if (unit.portraitNid) {
      blit(surf, need(this.getChibi(unit.portraitNid)), left + 1, top + 4);
    }

    blit(surf, need(getSprite('unit_info_hp')), left + 1, top + 37);
    blit(surf, need(getSprite('unit_info_slash')), left + 34, top + 38);
    const currentHp = unit.currentHp;
    const maxHp = unit.maxHp;
    if (fnt) {
      fnt.blitRight(surf, currentHp > 99 ? '??' : String(currentHp), left + 33, top + 33);
      fnt.blitRight(surf, maxHp > 99 ? '??' : String(maxHp), left + 57, top + 33);
    }

    blit(surf, need(getSprite('health_bar2_bg')), left + 57, top + 39);
    const hpRatio = maxHp > 0 ? Math.max(0, Math.min(1, currentHp / maxHp)) : 0;
    const hpSurf = need(getSprite('health_bar2'));
    if (hpRatio > 0 && hpSurf) {
      const idx = Math.trunc(hpRatio * hpSurf.width);
      if (idx > 0) surf.blitFrom(hpSurf, 0, 0, idx, 2, left + 58, top + 40);
    }

    const weapon = getEquippedWeapon(unit, game.db, game);
    let itNum = 0;
    for (const item of unit.items) {
      if (!item.iconNid) continue;
      need(getIconSheet(item.iconNid, '16'));
      const x = left + itNum * 16 + 32;
      if (item === weapon) blit(surf, need(getSprite('info_equipment_highlight')), x, top + 14);
      drawItemIcon(surf, item, x, top + 4);
      itNum += 1;
    }

    let name = unit.name;
    if (unit.generic) {
      const shortName = game.db.classes?.get(unit.klass)?.name ?? unit.klass;
      name = `${shortName} ${unit.level}`;
    }
    if (fnt) fnt.blit(surf, name, left + 34, top + 20);
    this.unitInfoPending = complete ? null : unit;
    return surf;
  }

  private createUnitInfo(unit: UnitObject, game: Game): Surface {
    if (isForkEngine()) return this.createForkUnitInfo(unit, game);
    const fnt = font('info-grey');
    const width = 112;
    const height = 40;
    let complete = !!fnt;
    const need = <T,>(value: T | null): T | null => {
      if (!value) complete = false;
      return value;
    };
    const bg = need(getSprite('unit_info_bg'));
    const surf = bg ? bg.copy() : new Surface(122, 48);
    const top = 4;
    const left = 6;
    if (!unit.portraitNid && unit.faction) {
      const faction = game.db.factions?.get(unit.faction);
      if (faction) {
        const sheet = need(getIconSheet(faction.icon_nid, '32'));
        if (sheet) {
          surf.blitImage(sheet as HTMLImageElement, faction.icon_index[0] * 32, faction.icon_index[1] * 32, 32, 32,
            left + 1, top + 4);
        }
      }
    } else if (unit.portraitNid) {
      blit(surf, need(this.getChibi(unit.portraitNid)), left + 1, top + 4);
    }

    let name = unit.name;
    if (!name) {
      const shortName = game.db.classes?.get(unit.klass)?.name ?? unit.klass;
      name = `${shortName} ${unit.level}`;
    }
    if (fnt) fnt.blit(surf, name, left + Math.floor(width / 2) + 6 - Math.floor(fnt.width(name) / 2), top + 4);

    blit(surf, need(getSprite('unit_info_hp')), left + 34, top + height - 20);
    blit(surf, need(getSprite('unit_info_slash')), left + 66, top + height - 19);
    const currentHp = unit.currentHp;
    const maxHp = unit.maxHp;
    if (fnt) {
      fnt.blitRight(surf, String(currentHp), left + 66, top + 16);
      fnt.blitRight(surf, String(maxHp), left + 90, top + 16);
    }

    blit(surf, need(getSprite('health_bar2_bg')), left + 36, top + height - 10);
    const hpRatio = maxHp > 0 ? Math.max(0, Math.min(1, currentHp / maxHp)) : 0;
    const hpSurf = need(getSprite('health_bar2'));
    if (hpRatio > 0 && hpSurf) {
      const idx = Math.trunc(hpRatio * hpSurf.width);
      if (idx > 0) surf.blitFrom(hpSurf, 0, 0, idx, 2, left + 37, top + height - 9);
    }

    const weapon = getEquippedWeapon(unit, game.db, game);
    if (weapon?.iconNid) {
      need(getIconSheet(weapon.iconNid, '16'));
      drawItemIcon(surf, weapon, left + width - 20, top + Math.floor(height / 2) - 8);
    }
    this.unitInfoPending = complete ? null : unit;
    return surf;
  }

  private createTileInfo(coord: [number, number], game: Game): Surface | null {
    const terrainNid = game.board.getTerrain(coord[0], coord[1]);
    const terrain = terrainNid ? game.db.terrain.get(terrainNid) : null;
    if (!terrain) return null;
    const currentUnit: UnitObject | null = game.board.getUnit(coord[0], coord[1]);
    const small = font('small');
    let bgSurf: Surface;
    if (currentUnit && unitHasTag(currentUnit, 'Tile')) {
      const base = getSprite('tile_info_destructible_opaque');
      if (!base) return null;
      bgSurf = makeTranslucent(base, 0.1);
      const atIcon = getSprite('icon_attackable_terrain');
      if (atIcon) bgSurf.blit(atIcon, 7, bgSurf.height - 7 - atIcon.height);
      small?.blitRight(bgSurf, String(currentUnit.currentHp), bgSurf.width - 9, 24);
    } else {
      const base = getSprite('tile_info_quick_opaque');
      if (!base) return null;
      bgSurf = makeTranslucent(base, 0.1);
      const [tileDef, tileAvoid] = getTerrainBonuses(terrain, game.db);
      small?.blitRight(bgSurf, String(tileDef), bgSurf.width - 4, 17);
      small?.blitRight(bgSurf, String(tileAvoid), bgSurf.width - 4, 25);
    }
    const text = font('text');
    if (text) {
      const name: string = terrain.name ?? '';
      text.blit(bgSurf, name, Math.floor(bgSurf.width / 2) - Math.floor(text.width(name) / 2), 22 - text.height);
    }
    return bgSurf;
  }

  /**
   * EOtF's weather window: the skinned 45x24 Weather_Window (opaque) with
   * the current weather's icon at x 3 and the next weather's at x 27, both
   * 3 px off the bottom; the arrow between them is part of the window art.
   *
   * The window ships as an 8-bit paletted PNG, and the engine blits the icons
   * onto a copy of that paletted surface, so every icon colour snaps to the
   * nearest window palette colour (squared RGB distance). Every palette entry
   * is used by the art, so the window's own opaque colours are its palette.
   */
  private createWeatherInfo(game: Game): Surface | null {
    const base = getSprite('Weather_Window');
    if (!base) return null;
    const vars = game.levelVars;
    const icons = [vars?.get?.('current_weather'), vars?.get?.('next_weather')]
      .map((weather) => WEATHER_ICONS[String(weather)] ?? 'Sun_Icon');
    const key = `${skinnedSpriteName('Weather_Window')}|${icons.join('|')}`;
    if (this.weatherInfo?.key === key) return this.weatherInfo.surf;
    const iconSurfs = icons.map((name) => getSprite(name));
    if (iconSurfs.some((icon) => !icon)) return base;
    const surf = base.copy();
    const palette = opaqueColors(base);
    iconSurfs.forEach((icon, idx) => {
      const snapped = snapToPalette(icon!, palette);
      surf.blit(snapped, idx === 0 ? 3 : 27, surf.height - 3 - snapped.height);
    });
    this.weatherInfo = { key, surf };
    return surf;
  }

  private createObjInfo(game: Game): Surface | null {
    const obj: string = game.currentLevel?.objective?.simple ?? '';
    if (!obj) return null;
    const lines = evaluateText(obj, game).split(',').map((line) => line.replace(/\{comma\}/g, ','));
    const key = `${skinnedSpriteName('menu_bg_base')}\n${lines.join('\n')}`;
    if (key === this.objInfoKey && this.objInfoDisp) return this.objInfoDisp;
    const text = font('text');
    if (!text || !this.menuBg) return this.objInfoDisp;
    const longest = Math.max(...lines.map((line) => text.width(line)));
    const bgSurf = createBaseSurf(this.menuBg, longest + 16, 16 * lines.length + 8);
    const shimmer = getSprite(lines.length === 1 ? 'menu_shimmer1' : 'menu_shimmer2');
    if (shimmer) bgSurf.blit(shimmer, bgSurf.width - 1 - shimmer.width, 4 + 16 * Math.max(lines.length - 2, 0));
    let surf = new Surface(bgSurf.width, bgSurf.height + 3);
    surf.blit(bgSurf, 0, 3);
    const gem = getSprite('combat_gem_blue');
    if (gem) surf.blit(gem, Math.floor(bgSurf.width / 2) - Math.floor(gem.width / 2), 0);
    surf = makeTranslucent(surf, 0.1);
    lines.forEach((line, idx) => {
      text.blit(surf, line, Math.floor(surf.width / 2) - Math.floor(text.width(line) / 2), 16 * idx + 6);
    });
    if (shimmer && gem) this.objInfoKey = key;
    return surf;
  }

  // ------------------------------------------------------------------
  // Attack forecast (draw_attack_info)
  // ------------------------------------------------------------------

  /** Python prepare_attack_info: rebuild and slide in from 80 px. */
  prepareAttackInfo(): void {
    this.attackInfoDisp = null;
    this.attackInfoOffset = 80;
  }

  /** Python reset_info. */
  resetInfo(): void {
    this.attackInfoDisp = null;
    this.spellInfoDisp = null;
  }

  private buildForecastBackground(
    game: Game, grandmaster: boolean, critFlag: boolean, guardFlag: boolean,
    aAssistFlag: boolean, dAssistFlag: boolean, attackerTeam: string, defenderTeam: string,
  ): Surface | null {
    let prefix = 'attack_info_';
    let asPrefix = 'assist_info_';
    if (grandmaster) {
      prefix += 'grandmaster_';
      asPrefix += 'grandmaster_';
    } else if (critFlag) {
      prefix += 'crit_';
      asPrefix += 'crit_';
    }
    if (guardFlag) prefix += 'guard_';
    const aColor = game.getTeamCombatColor?.(attackerTeam) ?? 'blue';
    const dColor = game.getTeamCombatColor?.(defenderTeam) ?? 'red';
    const dbColor = (team: string) => game.db.teams.defs.find((t: any) => t.nid === team)?.combatColor;
    const diverged = aColor !== dbColor(attackerTeam) || dColor !== dbColor(defenderTeam);
    let surf: Surface | null;
    if (diverged) {
      const topSurf = getSprite(`${prefix}top_${aColor}`, `${prefix}top_blue`);
      if (!topSurf) return null;
      surf = topSurf.copy();
      blit(surf, getSprite(`${prefix}bottom_${dColor}`, `${prefix}bottom_red`), 0, 0);
      blit(surf, getSprite(`${prefix}center`), 0, 0);
      if (aAssistFlag) blit(surf, getSprite(`${asPrefix}right_${aColor}`, `${asPrefix}right_blue`), 92, 35);
      if (dAssistFlag) blit(surf, getSprite(`${asPrefix}left_${dColor}`, `${asPrefix}left_red`), 1, 35);
    } else {
      const base = getSprite(`${prefix}${dColor}`, `${prefix}red`);
      if (!base) return null;
      surf = base.copy();
      if (aAssistFlag) blit(surf, getSprite(`${asPrefix}${aColor}`, `${asPrefix}red`), 92, 35);
      if (dAssistFlag) blit(surf, getSprite(`${asPrefix}${dColor}`, `${asPrefix}red`), 1, 35);
    }
    return makeTranslucent(surf, 0.1);
  }

  private createAttackInfo(
    game: Game, attacker: UnitObject, weapon: ItemObject, defender: UnitObject,
    aAssist: UnitObject | null, dAssist: UnitObject | null,
  ): Surface | null {
    const blue = font('text-blue');
    const text = font('text');
    if (!blue || !text) return null;
    const db = game.db;
    const fork = isForkEngine();
    const blitNum = (surf: Surface, num: number | string | null, x: number, y: number): void => {
      if (num === null || num === '--') {
        blue.blitRight(surf, '--', x - 1, y);
        return;
      }
      // EOtF's engine keeps the narrow blue_100 glyph for 999 and up; 100-998
      // print as digits, 2 px further right.
      if (typeof num === 'number' && num >= (fork ? 999 : 100)) blit(surf, getSprite('blue_100'), x - 15, y);
      else if (fork && typeof num === 'number' && num >= 100) blue.blitRight(surf, String(num), x + 2, y);
      else blue.blitRight(surf, String(num), x, y);
    };

    const grandmaster = isGrandmaster(game);
    const critFlag = !!db.getConstant('crit', true) && !grandmaster;
    const pairup = !!db.getConstant('pairup', false);
    const guardFlag = pairup && !!(attacker.traveler || defender.traveler);
    const defWeapon = getEquippedWeapon(defender, db, game);
    const canCounter = !!defWeapon && canCounterattack(attacker, weapon, defender, db, game);
    let aAssistFlag = false;
    let dAssistFlag = false;
    if (pairup && !(attacker.traveler || defender.traveler)) {
      aAssistFlag = !!aAssist;
      dAssistFlag = !!dAssist && canCounter;
    }

    const surf = this.buildForecastBackground(
      game, grandmaster, critFlag, guardFlag, aAssistFlag, dAssistFlag, attacker.team, defender.team);
    if (!surf) return null;
    const board = game.board;

    if (aAssistFlag && aAssist) {
      const aWeapon = getEquippedWeapon(aAssist, db, game);
      if (aWeapon) {
        const mt = computeAssistDamage(aAssist, aWeapon, defender, db, board, game, 'attack');
        const hit = computeHit(aAssist, aWeapon, defender, db, board, game, 'attack');
        if (grandmaster) blitNum(surf, Math.trunc(mt * Math.max(0, Math.min(100, hit)) / 100), 112, 35);
        else {
          blitNum(surf, mt, 112, 35);
          blitNum(surf, hit, 112, 51);
          if (critFlag) blitNum(surf, computeCrit(aAssist, aWeapon, defender, db, game, 'attack'), 112, 67);
        }
      }
    }
    if (dAssistFlag && dAssist) {
      const dWeapon = getEquippedWeapon(dAssist, db, game);
      if (dWeapon) {
        const mt = computeAssistDamage(dAssist, dWeapon, attacker, db, board, game, 'defense');
        const hit = computeHit(dAssist, dWeapon, attacker, db, board, game, 'defense');
        if (grandmaster) blitNum(surf, Math.trunc(mt * Math.max(0, Math.min(100, hit)) / 100), 21, 35);
        else {
          blitNum(surf, mt, 21, 35);
          blitNum(surf, hit, 21, 51);
          if (critFlag) blitNum(surf, computeCrit(dAssist, dWeapon, attacker, db, game, 'defense'), 21, 67);
        }
      }
    }

    // Names
    text.blit(surf, attacker.name, 67 - Math.floor(text.width(attacker.name) / 2), 3);
    const rowShift = (critFlag ? 0 : -16) + (grandmaster ? -16 : 0) + (guardFlag ? 16 : 0);
    text.blit(surf, defender.name, 50 - Math.floor(text.width(defender.name) / 2), 84 + rowShift);
    if (defWeapon) {
      text.blit(surf, defWeapon.name, 56 - Math.floor(text.width(defWeapon.name) / 2), 100 + rowShift);
    }

    // Combat stats
    const mt = computeDamage(attacker, weapon, defender, db, board, game, 'attack');
    const hit = computeHit(attacker, weapon, defender, db, board, game, 'attack');
    const crit = computeCrit(attacker, weapon, defender, db, game, 'attack');
    let eMt: number | string = '--';
    let eHit: number | string = '--';
    let eCrit: number | string = '--';
    if (canCounter && defWeapon) {
      eMt = computeDamage(defender, defWeapon, attacker, db, board, game, 'defense');
      eHit = computeHit(defender, defWeapon, attacker, db, board, game, 'defense');
      eCrit = critFlag ? computeCrit(defender, defWeapon, attacker, db, game, 'defense') : 0;
    }
    const stat: (number | string)[] = [attacker.currentHp];
    const eStat: (number | string)[] = [defender.currentHp];
    if (grandmaster) {
      stat.push(Math.trunc(mt * Math.max(0, Math.min(100, hit)) / 100));
      eStat.push(typeof eMt === 'number' && typeof eHit === 'number'
        ? Math.trunc(eMt * Math.max(0, Math.min(100, eHit)) / 100) : eMt);
    } else {
      stat.push(mt, hit);
      eStat.push(eMt, eHit);
      if (critFlag) {
        stat.push(crit);
        eStat.push(eCrit);
      }
    }
    if (guardFlag) {
      stat.push(attacker.traveler ? attacker.getGuardGauge() : '--');
      eStat.push(defender.traveler ? defender.getGuardGauge() : '--');
    }
    for (let idx = 0; idx < stat.length; idx++) {
      blitNum(surf, stat[idx], 88, 19 + 16 * idx);
      blitNum(surf, eStat[idx], 44, 19 + 16 * idx);
    }
    return surf;
  }

  /** Python draw_adv_arrows. */
  drawAdvArrows(
    surf: Surface, game: Game, attacker: UnitObject, defender: UnitObject,
    weapon: ItemObject, defWeapon: ItemObject | null, x: number, y: number,
  ): void {
    const sheet = getSprite('arrow_advantage');
    if (!sheet || !defWeapon) return;
    const tri = weaponTriangle(weapon, defWeapon, game.db, attacker, defender);
    const advantage = tri.hitBonus + tri.damageBonus;
    const frame = Math.floor(getFrameCount() / 8) % 3;
    if (advantage > 0) surf.blitFrom(sheet, frame * 7, 0, 7, 10, x, y);
    else if (advantage < 0) surf.blitFrom(sheet, frame * 7, 10, 7, 10, x, y);
  }

  private numAttacks(
    game: Game, unit: UnitObject, item: ItemObject, target: UnitObject,
    targetItem: ItemObject | null, mode: 'attack' | 'defense',
  ): number {
    const db = game.db;
    // For 'defense', unit/item are the defender's and target/targetItem the attacker's.
    const doubles = mode === 'attack'
      ? canDouble(unit, item, target, targetItem, db, game)
      : !!targetItem && canDefenderDouble(target, targetItem, unit, item, db, game);
    const phases = 1 +
      computeBlitzPhases(unit, item, target, targetItem, mode, [0, 0], game) +
      computeExtraAttackPhases(unit, item, target, targetItem, mode, [0, 0], game) +
      (doubles ? 1 : 0);
    let attacks = phases * computeStrikeCount(unit, item, target, targetItem, mode, [0, 0], game);
    attacks = Math.min(attacks, itemUses(item));
    return attacks;
  }

  private drawMultiplier(surf: Surface, count: number, x: number, y: number): void {
    if (count <= 1) return;
    const im = getSprite(`x${count}`);
    if (im) {
      surf.blit(im, x, y);
      return;
    }
    font('small-yellow')?.blit(surf, 'X', x, y - 4);
    font('number_small')?.blit(surf, String(count), x + 6, y - 2);
  }

  /** Python draw_attack_info. */
  drawAttackInfo(
    surf: Surface, game: Game, attacker: UnitObject, weapon: ItemObject, defender: UnitObject,
    aAssist: UnitObject | null = null, dAssist: UnitObject | null = null,
  ): Surface {
    const db = game.db;
    if (!this.attackInfoDisp) {
      this.attackInfoDisp = this.createAttackInfo(game, attacker, weapon, defender, aAssist, dAssist);
    }
    if (!this.attackInfoDisp) return surf;
    const pairup = !!db.getConstant('pairup', false);
    const grandmaster = isGrandmaster(game);
    const critFlag = !!db.getConstant('crit', true) && !grandmaster;
    const guardFlag = pairup && !!(attacker.traveler || defender.traveler);
    const defWeapon = getEquippedWeapon(defender, db, game);
    const canCounter = !!defWeapon && canCounterattack(attacker, weapon, defender, db, game);
    const hasAttackerPartner = pairup && !!aAssist && !(attacker.traveler || defender.traveler);
    const hasDefenderPartner = pairup && !!dAssist && !(attacker.traveler || defender.traveler) && canCounter;

    let topleft: [number, number];
    if (cursorOnRight(game)) {
      topleft = hasDefenderPartner ? [5 - this.attackInfoOffset, 4] : [-19 - this.attackInfoOffset, 4];
    } else {
      topleft = hasAttackerPartner
        ? [viewport.width - 122 + this.attackInfoOffset, 4]
        : [viewport.width - 97 + this.attackInfoOffset, 4];
    }
    if (this.attackInfoOffset > 0 && getFrameCount() !== this.lastAttackFrame) {
      this.attackInfoOffset -= 20;
    }
    this.lastAttackFrame = getFrameCount();
    this.place(surf, 'attack', this.attackInfoDisp, topleft[0], topleft[1]);

    const rowShift = (critFlag ? 0 : -16) + (grandmaster ? -16 : 0) + (guardFlag ? 16 : 0);
    // Python item_system.item_icon_mod: effective / item_icon_flash icons pulse white.
    const now = performance.now();
    if (weapon.iconNid) {
      drawItemIcon(surf, weapon, topleft[0] + 26, topleft[1] + 4,
        itemIconWhiteness(attacker, weapon, defender, defWeapon ?? null, game, now));
    }
    if (defWeapon?.iconNid) {
      drawItemIcon(surf, defWeapon, topleft[0] + 74, topleft[1] + 83 + rowShift,
        itemIconWhiteness(defender, defWeapon, attacker, weapon, game, now));
    }

    if (checkEnemy(attacker, defender, db, game)) {
      this.drawAdvArrows(surf, game, attacker, defender, weapon, defWeapon, topleft[0] + 37, topleft[1] + 8);
      if (defWeapon) {
        this.drawAdvArrows(surf, game, defender, attacker, defWeapon, weapon, topleft[0] + 85, topleft[1] + 89 + rowShift);
      }
    }

    // Doubling
    const count = Math.floor(getFrameCount() / 3) % 18;
    const dx = HUD.xPositions[count];
    const dy = HUD.yPositions[count];
    this.drawMultiplier(surf, this.numAttacks(game, attacker, weapon, defender, defWeapon, 'attack'),
      topleft[0] + 83 + dx, topleft[1] + 38 + dy);
    if (aAssist) {
      const aWeapon = getEquippedWeapon(aAssist, db, game);
      if (aWeapon) {
        this.drawMultiplier(surf, computeStrikeCount(aAssist, aWeapon, defender, defWeapon, 'attack', [0, 0], game),
          topleft[0] + 107 + dx, topleft[1] + 38 + dy);
      }
    }
    if (defWeapon && canCounter) {
      this.drawMultiplier(surf, this.numAttacks(game, defender, defWeapon, attacker, weapon, 'defense'),
        topleft[0] + 44 + dx, topleft[1] + 38 + dy);
      if (dAssist) {
        const dWeapon = getEquippedWeapon(dAssist, db, game);
        if (dWeapon) {
          this.drawMultiplier(surf, computeStrikeCount(dAssist, dWeapon, attacker, weapon, 'defense', [0, 0], game),
            topleft[0] + 20 + dx, topleft[1] + 38 + dy);
        }
      }
    }
    return surf;
  }

  private lastAttackFrame = -1;

  // ------------------------------------------------------------------
  // Spell forecast (draw_spell_info)
  // ------------------------------------------------------------------

  /** Python prepare_spell_info. */
  prepareSpellInfo(): void {
    this.spellInfoDisp = null;
  }

  private createSpellInfo(game: Game, attacker: UnitObject, spell: ItemObject, defender: UnitObject | null): Surface | null {
    const db = game.db;
    const text = font('text');
    const yellow = font('text-yellow');
    const blue = font('text-blue');
    if (!text || !yellow || !blue) return null;
    if (defender) {
      let rows = 2;
      const hasMt = spell.hasComponent('damage');
      const mt = hasMt ? computeDamage(attacker, spell, defender, db, game.board, game, 'attack') : null;
      if (mt !== null) rows += 1;
      const hasHit = spell.hasComponent('hit');
      const hit = computeHit(attacker, spell, defender, db, game.board, game, 'attack');
      if (hasHit) rows += 1;
      const hasCrit = !!db.getConstant('crit', true) && spell.hasComponent('crit');
      const crit = hasCrit ? computeCrit(attacker, spell, defender, db, game, 'attack') : null;
      if (crit !== null) rows += 1;

      const window = getSprite(`spell_window${rows}`);
      if (!window) return null;
      const bgSurf = makeTranslucent(window, 0.1);
      const width = bgSurf.width;
      let runningHeight = 8;
      text.blit(bgSurf, defender.name, 30, runningHeight);
      runningHeight += 16;
      yellow.blit(bgSurf, 'HP', 9, runningHeight);
      yellow.blit(bgSurf, '/', width - 25, runningHeight);
      const maxHp = String(defender.maxHp);
      blue.blit(bgSurf, maxHp, width - 5 - blue.width(maxHp), runningHeight);
      const currentHp = String(defender.currentHp);
      blue.blit(bgSurf, currentHp, width - 26 - blue.width(currentHp), runningHeight);
      if (mt !== null) {
        runningHeight += 16;
        yellow.blit(bgSurf, 'Mt', 9, runningHeight);
        blue.blit(bgSurf, String(mt), width - 5 - blue.width(String(mt)), runningHeight);
      }
      if (hasHit) {
        runningHeight += 16;
        yellow.blit(bgSurf, 'Hit', 9, runningHeight);
        if (hit >= 100) blit(bgSurf, getSprite('blue_100'), width - 21, runningHeight);
        else blue.blit(bgSurf, String(hit), width - 5 - blue.width(String(hit)), runningHeight);
      }
      if (crit !== null) {
        runningHeight += 16;
        yellow.blit(bgSurf, 'Crit', 9, runningHeight);
        if (crit >= 100) blit(bgSurf, getSprite('blue_100'), width - 21, runningHeight);
        else blue.blit(bgSurf, String(crit), width - 5 - blue.width(String(crit)), runningHeight);
      }
      runningHeight += 16;
      text.blit(bgSurf, spell.name, 52 - Math.floor(text.width(spell.name) / 2), runningHeight);
      return bgSurf;
    }

    let height = 24;
    const mt = spell.hasComponent('damage') ? itemDamage(attacker, spell, db, game) : null;
    if (mt !== null) height += 16;
    if (!this.menuBg) return null;
    const realSurf = createBaseSurf(this.menuBg, 80, height);
    let bgSurf = new Surface(realSurf.width + 2, realSurf.height + 4);
    bgSurf.blit(realSurf, 2, 4);
    blit(bgSurf, getSprite('menu_gem_small'), 0, 0);
    const shimmer = getSprite('menu_shimmer1');
    if (shimmer) bgSurf.blit(shimmer, bgSurf.width - shimmer.width - 1, bgSurf.height - shimmer.height - 5);
    bgSurf = makeTranslucent(bgSurf, 0.1);
    const width = bgSurf.width;
    let runningHeight = -10;
    if (mt !== null) {
      runningHeight += 16;
      yellow.blit(bgSurf, 'Mt', 5, runningHeight);
      blue.blit(bgSurf, String(mt), width - 5 - blue.width(String(mt)), runningHeight);
    }
    runningHeight += 16;
    if (spell.iconNid) drawItemIcon(bgSurf, spell, 4, runningHeight);
    text.blit(bgSurf, spell.name, 52 - Math.floor(text.width(spell.name) / 2), runningHeight);
    return bgSurf;
  }

  /** Python draw_spell_info. */
  drawSpellInfo(surf: Surface, game: Game, attacker: UnitObject, spell: ItemObject, defender: UnitObject | null): Surface {
    if (!this.spellInfoDisp) {
      this.spellInfoDisp = this.createSpellInfo(game, attacker, spell, defender);
      // Python returns on the frame it builds the window.
      return surf;
    }
    const disp = this.spellInfoDisp;
    const width = disp.width;
    const unitSurf = defender
      ? (game.unitRenderer?.getSprite(defender.nid)?.getCurrentFrame?.() as Surface | undefined) ?? null
      : null;
    const pad = unitSurf ? Math.max(0, Math.floor((unitSurf.width - 16) / 2)) : 0;
    let topleft: [number, number];
    let uTopleft: [number, number];
    if (cursorOnRight(game)) {
      topleft = [4, 4];
      uTopleft = [16 - pad, 12 - pad];
    } else {
      topleft = [viewport.width - 4 - width, 4];
      uTopleft = [viewport.width - width + 8 - pad, 12 - pad];
    }
    this.place(surf, 'spell', disp, topleft[0], topleft[1]);
    if (unitSurf) surf.blit(unitSurf, uTopleft[0], uTopleft[1]);
    if (spell.iconNid) {
      const whiteness = defender
        ? itemIconWhiteness(attacker, spell, defender, getEquippedWeapon(defender, game.db, game) ?? null, game, performance.now())
        : 0;
      drawItemIcon(surf, spell, topleft[0] + 8, topleft[1] + disp.height - 20, whiteness);
    }
    return surf;
  }
}

/** Python name for the same class. */
/** Top-left of a target preview window: the side away from the cursor. */
function previewTopleft(game: Game, width: number): [number, number] {
  return cursorOnRight(game) ? [0, 0] : [viewport.width - 4 - width, 0];
}

/**
 * Python UIView.draw_trade_preview: the unit's inventory in the skinned
 * trade_window (27 px top, 16 px per row, 5 px bottom; translucent .1),
 * the unit's name at (32, 8) and its passive map sprite hanging off the
 * window's top-left corner. `ignore` greys rows (steal targeting).
 */
export function drawTradePreview(surf: Surface, game: Game, unit: UnitObject, ignore: boolean[] | null = null): Surface {
  const window = getSprite('trade_window');
  if (!window) return surf;
  const items: ItemObject[] = unit.items ?? [];
  const width = window.width;
  const height = window.height;
  const size: [number, number] = [width, -2 + 27 + 5 + 16 * Math.max(1, items.length)];
  const bg = new Surface(size[0], size[1]);
  bg.blitFrom(window, 0, 0, width, 27, 0, 0);
  for (let idx = 0; idx < Math.max(1, items.length); idx++) {
    bg.blitFrom(window, 0, Math.floor(height / 2) + 3, width, 16, 0, 27 + idx * 16);
  }
  bg.blitFrom(window, 0, height - 5, width, 5, 0, size[1] - 5);
  const out = new Surface(size[0], size[1]);
  bg.setAlpha(0.9);
  out.blit(bg, 0, 0);
  items.forEach((item, idx) => {
    drawItemOption(out, game, item, 5, 27 + idx * 16 - 2, { ignore: !!ignore?.[idx] });
  });
  if (!items.length) font('text-grey')?.blit(out, 'Nothing', 25, 27 - 2);
  font('text')?.blit(out, unit.name, 32, 8);
  const [x, y] = previewTopleft(game, width);
  surf.blit(out, x, y);
  const sprite = unitStandFrame(game, unit, 'passive');
  if (sprite) surf.blit(sprite, x - 12, y - 16);
  return surf;
}

/**
 * Python TargetingState.draw_rescue_preview / draw_give_preview: the skinned
 * rescue_window or give_window (drawn as is) with the two units' names at
 * (32, 8) and (32, 56), the numbers right-aligned 5 px in at y 24 and 72,
 * and both passive map sprites hanging off the left edge.
 */
export function drawCarryPreview(
  surf: Surface, game: Game, kind: 'rescue' | 'give',
  top: UnitObject, bottom: UnitObject, topNumber: number, bottomNumber: number,
): Surface {
  const window = getSprite(kind === 'rescue' ? 'rescue_window' : 'give_window');
  if (!window) return surf;
  const out = window.copy();
  const blue = font('text-blue');
  blue?.blitRight(out, String(topNumber), out.width - 5, 24);
  blue?.blitRight(out, String(bottomNumber), out.width - 5, 72);
  font('text')?.blit(out, top.name, 32, 8);
  font('text')?.blit(out, bottom.name, 32, 56);
  const [x, y] = previewTopleft(game, out.width);
  surf.blit(out, x, y);
  const topSprite = unitStandFrame(game, top, 'passive');
  const bottomSprite = unitStandFrame(game, bottom, 'passive');
  if (topSprite) surf.blit(topSprite, x - 12, y - 16);
  if (bottomSprite) surf.blit(bottomSprite, x - 12, y - 16 + 48);
  return surf;
}

export { HUD as UIView };
