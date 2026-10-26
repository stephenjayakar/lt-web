/**
 * objective-dialog-states.ts — ObjectiveMenuState and DialogLogState.
 *
 * Ports lt-maker/app/engine/objective_menu.py (with menus.Table in its
 * 'objective_menu' mode) and dialog_log.py / graphics/dialog/dialog_log_ui.py.
 */

import { State, type StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { WINHEIGHT, WINWIDTH } from '../constants';
import { viewport } from '../viewport';
import { drawStyledText } from '../../ui/styled-text';
import {
  MenuBackground,
  MenuScene,
  ScrollBar,
  blitBaseSurf,
  blitSprite,
  blitSub,
  blitText,
  blitTextCenter,
  blitTextRight,
  drawChibi,
  formatPlaytime,
  getSprite,
  lineWrap,
  passiveFrame,
  preloadSprites,
  textWidth,
  unitDisplayName,
} from '../../ui/menu-chrome';
import { evaluateText } from '../../ui/hud';

let _game: any = null;
export function setObjectiveDialogGameRef(game: any): void {
  _game = game;
}
function getGame(): any {
  if (!_game) throw new Error('Objective/dialog states: game reference not set');
  return _game;
}

/** Python DialogLog.clean_speak_text, with {br} stored as '\n'. */
function cleanDialogText(text: string): string {
  return text
    .trim()
    .replace(/\{semicolon\}/g, ';')
    .replace(/\{lt\}/g, '<')
    .replace(/\{gt\}/g, '>')
    .replace(/\{lcb\}/g, '{')
    .replace(/\{rcb\}/g, '}')
    .replace(/\||\{br\}|\{clear\}|\{sub_break\}/g, '\n')
    .replace(/\{[^{}]*\}/g, '')
    .replace(/ +/g, ' ');
}

/** text_renderer.fix_tags: re-open/close tags that span split lines. */
function fixTags(lines: string[]): string[] {
  const stack: string[] = [];
  return lines.map((line) => {
    let fixed = line;
    for (const tag of [...stack].reverse()) fixed = `<${tag}>${fixed}`;
    for (const match of line.matchAll(/<([^<>]*)>/g)) {
      if (match[1].includes('/')) stack.pop();
      else stack.push(match[1]);
    }
    for (let i = 0; i < stack.length; i++) fixed = `${fixed}</>`;
    return fixed;
  });
}

/**
 * objective_menu.get_surfaces: TextEvaluator._evaluate_all(','+condition),
 * split on commas, '{comma}' restored.
 */
function conditionLines(condition: string): string[] {
  const evaluated = evaluateText(`,${condition}`, getGame());
  return fixTags(evaluated.split(',').map((line) => line.replace(/\{comma\}/g, ',')));
}

// ============================================================================
// ObjectiveMenuState
// ============================================================================

const TABLE_TOPLEFT: [number, number] = [4, 60];
const TABLE_ROWS = 6;

export class ObjectiveMenuState extends State {
  readonly name = 'objective_menu';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private options: string[] = [];
  private currentIndex = 0;
  private scroll = 0;
  private winCount = 0;
  private scrollBar = new ScrollBar();

  override start(): StateResult {
    const game = getGame();
    this.bg = new MenuBackground('settings_background', game.resources);
    preloadSprites([
      'menus/chapter_select_green', 'golden_words', 'menus/lowlight', 'scroll_bar',
      'menus/menu_shimmer1', 'menus/menu_shimmer_green', 'menus/menu_shimmer_red', 'menus/menu_shimmer_purple',
    ]);
    const objective = game.currentLevel?.objective ?? {};
    const win = String(objective.win ?? '');
    const loss = String(objective.loss ?? '');
    this.winCount = (win.match(/,/g) ?? []).length;
    this.options = [...conditionLines(win), ...conditionLines(loss)];
    this.currentIndex = 0;
    this.scroll = 0;
  }

  // -- menus.Table move_down/move_up in 'objective_menu' mode (columns = 1) --

  private moveDown(): void {
    const n = this.options.length;
    let row = this.currentIndex + 5;
    if (row >= n) {
      row = 0;
      this.scroll = 0;
    }
    if (row > this.scroll + TABLE_ROWS - 5) this.scroll += 5;
    else if (row > this.scroll + TABLE_ROWS - 2) this.scroll += 1;
    this.currentIndex = row;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, n - TABLE_ROWS)));
  }

  private moveUp(): void {
    const n = this.options.length;
    let row = this.currentIndex - 5;
    if (row < 0) {
      row = n - 1;
      this.scroll = n - TABLE_ROWS;
    }
    if (row < this.scroll + 4) this.scroll -= 5;
    else if (row < this.scroll + 1) this.scroll -= 1;
    this.currentIndex = row;
    this.scroll = Math.max(0, this.scroll);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (event === 'DOWN' || event === 'UP') {
      const before = this.scroll;
      if (event === 'DOWN') this.moveDown();
      else this.moveUp();
      if (before !== this.scroll) game.audioManager?.playSfx?.('Select 6');
    }
    if (event === 'BACK' || game.input?.mouseClick === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      game.state.back();
    }
  }

  override update(): StateResult {
    this.bg?.update();
  }

  /** ObjectiveMenuState.determine_party_leader */
  private partyLeader(): any {
    const game = getGame();
    let unit: any = null;
    if (game.roamInfo?.roam) {
      unit = game.roamInfo.roamUnitNid ? game.units.get(game.roamInfo.roamUnitNid) : null;
    } else {
      const leader = game.getParty?.()?.leaderNid;
      unit = leader ? game.units.get(leader) : null;
    }
    if (!unit) {
      const all: any[] = game.getUnitsInParty?.() ?? [];
      unit = all.find((u) => (u.tags ?? []).includes('Lord')) ?? all[0] ?? null;
    }
    return unit;
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const s = this.scene.begin();

    this.drawTable(s);

    // Chapter name on chapter_select_green.
    const nameBack = getSprite('menus/chapter_select_green');
    if (nameBack) {
      blitSprite(s, nameBack, 24, 2);
      blitTextCenter(s, 'chapter-green', game.currentLevel?.name ?? '', 24 + Math.floor(nameBack.width / 2),
        2 + Math.floor(nameBack.height / 2) - 8);
    }

    // Turn / funds / playtime strip.
    blitBaseSurf(s, WINWIDTH - 8, 24, 'menu_bg_white', 4, 34);
    const golden = getSprite('golden_words');
    blitSub(s, golden, 0, 17, 26, 10, 10, 42);
    blitSub(s, golden, 0, 33, 32, 10, Math.floor(WINWIDTH / 3) - 8, 42);
    blitSub(s, golden, 32, 15, 17, 13, Math.floor(2 * WINWIDTH / 3) + 6, 39);
    blitSub(s, golden, 40, 47, 9, 12, Math.floor(2 * WINWIDTH / 3) - 9, 40);
    const topCount = (a: number, pos: [number, number], value: unknown): void => {
      const text = String(value);
      const w = textWidth('text-blue', text) + 1;
      blitText(s, 'text-blue', text, Math.floor(a * WINWIDTH / 3) - pos[0] - w, pos[1]);
    };
    topCount(1, [16, 38], game.turnCount ?? 1);
    topCount(2, [12, 38], game.getMoney?.() ?? 0);

    // Random seed.
    const seed = String(game.gameVars?.get?.('_random_seed') ?? 0);
    blitTextCenter(s, 'text_numbers', seed, WINWIDTH - 28 + 14, 4);

    // Unit count per team.
    const onField = (team: string): any[] => [...game.units.values()]
      .filter((u: any) => u.team === team && u.position && !u.isDead?.());
    const teamBox = (pos: [number, number], bgNid: string, shimmer: string): void => {
      const w = WINWIDTH - 192;
      blitBaseSurf(s, w, 24, bgNid, pos[0], pos[1]);
      const sh = getSprite(`menus/${shimmer}`);
      if (sh) blitSprite(s, sh, pos[0] + w - 1 - sh.width, pos[1] + 24 - sh.height - 5);
    };
    const partyWord = (x: number, y: number, w: number, h: number, pos: [number, number]): void => {
      blitSub(s, golden, x, y, w, h, WINWIDTH - pos[0], pos[1]);
    };
    const unitCount = (pos: [number, number], units: any[]): void => {
      const text = units.length > 0 ? String(units.length) : '--';
      const w = textWidth('text-blue', String(units.length)) + 6;
      blitText(s, 'text-blue', text, WINWIDTH - pos[0] - w + (units.length > 0 ? 5 : 0), pos[1]);
    };
    teamBox([132, 60], 'menu_bg_base', 'menu_shimmer1');
    partyWord(56, 12, 40, 8, [104, 57]);
    unitCount([75, 62], onField('player'));
    teamBox([132, 80], 'menu_bg_green', 'menu_shimmer_green');
    partyWord(56, 36, 40, 8, [104, 77]);
    unitCount([75, 82], onField('other'));
    teamBox([188, 60], 'menu_bg_red', 'menu_shimmer_red');
    partyWord(56, 20, 40, 8, [48, 57]);
    unitCount([16, 62], onField('enemy'));
    teamBox([188, 80], 'menu_bg_purple', 'menu_shimmer_purple');
    unitCount([16, 82], onField('enemy2'));

    // Party leader box.
    blitBaseSurf(s, WINWIDTH - 136, 62, 'menu_bg_white', 132, 100);
    const unit = this.partyLeader();
    if (unit) {
      drawChibi(s, game.resources, unit.portraitNid, WINWIDTH - 44 + 7, 111 + 8);
      blitTextRight(s, 'text-white', String(unit.name ?? ''), WINWIDTH - 40 - 1, 104);
      blitSub(s, golden, 0, 48, 16, 24, 140, 122);
      blitTextRight(s, 'text-blue', String(unit.level ?? 1), WINWIDTH - 42 - 1, 120);
      blitSub(s, golden, 16, 48, 20, 24, 140, 136);
      const hp = String(unit.getHp?.() ?? unit.currentHp ?? 0);
      const maxHp = String(unit.getMaxHp?.() ?? unit.maxHp ?? 0);
      const hpW = textWidth('text-blue', hp) + 20;
      blitText(s, 'text-blue', `${hp}/${maxHp}`, WINWIDTH - 42 - hpW, 134);
      const frame = passiveFrame(unit.sprite);
      if (frame) s.blit(frame, 116, 82);
    }

    blitTextRight(s, 'text-blue', formatPlaytime(Number(game.playtime ?? 0)), WINWIDTH - 8, 38);

    this.scene.present(surf);
    return surf;
  }

  /** menus.Table.draw in 'objective_menu' mode. */
  private drawTable(s: Surface): void {
    const [tx, ty] = TABLE_TOPLEFT;
    const width = 120;
    const height = 16 * TABLE_ROWS + 8;
    blitBaseSurf(s, width, height, 'menu_bg_base', tx, ty, 0.1);
    if (this.options.length > TABLE_ROWS) {
      this.scrollBar.draw(s, tx + width, ty, this.scroll, TABLE_ROWS, this.options.length);
    }
    const lowlight = getSprite('menus/lowlight');
    const wc = this.winCount;
    const visible = this.options.slice(this.scroll, this.scroll + TABLE_ROWS);
    visible.forEach((text, idx) => {
      const absolute = idx + this.scroll;
      const top = ty + 4 + idx * 16;
      if (absolute < 1) {
        blitSprite(s, lowlight, tx + 2, ty + 12);
        blitText(s, 'text-yellow', 'Win Conditions', tx + 4, ty + 4);
        blitSprite(s, lowlight, tx + 2, ty + 44 + wc * 16);
        blitText(s, 'text-yellow', 'Loss Conditions', tx + 4, ty + 36 + wc * 16);
      } else if (absolute === this.currentIndex) {
        if (this.currentIndex <= 6 || wc >= this.scroll - 2) {
          const offset = (wc - this.scroll + 2) * 16;
          blitSprite(s, lowlight, tx + 2, ty + 12 + offset);
          blitText(s, 'text-yellow', 'Loss Conditions', tx + 4, ty + 4 + offset);
        }
      }
      drawStyledText(s, text, tx + 5, top, 'white', 'text');
    });
  }
}

// ============================================================================
// DialogLogState (dialog_log_ui.DialogLogUI)
// ============================================================================

const LOG_FONT_HEIGHT = 16;
const LOG_CHIBI_SIZE = 32;
const LOG_SCROLL_DISTANCE = 4;

interface LogEntryLayout {
  name: string;
  portraitNid: string | null;
  lines: string[];
  height: number;
}

export class DialogLogState extends State {
  readonly name = 'dialog_log';
  override readonly transparent = true;
  /** Pixels scrolled up from the bottom of the tray. */
  private scroll = 0;
  private layoutCache: { source: unknown[]; length: number; entries: LogEntryLayout[] } | null = null;

  override begin(): StateResult {
    this.scroll = 0; // scroll_to_bottom
  }

  private entries(): LogEntryLayout[] {
    const game = getGame();
    const source: Array<{ speaker: string; text: string }> = game.dialogLogEntries ?? [];
    if (this.layoutCache && this.layoutCache.source === source && this.layoutCache.length === source.length) {
      return this.layoutCache.entries;
    }
    const entries = source.map((entry) => {
      const lines: string[] = [];
      for (const chunk of entry.text.split('\n')) lines.push(...lineWrap('text', chunk, WINWIDTH - LOG_CHIBI_SIZE));
      return {
        name: entry.speaker ? unitDisplayName(game, entry.speaker) : '',
        portraitNid: this.portraitFor(entry.speaker),
        lines,
        height: Math.max(LOG_CHIBI_SIZE, LOG_FONT_HEIGHT + lines.length * LOG_FONT_HEIGHT),
      };
    });
    this.layoutCache = { source, length: source.length, entries };
    return entries;
  }

  /** DialogLog.get_chibi portrait lookup. */
  private portraitFor(name: string): string | null {
    if (!name) return null;
    const game = getGame();
    const unit = game.units?.get?.(name);
    if (unit?.portraitNid) return unit.portraitNid;
    const prefab = game.db?.units?.get?.(name);
    if (prefab) return prefab.portraitNid ?? prefab.portrait_nid ?? null;
    return name;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const entries = this.entries();
    if (event === 'UP') {
      const total = entries.reduce((sum, e) => sum + e.height, 0);
      this.scroll = Math.min(Math.max(0, total - WINHEIGHT), this.scroll + LOG_SCROLL_DISTANCE);
    } else if (event === 'DOWN') {
      this.scroll = Math.max(0, this.scroll - LOG_SCROLL_DISTANCE);
    }
    if (event === 'INFO' || event === 'BACK' || game.input?.mouseClick === 'BACK') {
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    // Fuzzy black background (33, 33, 33, 192) over the whole window.
    surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(33,33,33,0.753)');
    const entries = this.entries();
    const total = entries.reduce((sum, e) => sum + e.height, 0);
    const { x: ox, y: oy } = MenuScene.origin();
    let y = total < WINHEIGHT ? total : WINHEIGHT + this.scroll;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      y -= entry.height;
      if (y > WINHEIGHT || y < -entry.height) continue;
      const top = oy + y;
      if (entry.name) blitText(surf, 'text-yellow', entry.name, ox + LOG_CHIBI_SIZE, top);
      entry.lines.forEach((line, idx) => {
        drawStyledText(surf, line, ox + LOG_CHIBI_SIZE, top + LOG_FONT_HEIGHT + idx * LOG_FONT_HEIGHT, 'white', 'text');
      });
      drawChibi(surf, game.resources, entry.portraitNid, ox, top);
    }
    return surf;
  }
}

export function appendDialogLogEntry(game: any, speaker: string, text: string): void {
  const cleaned = cleanDialogText(text);
  if (!cleaned) return;
  game.dialogLogEntries ??= [];
  game.dialogLogEntries.push({ speaker, text: cleaned });
}
