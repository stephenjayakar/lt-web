/**
 * exp-display.ts — EXP bar and Level-Up screen display.
 *
 * Faithful port of lt-maker/app/engine/level_up.py.
 * Uses the original sprite assets (expbar.png, level_screen.png, etc.)
 * and matches the original timing, animation, and layout exactly.
 */

import { Surface, surfaceFromImage } from '../engine/surface';
import { WINWIDTH, WINHEIGHT, FRAMETIME } from '../engine/constants';
import { FONT } from '../rendering/bmp-font';
import type { UnitObject } from '../objects/unit';
import type { StatDef } from '../data/types';

// ---------------------------------------------------------------------------
// Sprite loading
// ---------------------------------------------------------------------------

/** Cached sprites for the EXP bar and level-up screen. */
let expBarBgSurf: Surface | null = null;
let expBarBeginSurf: Surface | null = null;
let expBarMiddleSurf: Surface | null = null;
let expBarEndSurf: Surface | null = null;
let levelScreenBgSurf: Surface | null = null;
let statUnderlineSurf: Surface | null = null;

/** Whether sprites have been loaded. */
let spritesLoaded = false;
let spritesLoading = false;

/**
 * Load all EXP display sprites. Call once during init.
 * Sprites are at /sprites/exp_displays/*.png (engine-level shared assets).
 */
export async function loadExpDisplaySprites(): Promise<void> {
  if (spritesLoaded || spritesLoading) return;
  spritesLoading = true;

  try {
    const [expBarImg, levelScreenImg, underlineImg] = await Promise.all([
      loadImg('/sprites/exp_displays/expbar.png'),
      loadImg('/sprites/exp_displays/level_screen.png'),
      loadImg('/sprites/exp_displays/stat_underline.png'),
    ]);

    if (expBarImg) {
      // expbar.png is 144x31:
      //   top 144x24 = background
      //   bottom row: (0,24) 3x7 = begin cap, (3,24) 1x7 = middle fill, (4,24) 2x7 = end cap
      const fullSurf = surfaceFromImage(expBarImg);
      expBarBgSurf = fullSurf.subsurface(0, 0, 144, 24);
      expBarBeginSurf = fullSurf.subsurface(0, 24, 3, 7);
      expBarMiddleSurf = fullSurf.subsurface(3, 24, 1, 7);
      expBarEndSurf = fullSurf.subsurface(4, 24, 2, 7);
    }

    if (levelScreenImg) {
      levelScreenBgSurf = surfaceFromImage(levelScreenImg);
    }

    if (underlineImg) {
      statUnderlineSurf = surfaceFromImage(underlineImg);
    }

    spritesLoaded = true;
  } catch (e) {
    console.warn('[ExpDisplay] Failed to load sprites:', e);
  } finally {
    spritesLoading = false;
  }
}

function loadImg(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn(`[ExpDisplay] Failed to load: ${url}`);
      resolve(null);
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// ExpBar — Sprite-based EXP bar with iris fade in/out
// ---------------------------------------------------------------------------

/**
 * Faithful port of the Python ExpBar class.
 *
 * The bar uses the expbar.png sprite sheet:
 * - 144x24 background with decorative frame
 * - 3x7 "begin" cap, 1x7 "middle" fill (repeated), 2x7 "end" cap
 * - Fill spans from pixel 10 to pixel 110 (100 pixels for 100 EXP)
 * - Iris fade in/out: bar opens/closes vertically from center
 * - EXP number shown right-aligned using 'number_small3' BMP font
 */
export class ExpBar {
  private width = 144;
  private height = 24;
  private barMax = 100;
  private pos: [number, number];
  private offset: number;
  private done: boolean = false;
  private num: number;
  private bgSurf: Surface | null = null;

  constructor(oldExp: number, center: boolean = true) {
    if (center) {
      this.pos = [
        Math.floor(WINWIDTH / 2 - this.width / 2),
        Math.floor(WINHEIGHT / 2 - this.height / 2),
      ];
    } else {
      this.pos = [
        Math.floor(WINWIDTH / 2 - this.width / 2),
        WINHEIGHT - this.height,
      ];
    }

    this.offset = Math.floor(this.height / 2); // Start fully collapsed (fade in)
    this.done = false;
    this.num = oldExp;

    this.createBgSurf();
  }

  private createBgSurf(): void {
    if (!expBarBgSurf || !expBarBeginSurf) {
      this.bgSurf = null;
      return;
    }
    // Create a 144x24 surface with the background and begin cap
    const surf = new Surface(this.width, this.height);
    surf.blit(expBarBgSurf, 0, 0);
    surf.blit(expBarBeginSurf, 7, 9);
    this.bgSurf = surf;
  }

  /** Start the fade-out animation. */
  fadeOut(): void {
    this.done = true;
  }

  /**
   * Update the bar state.
   * @param exp - Current EXP value to display (null to just animate fade)
   * @returns true when fade-out is complete
   */
  update(exp?: number): boolean {
    if (this.done) {
      this.offset += 1;
      if (this.offset >= Math.floor(this.height / 2)) {
        return true; // Fade-out complete
      }
    } else if (this.offset > 0) {
      this.offset -= 1; // Fade in
    }

    if (exp !== undefined) {
      this.num = exp;
    }
    return false;
  }

  /** Draw the EXP bar onto the target surface. */
  draw(surf: Surface): void {
    if (!this.bgSurf || !expBarMiddleSurf || !expBarEndSurf) {
      // Fallback: draw a simple rectangle bar
      this.drawFallback(surf);
      return;
    }

    // Copy the background surface
    const barSurf = this.bgSurf.copy();

    // Draw fill: idx pixels of the middle piece (1px wide each)
    const idx = Math.floor(100 * Math.max(0, this.num) / this.barMax);
    for (let x = 0; x < idx; x++) {
      barSurf.blit(expBarMiddleSurf, 10 + x, 9);
    }

    // Draw end cap
    barSurf.blit(expBarEndSurf, 10 + idx, 9);

    // Draw EXP number using BMP font (or fallback)
    const numStr = String(Math.floor(this.num));
    const font = FONT['number_small3'];
    if (font) {
      font.blitRight(barSurf, numStr, this.width - 8, 4);
    } else {
      // Fallback: use canvas text
      barSurf.drawTextRight(numStr, this.width - 8, 6, 'white', '8px monospace');
    }

    // Iris transition: subsurface to show only the visible strip
    if (this.offset > 0) {
      const visibleH = Math.max(1, this.height - this.offset * 2);
      const clippedSurf = barSurf.subsurface(0, this.offset, this.width, visibleH);
      surf.blit(clippedSurf, this.pos[0], this.pos[1] + this.offset);
    } else {
      surf.blit(barSurf, this.pos[0], this.pos[1]);
    }
  }

  /** Simple fallback when sprites haven't loaded. */
  private drawFallback(surf: Surface): void {
    const barX = this.pos[0];
    const barY = this.pos[1];

    // Background
    surf.fillRect(barX, barY, this.width, this.height, 'rgba(16,16,48,0.9)');

    // Fill
    const ratio = Math.max(0, Math.min(1, this.num / this.barMax));
    const fillW = Math.round(100 * ratio);
    if (fillW > 0) {
      surf.fillRect(barX + 10, barY + 9, fillW, 7, 'rgba(64,160,255,1)');
    }

    // Border
    surf.drawRect(barX, barY, this.width, this.height, 'rgba(120,120,180,1)');

    // Text
    surf.drawTextRight(String(Math.floor(this.num)), barX + this.width - 8, barY + 6, 'white', '8px monospace');
  }
}

// ---------------------------------------------------------------------------
// LevelUpScreen — Stat display panel with scroll in/out and stat sparks
// ---------------------------------------------------------------------------

/**
 * Faithful port of the Python LevelUpScreen class.
 *
 * Shows the level-up stat panel with:
 * - Scroll-in/out animation (panel from left, portrait from right)
 * - Sequential stat spark reveals with underline grow animation
 * - Color-cycling underlines (sine wave color blend)
 * - Class name, level number, stat names + values using BMP fonts
 */
export class LevelUpScreen {
  private unit: UnitObject;
  private statList: number[];
  private statNids: string[];
  private statNames: string[];
  private oldLevel: number;
  private newLevel: number;

  private width: number;
  private height: number;

  // Animation state
  private state: string = 'scroll_in';
  private startTime: number = 0;
  private currentSpark: number = -1;
  private unitScrollOffset: number = 80;
  private screenScrollOffset: number;
  private underlineOffset: number = 36;

  // Timing constants (matching Python)
  private sparkTime = 350;    // ms between each stat spark
  private levelUpWait = 1366; // ms wait at end before scrolling out

  // Audio callback
  private audioManager: { playSfx(name: string): void } | null = null;

  // Portrait image
  private portraitImg: HTMLImageElement | null = null;

  constructor(
    unit: UnitObject,
    statChanges: Record<string, number>,
    oldLevel: number,
    newLevel: number,
    statDefs: StatDef[],
    audioManager?: { playSfx(name: string): void } | null,
    portraitImg?: HTMLImageElement | null,
  ) {
    this.unit = unit;
    this.oldLevel = oldLevel;
    this.newLevel = newLevel;
    this.audioManager = audioManager ?? null;
    this.portraitImg = portraitImg ?? null;

    // Use level_screen sprite dimensions, or fallback
    this.width = levelScreenBgSurf?.width ?? 133;
    this.height = levelScreenBgSurf?.height ?? 107;

    this.screenScrollOffset = this.width + 32;

    // Build stat list from stat definitions (first 8 only, matching Python)
    this.statNids = [];
    this.statNames = [];
    this.statList = [];
    const statKeys = statDefs.length > 0
      ? statDefs.map(s => s.nid)
      : Object.keys(statChanges);
    for (let i = 0; i < Math.min(8, statKeys.length); i++) {
      const nid = statKeys[i];
      this.statNids.push(nid);
      const def = statDefs.find(s => s.nid === nid);
      this.statNames.push(def?.name ?? nid);
      this.statList.push(statChanges[nid] ?? 0);
    }
  }

  /** Get the top-left position of the panel. */
  private topleft(): [number, number] {
    return [6 - this.screenScrollOffset, WINHEIGHT - 8 - this.height];
  }

  /** Get the position of stat row i within the panel. */
  private getPosition(i: number, absolute: boolean = false): [number, number] {
    const tl = absolute ? this.topleft() : [0, 0];
    if (i >= 4) {
      return [
        Math.floor(this.width / 2) + 8 + tl[0],
        (i - 4) * 16 + 35 + tl[1],
      ];
    }
    return [10 + tl[0], i * 16 + 35 + tl[1]];
  }

  /** Advance to the next non-zero stat change. Returns true if all done. */
  private incSpark(): boolean {
    this.currentSpark++;
    if (this.currentSpark >= this.statList.length) {
      return true;
    }
    if (this.statList[this.currentSpark] === 0) {
      return this.incSpark();
    }
    return false;
  }

  /**
   * Update the level-up screen animation.
   * @param currentTime - Current engine time in ms
   * @returns true when the screen is done (scroll-out complete)
   */
  update(currentTime: number): boolean {
    switch (this.state) {
      case 'scroll_in': {
        this.unitScrollOffset = Math.max(0, this.unitScrollOffset - 8);
        this.screenScrollOffset = Math.max(0, this.screenScrollOffset - 16);
        if (this.unitScrollOffset === 0 && this.screenScrollOffset === 0) {
          this.state = 'init_wait';
          this.startTime = currentTime;
        }
        break;
      }

      case 'init_wait': {
        if (currentTime - this.startTime > 500) {
          if (this.oldLevel === this.newLevel) {
            // No level change — skip to stat sparks
            this.state = 'get_next_spark';
          } else {
            this.state = 'first_spark';
            this.audioManager?.playSfx?.('Level_Up_Level');
          }
          this.startTime = currentTime;
        }
        break;
      }

      case 'first_spark': {
        if (currentTime - this.startTime > this.sparkTime) {
          this.state = 'get_next_spark';
          this.startTime = currentTime;
        }
        break;
      }

      case 'get_next_spark': {
        const done = this.incSpark();
        if (done) {
          this.state = 'level_up_wait';
          this.startTime = currentTime;
        } else {
          this.audioManager?.playSfx?.('Stat Up');
          this.underlineOffset = 36;
          this.state = 'spark_wait';
          this.startTime = currentTime;
        }
        break;
      }

      case 'spark_wait': {
        if (currentTime - this.startTime > this.sparkTime) {
          this.state = 'get_next_spark';
        }
        break;
      }

      case 'level_up_wait': {
        if (currentTime - this.startTime > this.levelUpWait) {
          this.state = 'scroll_out';
          this.startTime = currentTime;
        }
        break;
      }

      case 'scroll_out': {
        this.unitScrollOffset += 10;
        this.screenScrollOffset += 20;
        if (currentTime - this.startTime > 500) {
          return true; // Done
        }
        break;
      }
    }

    return false;
  }

  /** Draw the level-up screen onto the target surface. */
  draw(surf: Surface, currentTime: number): void {
    // --- Draw the stat panel ---
    const panelSurf = this.drawPanel(currentTime);

    const panelPos = this.topleft();
    surf.blit(panelSurf, panelPos[0], panelPos[1]);

    // --- Draw unit portrait ---
    if (this.portraitImg) {
      const right = WINWIDTH - 4;
      const bottom = WINHEIGHT + this.unitScrollOffset;
      // Portrait is typically 96x80; draw so bottom-right is at (right, bottom)
      const pw = Math.min(this.portraitImg.naturalWidth || 96, 96);
      const ph = Math.min(this.portraitImg.naturalHeight || 80, 80);
      surf.drawImageFull(
        this.portraitImg,
        right - pw,
        bottom - ph,
        pw, ph,
      );
    }
  }

  /** Render the stat panel onto a surface. */
  private drawPanel(currentTime: number): Surface {
    // Start with the background sprite or a fallback
    let sprite: Surface;
    if (levelScreenBgSurf) {
      sprite = levelScreenBgSurf.copy();
    } else {
      sprite = new Surface(this.width, this.height);
      sprite.fill(24, 32, 64, 0.95);
    }

    // Color cycling for underlines (matches Python's sin-based blend)
    const t = Math.sin(((Math.floor(currentTime / 10)) % 180) * Math.PI / 180);
    // Blend between (88, 16, -40) and (-80, -32, 40) — these are additive offsets
    const colorR = Math.round(88 + (-80 - 88) * t);
    const colorG = Math.round(16 + (-32 - 16) * t);
    const colorB = Math.round(-40 + (40 - (-40)) * t);

    // --- Header: Class name and Level ---
    const klassName = this.unit.klass ?? 'Unknown';
    const textFont = FONT['text'];
    const narrowFont = FONT['narrow'];
    const yellowFont = FONT['text-yellow'];
    const blueFont = FONT['text-blue'];

    if (textFont) {
      if (narrowFont && textFont.width(klassName) > 60) {
        narrowFont.blit(sprite, klassName, 12, 3);
      } else {
        textFont.blit(sprite, klassName, 12, 3);
      }
    } else {
      sprite.drawText(klassName, 12, 3, 'white', '8px monospace');
    }

    // "Lv" label
    if (yellowFont) {
      yellowFont.blit(sprite, 'Lv', Math.floor(this.width / 2) + 12, 3);
    } else {
      sprite.drawText('Lv', Math.floor(this.width / 2) + 12, 3, 'rgba(255,255,128,1)', '8px monospace');
    }

    // Level number
    const levelStr = (this.state === 'scroll_in' || this.state === 'init_wait')
      ? String(this.oldLevel)
      : String(this.newLevel);
    if (blueFont) {
      const levelW = blueFont.width(levelStr);
      blueFont.blit(sprite, levelStr, Math.floor(this.width / 2) + 50 - levelW, 3);
    } else {
      sprite.drawTextRight(levelStr, Math.floor(this.width / 2) + 50, 3, 'rgba(128,160,255,1)', '8px monospace');
    }

    // --- Stat underlines ---
    for (let idx = 0; idx <= this.currentSpark && idx < this.statList.length; idx++) {
      if (this.statList[idx] === 0) continue;

      const pos = this.getPosition(idx);
      let ulX: number;
      let ulY: number;
      let ulWidth: number;

      if (idx === this.currentSpark && this.underlineOffset > 0) {
        // Currently revealing: grow from right
        this.underlineOffset = Math.max(0, this.underlineOffset - 6);
        ulX = pos[0] + Math.floor(this.underlineOffset / 2) + 1;
        ulY = pos[1] + 10;
        ulWidth = 53 - this.underlineOffset; // stat_underline.png is 53x3
      } else {
        ulX = pos[0] + 4;
        ulY = pos[1] + 11;
        ulWidth = 53; // full width
      }

      if (statUnderlineSurf && ulWidth > 0) {
        // Tint the underline with the cycling color
        const tintedUl = this.tintSurface(statUnderlineSurf, colorR, colorG, colorB);
        if (ulWidth < 53) {
          const clipped = tintedUl.subsurface(53 - ulWidth, 0, ulWidth, 3);
          sprite.blit(clipped, ulX, ulY);
        } else {
          sprite.blit(tintedUl, ulX, ulY);
        }
      } else if (ulWidth > 0) {
        // Fallback: colored rectangle
        const r = Math.max(0, Math.min(255, 128 + colorR));
        const g = Math.max(0, Math.min(255, 128 + colorG));
        const b = Math.max(0, Math.min(255, 128 + colorB));
        sprite.fillRect(ulX, ulY, ulWidth, 2, `rgb(${r},${g},${b})`);
      }
    }

    // --- Stat names and values ---
    for (let idx = 0; idx < this.statNids.length; idx++) {
      if (idx >= this.statList.length) continue;
      const pos = this.getPosition(idx);
      const name = this.statNames[idx];

      // Stat name in yellow
      if (textFont) {
        textFont.blit(sprite, name, pos[0], pos[1], 'yellow');
      } else {
        sprite.drawText(name, pos[0], pos[1], 'rgba(255,255,128,1)', '7px monospace');
      }

      // Stat value: show old value until spark has passed this stat
      const statNid = this.statNids[idx];
      const currentVal = this.unit.stats[statNid] ?? 0;
      const change = this.statList[idx];
      // After spark reveals, show final value; before, show original
      const displayVal = this.currentSpark >= idx ? currentVal : currentVal - change;

      if (blueFont) {
        const valStr = String(displayVal);
        const valW = blueFont.width(valStr);
        blueFont.blit(sprite, valStr, pos[0] + 40 - valW, pos[1]);
      } else {
        sprite.drawTextRight(String(displayVal), pos[0] + 40, pos[1], 'rgba(128,160,255,1)', '7px monospace');
      }

      // Stat change indicator (after spark)
      if (this.currentSpark >= idx && change !== 0) {
        const changeStr = change > 0 ? `+${change}` : `${change}`;
        const changeColor = change > 0 ? 'rgba(128,255,128,1)' : 'rgba(200,128,255,1)';

        if (textFont) {
          textFont.blit(sprite, changeStr, pos[0] + 48, pos[1], change > 0 ? 'white' : 'purple');
        } else {
          sprite.drawText(changeStr, pos[0] + 48, pos[1], changeColor, '7px monospace');
        }
      }
    }

    return sprite;
  }

  /**
   * Apply an additive color tint to a surface.
   * Matches Python's image_mods.change_color which adds RGB offsets.
   */
  private tintSurface(source: Surface, dr: number, dg: number, db: number): Surface {
    const result = source.copy();
    const imageData = result.getImageData();
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // Skip transparent pixels
      data[i] = Math.max(0, Math.min(255, data[i] + dr));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + dg));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + db));
    }
    result.putImageData(imageData);
    return result;
  }
}
