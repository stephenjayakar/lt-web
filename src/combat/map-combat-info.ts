/**
 * map-combat-info.ts - Port of Python health_bar.MapCombatInfo and
 * MapCombatHealthBar: the team-colored name/HP window (plus HIT/DMG stat
 * strip) that map combat shows for each side.
 */

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT, TILEX, TILEY, WINWIDTH, WINHEIGHT, FRAMETIME, getFrameCount } from '../engine/constants';
import { FONT } from '../rendering/bmp-font';
import { drawItemIcon } from '../ui/icons';
import { getCombatSprite } from './combat-sprites';

export type MapCombatInfoMethod = 'p1' | 'p2' | 'splash';
export type MapCombatStats = [number | null, number | null, number | null, number | null];

/** health_bar.HealthBar timing for MapCombatHealthBar (1 frame per HP). */
const HP_TIME_FOR_CHANGE_MIN = 200;
const HP_SPEED = FRAMETIME;
/** MapCombatInfo.blind_speed: 8 frames to open. */
const BLIND_SPEED = 1 / 8;

/** MapCombatHealthBar: displayed HP lerps to the target over time_for_change. */
export class MapCombatHpBar {
  displayedHp: number;
  private oldHp: number;
  private targetHp: number;
  transitionFlag = false;
  timeForChange = HP_TIME_FOR_CHANGE_MIN;
  private elapsed = 0;

  constructor(hp: number) {
    this.displayedHp = hp;
    this.oldHp = hp;
    this.targetHp = hp;
  }

  setTarget(hp: number): void {
    this.targetHp = hp;
  }

  /** HealthBar.update, advanced by one engine frame. */
  update(deltaMs: number): void {
    if (this.displayedHp !== this.targetHp && !this.transitionFlag) {
      this.transitionFlag = true;
      this.timeForChange = Math.max(HP_TIME_FOR_CHANGE_MIN, Math.abs(this.displayedHp - this.targetHp) * HP_SPEED);
      this.elapsed = 0;
      return;
    }
    if (!this.transitionFlag) return;
    this.elapsed += deltaMs;
    const time = this.elapsed / this.timeForChange;
    this.displayedHp = Math.trunc(this.oldHp + (this.targetHp - this.oldHp) * Math.min(1, time));
    if (time >= 1) {
      this.displayedHp = this.targetHp;
      this.oldHp = this.displayedHp;
      this.transitionFlag = false;
    }
  }
}

function teamColor(unit: UnitObject, db: any): string {
  return db?.teams?.defs?.find((team: { nid: string }) => team.nid === unit.team)?.combatColor ?? 'blue';
}

function colored(base: string, color: string): Surface | null {
  return getCombatSprite(`${base}_${color}`) ?? getCombatSprite(`${base}_blue`);
}

export class MapCombatInfo {
  readonly method: MapCombatInfoMethod;
  readonly unit: UnitObject;
  item: ItemObject | null;
  target: UnitObject | null;
  stats: MapCombatStats;
  readonly hpBar: MapCombatHpBar;
  /** 'left' | 'right' | 'middle' once positioned (gem placement, proc icons). */
  ordering: 'left' | 'right' | 'middle' | null = null;
  private truePosition: [number, number] | null = null;
  private blinds = 0;
  private shakeSet: [number, number][] = [[0, 0]];
  private shakeOffset: [number, number] = [0, 0];
  private shakeIdx = 0;
  private readonly db: any;
  private readonly advantage: (unit: UnitObject, target: UnitObject, item: ItemObject) => number;

  constructor(
    method: MapCombatInfoMethod,
    unit: UnitObject,
    item: ItemObject | null,
    target: UnitObject | null,
    stats: MapCombatStats,
    hp: number,
    db: any,
    advantage: (unit: UnitObject, target: UnitObject, item: ItemObject) => number,
  ) {
    this.method = method;
    this.unit = unit;
    this.item = item;
    this.target = target;
    this.stats = stats;
    this.hpBar = new MapCombatHpBar(hp);
    this.db = db;
    this.advantage = advantage;
  }

  updateStats(stats: MapCombatStats): void {
    this.stats = stats;
  }

  /** MapCombatInfo.shake */
  shake(num: number, random: () => number = Math.random): void {
    this.shakeIdx = 1;
    if (num === 1) this.shakeSet = [[-3, -3], [0, 0], [3, 3], [0, 0]];
    else if (num === 2) this.shakeSet = [[3, 3], [0, 0], [0, 0], [3, 3], [-3, -3], [3, 3], [-3, -3], [0, 0]];
    else if (num === 3) {
      const roll = () => Math.floor(random() * 9) - 4;
      this.shakeSet = [...Array.from({ length: 16 }, () => [roll(), roll()] as [number, number]), [0, 0]];
    } else if (num === 4) this.shakeSet = [[-1, -1], [0, 0], [1, 1], [0, 0]];
  }

  get timeForChange(): number {
    return this.hpBar.timeForChange;
  }

  /** MapCombatInfo.update: open the blinds, then shake and drain. */
  update(deltaMs: number, updateHp: boolean): void {
    this.blinds = Math.min(1, this.blinds + BLIND_SPEED);
    if (this.blinds >= 1) {
      if (this.shakeIdx) {
        this.shakeOffset = this.shakeSet[this.shakeIdx - 1];
        this.shakeIdx++;
        if (this.shakeIdx > this.shakeSet.length) this.shakeIdx = 0;
      }
      if (updateHp) this.hpBar.update(deltaMs);
    }
  }

  private determinePosition(width: number, height: number, camera: [number, number]): void {
    if (this.method === 'splash') {
      const pos = this.unit.position;
      if (pos) {
        const x = Math.max(3, Math.min(TILEX - 2, pos[0] - camera[0]));
        const y = pos[1] - camera[1] < TILEY / 2 ? pos[1] - camera[1] + 2 : pos[1] - camera[1] - 3;
        this.truePosition = [x * TILEWIDTH - Math.floor(width / 2), y * TILEHEIGHT - 8];
      } else {
        this.truePosition = [Math.floor(WINWIDTH / 2 - width / 2), Math.floor(WINHEIGHT / 2 - height / 2)];
      }
      this.ordering = 'middle';
      return;
    }
    const pos1 = this.unit.position ?? [0, 0];
    const pos2 = this.target?.position ?? pos1;
    const left = this.method === 'p1' ? pos1[0] <= pos2[0] : pos1[0] < pos2[0];
    this.ordering = left ? 'left' : 'right';
    let x = left ? WINWIDTH / 2 - width : WINWIDTH / 2;
    let y: number;
    const rel1 = pos1[1] - camera[1];
    const rel2 = pos2[1] - camera[1];
    const half = Math.floor(TILEY / 2);
    if (rel1 < half && rel2 < half) {
      y = (Math.max(rel1, rel2) + 1) * TILEHEIGHT + 12;
    } else if (rel1 >= half && rel2 >= half) {
      y = Math.min(rel1, rel2) * TILEHEIGHT - 12 - height - 13;
    } else {
      const topGap = Math.min(rel1, rel2);
      const bottomGap = TILEY - 1 - Math.max(rel1, rel2);
      const middleGap = Math.abs(rel1 - rel2);
      if (topGap > bottomGap && topGap > middleGap) {
        y = topGap * TILEHEIGHT - 12 - height - 13;
      } else if (bottomGap > topGap && bottomGap > middleGap) {
        y = (TILEY - 1 - Math.floor(bottomGap / 2)) * TILEHEIGHT - 12;
      } else {
        y = rel1 < half
          ? Math.floor(WINHEIGHT / 4 - height / 2 - 13 / 2)
          : Math.floor(3 * WINHEIGHT / 4 - height / 2 - 13 / 2);
        x = pos1[0] - camera[0] > Math.floor(TILEX / 2)
          ? Math.floor(WINWIDTH / 4 - width / 2)
          : Math.floor(3 * WINWIDTH / 4 - width / 2);
        this.ordering = 'middle';
      }
    }
    this.truePosition = [Math.floor(x), Math.floor(y)];
  }

  /** Screen top-left of the window (after positioning), for proc icons. */
  get position(): [number, number] | null {
    return this.truePosition;
  }

  private windowSurf: Surface | null = null;

  /** MapCombatInfo.draw. `camera` is the camera position in tiles. */
  draw(surf: Surface, camera: [number, number]): void {
    const color = teamColor(this.unit, this.db);
    const bg = colored('health', color);
    if (!bg) return;
    const statsSprite = colored('combat_stats', color);
    const guardSprite = colored('combat_stats_guard', color);
    const gem = colored('combat_gem', color);
    const [hit, mt, crt, grd] = this.stats;
    const width = bg.width;
    const height = bg.height;
    let statHeight = height;
    if (grd !== null && guardSprite) statHeight = height + guardSprite.height;
    else if ((hit !== null || mt !== null) && statsSprite) statHeight = height + statsSprite.height;

    // Reused every frame (a fresh canvas per window per frame was the main
    // allocation in map combat).
    if (!this.windowSurf || this.windowSurf.width !== width || this.windowSurf.height !== statHeight) {
      this.windowSurf = new Surface(width, statHeight);
    } else {
      this.windowSurf.clear();
      this.windowSurf.setAlpha(1);
    }
    const window = this.windowSurf;
    window.blit(bg, 0, 0);

    // Name
    const nameFont = FONT['text_numbers'];
    if (nameFont) nameFont.blit(window, this.unit.name, width - nameFont.width(this.unit.name) - 4, 3);

    // Item icon and weapon-triangle arrow
    if (this.item) {
      drawItemIcon(window, this.item as any, 2, 3);
      if (this.target) {
        const advantage = this.advantage(this.unit, this.target, this.item);
        const arrows = getCombatSprite('arrow_advantage');
        if (arrows && advantage !== 0) {
          const frame = Math.floor(getFrameCount() / 8) % 3;
          window.blitFrom(arrows, frame * 7, advantage > 0 ? 0 : 10, 7, 10, 11, 7);
        }
      }
    }

    // MapCombatHealthBar.draw
    const healthBar = getCombatSprite('health_bar');
    const total = Math.max(1, this.unit.maxHp);
    const fraction = Math.max(0, Math.min(1, this.hpBar.displayedHp / total));
    const pixels = Math.trunc(50 * fraction);
    if (healthBar && pixels > 0) window.blitFrom(healthBar, 0, 0, pixels, 2, 25, 22);
    const hpFont = this.hpBar.transitionFlag ? FONT['number_big2'] : FONT['number_small2'];
    if (hpFont) {
      const text = String(this.hpBar.displayedHp);
      hpFont.blit(window, text, 22 - hpFont.width(text), 15);
    }

    // Stat strip
    const small = FONT['number_small2'];
    const blitHitAndMt = (strip: Surface) => {
      if (!small) return;
      const hitText = hit !== null ? String(Math.max(0, Math.min(100, hit))) : '--';
      small.blit(strip, hitText, Math.floor(strip.width / 2) - small.width(hitText) - 1, -2);
      const mtText = mt !== null ? String(Math.max(0, mt)) : '--';
      small.blit(strip, mtText, strip.width - small.width(mtText) - 2, -2);
    };
    if (grd !== null && guardSprite) {
      const strip = guardSprite.copy();
      blitHitAndMt(strip);
      if (small) {
        const crtText = crt !== null ? String(Math.max(0, Math.min(100, crt))) : '--';
        small.blit(strip, crtText, Math.floor(strip.width / 2) - small.width(crtText) - 1, 7);
        const grdText = String(grd);
        small.blit(strip, grdText, strip.width - small.width(grdText) - 2, 7);
      }
      window.blit(strip, 0, height);
    } else if ((hit !== null || mt !== null) && statsSprite) {
      const strip = statsSprite.copy();
      blitHitAndMt(strip);
      window.blit(strip, 0, height);
    }

    if (!this.truePosition || this.method === 'splash') this.determinePosition(width, height, camera);
    const [tx, ty] = this.truePosition!;
    const blindHeight = Math.floor(statHeight / 2) - Math.floor(statHeight * this.blinds / 2);
    const visibleHeight = Math.trunc(statHeight * this.blinds);
    if (visibleHeight <= 0) return;
    const x = tx + this.shakeOffset[0];
    const y = ty + blindHeight + this.shakeOffset[1];
    surf.blitFrom(window, 0, blindHeight, width, visibleHeight, x, y);

    if (this.blinds >= 1 && gem && this.ordering) {
      const gemX = this.ordering === 'left' ? x + 2 : this.ordering === 'right' ? x + 56 : x + 27;
      surf.blit(gem, gemX, y - 3);
    }
  }
}
