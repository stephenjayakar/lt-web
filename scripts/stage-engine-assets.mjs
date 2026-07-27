#!/usr/bin/env node
/**
 * stage-engine-assets.mjs — Copy engine-level shared assets into
 * public/game-data/ so they survive a production build.
 *
 * Usage:
 *   node scripts/stage-engine-assets.mjs [lt-maker-path]
 *
 * During `vite dev` the `serve-game-data` plugin serves `/game-data/*`
 * straight out of lt-maker/, so these files are always reachable. A
 * production build has no such middleware: only what sits in public/ is
 * copied into dist/. The campaign zip produced by bundle-assets.mjs covers
 * the .ltproj directory alone, so without this step a packaged deployment
 * loads the campaign but has no fonts, menu sprites, or combat platforms.
 *
 * Only uses Node.js built-ins — no external dependencies.
 */

import { cpSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const ltMakerDir = resolve(process.argv[2] ?? 'lt-maker');
const outDir = resolve('public/game-data');

// Paths are relative to lt-maker/ and keep their layout under /game-data/,
// because that is exactly how the engine requests them at runtime:
//   base-surf.ts      -> /game-data/sprites/menus/<nid>.png
//   sprite-loader.ts  -> /game-data/resources/platforms/<nid>.png
//   bmp-font.ts       -> /game-data/default.ltproj/resources/fonts/fonts.json
const ENGINE_ASSETS = [
  'sprites',
  'resources/platforms',
  'default.ltproj/resources/fonts',
];

if (!existsSync(ltMakerDir)) {
  console.error(`ERROR: ${ltMakerDir} not found. Install lt-maker first.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

let copied = 0;
let missing = 0;
for (const relPath of ENGINE_ASSETS) {
  const src = join(ltMakerDir, relPath);
  const dest = join(outDir, relPath);
  if (!existsSync(src)) {
    console.warn(`  skipped (not found): ${relPath}`);
    missing += 1;
    continue;
  }
  mkdirSync(join(dest, '..'), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`  staged: ${relPath}`);
  copied += 1;
}

console.log(`\nStaged ${copied}/${ENGINE_ASSETS.length} engine asset roots into ${outDir}`);
if (missing > 0) {
  console.error(`ERROR: ${missing} engine asset root(s) missing; a build now would ship an incomplete app.`);
  process.exit(1);
}
