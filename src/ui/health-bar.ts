import { Surface } from '../engine/surface';

const FONT = '8px monospace';
const BG_COLOR = 'rgba(32, 32, 32, 1)';
const BORDER_COLOR = 'rgba(120, 120, 120, 1)';

/**
 * HealthBar - Animated health bar for combat display.
 */
export class HealthBar {
  private currentHp: number;
  private maxHp: number;
  private displayHp: number;
  private x: number;
  private y: number;
  private width: number;
  private height: number;
  private drainSpeed: number;

  constructor(x: number, y: number, width: number, maxHp: number, currentHp: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = 8;
    this.maxHp = maxHp;
    this.currentHp = currentHp;
    this.displayHp = currentHp;
    // Drain ~30 HP per second (at 60fps that's 0.5 HP/frame, scaled via deltaMs)
    this.drainSpeed = 30;
  }

  /** Set target HP (will animate toward it) */
  setHp(hp: number): void {
    this.currentHp = Math.max(0, Math.min(hp, this.maxHp));
  }

  /** Update animation. Returns true when done animating. */
  update(deltaMs: number): boolean {
    if (Math.abs(this.displayHp - this.currentHp) < 0.01) {
      this.displayHp = this.currentHp;
      return true;
    }

    const step = this.drainSpeed * (deltaMs / 1000);

    if (this.displayHp > this.currentHp) {
      this.displayHp = Math.max(this.currentHp, this.displayHp - step);
    } else {
      this.displayHp = Math.min(this.currentHp, this.displayHp + step);
    }

    return false;
  }

  /** Draw the health bar */
  draw(surf: Surface, label: string): void {
    const barX = this.x;
    const barY = this.y;
    const barH = this.height;
    const labelWidth = label.length * 5 + 4; // approximate char width + gap
    const barLeft = barX + labelWidth;
    const barWidth = this.width - labelWidth;

    // Label (e.g. unit name)
    surf.drawText(label, barX, barY - 1, 'white', FONT);

    // Background
    surf.fillRect(barLeft, barY, barWidth, barH, BG_COLOR);

    // Filled portion
    const ratio = this.maxHp > 0
      ? Math.max(0, Math.min(1, this.displayHp / this.maxHp))
      : 0;
    const filledWidth = Math.round(barWidth * ratio);

    // Color based on HP ratio
    let barColor: string;
    if (ratio > 0.5) {
      barColor = 'rgba(64, 200, 64, 1)';
    } else if (ratio > 0.25) {
      barColor = 'rgba(220, 200, 32, 1)';
    } else {
      barColor = 'rgba(220, 48, 48, 1)';
    }

    if (filledWidth > 0) {
      surf.fillRect(barLeft, barY, filledWidth, barH, barColor);
    }

    // Border
    surf.drawRect(barLeft, barY, barWidth, barH, BORDER_COLOR);

    // HP number text below the bar
    const hpText = `${Math.ceil(this.displayHp)}/${this.maxHp}`;
    surf.drawText(hpText, barLeft, barY + barH + 2, 'rgba(220, 220, 220, 1)', FONT);
  }
}
