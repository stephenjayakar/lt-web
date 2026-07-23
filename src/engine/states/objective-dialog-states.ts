import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';

let _game: any = null;
export function setObjectiveDialogGameRef(game: any): void {
  _game = game;
}
function getGame(): any {
  if (!_game) throw new Error('Objective/dialog states: game reference not set');
  return _game;
}

const FONT = '7px monospace';
const SMALL = '6px monospace';
const GOLD = '#f6d77a';
const TEXT = '#f7f3df';
const MUTED = '#a9b4c8';
const PANEL = 'rgba(10, 18, 33, 0.94)';
const EDGE = '#8da9cf';

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
    .replace(/[ \t]+/g, ' ');
}

function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  for (const paragraph of cleanDialogText(text).split('\n')) {
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > columns && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.filter((line, index, all) => line || all.length === 1 || index < all.length - 1);
}

function panel(surf: Surface, x: number, y: number, width: number, height: number): void {
  surf.fillRect(x, y, width, height, PANEL);
  surf.drawRect(x, y, width, height, EDGE);
  surf.drawLine(x + 2, y + 2, x + width - 3, y + 2, 'rgba(255,255,255,.18)');
}

export class ObjectiveMenuState extends State {
  readonly name = 'objective_menu';
  override readonly showMap = false;
  private scroll = 0;

  override begin(): StateResult {
    this.scroll = 0;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (event === 'UP') this.scroll = Math.max(0, this.scroll - 1);
    else if (event === 'DOWN') this.scroll += 1;
    else if (event === 'BACK' || event === 'INFO' || game.input?.mouseClick === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const level = game.currentLevel;
    surf.fill(6, 11, 23, 1);
    surf.fillRect(0, 0, surf.width, 30, '#10294a');
    surf.fillRect(0, 29, surf.width, 1, '#d5a94a');

    surf.drawText(level?.name ?? 'Current Mission', 8, 7, TEXT, 'bold 10px monospace');
    surf.drawText('MISSION BRIEF', 8, 20, GOLD, SMALL);
    const seed = String(game.gameVars.get('_random_seed') ?? 0);
    surf.drawText(`#${seed}`, surf.width - 9 - seed.length * 6, 9, MUTED, SMALL);

    panel(surf, 5, 35, surf.width - 10, 28);
    const playSeconds = Math.floor(Number(game.playtime ?? 0) / 1000);
    const playtime = `${Math.floor(playSeconds / 3600)}:${String(Math.floor(playSeconds / 60) % 60).padStart(2, '0')}:${String(playSeconds % 60).padStart(2, '0')}`;
    const stats = [
      ['TURN', String(game.turnCount ?? 1)],
      ['FUNDS', `${game.getMoney?.() ?? 0}G`],
      ['TIME', playtime],
    ];
    stats.forEach(([label, value], index) => {
      const x = 12 + index * Math.floor((surf.width - 24) / 3);
      surf.drawText(label, x, 40, GOLD, SMALL);
      surf.drawText(value, x, 50, TEXT, FONT);
    });

    panel(surf, 5, 68, Math.floor(surf.width * 0.62), 86);
    surf.drawText('OBJECTIVES', 12, 74, GOLD, SMALL);
    const objective = level?.objective ?? {};
    const lines = [
      ...wrap(`VICTORY  ${objective.win || objective.simple || 'Complete the mission'}`, 31),
      '',
      ...wrap(`DEFEAT   ${objective.loss || 'The party falls'}`, 31),
    ];
    const visible = lines.slice(this.scroll, this.scroll + 8);
    visible.forEach((line, index) => {
      surf.drawText(line, 12, 86 + index * 8, line.startsWith('VICTORY') || line.startsWith('DEFEAT') ? GOLD : TEXT, SMALL);
    });
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - 8));

    const rightX = Math.floor(surf.width * 0.62) + 9;
    const rightW = surf.width - rightX - 5;
    panel(surf, rightX, 68, rightW, 58);
    surf.drawText('FORCES', rightX + 7, 74, GOLD, SMALL);
    const teamRows = [
      ['PLAYER', 'player', '#76d6ff'],
      ['ENEMY', 'enemy', '#ff7c72'],
      ['OTHER', 'other', '#9be49b'],
    ];
    teamRows.forEach(([label, team, color], index) => {
      const count = game.getTeamUnits?.(team).filter((unit: any) => unit.position).length ?? 0;
      surf.drawText(label, rightX + 7, 87 + index * 11, color, SMALL);
      surf.drawText(String(count || '--'), rightX + rightW - 18, 87 + index * 11, TEXT, FONT);
    });

    panel(surf, rightX, 131, rightW, 23);
    surf.drawText('↑↓ scroll', rightX + 6, 137, MUTED, SMALL);
    surf.drawText('B close', rightX + 6, 146, TEXT, SMALL);
    return surf;
  }
}

export class DialogLogState extends State {
  readonly name = 'dialog_log';
  override readonly transparent = true;
  private scroll = 0;

  override begin(): StateResult {
    this.scroll = Math.max(0, (getGame().dialogLogEntries?.length ?? 0) - 4);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const max = Math.max(0, (game.dialogLogEntries?.length ?? 0) - 1);
    if (event === 'UP') this.scroll = Math.max(0, this.scroll - 1);
    else if (event === 'DOWN') this.scroll = Math.min(max, this.scroll + 1);
    else if (event === 'INFO' || event === 'BACK' || game.input?.mouseClick === 'BACK') {
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    const entries: Array<{ speaker: string; text: string }> = getGame().dialogLogEntries ?? [];
    surf.fillRect(0, 0, surf.width, surf.height, 'rgba(2, 6, 14, 0.82)');
    panel(surf, 8, 7, surf.width - 16, surf.height - 14);
    surf.drawText('DIALOG LOG', 16, 14, GOLD, 'bold 9px monospace');
    surf.drawText('INFO / B  close', surf.width - 91, 16, MUTED, SMALL);
    surf.drawLine(15, 28, surf.width - 16, 28, 'rgba(141,169,207,.55)');

    let y = 35;
    for (let index = this.scroll; index < entries.length && y < surf.height - 15; index++) {
      const entry = entries[index];
      const lines = wrap(entry.text, 43);
      const height = 12 + lines.length * 8;
      if (y + height > surf.height - 10 && index > this.scroll) break;
      if (entry.speaker) surf.drawText(entry.speaker.toUpperCase(), 17, y, GOLD, SMALL);
      lines.forEach((line, lineIndex) => {
        surf.drawText(line, 17, y + 9 + lineIndex * 8, TEXT, SMALL);
      });
      y += height + 5;
    }
    if (entries.length === 0) {
      surf.drawText('No dialog recorded yet.', 17, 42, MUTED, FONT);
    } else {
      const trackY = 34;
      const trackH = surf.height - 52;
      surf.fillRect(surf.width - 14, trackY, 2, trackH, 'rgba(255,255,255,.16)');
      const thumbH = Math.max(8, Math.floor(trackH * Math.min(1, 4 / entries.length)));
      const thumbY = trackY + Math.floor((trackH - thumbH) * (this.scroll / Math.max(1, entries.length - 1)));
      surf.fillRect(surf.width - 14, thumbY, 2, thumbH, GOLD);
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
