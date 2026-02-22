/**
 * weather.ts - Weather particle system for map effects.
 *
 * Ported from LT's app/engine/particles.py.
 * Supports: rain, snow, sand, smoke, light, dark, night, sunset.
 * Particles are simple canvas-drawn shapes (no sprite loading needed).
 */

import { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';

// ============================================================
// Particle base
// ============================================================

interface Particle {
  x: number;
  y: number;
  dead: boolean;
  update(): void;
  draw(surf: Surface, ox: number, oy: number): void;
}

// ============================================================
// Particle types
// ============================================================

class Raindrop implements Particle {
  x: number;
  y: number;
  dead = false;
  private maxX: number;
  private maxY: number;

  constructor(x: number, y: number, maxX: number, maxY: number) {
    this.x = x; this.y = y; this.maxX = maxX; this.maxY = maxY;
  }

  update(): void {
    this.x += 3;
    this.y += 12;
    if (this.x > this.maxX + 16 || this.y > this.maxY + 16) this.dead = true;
  }

  draw(surf: Surface, ox: number, oy: number): void {
    const sx = Math.floor(this.x - ox);
    const sy = Math.floor(this.y - oy);
    surf.fillRect(sx, sy, 1, 3, 'rgba(180,200,255,0.5)');
  }
}

class Snowflake implements Particle {
  x: number;
  y: number;
  dead = false;
  private xSpeed: number;
  private ySpeed: number;
  private maxX: number;
  private maxY: number;
  private size: number;

  constructor(x: number, y: number, maxX: number, maxY: number) {
    this.x = x; this.y = y; this.maxX = maxX; this.maxY = maxY;
    this.ySpeed = 1 + Math.random() * 2.5;
    this.xSpeed = Math.min(this.ySpeed, 0.5 + Math.random() * 2);
    this.size = Math.random() < 0.5 ? 1 : 2;
  }

  update(): void {
    this.x += this.xSpeed;
    this.y += this.ySpeed;
    if (this.x > this.maxX + 16 || this.y > this.maxY + 16) this.dead = true;
  }

  draw(surf: Surface, ox: number, oy: number): void {
    const sx = Math.floor(this.x - ox);
    const sy = Math.floor(this.y - oy);
    surf.fillRect(sx, sy, this.size, this.size, 'rgba(240,240,255,0.8)');
  }
}

class SandParticle implements Particle {
  x: number;
  y: number;
  dead = false;
  private maxX: number;
  private minY: number;

  constructor(x: number, y: number, maxX: number, minY: number) {
    this.x = x; this.y = y; this.maxX = maxX; this.minY = minY;
  }

  update(): void {
    this.x += 12;
    this.y -= 6;
    if (this.x > this.maxX + 16 || this.y < this.minY - 16) this.dead = true;
  }

  draw(surf: Surface, ox: number, oy: number): void {
    const sx = Math.floor(this.x - ox);
    const sy = Math.floor(this.y - oy);
    surf.fillRect(sx, sy, 2, 1, 'rgba(210,190,140,0.6)');
  }
}

class LightMote implements Particle {
  x: number;
  y: number;
  dead = false;
  private alpha: number = 0;
  private alphaDir: number = 1;
  private maxX: number;
  private maxY: number;

  constructor(x: number, y: number, maxX: number, maxY: number) {
    this.x = x; this.y = y; this.maxX = maxX; this.maxY = maxY;
    this.alpha = Math.random() * 0.5;
  }

  update(): void {
    this.x += 0.16;
    this.y += 0.16;
    this.alpha += this.alphaDir * 0.01;
    if (this.alpha >= 0.75) this.alphaDir = -1;
    if (this.alpha <= 0.05) this.dead = true;
    if (this.x > this.maxX + 16 || this.y > this.maxY + 16) this.dead = true;
  }

  draw(surf: Surface, ox: number, oy: number): void {
    const sx = Math.floor(this.x - ox);
    const sy = Math.floor(this.y - oy);
    const a = Math.max(0, Math.min(1, this.alpha));
    surf.fillRect(sx, sy, 2, 2, `rgba(255,255,200,${a})`);
  }
}

// ============================================================
// Weather system
// ============================================================

interface WeatherConfig {
  abundance: number; // particles per tile²
  createParticle: (w: number, h: number) => Particle;
  /** Full-screen overlay color (for night/sunset). */
  overlay?: string;
}

const WEATHER_CONFIGS: Record<string, (mapW: number, mapH: number) => WeatherConfig> = {
  rain: (mapW, mapH) => ({
    abundance: 0.1,
    createParticle: () => new Raindrop(
      Math.random() * mapW - mapH / 4, -8 - Math.random() * 8, mapW, mapH,
    ),
  }),
  snow: (mapW, mapH) => ({
    abundance: 0.2,
    createParticle: () => new Snowflake(
      Math.random() * mapW - mapH, -8 - Math.random() * 8, mapW, mapH,
    ),
  }),
  sand: (mapW, mapH) => ({
    abundance: 0.075,
    createParticle: () => new SandParticle(
      Math.random() * mapW - mapH * 2, mapH + 16 + Math.random() * 16, mapW, 0,
    ),
  }),
  light: (mapW, mapH) => ({
    abundance: 0.02,
    createParticle: () => new LightMote(
      Math.random() * mapW, Math.random() * mapH, mapW, mapH,
    ),
  }),
  dark: (mapW, mapH) => ({
    abundance: 0.02,
    createParticle: () => new LightMote(
      Math.random() * mapW, Math.random() * mapH, mapW, mapH,
    ),
  }),
  night: () => ({
    abundance: 0,
    createParticle: () => ({ x: 0, y: 0, dead: true, update() {}, draw() {} }),
    overlay: 'rgba(20,20,60,0.35)',
  }),
  sunset: () => ({
    abundance: 0,
    createParticle: () => ({ x: 0, y: 0, dead: true, update() {}, draw() {} }),
    overlay: 'rgba(80,40,20,0.25)',
  }),
};

export class WeatherSystem {
  nid: string;
  private particles: Particle[] = [];
  private targetCount: number;
  private config: WeatherConfig;
  private mapPixelW: number;
  private mapPixelH: number;

  constructor(nid: string, mapWidthTiles: number, mapHeightTiles: number) {
    this.nid = nid;
    this.mapPixelW = mapWidthTiles * TILEWIDTH;
    this.mapPixelH = mapHeightTiles * TILEHEIGHT;

    const configFn = WEATHER_CONFIGS[nid.toLowerCase()] ?? WEATHER_CONFIGS['rain'];
    this.config = configFn(this.mapPixelW, this.mapPixelH);
    this.targetCount = Math.floor(this.config.abundance * mapWidthTiles * mapHeightTiles);

    // Prefill particles so they don't gradually appear
    for (let i = 0; i < 300; i++) this.update();
  }

  update(): void {
    // Spawn particles to maintain target count
    while (this.particles.length < this.targetCount) {
      this.particles.push(this.config.createParticle(this.mapPixelW, this.mapPixelH));
    }

    // Update all particles
    for (const p of this.particles) {
      p.update();
    }

    // Remove dead particles
    this.particles = this.particles.filter(p => !p.dead);
  }

  draw(surf: Surface, cameraX: number, cameraY: number): void {
    // Draw overlay first (night/sunset)
    if (this.config.overlay) {
      surf.fillRect(0, 0, surf.width, surf.height, this.config.overlay);
    }

    // Draw particles
    for (const p of this.particles) {
      p.draw(surf, cameraX, cameraY);
    }
  }
}
