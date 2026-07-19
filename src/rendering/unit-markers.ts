/**
 * Small overlay icons drawn on/near unit map sprites: rescue (pairup/carry)
 * marker, droppable-item marker, and the boss/elite/protect blink icon.
 *
 * Ported from: app/engine/unit_sprite.py UnitSprite.draw_hp (icon block).
 *
 * Python timing for the boss/elite/protect icon: drawn only while
 * `int((current_time % 450) // 150) in (1, 2)` -- i.e. visible for two of
 * every three 150ms sub-frames (a 450ms blink period, hidden 1/3 of the
 * time). The rescue and droppable icons have no blink -- they're always
 * drawn when their condition holds, and both use the same topleft offset
 * (left-8, top-8) as the boss/protect icon, so if more than one condition
 * is true they are blitted in the same Python if/if/if order: boss/elite/
 * protect first, then rescue (if traveling), then droppable (if any item
 * is droppable) -- the last blit wins visually since they share a spot.
 */

import type { Surface } from '../engine/surface';

export type SpecialTag = 'Boss' | 'Elite' | 'Protect' | null;

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export class UnitMarkerIcons {
  private rescueIcons: Map<string, HTMLImageElement> = new Map();
  private bossIcon: HTMLImageElement | null = null;
  private eliteIcon: HTMLImageElement | null = null;
  private protectIcon: HTMLImageElement | null = null;
  private droppableIcon: HTMLImageElement | null = null;
  loaded = false;

  async loadAll(): Promise<void> {
    const colors = ['green', 'red', 'blue', 'purple'];
    const [rescues, boss, elite, protect, droppable] = await Promise.all([
      Promise.all(colors.map((c) => loadImage(`/sprites/rescue_icon_${c}.png`))),
      loadImage('/sprites/boss_icon.png'),
      loadImage('/sprites/elite_icon.png'),
      loadImage('/sprites/protect_icon.png'),
      loadImage('/sprites/droppable_icon.png'),
    ]);
    colors.forEach((c, i) => {
      const img = rescues[i];
      if (img) this.rescueIcons.set(c, img);
    });
    this.bossIcon = boss;
    this.eliteIcon = elite;
    this.protectIcon = protect;
    this.droppableIcon = droppable;
    this.loaded = true;
  }

  /** Whether the blinking special-tag icon is visible at time `timeMs` (Python: frame in (1,2) of a 150ms x 3 cycle). */
  static specialIconVisible(timeMs: number): boolean {
    const frame = Math.floor((timeMs % 450) / 150);
    return frame === 1 || frame === 2;
  }

  /**
   * Draw markers for a single unit. `left`/`top` are the unit's screen-space
   * tile origin (matching UnitSprite.get_topleft in Python).
   */
  draw(
    surf: Surface,
    left: number,
    top: number,
    opts: {
      specialTag: SpecialTag;
      travelerCombatColor: string | null;
      droppable: boolean;
    },
    timeMs: number,
  ): void {
    const topleft: [number, number] = [left - 8, top - 8];

    if (opts.specialTag && UnitMarkerIcons.specialIconVisible(timeMs)) {
      const icon =
        opts.specialTag === 'Boss' ? this.bossIcon :
        opts.specialTag === 'Elite' ? this.eliteIcon :
        this.protectIcon;
      if (icon) {
        surf.blitImage(icon, 0, 0, icon.width, icon.height, topleft[0], topleft[1]);
      }
    }

    if (opts.travelerCombatColor) {
      const icon = this.rescueIcons.get(opts.travelerCombatColor) ?? this.rescueIcons.get('green');
      if (icon) {
        surf.blitImage(icon, 0, 0, icon.width, icon.height, topleft[0], topleft[1]);
      }
    }

    if (opts.droppable && this.droppableIcon) {
      surf.blitImage(this.droppableIcon, 0, 0, this.droppableIcon.width, this.droppableIcon.height, topleft[0], topleft[1]);
    }
  }
}
