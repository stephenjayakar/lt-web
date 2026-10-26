/**
 * banner.ts — Map banners. Port of lt-maker/app/engine/banner.py (Banner and
 * its AcquiredItem / StoleItem / GainWexp / GiveSkill ... subclasses) and of
 * phase.py PhaseIn (the "Player Phase" turn banner with the black-square
 * transition).
 *
 * A Banner is a menu_bg_base window with the menu_gem_small gem, made 10%
 * translucent, with styled bitmap text at (6, 7) and an optional 16x16 icon
 * at the right, blitted at the centre of the scene. Python shows it through
 * AlertState for `time_to_wait` (3000 ms), dismissable by input after
 * `time_to_pause` (300 ms).
 */

import { Surface } from '../engine/surface';
import { FRAMETIME } from '../engine/constants';
import { viewport } from '../engine/viewport';
import { createBaseSurf, getMenuBgSpriteSync } from './base-surf';
import { getSprite, makeTranslucent } from './sprites';
import { drawIcon16, drawIconByAlias } from './icons';
import { drawStyledText, measureStyledText } from './styled-text';

/** What a banner shows at its right edge (Python Banner.item / draw_icon). */
export type BannerIcon =
  | { kind: 'item'; iconNid: string; iconIndex: [number, number] }
  | { kind: 'skill'; iconNid: string; iconIndex: [number, number] }
  | { kind: 'weapon'; iconNid: string; iconIndex: [number, number] }
  | { kind: 'alias'; alias: string };

const TIME_TO_PAUSE = 300;

let bannerAudio: { playSfx?: (nid: string) => void } | null = null;
/** Banners play their sound on their first update (Python Banner.update). */
export function setBannerAudio(audio: { playSfx?: (nid: string) => void } | null): void {
  bannerAudio = audio;
}

type IconSource = { iconNid?: string; icon_nid?: string; iconIndex?: [number, number]; icon_index?: [number, number] };
function iconOf(kind: 'item' | 'skill' | 'weapon', src: IconSource | null | undefined): BannerIcon | null {
  const iconNid = src?.iconNid ?? src?.icon_nid;
  const iconIndex = src?.iconIndex ?? src?.icon_index;
  return iconNid && iconIndex ? { kind, iconNid, iconIndex } : null;
}
/** Python icons.draw_item source for a banner. */
export const itemIcon = (item: IconSource | null | undefined) => iconOf('item', item);
/** Python icons.draw_skill source for a banner. */
export const skillIcon = (skill: IconSource | null | undefined) => iconOf('skill', skill);
/** Python icons.draw_weapon: the weapon type's icon from the database. */
export function weaponIcon(db: { weapons: IconSource[] & { find: (fn: (w: any) => boolean) => any } }, weaponType: string): BannerIcon | null {
  return iconOf('weapon', db.weapons.find((weapon: any) => weapon.nid === weaponType));
}
const TIME_TO_WAIT = 3000;


/** Python `'<blue>X</>'`: wrap text in an LT colour tag. */
export function colored(text: string, color = 'blue'): string {
  return `<${color}>${text}</>`;
}

/** Python article rule used by AcquiredItem / StoleItem. */
function article(name: string): string {
  return 'aeiou'.includes(name.toLowerCase()[0] ?? '') ? 'an' : 'a';
}

/** Python AcquiredItem text: "{name} got {article} {item}." (no article for possessives). */
export function acquiredItemText(unitName: string, itemName: string, itemColor = 'blue'): string {
  return itemName.includes("'")
    ? `${colored(unitName)} got ${colored(itemName, itemColor)}.`
    : `${colored(unitName)} got ${article(itemName)} ${colored(itemName, itemColor)}.`;
}

/** Python StoleItem text. */
export function stoleItemText(unitName: string, itemName: string, itemColor = 'blue'): string {
  return itemName.includes("'")
    ? `${colored(unitName)} stole ${colored(itemName, itemColor)}.`
    : `${colored(unitName)} stole ${article(itemName)} ${colored(itemName, itemColor)}.`;
}

/** Python GainWexp text. */
export function gainWexpText(unitName: string, rank: string): string {
  return `${colored(unitName)} reached rank ${colored(rank)}.`;
}

export class Banner {
  readonly text: string;
  private icon: BannerIcon | null;
  /** Python AlertState: the banner leaves after this long. */
  private duration: number;
  private timer = 0;
  private surf: Surface | null = null;
  private size: [number, number] = [0, 24];
  /** Python CustomIcon draws its icon on the left with text at x=22. */
  private iconLeft: boolean;

  private sound: string | null;
  private started = false;

  /**
   * @param opts.iconLeft Python CustomIcon layout (icon left, text at x=22)
   * @param opts.sound    sfx played when the banner first updates
   */
  constructor(
    text: string,
    icon: BannerIcon | null = null,
    duration: number = TIME_TO_WAIT,
    opts: { iconLeft?: boolean; sound?: string | null } = {},
  ) {
    this.text = text;
    this.icon = icon;
    this.duration = duration;
    this.iconLeft = opts.iconLeft ?? false;
    this.sound = opts.sound ?? null;
  }

  /** Python figure_out_size. */
  private figureOutSize(): void {
    let length = measureStyledText(this.text, 'text') + 16;
    length -= length % 8;
    length += this.icon ? 16 : 0;
    this.size = [length, 24];
  }

  /** Advance the timer. Returns true when the banner should be removed. */
  update(deltaMs: number = FRAMETIME): boolean {
    if (!this.started) {
      this.started = true;
      if (this.sound) bannerAudio?.playSfx?.(this.sound);
      return false;
    }
    this.timer += deltaMs;
    return this.timer >= this.duration;
  }

  /** Python AlertState.take_input: any input closes it after time_to_pause. */
  canDismiss(): boolean {
    return this.timer > TIME_TO_PAUSE;
  }

  getElapsed(): number {
    return this.timer;
  }

  private drawIcon(surf: Surface): void {
    const icon = this.icon;
    if (!icon) return;
    const x = this.iconLeft ? 4 : this.size[0] - 20;
    const y = this.iconLeft || icon.kind !== 'item' ? 7 : 8;
    if (icon.kind === 'alias') drawIconByAlias(surf, icon.alias, x, y);
    else if (icon.iconNid) drawIcon16(surf, icon.iconNid, icon.iconIndex, x, y);
  }

  draw(surf: Surface): Surface {
    if (this.timer >= this.duration) return surf;
    if (!this.surf) {
      const gem = getSprite('menu_gem_small');
      const menuBg = getMenuBgSpriteSync('menu_bg_base');
      if (!menuBg || !gem) return surf;
      this.figureOutSize();
      const [w, h] = this.size;
      const bgSurf = createBaseSurf(menuBg, w, h);
      const built = new Surface(w + 2, h + 4);
      built.blit(bgSurf, 2, 4);
      built.blit(gem, 0, 0);
      this.surf = makeTranslucent(built, 0.1);
    }
    const bgSurf = this.surf.copy();
    drawStyledText(bgSurf, this.text, this.iconLeft ? 22 : 6, Math.floor(this.size[1] / 2) - 8 + 3, 'white', 'text');
    this.drawIcon(bgSurf);
    // Python engine.blit_center
    surf.blit(bgSurf,
      Math.floor(viewport.width / 2 - bgSurf.width / 2),
      Math.floor(viewport.height / 2 - bgSurf.height / 2));
    return surf;
  }
}

/**
 * Python phase.PhaseIn: the turnbanner_<team> sprite slides in from the
 * right, holds, and slides out to the left, while rows of phase_transition
 * squares close in from the top and bottom of the screen.
 */
export class PhaseIn {
  static readonly tBegin = 128;
  static readonly tMain = 1000;
  static readonly tEnd = 240;
  static readonly tDisplay = PhaseIn.tBegin + PhaseIn.tMain + PhaseIn.tEnd;

  private elapsed = 0;
  private spriteName: string;
  private fallbackName: string;

  /**
   * @param team        team nid (sprite turnbanner_<team>)
   * @param combatColor the team's current combat colour when it diverged
   *                    from the database colour, else null
   */
  constructor(team: string, combatColor: string | null = null) {
    this.fallbackName = `turnbanner_${team}`;
    this.spriteName = combatColor ? `${this.fallbackName}_${combatColor}` : this.fallbackName;
    // Start loading now so the first frame has the images.
    getSprite(this.spriteName, this.fallbackName);
    getSprite('phase_transition');
  }

  /** Advance one frame; true once the display time has passed. */
  update(deltaMs: number = FRAMETIME): boolean {
    this.elapsed += deltaMs;
    return this.elapsed >= PhaseIn.tDisplay;
  }

  draw(surf: Surface): Surface {
    const winW = viewport.width;
    const winH = viewport.height;
    const timePassed = Math.min(this.elapsed, PhaseIn.tDisplay);
    const maxOpacity = 118;
    const image = getSprite(this.spriteName, this.fallbackName);
    if (image) {
      let offsetX: number;
      let trans: number;
      if (timePassed < PhaseIn.tBegin) {
        const diff = timePassed / PhaseIn.tBegin;
        offsetX = PhaseIn.tBegin * (1 - diff);
        trans = (1 - diff) ** 2;
      } else if (timePassed < PhaseIn.tBegin + PhaseIn.tMain) {
        offsetX = 0;
        trans = 0;
      } else {
        const diff = (timePassed - PhaseIn.tBegin - PhaseIn.tMain) / PhaseIn.tEnd;
        offsetX = -PhaseIn.tEnd * diff;
        trans = diff ** 2;
      }
      surf.blit(makeTranslucent(image, trans),
        offsetX + Math.floor(winW / 2) - Math.floor(image.width / 2),
        Math.floor(winH / 2) - Math.floor(image.height / 2));
    }

    const squares = getSprite('phase_transition');
    if (!squares) return surf;
    const spaceH = Math.floor(winH / 2) - 16;
    const space1 = new Surface(winW, spaceH);
    const space2 = new Surface(winW, spaceH);
    const tHalf = Math.floor(PhaseIn.tDisplay / 2);
    let height: number;
    let alpha: number;
    let t: number;
    if (timePassed < tHalf) {
      const diff = timePassed / tHalf;
      height = 64 * diff;
      alpha = Math.trunc(maxOpacity * Math.sqrt(timePassed / tHalf));
      t = Math.trunc(2 + diff * 16);
    } else {
      const diff = -(tHalf - timePassed) / tHalf;
      height = 64 * (1 - diff);
      alpha = Math.trunc(maxOpacity - maxOpacity * ((timePassed - tHalf) / tHalf) ** 2);
      t = Math.trunc(diff * 16);
    }
    const clamp = (v: number) => Math.max(0, Math.min(8, v));
    for (let x = 0; x < winW; x += 16) {
      for (let y = 0; y < spaceH; y += 16) {
        const i = Math.floor(x / 16);
        const j = Math.floor(y / 16);
        const k1 = Math.trunc(t * 1.5 - (i - (j % 2)) / 2 + j / 2 - 4);
        const k2 = Math.trunc(t * 1.5 - (i - (j % 2)) / 2 + j / 2 - 1);
        const frame1 = timePassed < tHalf ? clamp(8 - Math.abs(Math.max(k1, 8) - 8)) : clamp(k1);
        const frame2 = timePassed < tHalf ? clamp(8 - Math.abs(Math.max(k2, 8) - 8)) : clamp(k2);
        space1.blitFrom(squares, frame1 * 16, 0, 16, 16, x, y);
        space2.blitFrom(squares, frame2 * 16, 0, 16, 16, x, y);
      }
    }
    const h = Math.trunc(height);
    if (h > 0) {
      const a = Math.max(0, alpha) / 255;
      const top = space1.subsurface(0, 0, winW, Math.min(h, spaceH));
      const bottom = space2.subsurface(0, Math.max(0, spaceH - h), winW, Math.min(h, spaceH));
      top.setAlpha(a);
      bottom.setAlpha(a);
      surf.blit(top, 0, 0);
      surf.blit(bottom, 0, winH - bottom.height);
    }
    return surf;
  }
}
