/**
 * Surface - The core rendering primitive, replacing Pygame's Surface.
 * Wraps an OffscreenCanvas + context for compositing operations.
 *
 * Supports a `logicalScale` factor: when set, the backing canvas is
 * larger than the logical (width x height) dimensions. All draw calls
 * (fillRect, drawText, blit, etc.) accept coordinates in logical space
 * and internally scale them. Sprite blits use nearest-neighbor filtering;
 * text and vector ops render at native resolution for crispness.
 */
export class Surface {
  /** Logical dimensions (game-space, e.g. 240x160). */
  readonly width: number;
  readonly height: number;
  /** Scale factor from logical to physical pixels. 1 = no scaling. */
  readonly scale: number;
  private _canvas: OffscreenCanvas;
  private _ctx: OffscreenCanvasRenderingContext2D;
  private _alpha: number = 1.0;

  constructor(width: number, height: number, scale: number = 1) {
    this.width = width;
    this.height = height;
    this.scale = scale;
    this._canvas = new OffscreenCanvas(
      Math.round(width * scale),
      Math.round(height * scale),
    );
    const ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to get 2d context');
    this._ctx = ctx;
    this._ctx.imageSmoothingEnabled = false;
  }

  get canvas(): OffscreenCanvas {
    return this._canvas;
  }

  get ctx(): OffscreenCanvasRenderingContext2D {
    return this._ctx;
  }

  /** Set global alpha for this surface when blitted */
  setAlpha(alpha: number): void {
    this._alpha = Math.max(0, Math.min(1, alpha));
  }

  getAlpha(): number {
    return this._alpha;
  }

  /** Fill the entire surface with a color */
  fill(r: number, g: number, b: number, a: number = 1): void {
    this._ctx.globalAlpha = 1;
    this._ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    this._ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
  }

  /** Clear the surface to transparent */
  clear(): void {
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  /** Blit another surface onto this one (nearest-neighbor for sprites). */
  blit(source: Surface, dx: number = 0, dy: number = 0): void {
    const s = this.scale;
    this._ctx.imageSmoothingEnabled = false;
    this._ctx.globalAlpha = source._alpha;
    // Source canvas may have its own scale; draw it scaled into our space.
    this._ctx.drawImage(
      source._canvas,
      0, 0, source._canvas.width, source._canvas.height,
      Math.round(dx * s), Math.round(dy * s),
      Math.round(source.width * s), Math.round(source.height * s),
    );
    this._ctx.globalAlpha = 1;
  }

  /** Blit a sub-region of another surface onto this one */
  blitFrom(
    source: Surface,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number
  ): void {
    const s = this.scale;
    const ss = source.scale;
    this._ctx.imageSmoothingEnabled = false;
    this._ctx.globalAlpha = source._alpha;
    this._ctx.drawImage(
      source._canvas,
      Math.round(sx * ss), Math.round(sy * ss),
      Math.round(sw * ss), Math.round(sh * ss),
      Math.round(dx * s), Math.round(dy * s),
      Math.round(sw * s), Math.round(sh * s),
    );
    this._ctx.globalAlpha = 1;
  }

  /** Blit with scaling */
  blitScaled(
    source: Surface,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number
  ): void {
    const s = this.scale;
    const ss = source.scale;
    this._ctx.imageSmoothingEnabled = false;
    this._ctx.globalAlpha = source._alpha;
    this._ctx.drawImage(
      source._canvas,
      Math.round(sx * ss), Math.round(sy * ss),
      Math.round(sw * ss), Math.round(sh * ss),
      Math.round(dx * s), Math.round(dy * s),
      Math.round(dw * s), Math.round(dh * s),
    );
    this._ctx.globalAlpha = 1;
  }

  /** Blit an HTMLImageElement or ImageBitmap directly */
  blitImage(
    image: HTMLImageElement | ImageBitmap,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number
  ): void {
    const s = this.scale;
    this._ctx.imageSmoothingEnabled = false;
    this._ctx.globalAlpha = this._alpha;
    this._ctx.drawImage(
      image,
      sx, sy, sw, sh,
      Math.round(dx * s), Math.round(dy * s),
      Math.round(sw * s), Math.round(sh * s),
    );
    this._ctx.globalAlpha = 1;
  }

  /** Create a subsurface view (copies the region). Result is unscaled (scale=1). */
  subsurface(x: number, y: number, w: number, h: number): Surface {
    const sub = new Surface(w, h);
    // Read from physical pixels of this surface, write at 1:1 into sub
    const ss = this.scale;
    sub._ctx.imageSmoothingEnabled = false;
    sub._ctx.drawImage(
      this._canvas,
      Math.round(x * ss), Math.round(y * ss),
      Math.round(w * ss), Math.round(h * ss),
      0, 0, w, h,
    );
    return sub;
  }

  /** Get pixel data at a logical position */
  getPixel(x: number, y: number): [number, number, number, number] {
    const px = Math.round(x * this.scale);
    const py = Math.round(y * this.scale);
    const data = this._ctx.getImageData(px, py, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }

  /** Get the full ImageData (physical pixels) */
  getImageData(): ImageData {
    return this._ctx.getImageData(0, 0, this._canvas.width, this._canvas.height);
  }

  /** Put ImageData back (physical pixels) */
  putImageData(data: ImageData, x: number = 0, y: number = 0): void {
    this._ctx.putImageData(data, x, y);
  }

  /** Create a copy of this surface (preserves scale) */
  copy(): Surface {
    const s = new Surface(this.width, this.height, this.scale);
    s._ctx.imageSmoothingEnabled = false;
    s._ctx.drawImage(this._canvas, 0, 0);
    s._alpha = this._alpha;
    return s;
  }

  /** Create a horizontally flipped copy */
  flipH(): Surface {
    const s = new Surface(this.width, this.height, this.scale);
    const pw = this._canvas.width;
    s._ctx.imageSmoothingEnabled = false;
    s._ctx.save();
    s._ctx.scale(-1, 1);
    s._ctx.drawImage(this._canvas, -pw, 0);
    s._ctx.restore();
    return s;
  }

  /** Create a vertically flipped copy */
  flipV(): Surface {
    const s = new Surface(this.width, this.height, this.scale);
    const ph = this._canvas.height;
    s._ctx.imageSmoothingEnabled = false;
    s._ctx.save();
    s._ctx.scale(1, -1);
    s._ctx.drawImage(this._canvas, 0, -ph);
    s._ctx.restore();
    return s;
  }

  /** Make a translucent copy */
  makeTranslucent(alpha: number): Surface {
    const s = this.copy();
    s.setAlpha(alpha);
    return s;
  }

  /** Convert to grayscale */
  makeGray(): Surface {
    const s = this.copy();
    const imageData = s.getImageData();
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
    }
    s.putImageData(imageData);
    return s;
  }

  /** Draw a rectangle outline */
  drawRect(x: number, y: number, w: number, h: number, color: string, lineWidth: number = 1): void {
    const s = this.scale;
    this._ctx.strokeStyle = color;
    this._ctx.lineWidth = lineWidth * s;
    this._ctx.strokeRect(
      Math.round(x * s) + 0.5,
      Math.round(y * s) + 0.5,
      Math.round(w * s) - 1,
      Math.round(h * s) - 1,
    );
  }

  /** Fill a rectangle */
  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    const s = this.scale;
    this._ctx.fillStyle = color;
    this._ctx.fillRect(
      Math.round(x * s),
      Math.round(y * s),
      Math.round(w * s),
      Math.round(h * s),
    );
  }

  /** Draw a line */
  drawLine(x1: number, y1: number, x2: number, y2: number, color: string, lineWidth: number = 1): void {
    const s = this.scale;
    this._ctx.strokeStyle = color;
    this._ctx.lineWidth = lineWidth * s;
    this._ctx.beginPath();
    this._ctx.moveTo(Math.round(x1 * s), Math.round(y1 * s));
    this._ctx.lineTo(Math.round(x2 * s), Math.round(y2 * s));
    this._ctx.stroke();
  }

  /**
   * Draw text. The font size in the font string is scaled up by the
   * surface scale so text renders crisply at native resolution.
   */
  drawText(text: string, x: number, y: number, color: string = 'white', font: string = '8px monospace'): void {
    const s = this.scale;
    // Scale the font size: extract the numeric px value and multiply by scale
    const scaledFont = font.replace(/(\d+(?:\.\d+)?)px/, (_, size) => `${parseFloat(size) * s}px`);
    this._ctx.font = scaledFont;
    this._ctx.fillStyle = color;
    this._ctx.textBaseline = 'top';
    this._ctx.fillText(text, Math.round(x * s), Math.round(y * s));
  }
}

/** Create a surface from an HTMLImageElement */
export function surfaceFromImage(img: HTMLImageElement | ImageBitmap): Surface {
  const s = new Surface(img.width, img.height);
  s.ctx.drawImage(img, 0, 0);
  return s;
}

/** Color conversion: remap palette colors */
export function colorConvert(surface: Surface, paletteMap: Map<string, [number, number, number]>): Surface {
  const result = surface.copy();
  const imageData = result.getImageData();
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    const mapped = paletteMap.get(key);
    if (mapped) {
      data[i] = mapped[0];
      data[i + 1] = mapped[1];
      data[i + 2] = mapped[2];
    }
  }
  result.putImageData(imageData);
  return result;
}
