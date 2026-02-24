/**
 * game-over-state.ts — Game Over screen shown when a loss condition is met.
 *
 * Faithful port of LT's GameOverState (lt-maker/app/engine/game_over.py).
 *
 * Three-phase animation:
 *   1. text_fade_in  — "GAME OVER" text fades in from transparent over ~50 frames
 *   2. bg_fade_in    — Tiled background image scrolls in with a fade
 *   3. stasis        — Static display; any input returns to title screen
 *
 * Loads three sprites from public/sprites/:
 *   - game_over_text.png  — The "GAME OVER" text image
 *   - game_over_fade.png  — Overlay drawn on top
 *   - game_over_bg.png    — Tiled scrolling background
 *
 * Plays game-over music from _music_game_over game var or
 * music_game_over DB constant.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as other state files)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setGameOverGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for game-over state');
  return _game;
}

// ---------------------------------------------------------------------------
// TransitionBackground — tiled scrolling background with fade-in
// Faithful port of lt-maker/app/engine/background.py TransitionBackground
// ---------------------------------------------------------------------------

class TransitionBackground {
  private image: HTMLImageElement;
  private counter: number = 0;
  private fade: number = 1; // 1 = fully transparent, 0 = fully opaque
  private state: 'in' | 'normal' = 'in';
  private lastUpdate: number = 0;
  private fadeUpdate: number = 0;
  private width: number;
  private height: number;

  // Speed of scrolling (lower = faster). Original: 25ms per pixel
  private speed: number = 25;
  // Fade duration in ms. Original: 50 * 16.66 ≈ 833ms
  private fadeSpeed: number = 833;

  constructor(image: HTMLImageElement) {
    this.image = image;
    this.width = image.naturalWidth || 64;
    this.height = image.naturalHeight || 64;
  }

  setUpdate(time: number): void {
    this.lastUpdate = time;
    this.fadeUpdate = 0;
  }

  update(currentTime: number): boolean {
    const diff = currentTime - this.lastUpdate;
    this.counter += diff / this.speed;
    this.counter %= this.width;
    this.lastUpdate = currentTime;

    if (this.state === 'in') {
      if (!this.fadeUpdate) {
        this.fadeUpdate = currentTime;
      }
      const perc = (currentTime - this.fadeUpdate) / this.fadeSpeed;
      this.fade = 1 - Math.min(Math.max(perc, 0), 1);
      if (this.fade <= 0) {
        this.fade = 0;
        this.state = 'normal';
      }
    }
    return this.state === 'normal';
  }

  draw(surf: Surface): void {
    const vw = viewport.width;
    const vh = viewport.height;
    const alpha = 1 - this.fade; // Convert transparency to alpha

    let xindex = -this.counter;
    while (xindex < vw) {
      let yindex = -this.counter;
      while (yindex < vh) {
        surf.drawImageFull(this.image, Math.floor(xindex), Math.floor(yindex), this.width, this.height, alpha);
        yindex += this.height;
      }
      xindex += this.width;
    }
  }
}

// ---------------------------------------------------------------------------
// GameOverState
// ---------------------------------------------------------------------------

export class GameOverState extends State {
  override readonly name = 'game_over';
  override readonly inLevel = false;
  override readonly showMap = false;

  private phase: 'text_fade_in' | 'bg_fade_in' | 'stasis' = 'text_fade_in';
  private textTransparency: number = 1; // 1 = invisible, 0 = fully visible
  private textImage: HTMLImageElement | null = null;
  private fadeImage: HTMLImageElement | null = null;
  private bg: TransitionBackground | null = null;
  private currentTime: number = 0;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override start(): StateResult {
    const game = getGame();

    this.phase = 'text_fade_in';
    this.textTransparency = 1;
    this.currentTime = performance.now();

    // Play game-over music
    const musicOverride = game.gameVars?.get?.('_music_game_over') ?? null;
    const musicConstant = game.db?.getConstant?.('music_game_over', null) ?? null;
    const musicNid = musicOverride || musicConstant;
    if (musicNid && game.audioManager) {
      void game.audioManager.playMusic(musicNid);
    }

    // Load sprites asynchronously
    this.loadSprites();
  }

  private loadSprites(): void {
    // Load game_over_text.png
    const textImg = new Image();
    textImg.crossOrigin = 'anonymous';
    textImg.onload = () => { this.textImage = textImg; };
    textImg.onerror = () => { console.warn('Failed to load game_over_text.png'); };
    textImg.src = '/sprites/game_over_text.png';

    // Load game_over_fade.png
    const fadeImg = new Image();
    fadeImg.crossOrigin = 'anonymous';
    fadeImg.onload = () => { this.fadeImage = fadeImg; };
    fadeImg.onerror = () => { console.warn('Failed to load game_over_fade.png'); };
    fadeImg.src = '/sprites/game_over_fade.png';

    // Load game_over_bg.png
    const bgImg = new Image();
    bgImg.crossOrigin = 'anonymous';
    bgImg.onload = () => {
      this.bg = new TransitionBackground(bgImg);
    };
    bgImg.onerror = () => { console.warn('Failed to load game_over_bg.png'); };
    bgImg.src = '/sprites/game_over_bg.png';
  }

  override takeInput(event: InputEvent): StateResult {
    if (this.phase === 'stasis' && event) {
      // Any input returns to title screen
      const game = getGame();
      game.state.clear();
      game.state.change('title');
    }
  }

  override update(): StateResult {
    const game = getGame();
    const dt = game.frameDeltaMs ?? 16;
    this.currentTime += dt;

    if (this.phase === 'text_fade_in') {
      // Fade text in: decrease transparency by 0.02 per frame (~50 frames)
      this.textTransparency -= 0.02;
      if (this.textTransparency <= 0) {
        this.textTransparency = 0;
        this.phase = 'bg_fade_in';
        // Start the background transition
        if (this.bg) {
          this.bg.setUpdate(this.currentTime);
        }
      }
    } else if (this.phase === 'bg_fade_in') {
      if (this.bg) {
        const done = this.bg.update(this.currentTime);
        if (done) {
          this.phase = 'stasis';
        }
      } else {
        // No bg loaded yet, just go to stasis
        this.phase = 'stasis';
      }
    } else if (this.phase === 'stasis') {
      // Keep updating the background so it continues scrolling
      if (this.bg) {
        this.bg.update(this.currentTime);
      }
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // 1. Fill screen black
    surf.fillRect(0, 0, vw, vh, 'rgb(0,0,0)');

    // 2. Draw the tiled scrolling background (if loaded)
    if (this.bg) {
      this.bg.draw(surf);
    }

    // 3. Draw the "GAME OVER" text centered, with transparency
    if (this.textImage) {
      const alpha = 1 - this.textTransparency;
      const imgW = this.textImage.naturalWidth;
      const imgH = this.textImage.naturalHeight;
      const x = Math.floor((vw - imgW) / 2);
      const y = Math.floor((vh - imgH) / 2);
      surf.drawImageFull(this.textImage, x, y, imgW, imgH, alpha);
    } else if (this.textTransparency < 1) {
      // Fallback: draw text with canvas if sprite not loaded
      const alpha = 1 - this.textTransparency;
      const text = 'GAME OVER';
      const textW = text.length * 10;
      const x = Math.floor((vw - textW) / 2);
      const y = Math.floor(vh / 2 - 7);
      surf.drawText(text, x, y, `rgba(200,40,40,${alpha})`, '14px monospace');
    }

    // 4. Draw the fade overlay on top (if loaded)
    if (this.fadeImage) {
      const imgW = this.fadeImage.naturalWidth;
      const imgH = this.fadeImage.naturalHeight;
      surf.drawImageFull(this.fadeImage, 0, 0, imgW, imgH);
    }

    return surf;
  }
}
