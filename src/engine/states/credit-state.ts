/**
 * credit-state.ts — port of lt-maker/app/engine/credit_state.py.
 *
 * A brown CreditMenu (menu_gem_brown, menu_shimmer3) lists the project's
 * credit catalog (game_data/credit.json) by category; the CreditDisplay
 * panel on the right pages through the selected entry. The background is the
 * title/credit panorama (or a scrolling default_background).
 */

import { State, type StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { WINHEIGHT, WINWIDTH } from '../constants';
import { drawStyledText } from '../../ui/styled-text';
import { drawIcon16, drawIcon32 } from '../../ui/icons';
import {
  MenuBackground,
  MenuCursor,
  MenuScene,
  ScrollArrow,
  baseSurf,
  blitSprite,
  blitTextCenter,
  blitTextRight,
  getKeyedImage,
  getPortrait,
  getSprite,
  lineWrap,
  preloadSprites,
  textWidth,
} from '../../ui/menu-chrome';

let _game: any = null;
export function setCreditGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for credit state');
  return _game;
}

/** Python ResourceType enum values used by credit entries. */
const RESOURCE_TYPES: Record<number, string> = {
  1: 'ICONS16', 2: 'ICONS32', 3: 'ICONS80', 4: 'PORTRAITS', 5: 'ANIMATIONS', 6: 'PANORAMAS',
  7: 'MAP_ICONS', 8: 'MAP_SPRITES', 9: 'COMBAT_PALETTES', 10: 'COMBAT_ANIMS', 11: 'COMBAT_EFFECTS',
  12: 'TILESETS', 13: 'TILEMAPS', 14: 'MUSIC', 15: 'SFX',
};

interface CreditEntry {
  nid: string;
  sub_nid: string;
  credit_type: number | string;
  category: string;
  icon_index: [number, number] | [];
  contrib: [string, string][];
}

function resourceType(entry: CreditEntry): string | null {
  return typeof entry.credit_type === 'number' ? RESOURCE_TYPES[entry.credit_type] ?? null : null;
}

/** CreditEntry.header() */
function header(entry: CreditEntry): string {
  const type = resourceType(entry);
  if (type) {
    const text = type.replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  }
  return entry.sub_nid;
}

/** credit_state.populate_options */
function populateOptions(credits: CreditEntry[]): { options: string[]; ignore: boolean[]; ordered: (CreditEntry[] | null)[] } {
  const sorted = [...credits].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : header(a) < header(b) ? -1 : header(a) > header(b) ? 1 : 0);
  const categories: string[] = [];
  const options: string[] = [];
  const ignore: boolean[] = [];
  const ordered: (CreditEntry[] | null)[] = [];
  let temp: CreditEntry[] | null = null;
  let prev = '';
  for (const credit of sorted) {
    const current = header(credit);
    if (!categories.includes(credit.category)) {
      categories.push(credit.category);
      if (temp) ordered.push(temp);
      options.push(credit.category);
      ignore.push(true);
      ordered.push([]);
      options.push(current);
      ignore.push(false);
      prev = current;
      temp = [credit];
      continue;
    }
    if (prev === current) {
      temp?.push(credit);
      continue;
    }
    ordered.push(temp);
    options.push(current);
    ignore.push(false);
    prev = current;
    temp = [credit];
  }
  ordered.push(temp);
  return { options, ignore, ordered };
}

const MENU_LIMIT = 9;
const MENU_WIDTH = 80;
const DISPLAY_LEFT = 84;
const DISPLAY_TOP = 4;
const DISPLAY_WIDTH = WINWIDTH - 84;
const DISPLAY_HEIGHT = WINHEIGHT - 8;
const FONT_HEIGHT = 16;

type Page = { credits: CreditEntry[]; content: unknown };

export class CreditState extends State {
  readonly name = 'credit';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private options: string[] = [];
  private ignore: boolean[] = [];
  private ordered: (CreditEntry[] | null)[] = [];
  private currentIndex = 0;
  private scroll = 0;
  private cursor = new MenuCursor();
  private pages: Page[] = [];
  private pageNum = 0;
  private shownEntry = -1;
  private leftArrow = new ScrollArrow('left', DISPLAY_LEFT + 4, 8);
  private rightArrow = new ScrollArrow('right', DISPLAY_LEFT + DISPLAY_WIDTH - 17, 8, 0.5);
  private panorama: MenuBackground | null = null;

  override start(): StateResult {
    const game = getGame();
    // open_credits stores its panorama as base_bg; Python keeps the built
    // background in credit_bg (falling back to the title background).
    const bgNid = [game.memory?.get?.('credit_bg'), game.memory?.get?.('base_bg'), game.memory?.get?.('title_bg')]
      .find((value) => typeof value === 'string' && value);
    this.bg = bgNid
      ? new MenuBackground(bgNid, game.resources, false)
      : new MenuBackground('default_background', game.resources);
    preloadSprites(['menus/menu_gem_brown', 'menus/menu_shimmer3', 'menus/menu_highlight', 'page_arrows']);
    this.setCredits([]);
    void game.resources?.tryLoadJsonSilent?.('game_data/credit.json').then((data: unknown) => {
      if (Array.isArray(data)) this.setCredits(data as CreditEntry[]);
    });
  }

  private setCredits(credits: CreditEntry[]): void {
    const { options, ignore, ordered } = populateOptions(credits);
    this.options = options;
    this.ignore = ignore;
    while (this.options.length < MENU_LIMIT) {
      this.options.push('');
      this.ignore.push(true);
    }
    this.ordered = ordered;
    const first = this.ignore.findIndex((ig) => !ig);
    this.currentIndex = first >= 0 ? first : 0;
    this.scroll = 0;
    this.shownEntry = -1;
    this.updateEntry(this.currentIndex);
  }

  /** CreditDisplay.update_entry */
  private updateEntry(idx: number): void {
    if (this.shownEntry === idx) return;
    this.shownEntry = idx;
    this.pageNum = 0;
    this.pages = [];
    this.panorama = null;
    const lst = this.ordered[idx];
    if (!lst || !lst.length) return;
    const type = resourceType(lst[0]);
    if (type === 'ICONS16' || type === 'ICONS32' || type === 'MAP_ICONS' || type === 'MAP_SPRITES') {
      const limit = DISPLAY_HEIGHT - 24;
      const iconSize = (type === 'ICONS16' || type === 'MAP_SPRITES' ? 16 : 32) + 4;
      let height = 0;
      let page: CreditEntry[] = [];
      for (const credit of lst) {
        const contrib = credit.contrib?.[0];
        const lines = contrib ? lineWrap('text', `by ${contrib[0]}`, DISPLAY_WIDTH - 16 - iconSize).length : 0;
        const h = Math.max(lines * FONT_HEIGHT, iconSize);
        if (height + h <= limit) {
          height += h;
          page.push(credit);
          continue;
        }
        this.pages.push({ credits: page, content: null });
        height = h;
        page = [credit];
      }
      this.pages.push({ credits: page, content: null });
    } else if (!type) {
      for (const credit of lst) {
        if (!credit.contrib?.[0]) {
          this.pages.push({ credits: [credit], content: null });
          continue;
        }
        if (credit.credit_type === 'Text') {
          const translate = (t: string): string => getGame().db?.translate?.(t) ?? t;
          for (const line of translate(credit.contrib[0][1]).split('\n')) {
            this.pages.push({ credits: [credit], content: lineWrap('text', line, WINWIDTH - 100).slice(0, 8) });
          }
        } else if (credit.credit_type === 'List') {
          const limit = DISPLAY_HEIGHT - 24;
          let height = 0;
          let page: [string, string][] = [];
          for (const c of credit.contrib) {
            const lines = lineWrap('text', `${c[1]} by ${c[0]}`, DISPLAY_WIDTH - 16).length;
            if (height + lines * FONT_HEIGHT <= limit) {
              height += lines * FONT_HEIGHT;
              page.push(c);
              continue;
            }
            this.pages.push({ credits: [credit], content: page });
            height = lines * FONT_HEIGHT;
            page = [c];
          }
          this.pages.push({ credits: [credit], content: page });
        }
      }
    } else {
      this.pages = lst.map((credit) => ({ credits: [credit], content: null }));
    }
  }

  private pageRight(firstPush = false): boolean {
    const n = this.pages.length;
    if (!n) return false;
    if (this.pageNum < n - 1) this.pageNum += 1;
    else if (firstPush) this.pageNum = (this.pageNum + 1) % n;
    else return false;
    this.rightArrow.pulse();
    this.panorama = null;
    return true;
  }

  private pageLeft(): boolean {
    if (this.pageNum <= 0) return false;
    this.pageNum -= 1;
    this.leftArrow.pulse();
    this.panorama = null;
    return true;
  }

  // -- Choice.move_down/move_up (first_push), skipping ignored rows --

  private move(dir: 1 | -1): boolean {
    if (this.ignore.every(Boolean)) return false;
    const n = this.options.length;
    let idx = this.currentIndex;
    do {
      idx = (idx + dir + n) % n;
    } while (this.ignore[idx]);
    if (idx === this.currentIndex) return false;
    this.currentIndex = idx;
    if (this.currentIndex < this.scroll + 1) this.scroll = Math.max(0, this.currentIndex - 1);
    if (this.currentIndex > this.scroll + MENU_LIMIT - 2) this.scroll = Math.min(n - MENU_LIMIT, this.currentIndex - MENU_LIMIT + 2);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, n - MENU_LIMIT)));
    return true;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const sfx = (name: string): void => game.audioManager?.playSfx?.(name);
    if (event === 'DOWN' || event === 'UP') {
      if (this.move(event === 'DOWN' ? 1 : -1)) sfx('Select 6');
      this.updateEntry(this.currentIndex);
    } else if (event === 'RIGHT') {
      if (this.pageRight()) sfx('Status_Page_Change');
    } else if (event === 'LEFT') {
      if (this.pageLeft()) sfx('Status_Page_Change');
    }
    if (event === 'BACK') {
      sfx('Select 4');
      game.state.back();
    } else if (event === 'SELECT') {
      if (this.pageRight(true)) sfx('Status_Page_Change');
    }
  }

  override update(): StateResult {
    this.cursor.update();
    this.bg?.update();
    this.panorama?.update();
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    const s = this.scene.begin();
    this.drawDisplay(s);
    this.drawMenu(s);
    this.scene.present(surf);
    return surf;
  }

  /** CreditMenu (menus.Choice.vert_draw) */
  private drawMenu(s: Surface): void {
    const height = MENU_LIMIT * 16 + 8;
    const bg = new Surface(MENU_WIDTH + 2, height + 4);
    bg.blit(baseSurf(MENU_WIDTH, height, 'menu_bg_brown'), 2, 4);
    blitSprite(bg, getSprite('menus/menu_gem_brown'), 0, 0);
    const shimmer = getSprite('menus/menu_shimmer3');
    if (shimmer) blitSprite(bg, shimmer, bg.width - 1 - shimmer.width, bg.height - 5 - shimmer.height);
    bg.setAlpha(0.9);
    s.blit(bg, 2, 0);
    const highlight = getSprite('menus/menu_highlight');
    const visible = this.options.slice(this.scroll, this.scroll + MENU_LIMIT);
    visible.forEach((text, idx) => {
      const absolute = idx + this.scroll;
      const top = 4 + 4 + idx * 16;
      const left = 4;
      if (absolute === this.currentIndex && highlight) {
        for (let slot = 0; slot < Math.floor((MENU_WIDTH - 10) / highlight.width); slot++) {
          blitSprite(s, highlight, left + 5 + slot * highlight.width, top + 9);
        }
      }
      if (text) {
        const font = textWidth('text', text) > 66 ? 'narrow' : 'text';
        drawStyledText(s, text, left + 6, top, this.ignore[absolute] ? 'yellow' : 'white', font);
      }
      if (absolute === this.currentIndex) this.cursor.draw(s, left, top);
    });
  }

  /** CreditDisplay.draw + create_static_surf */
  private drawDisplay(s: Surface): void {
    const game = getGame();
    const page = this.pages[this.pageNum];
    if (!page) return;
    const credit = page.credits[0];
    const type = resourceType(credit);
    const [tx, ty] = [DISPLAY_LEFT, DISPLAY_TOP];
    if (type === 'PANORAMAS') {
      if (!this.panorama) this.panorama = new MenuBackground(credit.sub_nid, game.resources, false);
      this.panorama.draw(s);
      const c = credit.contrib?.[0];
      const lines = c ? lineWrap('text', `${c[1]} by ${c[0]}`, DISPLAY_WIDTH - 16).length : 0;
      s.blit(baseSurf(DISPLAY_WIDTH, 28 + lines * FONT_HEIGHT, 'menu_bg_clear'), tx, ty);
    } else {
      const bg = new Surface(DISPLAY_WIDTH, DISPLAY_HEIGHT);
      bg.blit(baseSurf(DISPLAY_WIDTH, DISPLAY_HEIGHT, 'menu_bg_brown'), 0, 0);
      const shimmer = getSprite('menus/menu_shimmer3');
      if (shimmer) blitSprite(bg, shimmer, bg.width - shimmer.width - 1, bg.height - shimmer.height - 5);
      bg.setAlpha(0.9);
      s.blit(bg, tx, ty);
    }

    if (type === 'PORTRAITS') {
      const img = getPortrait(game.resources, credit.sub_nid);
      if (img) s.blitImage(img, 0, 0, 96, 80, tx + DISPLAY_WIDTH - 8 - 96, ty + WINHEIGHT - 12 - 80);
    }

    blitTextCenter(s, 'text-blue', header(credit), tx + Math.floor(DISPLAY_WIDTH / 2), ty + 4);

    const index = credit.icon_index.length ? credit.icon_index as [number, number] : [0, 0] as [number, number];
    if (type === 'ICONS80') {
      const img = getKeyedImage(game.resources, `resources/icons80/${credit.sub_nid}.png`);
      if (img) s.blitImage(img, index[0] * 80, index[1] * 72, 80, 72, tx + DISPLAY_WIDTH - 8 - 80, ty + WINHEIGHT - 12 - 72);
    }

    let lines: string[] = [];
    let highlight = new Set<number>();
    if (type === 'ICONS16' || type === 'ICONS32' || type === 'MAP_ICONS' || type === 'MAP_SPRITES') {
      let y = 20;
      const iconSize = (type === 'ICONS16' || type === 'MAP_SPRITES' ? 16 : 32) + 4;
      for (const c of page.credits) {
        const idx = c.icon_index.length ? c.icon_index as [number, number] : [0, 0] as [number, number];
        if (type === 'ICONS16') drawIcon16(s, c.sub_nid, idx, tx + 8, ty + y);
        else if (type === 'ICONS32') drawIcon32(s, c.sub_nid, idx, tx + 8, ty + y);
        const wrapped = c.contrib?.[0] ? lineWrap('text', `by ${c.contrib[0][0]}`, DISPLAY_WIDTH - 16 - iconSize) : [];
        wrapped.forEach((line, i) => drawStyledText(s, line, tx + 8 + iconSize, ty + y + i * FONT_HEIGHT, 'white', 'text'));
        y += Math.max(wrapped.length * FONT_HEIGHT, iconSize);
      }
    } else if ((type === 'ICONS80' || type === 'PORTRAITS' || type === 'PANORAMAS') && credit.contrib?.[0]) {
      const c = credit.contrib[0];
      lines = lineWrap('text', c[1], DISPLAY_WIDTH - 16);
      const last = lines.pop() ?? '';
      highlight = new Set(lines.map((_, i) => i));
      lines.push(...lineWrap('text', `<orange>${last}</> by ${c[0]}`, DISPLAY_WIDTH - 16));
    } else if (credit.credit_type === 'List' && Array.isArray(page.content)) {
      for (const c of page.content as [string, string][]) {
        const start = lines.length;
        lines.push(...lineWrap('text', c[1], DISPLAY_WIDTH - 16));
        const last = lines.pop() ?? '';
        for (let i = start; i < lines.length; i++) highlight.add(i);
        lines.push(...lineWrap('text', `<orange>${last}</> by ${c[0]}`, DISPLAY_WIDTH - 16));
      }
    } else if (credit.credit_type === 'Text' && Array.isArray(page.content)) {
      (page.content as string[]).forEach((line, i) => drawStyledText(s, line, tx + 8, ty + 12 + 8 + i * FONT_HEIGHT, 'white', 'text'));
    }
    lines.forEach((line, i) => {
      drawStyledText(s, line, tx + 8, ty + 20 + i * FONT_HEIGHT, highlight.has(i) ? 'orange' : 'white', 'text');
    });

    if (this.pages.length > 1) {
      blitTextRight(s, 'text-yellow', `${this.pageNum + 1} / ${this.pages.length}`, tx + DISPLAY_WIDTH - 8, ty + WINHEIGHT - 12 - 16);
      this.leftArrow.draw(s);
      this.rightArrow.draw(s);
    }
  }
}
