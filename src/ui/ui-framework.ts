/**
 * ui-framework.ts: the subset of lt-maker's app/engine/graphics/ui_framework
 * the unit chart (game_menus/menu_components/unit_menu) is built from:
 * UIComponent with its CSS-like metrics (sizes and margins in pixels or
 * percentages of the parent, overflow, scroll), the NONE and LIST layouts,
 * scroll animations on the component clock, and the PlainTextLine,
 * IconRow and HeaderList premade components.
 *
 * Python caches every derived dimension and re-derives it when a property
 * changes; here they are derived on read from the same properties, which
 * gives the same numbers. Rendered surfaces are cached per component and
 * rebuilt when a component (or a child) changed, as Python does.
 */

import { Surface } from '../engine/surface';
import { WINHEIGHT, WINWIDTH } from '../engine/constants';
import { FONT } from '../rendering/bmp-font';
import { blitText, textWidth } from './menu-chrome';

export type HAlignment = 'left' | 'center' | 'right';
export type VAlignment = 'top' | 'center' | 'bottom';
export type MetricInput = number | string | UIMetric;
type Quad = [number, number, number, number];

/** Python round(): halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

/** Python UIMetric: a length in pixels or a percentage of the parent's. */
export class UIMetric {
  readonly val: number;
  readonly percent: boolean;

  constructor(val: number, percent: boolean) {
    this.val = Math.trunc(val);
    this.percent = percent;
  }

  static pixels(val: number): UIMetric { return new UIMetric(val, false); }
  static percentOf(val: number): UIMetric { return new UIMetric(val, true); }

  /** "50%" is a percentage; 50, "50px" and "50.0" are pixels (rounded). */
  static parse(input: MetricInput): UIMetric {
    if (input instanceof UIMetric) return input;
    const text = String(input);
    if (text.endsWith('px')) return new UIMetric(Number.parseInt(text.slice(0, -2), 10) || 0, false);
    if (text.endsWith('%')) return new UIMetric(Number.parseInt(text.slice(0, -1), 10) || 0, true);
    const value = Number(text);
    return new UIMetric(Number.isFinite(value) ? pyRound(value) : 0, false);
  }

  toPixels(parent = 100): number {
    return this.percent ? Math.trunc(this.val * parent / 100) : this.val;
  }
}

const px = (value: number) => UIMetric.pixels(value);

/** copy_surface of a possibly empty surface. */
function copySafe(source: Surface): Surface {
  if (source.width <= 0 || source.height <= 0) return new Surface(Math.max(0, source.width), Math.max(0, source.height));
  return source.copy();
}

/** pygame blit: an empty surface draws nothing (canvas refuses 0-size sources). */
function blitSafe(target: Surface, source: Surface, x: number, y: number): void {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) return;
  target.blit(source, x, y);
}

/** Python ComponentProperties. */
export class ComponentProperties {
  hAlignment: HAlignment = 'left';
  vAlignment: VAlignment = 'top';
  bg: Surface | null = null;
  bgColor: [number, number, number, number] = [0, 0, 0, 0];
  bgAlign: [HAlignment, VAlignment] = ['center', 'center'];
  layout: 'none' | 'list' = 'none';
  listStyle: 'row' | 'column' = 'row';
  overflow: UIMetric[] = [px(0), px(0), px(0), px(0)];
  size: UIMetric[] = [UIMetric.percentOf(100), UIMetric.percentOf(100)];
  margin: UIMetric[] = [px(0), px(0), px(0), px(0)];
  padding: UIMetric[] = [px(0), px(0), px(0), px(0)];
  offset: UIMetric[] = [px(0), px(0)];
  scroll: UIMetric[] = [px(0), px(0)];
  maxWidth: UIMetric = UIMetric.percentOf(100);
  maxHeight: UIMetric = UIMetric.percentOf(100);
  opacity = 1;
  /** TextProperties.font_name for text components. */
  fontName = 'text';
}

/** Python UIAnimation (only what the scroll animations use). */
export class UIAnimation {
  component: UIComponent | null = null;
  private begun = false;
  private currentTime = 0;
  private readonly before: (c: UIComponent) => void;
  private readonly during: (c: UIComponent, t: number) => void;
  private readonly after: (c: UIComponent) => void;
  private readonly shouldHalt: (c: UIComponent, t: number) => boolean;

  constructor(opts: {
    before: (c: UIComponent) => void;
    during: (c: UIComponent, t: number) => void;
    after: (c: UIComponent) => void;
    halt: (c: UIComponent, t: number) => boolean;
  }) {
    this.before = opts.before;
    this.during = opts.during;
    this.after = opts.after;
    this.shouldHalt = opts.halt;
  }

  /** True once the animation has halted. */
  update(deltaTime: number): boolean {
    if (!this.component) return false;
    if (!this.begun) {
      this.begun = true;
      this.currentTime = 0;
      this.before(this.component);
      return false;
    }
    this.currentTime += deltaTime;
    if (this.shouldHalt(this.component, this.currentTime)) {
      this.after(this.component);
      this.begun = false;
      this.currentTime = 0;
      return true;
    }
    this.during(this.component, this.currentTime);
    return false;
  }
}

/** animation_templates.component_scroll_anim: linear scroll over `duration` ms. */
export function componentScrollAnim(start: [number, number], end: [number, number], duration = 125): UIAnimation {
  const lerp = (t: number): [number, number] => [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
  ];
  return new UIAnimation({
    before: (c) => { c.scroll = start; },
    during: (c, t) => { c.scroll = lerp(t / duration); },
    after: (c) => { c.scroll = end; },
    halt: (_c, t) => t >= duration,
  });
}

/** The engine clock UI animations run on (Python engine.get_time). */
let chronometer: () => number = () => performance.now();

export function setUiChronometer(clock: () => number): void {
  chronometer = clock;
}

interface ParentLike {
  readonly size: [number, number];
  readonly padding: Quad;
}

const ROOT: ParentLike = { size: [WINWIDTH, WINHEIGHT], padding: [0, 0, 0, 0] };

/** Python UIComponent. */
export class UIComponent {
  name: string;
  parent: UIComponent | null;
  children: UIComponent[] = [];
  /** (pos, surf, z_level, name) */
  manualSurfaces: { pos: [number, number]; surf: Surface; z: number; name: string | null }[] = [];
  props = new ComponentProperties();
  enabled = true;
  onScreen = true;
  queuedAnimations: UIAnimation[] = [];
  private lastUpdate: number;
  protected shouldRedrawFlag = true;
  private cachedSurf: Surface | null = null;
  private cachedBackground: Surface | null = null;

  constructor(name = '', parent: UIComponent | null = null) {
    this.name = name;
    this.parent = parent;
    this.lastUpdate = chronometer();
  }

  get isRoot(): boolean {
    return this.parent === null;
  }

  // -- derived dimensions --------------------------------------------------

  private parentInner(): [number, number] {
    const parent: ParentLike = this.parent ?? ROOT;
    const [w, h] = parent.size;
    const p = parent.padding;
    return [w - p[0] - p[1], h - p[2] - p[3]];
  }

  get tsize(): [number, number] {
    const [pw, ph] = this.parentInner();
    return [this.props.size[0].toPixels(pw), this.props.size[1].toPixels(ph)];
  }
  get twidth(): number { return this.tsize[0]; }
  get theight(): number { return this.tsize[1]; }
  get maxWidth(): number { return this.props.maxWidth.toPixels(this.parentInner()[0]); }
  get maxHeight(): number { return this.props.maxHeight.toPixels(this.parentInner()[1]); }
  get size(): [number, number] {
    const [tw, th] = this.tsize;
    return [Math.min(this.maxWidth, tw), Math.min(th, this.maxHeight)];
  }
  get width(): number { return this.size[0]; }
  get height(): number { return this.size[1]; }

  get padding(): Quad {
    const [tw, th] = this.tsize;
    const p = this.props.padding;
    return [p[0].toPixels(tw), p[1].toPixels(tw), p[2].toPixels(th), p[3].toPixels(th)];
  }
  get margin(): Quad {
    const [pw, ph] = this.parentInner();
    const m = this.props.margin;
    return [m[0].toPixels(pw), m[1].toPixels(pw), m[2].toPixels(ph), m[3].toPixels(ph)];
  }
  get overflow(): Quad {
    const [pw, ph] = this.parentInner();
    const o = this.props.overflow;
    return [o[0].toPixels(pw), o[1].toPixels(pw), o[2].toPixels(ph), o[3].toPixels(ph)];
  }
  get offset(): [number, number] {
    const [pw, ph] = this.parentInner();
    return [this.props.offset[0].toPixels(pw), this.props.offset[1].toPixels(ph)];
  }
  get scroll(): [number, number] {
    const [tw, th] = this.tsize;
    const [w, h] = this.size;
    const sx = this.props.scroll[0].toPixels(tw - w);
    const sy = this.props.scroll[1].toPixels(th - h);
    return [Math.max(0, Math.min(tw, sx)), Math.max(0, Math.min(th, sy))];
  }

  // -- property setters (Python's cached-attribute __setattr__) -------------

  set size(value: [MetricInput, MetricInput]) {
    this.props.size = [UIMetric.parse(value[0]), UIMetric.parse(value[1])];
    this.shouldRedrawFlag = true;
    this.cachedBackground = null;
  }
  set width(value: MetricInput) {
    this.props.size = [UIMetric.parse(value), this.props.size[1]];
    this.shouldRedrawFlag = true;
    this.cachedBackground = null;
  }
  set height(value: MetricInput) {
    this.props.size = [this.props.size[0], UIMetric.parse(value)];
    this.shouldRedrawFlag = true;
    this.cachedBackground = null;
  }
  set maxWidth(value: MetricInput) {
    this.props.maxWidth = UIMetric.parse(value);
    this.shouldRedrawFlag = true;
  }
  set maxHeight(value: MetricInput) {
    this.props.maxHeight = UIMetric.parse(value);
    this.shouldRedrawFlag = true;
  }
  set margin(value: MetricInput[]) {
    this.props.margin = value.map(UIMetric.parse);
    if (this.parent) this.parent.shouldRedrawFlag = true;
  }
  set padding(value: MetricInput[]) {
    this.props.padding = value.map(UIMetric.parse);
    this.shouldRedrawFlag = true;
  }
  set overflow(value: MetricInput[]) {
    this.props.overflow = value.map(UIMetric.parse);
    this.shouldRedrawFlag = true;
    this.cachedBackground = null;
  }
  set offset(value: MetricInput[]) {
    this.props.offset = value.map(UIMetric.parse);
    if (this.parent) this.parent.shouldRedrawFlag = true;
  }
  set scroll(value: MetricInput[]) {
    this.props.scroll = value.map(UIMetric.parse);
    if (this.parent) this.parent.shouldRedrawFlag = true;
  }

  setBackground(bg: Surface | null): void {
    this.props.bg = bg;
    this.cachedBackground = null;
    this.shouldRedrawFlag = true;
  }

  static createBaseComponent(winWidth = WINWIDTH, winHeight = WINHEIGHT): UIComponent {
    const base = new UIComponent();
    base.width = winWidth;
    base.height = winHeight;
    base.overflow = [0, 0, 0, 0];
    return base;
  }

  static fromExistingSurf(surf: Surface): UIComponent {
    const component = new UIComponent();
    component.width = surf.width;
    component.height = surf.height;
    component.maxWidth = surf.width;
    component.maxHeight = surf.height;
    component.setBackground(surf);
    return component;
  }

  addChild(child: UIComponent | null): void {
    if (!child) return;
    child.parent = this;
    child.lastUpdate = chronometer();
    this.children.push(child);
    child.shouldRedrawFlag = true;
    this.shouldRedrawFlag = true;
  }

  addSurf(surf: Surface, pos: [number, number] = [0, 0], z = 0, name: string | null = null): void {
    this.shouldRedrawFlag = true;
    this.manualSurfaces.push({ pos, surf, z, name });
  }

  clearSurfs(): void {
    if (this.manualSurfaces.length) this.shouldRedrawFlag = true;
    this.manualSurfaces = [];
  }

  shouldRedraw(): boolean {
    return this.shouldRedrawFlag || this.children.some((child) => child.enabled && child.shouldRedraw());
  }

  markRedraw(): void {
    this.shouldRedrawFlag = true;
  }

  protected didRedraw(): void { /* hook */ }

  isAnimating(): boolean {
    return this.queuedAnimations.length !== 0;
  }

  enable(): void {
    this.shouldRedrawFlag = true;
    this.enabled = true;
    for (const child of this.children) child.enable();
  }

  disable(): void {
    this.shouldRedrawFlag = true;
    this.enabled = false;
  }

  queueAnimation(animations: UIAnimation[], force = false): void {
    if (!force && this.isAnimating()) return;
    for (const animation of animations) {
      animation.component = this;
      this.queuedAnimations.push(animation);
    }
  }

  /** Advance animations by the clock (children first, like Python). */
  update(manualDeltaTime = 0): void {
    const deltaTime = manualDeltaTime > 0 ? manualDeltaTime : chronometer() - this.lastUpdate;
    for (const child of this.children) child.update(deltaTime);
    this.lastUpdate += deltaTime;
    if (this.queuedAnimations.length > 0 && this.queuedAnimations[0].update(deltaTime)) {
      this.queuedAnimations.shift();
    }
  }

  /** Pre-draw recalculation (PlainTextLine renders its text here). */
  protected reset(): void { /* hook */ }

  // -- layout --------------------------------------------------------------

  generateChildPositions(): Map<number, [number, number]> {
    return this.props.layout === 'list' ? this.listLayout() : this.naiveLayout();
  }

  private naiveLayout(): Map<number, [number, number]> {
    const [width, height] = this.size;
    const padding = this.padding;
    const positions = new Map<number, [number, number]>();
    this.children.forEach((child, idx) => {
      const [cwidth, cheight] = child.size;
      const margin = child.margin;
      let left = 0;
      let top = 0;
      if (child.props.hAlignment === 'left') left = margin[0] + padding[0];
      else if (child.props.hAlignment === 'center') left = width / 2 - cwidth / 2;
      else left = width - (margin[1] + cwidth + padding[1]);
      if (child.props.vAlignment === 'top') top = margin[2] + padding[2];
      else if (child.props.vAlignment === 'center') top = height / 2 - cheight / 2;
      else top = height - (margin[3] + cheight + padding[3]);
      const offset = child.offset;
      positions.set(idx, [left + offset[0], top + offset[1]]);
    });
    return positions;
  }

  private listLayout(): Map<number, [number, number]> {
    const [width, height] = this.size;
    const padding = this.padding;
    const axis = this.props.listStyle === 'row' ? 0 : 1;
    const incrementing: [number, number] = [padding[0], padding[2]];
    const positions = new Map<number, [number, number]>();
    this.children.forEach((child, idx) => {
      const csize: [number, number] = [child.width, child.height];
      const margin = child.margin;
      const position: [number, number] = [incrementing[0], incrementing[1]];
      if (axis === 0) {
        if (child.props.vAlignment === 'top') position[1] = margin[2] + padding[2];
        else if (child.props.vAlignment === 'center') position[1] = height / 2 - csize[1] / 2;
        else position[1] = height - (margin[3] + csize[1] + padding[3]);
        position[0] += margin[0];
      } else {
        if (child.props.hAlignment === 'left') position[0] = margin[0] + padding[0];
        else if (child.props.hAlignment === 'center') position[0] = width / 2 - csize[0] / 2;
        else position[0] = width - (margin[1] + csize[0] + padding[1]);
        position[1] += margin[2];
      }
      positions.set(idx, position);
      const marginSum = axis === 0 ? margin[0] + margin[1] : margin[2] + margin[3];
      incrementing[axis] = incrementing[axis] + csize[axis] + marginSum;
    });
    return positions;
  }

  // -- rendering -----------------------------------------------------------

  private createBgSurf(): Surface {
    const overflow = this.overflow;
    const [tw, th] = this.tsize;
    const ow = tw + overflow[0] + overflow[1];
    const oh = th + overflow[2] + overflow[3];
    const bg = this.props.bg;
    if (!bg) {
      const surf = new Surface(Math.max(ow, 0), Math.max(oh, 0));
      const [r, g, b, a] = this.props.bgColor;
      if (a > 0) {
        const left = Math.trunc(tw * 0.5 + overflow[0] - tw * 0.5);
        const top = Math.trunc(th * 0.5 + overflow[2] - th * 0.5);
        surf.fillRect(left, top, tw, th, `rgba(${r},${g},${b},${a / 255})`);
      }
      return surf;
    }
    if (!this.cachedBackground || this.cachedBackground.width !== ow || this.cachedBackground.height !== oh) {
      const base = new Surface(Math.max(ow, 0), Math.max(oh, 0));
      let offX = tw * 0.5 + overflow[0] - bg.width * 0.5;
      let offY = th * 0.5 + overflow[2] - bg.height * 0.5;
      if (this.props.bgAlign[0] === 'left') offX = 0;
      else if (this.props.bgAlign[0] === 'right') offX = ow - bg.width;
      if (this.props.bgAlign[1] === 'top') offY = 0;
      else if (this.props.bgAlign[1] === 'bottom') offY = oh - bg.height;
      blitSafe(base, bg, Math.trunc(offX), Math.trunc(offY));
      this.cachedBackground = base;
    }
    return this.cachedBackground;
  }

  toSurf(noCull = false): Surface {
    if (!this.enabled) {
      this.shouldRedrawFlag = false;
      const [w, h] = this.size;
      return new Surface(Math.max(w, 1), Math.max(h, 1));
    }
    if (this.isRoot) this.update();
    let base: Surface;
    if (!this.shouldRedraw() && this.cachedSurf) {
      base = this.cachedSurf;
    } else {
      this.reset();
      base = copySafe(this.createBgSurf());
      const overflow = this.overflow;
      const sorted = [...this.manualSurfaces].sort((a, b) => a.z - b.z);
      for (const manual of sorted) {
        if (manual.z < 0) blitSafe(base, manual.surf, Math.trunc(manual.pos[0] + overflow[0]), Math.trunc(manual.pos[1] + overflow[2]));
      }
      const childSurfs = this.children.map((child) => child.toSurf());
      const positions = this.generateChildPositions();
      this.children.forEach((child, idx) => {
        const pos = positions.get(idx);
        if (!pos) {
          child.onScreen = false;
          return;
        }
        const childOverflow = child.overflow;
        blitSafe(
          base,
          childSurfs[idx],
          Math.trunc(pos[0] - childOverflow[0] + overflow[0]),
          Math.trunc(pos[1] - childOverflow[2] + overflow[2]),
        );
        child.onScreen = true;
      });
      for (const manual of sorted) {
        if (manual.z >= 0) blitSafe(base, manual.surf, Math.trunc(manual.pos[0] + overflow[0]), Math.trunc(manual.pos[1] + overflow[2]));
      }
      if (this.props.opacity < 1) base.setAlpha(this.props.opacity);
      this.cachedSurf = base;
      this.shouldRedrawFlag = false;
      this.didRedraw();
    }
    if (noCull || base.width <= 0 || base.height <= 0) return copySafe(base);
    const [sx, sy] = this.scroll;
    const overflow = this.overflow;
    const w = Math.min(this.twidth - sx, this.width) + overflow[0] + overflow[1];
    const h = Math.min(this.theight - sy, this.height) + overflow[2] + overflow[3];
    return base.subsurface(sx, sy, Math.max(w, 1), Math.max(h, 1));
  }
}

/** PlainTextLine: a single line of text sized to it (width + 1). */
export class PlainTextLine extends UIComponent {
  text: string;
  private prevText: string | null = null;
  private prevFont: string | null = null;

  constructor(name = '', parent: UIComponent | null = null, text = '', fontName = 'text') {
    super(name, parent);
    this.props.fontName = fontName;
    this.text = text;
    this.reset();
  }

  get fontHeight(): number {
    return FONT[this.props.fontName]?.height ?? 16;
  }

  setText(text: string): void {
    this.text = text;
  }

  setFontName(fontName: string): void {
    this.props.fontName = fontName;
  }

  override shouldRedraw(): boolean {
    return this.prevText !== this.text || this.prevFont !== this.props.fontName;
  }

  protected override didRedraw(): void {
    this.prevText = this.text;
    this.prevFont = this.props.fontName;
  }

  protected override reset(): void {
    const w = textWidth(this.props.fontName, this.text) + 1;
    const h = this.fontHeight;
    this.size = [w, h];
    const surf = new Surface(w, h);
    blitText(surf, this.props.fontName, this.text, 0, 0);
    this.setBackground(surf);
  }
}

/** IconRow: an icon then a text, left-aligned in a row (or text aligned right/center). */
export class IconRow extends UIComponent {
  data: unknown;
  text: PlainTextLine;
  icon: UIComponent;

  constructor(name = '', parent: UIComponent | null = null, opts: {
    width?: MetricInput; height?: MetricInput; text?: string;
    icon?: Surface | UIComponent | null; textAlign?: HAlignment; font?: string; data?: unknown;
  } = {}) {
    super(name, parent);
    const textAlign = opts.textAlign ?? 'left';
    if (textAlign === 'left') {
      this.props.layout = 'list';
      this.props.listStyle = 'row';
    }
    this.data = opts.data;
    this.text = new PlainTextLine(opts.text ?? '', this, opts.text ?? '');
    this.text.props.fontName = opts.font ?? 'text';
    this.text.props.hAlignment = textAlign;
    this.icon = this.processIcon(opts.icon ?? null);
    const parentHeight = (this.parent ?? null)?.height ?? WINHEIGHT;
    const parsedHeight = UIMetric.parse(opts.height ?? '0%').toPixels(parentHeight);
    this.size = [opts.width ?? '100%', Math.max(parsedHeight, this.icon.height)];
    this.addChild(this.icon);
    this.addChild(this.text);
    this.updateFont();
  }

  protected override reset(): void {
    this.updateFont();
  }

  updateFont(): void {
    if (this.icon.width + this.text.twidth > this.maxWidth) this.text.setFontName('narrow');
  }

  private processIcon(icon: Surface | UIComponent | null): UIComponent {
    if (icon instanceof UIComponent) return icon;
    if (icon) return UIComponent.fromExistingSurf(icon);
    return UIComponent.fromExistingSurf(new Surface(0, this.text.height));
  }

  getTextTopleft(): [number, number] {
    return this.generateChildPositions().get(1) ?? [0, 0];
  }
}

/** HeaderList: a header row over a scrollable column of rows. */
export class HeaderList extends UIComponent {
  headerRow: IconRow | null;
  dataRows: IconRow[];
  scrollableList: UIComponent | null;
  private listOverflow: number;

  constructor(name: string, parent: UIComponent | null, opts: {
    headerRow: IconRow | null; dataRows: IconRow[]; height?: MetricInput; width?: MetricInput; listOverflow?: number;
  }) {
    super(name, parent);
    const height = opts.height ?? '100%';
    this.size = [opts.width ?? '100%', height];
    this.maxHeight = height;
    this.props.layout = 'list';
    this.props.listStyle = 'column';
    this.listOverflow = opts.listOverflow ?? 6;
    this.dataRows = opts.dataRows;
    this.headerRow = opts.headerRow;
    this.scrollableList = new UIComponent('list', this);
    this.regenerateListComponent();
    this.repopulateChildren();
  }

  get rowHeight(): number {
    return this.dataRows.length ? this.dataRows[0].height : 0;
  }

  get scrolledIndex(): number {
    return this.scrollableList && this.rowHeight ? this.scrollableList.scroll[1] / this.rowHeight : 0;
  }

  get maxVisibleRows(): number {
    return this.rowHeight && this.scrollableList ? this.scrollableList.height / this.rowHeight : 0;
  }

  private repopulateChildren(): void {
    this.children = [];
    if (this.headerRow) this.addChild(this.headerRow);
    if (this.scrollableList) this.addChild(this.scrollableList);
  }

  private regenerateListComponent(): void {
    if (!this.dataRows.length) return;
    const list = new UIComponent('list', this);
    list.size = ['100%', this.height - (this.headerRow ? this.headerRow.height : 0)];
    list.maxHeight = this.height;
    list.props.layout = 'list';
    list.props.listStyle = 'column';
    list.overflow = [2, 2, this.listOverflow, 0];
    let total = 0;
    for (const row of this.dataRows) {
      row.maxWidth = this.width;
      list.addChild(row);
      total += row.height;
    }
    list.height = Math.max(list.maxHeight, total);
    this.scrollableList = list;
  }

  isScrolling(): boolean {
    return !!this.scrollableList?.isAnimating();
  }

  sortRows(order: (row: IconRow) => number): void {
    if (this.scrollableList) {
      this.scrollableList.children = [...this.scrollableList.children]
        .sort((a, b) => order(a as IconRow) - order(b as IconRow));
      this.scrollableList.markRedraw();
    }
    this.markRedraw();
  }

  scrollDown(): void {
    const list = this.scrollableList;
    if (!list) return;
    if (this.scrolledIndex === this.dataRows.length - this.maxVisibleRows + 1) return;
    list.queueAnimation([componentScrollAnim(list.scroll, [list.scroll[0], list.scroll[1] + this.rowHeight])]);
  }

  scrollUp(): void {
    const list = this.scrollableList;
    if (!list) return;
    if (this.scrolledIndex === 0) return;
    list.queueAnimation([componentScrollAnim(list.scroll, [list.scroll[0], list.scroll[1] - this.rowHeight])]);
  }

  override toSurf(noCull = false): Surface {
    const list = this.scrollableList;
    if (list) {
      list.markRedraw();
      const scrolled = this.scrolledIndex;
      const visible = this.maxVisibleRows;
      list.children.forEach((row, idx) => {
        if (idx < scrolled - 0.4 || idx > scrolled + visible) row.disable();
        else row.enable();
      });
    }
    return super.toSurf(noCull);
  }
}
