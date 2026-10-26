/**
 * help-menu.ts — Python app/engine/help_menu.py info boxes.
 *
 * HelpDialog / ItemHelpDialog / SkillHelpDialog / StatDialog draw a
 * help_bg_base window with the help_logo tab, 'convo' text in the
 * __default_help colour (black), and grow in from the top-left over 130 ms
 * whenever they reappear. Item boxes add the weapon-type icon, rank and the
 * Rng/Wt/Mt/Hit/Crit grid; stat boxes list each bonus with a dotted leader.
 *
 * Descriptions type out through a Dialog in the `__default_help` speak style
 * (speed 0.5 of the text_speed setting, 8 lines, no window or cursor), and
 * retype whenever the box reappears after a second unseen.
 */

import { Surface } from '../engine/surface';
import { FRAMETIME, WINHEIGHT, WINWIDTH, getFrameCount } from '../engine/constants';
import { drawIcon16 } from './icons';
import { drawStyledText, measureStyledText } from './styled-text';
import { baseSurf, blitText, blitTextRight, getSprite, lineWrap, textWidth } from './menu-chrome';
import { loadMenuBgSprite } from './base-surf';
import { createItemTree, type ItemObject } from '../objects/item';
import { evalWeightForHelp } from '../combat/item-system';
import { Dialog } from './dialog';
import { getSetting } from '../engine/states/settings-state';
import { isForkEngine } from '../engine/engine-flavor';
import type { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';

const MAX_TEXT_WIDTH = WINWIDTH - 40;
const FONT = 'convo';
const LINE_H = 16;
const TEXT_COLOR = 'black';
const ITEM_HELP_WIDTH = 160;

let _game: any = null;
/** Give help boxes access to the DB/translations. */
export function setHelpMenuGameRef(game: any): void {
  _game = game;
  // Load the window art up front so the first INFO press draws it.
  void loadMenuBgSprite('help_bg_base');
  getSprite('menus/help_logo');
}

function translate(text: string): string {
  return _game?.db?.translate?.(text) ?? text;
}

/** The `__default_help` speak style, with any event `speak_style` override. */
function helpStyle(): { speed: number; fontColor: string; numLines: number } {
  const custom = _game?.speakStyles instanceof Map ? _game.speakStyles.get('__default_help') : null;
  return {
    speed: typeof custom?.speed === 'number' ? custom.speed : 0.5,
    fontColor: custom?.fontColor || TEXT_COLOR,
    numLines: custom?.numLines || 8,
  };
}

/**
 * Dialog.from_style(__default_help, desc, width) placed at (0, y) inside the
 * help window: the typewriter that reveals a help description.
 */
function helpDialog(desc: string, width: number, y: number): Dialog {
  const style = helpStyle();
  const raw = Number(getSetting('text_speed'));
  const textSpeed = Number.isFinite(raw) && raw >= 0 ? raw : 32;
  return new Dialog(desc.replace(/\n/g, '{br}'), undefined, undefined, textSpeed, style.speed, false, {
    background: 'None', messageTail: 'None', drawCursor: false, fontType: FONT,
    fontColor: style.fontColor, numLines: style.numLines, width, position: [0, y],
  });
}

/** text_funcs.split: spread `text` over `numLines` roughly equal lines. */
function splitLines(text: string, numLines: number, maxWidth: number): string[] {
  const total = measureStyledText(text, FONT);
  const lines: string[][] = Array.from({ length: Math.max(1, numLines) }, () => []);
  let newLine = false;
  let which = 0;
  for (const ch of text) {
    if (newLine && ch === ' ') {
      which += 1;
      newLine = false;
      if (which >= lines.length) break;
      continue;
    }
    if (which >= lines.length) lines.push([]);
    lines[which].push(ch);
    const so = measureStyledText(lines[which].join(''), FONT);
    if (numLines > 1 && so >= Math.floor(total / numLines) - 5) newLine = true;
    else if (so >= maxWidth) newLine = true;
  }
  return lines.map((l) => l.join(''));
}

function findNumLines(desc: string): number {
  const lines = desc.replace(/\{br\}/g, '\n').split('\n');
  let total = lines.length;
  for (const line of lines) total += Math.floor(measureStyledText(line, FONT) / MAX_TEXT_WIDTH);
  return total;
}

/** HelpDialog.build_lines */
function buildLines(desc: string): string[] {
  const out: string[] = [];
  for (const line of desc.replace(/\{br\}/g, '\n').split('\n')) {
    out.push(...splitLines(line, findNumLines(line), MAX_TEXT_WIDTH));
  }
  return out.filter((line, i, all) => line.length > 0 || all.length === 1);
}

/** Wrap text to a dialog width (Dialog reformat), honouring {br}/newlines. */
function wrapTo(desc: string, width: number): string[] {
  const out: string[] = [];
  for (const chunk of desc.replace(/\{br\}/g, '\n').split('\n')) out.push(...lineWrap(FONT, chunk, width));
  return out;
}

export abstract class HelpBox {
  /** The description typewriter (Python self.dlg); null when there is no text. */
  protected dlg: Dialog | null = null;
  /**
   * Whether the text retypes when the box reappears. Upstream
   * ItemHelpDialog.draw rebuilds its dialog without keeping it, so item text
   * stays revealed; HelpDialog/StatDialog (and the fork base) retype.
   */
  protected retypeOnReappear = true;
  protected lastTime = -Infinity;
  protected startTime = 0;
  protected time = 0;
  protected transitionIn = false;
  protected transitionOut = 0;
  abstract get width(): number;
  abstract get height(): number;
  protected abstract paint(surf: Surface): void;
  /** Python create_dialog. */
  protected createDialog(): Dialog | null { return null; }

  /** Description text revealed so far (tests/logs). */
  get revealedText(): string {
    return this.dlg?.displayedText ?? '';
  }

  setTransitionIn(): void {
    this.transitionIn = true;
    this.transitionOut = 0;
    this.startTime = this.time;
  }

  setTransitionOut(): void {
    this.transitionOut = this.time || 1;
  }

  /** True while the box is still growing in (Python dlg TRANSITION_IN). */
  get transitioningIn(): boolean {
    return this.transitionIn;
  }

  /** Public HelpDialog.top_left for callers that decorate the box. */
  topLeftAt(x: number, y: number, right = false): [number, number] {
    return this.topLeft(x, y, right);
  }

  /** HelpDialog.top_left: keep the box on screen. */
  protected topLeft(x: number, y: number, right: boolean): [number, number] {
    if (right) x -= this.width;
    if (x + this.width >= WINWIDTH) x = WINWIDTH - this.width - 8;
    if (y + this.height >= WINHEIGHT) y = Math.max(0, y - this.height - 16);
    if (x < 0) x = 0;
    return [x, y];
  }

  /**
   * HelpDialog.draw + final_draw at scene position (x, y); `origin` offsets
   * the 240x160 scene inside a larger viewport surface.
   */
  draw(surf: Surface, x: number, y: number, right = false, origin: [number, number] = [0, 0], dtMs = FRAMETIME): void {
    this.time += dtMs;
    // Python compares engine.get_time() with the last draw: a box unseen for
    // over a second grows in again and retypes. The engine is frame-stepped
    // at 60 FPS, so the global frame count is that clock.
    const clock = getFrameCount() * FRAMETIME;
    if (this.lastTime === -Infinity || clock > this.lastTime + 1000) {
      this.startTime = this.time - 16;
      this.transitionIn = true;
      this.transitionOut = 0;
      if (this.retypeOnReappear || !this.dlg) this.dlg = this.createDialog();
    }
    this.lastTime = clock;

    const help = new Surface(this.width, this.height);
    help.blit(baseSurf(this.width, this.height, 'help_bg_base'), 0, 0);
    this.paint(help);
    if (this.dlg) {
      this.dlg.update(dtMs);
      this.dlg.draw(help);
    }
    const box = new Surface(this.width, this.height + 3);
    box.blit(help, 0, 3);
    const logo = getSprite('menus/help_logo');
    if (logo) box.blitImage(logo, 0, 0, logo.width, logo.height, 9, 0);

    let scale = 1;
    if (this.transitionIn) {
      const progress = Math.max(0, Math.min(1, (this.time - this.startTime) / 130));
      if (progress >= 1) this.transitionIn = false;
      else scale = progress;
    } else if (this.transitionOut) {
      let progress = 1 - (this.time - this.transitionOut) / 100;
      if (progress <= 0.1) {
        this.transitionOut = 0;
        progress = 0.1;
      }
      scale = progress;
    }
    const [sx, sy] = this.topLeft(x, y, right);
    const px = sx + origin[0];
    const py = sy + origin[1];
    if (scale >= 1) {
      surf.blit(box, px, py);
    } else {
      const w = Math.floor(box.width * scale);
      const h = Math.floor(box.height * scale);
      if (w > 0 && h > 0) surf.blitScaled(box, 0, 0, box.width, box.height, px, py, w, h);
    }
  }
}

/** Python help_menu.HelpDialog (plain description, optional name). */
export class HelpDialog extends HelpBox {
  /** The description as wrapped lines (sizing; tests read the text). */
  readonly lines: string[];
  private text: string;
  private name: string;
  private w: number;
  private h: number;

  constructor(desc = '', name = '') {
    super();
    this.name = name;
    const text = translate(desc);
    const built = buildLines(text);
    let greatest = built.length ? Math.max(...built.map((l) => measureStyledText(l, FONT))) : 8;
    let numLines = built.length;
    if (name) {
      // Python render_text parses colour tags in the name (EOtF's dex names
      // linked lore/skills as '<blue>Name</>').
      greatest = Math.max(greatest, measureStyledText(name, FONT));
      numLines += 1;
    }
    const dlgWidth = greatest + 16 + ((greatest + 16) % 8 ? 8 - ((greatest + 16) % 8) : 0);
    this.w = dlgWidth;
    this.text = text;
    this.lines = wrapTo(text, dlgWidth - 16);
    this.h = LINE_H * numLines + 16;
  }

  get width(): number { return this.w; }
  get height(): number { return this.h; }

  protected override createDialog(): Dialog {
    return helpDialog(this.text, this.w, this.name ? 16 : 0);
  }

  protected paint(surf: Surface): void {
    if (this.name) drawStyledText(surf, this.name, 8, 8, helpStyle().fontColor, FONT);
  }
}

/** Python help_menu.SkillHelpDialog: name (+ charge) then description. */
export class SkillHelpDialog extends HelpDialog {
  constructor(skill: SkillObject) {
    const total = Number(skill.data.get('total_charge') ?? 0);
    const charge = total ? ` ${Number(skill.data.get('charge') ?? 0)} / ${total}` : '';
    super(skill.desc ?? '', `${skill.name}${charge}`);
  }
}

/** Python help_menu.StatDialog: description plus a line per bonus source. */
export class StatDialog extends HelpBox {
  readonly lines: string[];
  private desc: string;
  private bonuses: [string, number][];

  constructor(desc: string, bonuses: Record<string, number>) {
    super();
    this.desc = translate(desc);
    this.lines = wrapTo(this.desc, 144);
    this.bonuses = Object.entries(bonuses)
      .sort((a, b) => Number(a[0] !== 'Base Value') - Number(b[0] !== 'Base Value'));
  }

  get width(): number { return 160; }
  get height(): number { return LINE_H * (this.lines.length + this.bonuses.length) + 16; }

  /**
   * StatDialog.create_dialog: each bonus becomes a dialog line, the value in
   * 'text' (green/red for later sources), a dotted leader typed at max speed,
   * then the source name.
   */
  protected override createDialog(): Dialog {
    const color = helpStyle().fontColor;
    let desc = this.desc.replace(/\n/g, '{br}');
    this.bonuses.forEach(([bonus, val], idx) => {
      let width: number;
      if (idx === 0) {
        width = textWidth('text', String(val));
        desc += `{br}<text><${color}>${val}</></>`;
      } else if (val > 0) {
        width = textWidth('text', `+${val}`);
        desc += `{br}<text><green>+${val}</></>`;
      } else if (val < 0) {
        width = textWidth('text', String(val));
        desc += `{br}<text><red>${val}</></>`;
      } else {
        width = textWidth(FONT, String(val));
        desc += `{br}<${FONT}><${color}>${val}</></>`;
      }
      desc += `{max_speed}${'﹘'.repeat(Math.max(0, 24 - width))}{starting_speed}<${FONT}><${color}>${bonus}</></>`;
    });
    return helpDialog(desc, 160, 0);
  }

  protected paint(_surf: Surface): void {}
}

/** Python help_menu.ItemHelpDialog. */
export class ItemHelpDialog extends HelpBox {
  private item: ItemObject;
  private unit: UnitObject | null;
  private vals: (string | number | null)[];
  private numPresent: number;
  readonly lines: string[];
  private desc: string;
  private vOffset = 0;
  private nameOverride: string | null = null;

  constructor(item: ItemObject, unit: UnitObject | null = null, first = true) {
    super();
    this.item = item;
    this.unit = unit ?? item.owner ?? null;
    if (!first || item.hasComponent('show_item_name_in_help_dlg')) {
      this.nameOverride = item.name;
      this.vOffset += 16;
    }
    let rank: string | null = item.getWeaponRank?.() ?? null;
    if (!rank) {
      rank = item.hasComponent('prf_unit') || item.hasComponent('prf_class') || item.hasComponent('prf_tag') ? 'Prf' : '--';
    }
    const comp = (nid: string): number | null => {
      if (!item.hasComponent(nid)) return null;
      const value = item.getComponent<number>(nid);
      return typeof value === 'number' ? value : Number(value ?? 0);
    };
    const might = comp('damage');
    const hit = comp('hit');
    const crit = _game?.db?.getConstant?.('crit', true) ? comp('crit') : null;
    let weight = comp('weight');
    if (item.hasComponent('eval_weight')) weight = evalWeightForHelp(item, this.unit, _game);
    this.vals = [rank, this.rangeString(), weight, might, hit, crit];
    this.numPresent = this.vals.filter((v) => v !== null).length;
    this.desc = item.desc ? translate(item.desc) : '';
    this.lines = this.desc ? wrapTo(this.desc, ITEM_HELP_WIDTH - 16) : [];
    this.retypeOnReappear = isForkEngine();
  }

  protected override createDialog(): Dialog | null {
    if (!this.desc) return null;
    return helpDialog(this.desc, ITEM_HELP_WIDTH, (this.numPresent > 3 ? 32 : 16) + this.vOffset);
  }

  /** item_funcs.get_range_string */
  private rangeString(): string {
    const minR = this.item.getMinRange(this.unit ?? undefined, _game);
    const maxR = this.item.getMaxRange(this.unit ?? undefined, _game);
    if (maxR >= 99) return `${minR}+`;
    if (maxR < 0) return translate('Varies');
    return minR !== maxR ? `${minR}-${maxR}` : String(maxR);
  }

  get width(): number { return ITEM_HELP_WIDTH; }
  get height(): number {
    return (this.numPresent > 3 ? 48 : 32) + LINE_H * this.lines.length + this.vOffset;
  }

  protected paint(surf: Surface): void {
    const v = this.vOffset;
    const wtype = this.item.getWeaponType?.();
    const wdef = wtype ? (_game?.db?.weapons ?? []).find((w: any) => w.nid === wtype) : null;
    if (wdef?.icon_nid) drawIcon16(surf, wdef.icon_nid, wdef.icon_index ?? [0, 0], 8, 8 + v);
    blitTextRight(surf, 'text-blue', String(this.vals[0]), 50, 8 + v);
    if (this.nameOverride !== null) blitText(surf, 'text-blue', this.nameOverride, 8, 6);
    const namePos: [number, number][] = [[56, 8], [106, 8], [8, 24], [56, 24], [106, 24]];
    const valPos: [number, number][] = [[100, 8], [144, 8], [50, 24], [100, 24], [144, 24]];
    const names = ['Rng', 'Wt', 'Mt', 'Hit', 'Crit'];
    let slot = 0;
    this.vals.slice(1).forEach((val, i) => {
      if (val === null) return;
      const [nx, ny] = namePos[slot];
      const [vx, vy] = valPos[slot];
      slot += 1;
      blitText(surf, 'text-yellow', translate(names[i]), nx, ny + v);
      blitTextRight(surf, 'text-blue', String(val), vx, vy + v);
    });
  }
}

/** The help box Python builds for an item option (weapons/spells get the stat grid). */
export function itemHelpBox(item: ItemObject, unit: UnitObject | null = null): HelpBox {
  if (item.isWeapon?.() || item.isSpell?.()) return new ItemHelpDialog(item, unit);
  return new HelpDialog(item.desc ?? '');
}

const itemBoxes = new WeakMap<ItemObject, HelpBox>();
/** ItemOption.help_box, built once per item object. */
export function cachedItemHelpBox(item: ItemObject): HelpBox {
  let box = itemBoxes.get(item);
  if (!box) {
    box = itemHelpBox(item);
    itemBoxes.set(item, box);
  }
  return box;
}

/** Colour-tagged keyword in a description (EOtF fork `colortext_pattern`). */
const COLORTEXT_PATTERN = /<(.*?)>([^<>]*?)<\/>/g;

/**
 * EOtF fork get_help_boxes (info_menu_state / player_choice /
 * base_copy_info_menu): every colour-tagged keyword in `desc` that names a
 * lore entry (`<green>`/`<brown>`, by nid, name or alias), an item
 * (`<red>`/`<indigo>`) or a skill (`<blue>`) adds a help page for it, each
 * linked entry at most once.
 */
export function getLinkedHelpBoxes(desc: string | null | undefined): HelpBox[] {
  const db = _game?.db;
  if (!desc || !db) return [];
  const boxes: HelpBox[] = [];
  const dupes: string[] = [];
  for (const match of desc.matchAll(COLORTEXT_PATTERN)) {
    const color = match[1];
    const word = match[2];
    let text = '';
    let name = '';
    let nid = '';
    if (color === 'green' || color === 'brown') {
      const lore = [...(db.lore?.values?.() ?? [])].find((entry: any) => !dupes.includes(entry.nid) &&
        (entry.nid === word || entry.name === word || String(entry.aliases ?? '').split(',').includes(word)));
      if (lore) {
        text = lore.text;
        name = lore.title ?? '';
        nid = lore.nid;
      }
    } else if (color === 'red' || color === 'indigo') {
      const prefab = [...(db.items?.values?.() ?? [])].find((entry: any) => !dupes.includes(entry.nid) &&
        (entry.nid === word || entry.name === word));
      if (prefab) {
        dupes.push(prefab.nid);
        const item = createItemTree(prefab, (n: string) => db.items.get(n));
        boxes.push(new ItemHelpDialog(item, null, false));
      }
    } else if (color === 'blue') {
      const skill = [...(db.skills?.values?.() ?? [])].find((entry: any) => !dupes.includes(entry.nid) &&
        (entry.nid === word || entry.name === word));
      if (skill) {
        text = skill.desc ?? '';
        name = skill.name;
        nid = skill.nid;
      }
    }
    if (nid) {
      dupes.push(nid);
      boxes.push(new HelpDialog(text, `<${color}>${name}</>`));
    }
  }
  return boxes;
}

/**
 * info_graph.InfoGraph.draw page counter: once a multi-page box has grown
 * in, a small-yellow `n/m` sits 16px in from its right edge, 8px up from its
 * bottom.
 */
export function drawHelpPageCounter(
  surf: Surface, box: HelpBox, x: number, y: number, page: number, total: number, right = false,
): void {
  if (total <= 1 || box.transitioningIn) return;
  const [tx, ty] = box.topLeftAt(x, y, right);
  blitTextRight(surf, 'small-yellow', `${page + 1}/${total}`, tx + box.width - 16, ty + box.height - 8);
}
