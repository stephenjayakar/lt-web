/**
 * victory-state.ts — port of lt-maker/app/engine/victory_screen.py.
 *
 * Over the map: the focus_fade sprite background fades in, the `victory`
 * banner sprite grows vertically from its centre line while fading in, and a
 * translucent menu_bg_base stat panel (Turns / MVP, menu_shimmer2) slides up
 * from the bottom edge over 20 frames.
 */

import { State, type StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import {
  blitBaseSurf,
  blitSprite,
  blitText,
  blitTextCenter,
  getSprite,
  preloadSprites,
} from '../../ui/menu-chrome';

let _game: any = null;
export function setVictoryGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for victory state');
  return _game;
}

const NUM_TRANSITION_FRAMES = 20;
const MENU_WIDTH = 96;
const MENU_HEIGHT = 40;

export class VictoryState extends State {
  override readonly name = 'victory';
  override readonly showMap = true;
  /** Python VictoryState is a MapState: the map shows underneath. */
  override readonly transparent = true;

  private state: 'init' | 'allow_input' | 'leave' = 'init';
  private numFrame = 0;
  /** SpriteBackground(focus_fade) transparency, 100 -> 0. */
  private bgFade = 100;
  private turns = '0';
  private mvp = '--';

  override start(): StateResult {
    const game = getGame();
    if (game.cursor) game.cursor.visible = false;
    preloadSprites(['focus_fade', 'victory', 'menus/menu_shimmer2']);
    this.state = 'init';
    this.numFrame = 0;
    this.bgFade = 100;

    this.turns = String(game.turnCount ?? 0);
    const mvpNid = game.records?.getMvp?.(game.currentLevel?.nid);
    const prefab = mvpNid ? game.db.units.get(mvpNid) : null;
    this.mvp = prefab?.name ?? '--';

    const sound = game.memory?.get?.('victory_screen_sound');
    if (sound) {
      game.audioManager?.playSfx?.(sound);
      game.memory.set('victory_screen_sound', null);
    } else {
      game.audioManager?.playSfx?.('StageClear');
    }
  }

  override update(): StateResult {
    if (this.state === 'init') {
      this.numFrame += 1;
      if (this.numFrame >= NUM_TRANSITION_FRAMES) {
        this.numFrame = NUM_TRANSITION_FRAMES;
        this.state = 'allow_input';
      }
    }
  }

  override takeInput(event: InputEvent): StateResult {
    if (this.state === 'allow_input' && (event === 'SELECT' || event === 'START' || event === 'BACK')) {
      this.state = 'leave';
      getGame().state.back();
      return 'repeat';
    }
  }

  /** Python create_stat_surf. */
  private statSurf(): Surface {
    const surf = new Surface(MENU_WIDTH, MENU_HEIGHT);
    blitBaseSurf(surf, MENU_WIDTH, MENU_HEIGHT, 'menu_bg_base', 0, 0, 0.1);
    const shimmer = getSprite('menus/menu_shimmer2');
    if (shimmer) {
      const prev = surf.getAlpha();
      surf.setAlpha(0.9);
      blitSprite(surf, shimmer, MENU_WIDTH - 1 - shimmer.width, MENU_HEIGHT - 5 - shimmer.height);
      surf.setAlpha(prev);
    }
    const translate = (text: string): string => getGame().db?.translate?.(text) ?? text;
    blitText(surf, 'text-yellow', translate('Turns'), 4, 4);
    blitText(surf, 'text-yellow', translate('MVP'), 4, 20);
    blitTextCenter(surf, 'text-blue', this.turns, MENU_WIDTH - 40, 4);
    blitTextCenter(surf, 'text-blue', this.mvp, MENU_WIDTH - 40, 20);
    return surf;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;
    const offset = this.numFrame / NUM_TRANSITION_FRAMES;

    // SpriteBackground(focus_fade): fades in by 4% per drawn frame.
    if (this.bgFade > 0) this.bgFade = Math.max(0, this.bgFade - 4);
    const fade = getSprite('focus_fade');
    if (fade) stretch(surf, fade, 0, 0, vw, vh, 1 - this.bgFade / 100);

    const stat = this.statSurf();
    surf.blit(stat, Math.floor(vw / 2 - stat.width / 2), Math.floor(vh - offset * stat.height));

    const victory = getSprite('victory');
    if (victory) {
      const height = Math.floor(victory.height * offset);
      if (height > 0) {
        stretch(surf, victory, 0, Math.floor(victory.height / 2) - Math.floor(height / 2), vw, height, offset);
      }
    }
    return surf;
  }
}

/** engine.transform_scale + blit with opacity. */
function stretch(
  surf: Surface, img: HTMLImageElement, x: number, y: number, w: number, h: number, alpha: number,
): void {
  if (alpha <= 0) return;
  const s = surf.scale;
  const ctx = surf.ctx;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(img, 0, 0, img.width, img.height, Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
  ctx.restore();
}
