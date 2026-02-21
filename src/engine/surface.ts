/**
 * Surface - The core rendering primitive, replacing Pygame's Surface.
 * Wraps an OffscreenCanvas + context for compositing operations.
 */
export class Surface {
  readonly width: number;
  readonly height: number;
  private _canvas: OffscreenCanvas;
  private _ctx: OffscreenCanvasRenderingContext2D;
  private _alpha: number = 1.0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this._canvas = new OffscreenCanvas(width, height);
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
    this._ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Clear the surface to transparent */
  clear(): void {
    this._ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Blit another surface onto this one */
  blit(source: Surface, dx: number = 0, dy: number = 0): void {
    this._ctx.globalAlpha = source._alpha;
    this._ctx.drawImage(source._canvas, dx, dy);
    this._ctx.globalAlpha = 1;
  }

  /** Blit a sub-region of another surface onto this one */
  blitFrom(
    source: Surface,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number
  ): void {
    this._ctx.globalAlpha = source._alpha;
    this._ctx.drawImage(source._canvas, sx, sy, sw, sh, dx, dy, sw, sh);
    this._ctx.globalAlpha = 1;
  }

  /** Blit with scaling */
  blitScaled(
    source: Surface,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number
  ): void {
    this._ctx.globalAlpha = source._alpha;
    this._ctx.drawImage(source._canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    this._ctx.globalAlpha = 1;
  }

  /** Blit an HTMLImageElement or ImageBitmap directly */
  blitImage(
    image: HTMLImageElement | ImageBitmap,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number
  ): void {
    this._ctx.globalAlpha = this._alpha;
    this._ctx.drawImage(image, sx, sy, sw, sh, dx, dy, sw, sh);
    this._ctx.globalAlpha = 1;
  }

  /** Create a subsurface view (copies the region) */
  subsurface(x: number, y: number, w: number, h: number): Surface {
    const sub = new Surface(w, h);
    sub.blitFrom(this, x, y, w, h, 0, 0);
    return sub;
  }

  /** Get pixel data at a position */
  getPixel(x: number, y: number): [number, number, number, number] {
    const data = this._ctx.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }

  /** Get the full ImageData */
  getImageData(): ImageData {
    return this._ctx.getImageData(0, 0, this.width, this.height);
  }

  /** Put ImageData back */
  putImageData(data: ImageData, x: number = 0, y: number = 0): void {
    this._ctx.putImageData(data, x, y);
  }

  /** Create a copy of this surface */
  copy(): Surface {
    const s = new Surface(this.width, this.height);
    s.blit(this);
    s._alpha = this._alpha;
    return s;
  }

  /** Create a horizontally flipped copy */
  flipH(): Surface {
    const s = new Surface(this.width, this.height);
    s._ctx.save();
    s._ctx.scale(-1, 1);
    s._ctx.drawImage(this._canvas, -this.width, 0);
    s._ctx.restore();
    return s;
  }

  /** Create a vertically flipped copy */
  flipV(): Surface {
    const s = new Surface(this.width, this.height);
    s._ctx.save();
    s._ctx.scale(1, -1);
    s._ctx.drawImage(this._canvas, 0, -this.height);
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
    this._ctx.strokeStyle = color;
    this._ctx.lineWidth = lineWidth;
    this._ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  /** Fill a rectangle */
  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    this._ctx.fillStyle = color;
    this._ctx.fillRect(x, y, w, h);
  }

  /** Draw a line */
  drawLine(x1: number, y1: number, x2: number, y2: number, color: string, lineWidth: number = 1): void {
    this._ctx.strokeStyle = color;
    this._ctx.lineWidth = lineWidth;
    this._ctx.beginPath();
    this._ctx.moveTo(x1, y1);
    this._ctx.lineTo(x2, y2);
    this._ctx.stroke();
  }

  /** Draw text */
  drawText(text: string, x: number, y: number, color: string = 'white', font: string = '8px monospace'): void {
    this._ctx.font = font;
    this._ctx.fillStyle = color;
    this._ctx.textBaseline = 'top';
    this._ctx.fillText(text, x, y);
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
