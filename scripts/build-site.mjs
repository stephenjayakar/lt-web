#!/usr/bin/env node
/**
 * build-site.mjs — Build dist/ for the hosted static site (
 * served from the site root).
 *
 * Usage:
 *   npm run build:site [-- --project <dir>] [--engine <lt-maker dir>]
 *                      [--convex-url <url>] [--no-pngopt] [--music-on-demand]
 *                      [--music-quality N|off]
 *
 *   --project DIR      the .ltproj to ship (default lt-maker/eotf.ltproj)
 *   --engine DIR       lt-maker checkout with the engine-level assets
 *                      (default lt-maker; see stage-engine-assets.mjs)
 *   --convex-url URL   Convex deployment baked in as VITE_CONVEX_URL
 *                      (default $CONVEX_URL, else production)
 *   --no-pngopt        keep PNG bytes as-is
 *   --music-on-demand  download each music track on first play instead of in
 *                      the background after boot
 *   --music-quality N  re-encode the campaign music with libvorbis (oggenc)
 *                      at VBR quality N (default 5, ~160 kbps; `off` ships the
 *                      original files). Same names, sample rate, channels and
 *                      sample counts; cached by source hash + quality.
 *                      Needs ffmpeg/ffprobe and oggenc (vorbis-tools).
 *
 * Steps: typecheck, `vite build` with LT_SITE_BUILD=1 (public/ is copied
 * without game-data/ and bundles/; the client loads packs), then write the
 * game data as content-hashed packs — dist/packs/manifest.json plus one
 * dist/packs/<sha256>.bin per chunk (scripts/lib/asset-packs.mjs).
 *
 * Fails when any dist/ file reaches the static host's 25 MiB per-file limit,
 * when dist/ as a whole reaches 240 MiB (headroom under the host's 256 MiB
 * archive cap), when raw game assets (game-data/, bundles/, loose media) end
 * up outside dist/packs/, or when a chunk does not match the manifest.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { buildPacks, collectFiles, packRecord } from './lib/asset-packs.mjs';
import { checkMusicTools, transcodeAll } from './lib/music-transcode.mjs';

const PROD_CONVEX_URL = 'https://<prod-deployment>.convex.cloud';
const FILE_LIMIT = 25 * 1024 * 1024;
const TOTAL_LIMIT = 240 * 1024 * 1024;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const projectDir = resolve(root, opt('--project', 'lt-maker/eotf.ltproj'));
const engineDir = resolve(root, opt('--engine', 'lt-maker'));
const convexUrl = opt('--convex-url', process.env.CONVEX_URL || PROD_CONVEX_URL);
const pngopt = !flag('--no-pngopt');
const musicLoad = flag('--music-on-demand') ? 'demand' : 'background';
const musicQualityArg = opt('--music-quality', '5');
const musicQuality = musicQualityArg === 'off' ? null : Number(musicQualityArg);
if (musicQuality !== null && !(musicQuality >= -1 && musicQuality <= 10)) {
  console.error(`--music-quality must be -1..10 or off, got ${musicQualityArg}`);
  process.exit(1);
}
const dist = join(root, 'dist');
const mb = (n) => (n / 1048576).toFixed(2);

function fail(msg) {
  console.error(`\nbuild:site FAILED: ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, env) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} exited with ${r.status}`);
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/.test(convexUrl)) fail(`not a Convex cloud URL: ${convexUrl}`);
if (!existsSync(projectDir)) fail(`${projectDir} not found (link the EOtF project at lt-maker/eotf.ltproj)`);
if (musicQuality !== null) {
  try {
    checkMusicTools();
  } catch (err) {
    fail(err.message);
  }
}
const convexSiteUrl = convexUrl.replace(/\/$/, '').replace(/\.convex\.cloud$/, '.convex.site');

// --- 1. app shell -----------------------------------------------------------
console.log(`build:site: Convex ${convexUrl}`);
rmSync(dist, { recursive: true, force: true });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
run(npx, ['tsc']);
run(npx, ['vite', 'build'], {
  LT_SITE_BUILD: '1',
  VITE_CONVEX_URL: convexUrl.replace(/\/$/, ''),
  VITE_CONVEX_SITE_URL: convexSiteUrl,
});

// --- 2. music re-encode (hosted build only; the source tree is untouched) ----
let overrides = new Map();
const music = { files: 0, before: 0, after: 0, kept: 0, cached: 0, maxDrift: 0 };
if (musicQuality !== null) {
  const musicFiles = collectFiles({ projectDir }).files
    .filter((f) => /\/resources\/music\/[^/]+\.ogg$/i.test(f.rel));
  console.log(`\nRe-encoding ${musicFiles.length} music tracks with libvorbis -q ${musicQuality}…`);
  const t = Date.now();
  overrides = new Map();
  try {
    const results = await transcodeAll(musicFiles, {
      quality: musicQuality,
      onDone: (rel, r) => {
        music.files++;
        if (r.cached) music.cached++;
        if (r.kept) music.kept++;
        music.maxDrift = Math.max(music.maxDrift, Math.abs(r.frames - r.sourceFrames));
        if (!r.cached) process.stdout.write(`  ${music.files}/${musicFiles.length} ${rel.split('/').pop()}\n`);
      },
    });
    for (const f of musicFiles) {
      const r = results.get(f.rel);
      music.before += f.size;
      music.after += r.data.length;
      overrides.set(f.rel, r.data);
    }
  } catch (err) {
    fail(`music re-encode: ${err.message}`);
  }
  console.log(`music: ${music.files} tracks ${mb(music.before)} MB -> ${mb(music.after)} MB `
    + `(${music.cached} cached, ${music.kept} kept original, max length change ${music.maxDrift} samples) `
    + `in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

// --- 3. game data packs -------------------------------------------------------
console.log(`\nPacking ${projectDir} (+ engine assets from ${engineDir})…`);
const t0 = Date.now();
const { project, packs, excluded } = buildPacks({ projectDir, engineDir, pngopt, musicLoad, overrides });
const packDir = join(dist, 'packs');
mkdirSync(packDir, { recursive: true });
const written = new Set();
for (const p of packs) {
  for (const c of p.chunks) {
    if (written.has(c.hash)) continue;
    writeFileSync(join(packDir, `${c.hash}.bin`), c.bytes);
    written.add(c.hash);
  }
}
const manifest = { version: 1, project, packs: packs.map(packRecord) };
writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest));

const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
const byLoad = (load) => packs.filter((p) => p.load === load);
console.log(`packed in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${packs.length} packs, ${written.size} chunk files`);
for (const load of ['boot', 'background', 'demand']) {
  const list = byLoad(load);
  console.log(`  ${load.padEnd(10)} ${String(list.length).padStart(4)} packs ${mb(sum(list, (p) => p.origSize)).padStart(8)} MB on disk -> ${mb(sum(list, (p) => p.size)).padStart(8)} MB`);
}
const droppedBytes = sum(excluded, (e) => e.size);
console.log(`  dropped    ${String(excluded.length).padStart(4)} files ${mb(droppedBytes).padStart(8)} MB (never loaded by the engine)`);
const isMusic = (p) => p.name.startsWith('music/');
console.log(`  by kind:   music ${mb(sum(packs.filter(isMusic), (p) => p.size))} MB, `
  + `other game data ${mb(sum(packs.filter((p) => !isMusic(p)), (p) => p.size))} MB`);

// --- 4. checks ----------------------------------------------------------------
const problems = [];
let distBytes = 0;
let distFiles = 0;
for (const file of walk(dist)) {
  const rel = relative(dist, file).split(sep).join('/');
  const size = statSync(file).size;
  distBytes += size;
  distFiles++;
  if (size >= FILE_LIMIT) problems.push(`${rel} is ${mb(size)} MB (limit: under 25 MiB per file)`);
  if (rel.startsWith('packs/')) continue;
  if (/^(game-data|bundles)\//.test(rel) || /\.(zip|ogg|mp3|wav|ltproj)$/i.test(rel) || rel.includes('.ltproj/')) {
    problems.push(`${rel}: game asset outside dist/packs/`);
  }
}
for (const p of manifest.packs) {
  for (const c of p.chunks) {
    const file = join(packDir, `${c.hash}.bin`);
    if (!existsSync(file)) { problems.push(`missing chunk ${c.hash} (${p.name})`); continue; }
    const bytes = readFileSync(file);
    if (bytes.length !== c.size || createHash('sha256').update(bytes).digest('hex') !== c.hash) {
      problems.push(`chunk ${c.hash} (${p.name}) does not match the manifest`);
    }
  }
}
if (distBytes >= TOTAL_LIMIT) {
  problems.push(`dist/ totals ${mb(distBytes)} MB (limit: under 240 MiB for the 256 MiB archive cap; lower --music-quality)`);
}
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
if (!/src="\/assets\/[^"]+\.js"/.test(indexHtml)) problems.push('index.html does not load /assets/*.js from the site root');
if (problems.length) fail(`\n  ${problems.join('\n  ')}`);

const packBytes = sum(manifest.packs, (p) => p.size);
console.log(`\ndist/ breakdown: app shell ${mb(distBytes - packBytes - statSync(join(packDir, 'manifest.json')).size)} MB, `
  + `packs ${mb(packBytes)} MB (boot ${mb(sum(byLoad('boot'), (p) => p.size))}, background ${mb(sum(byLoad('background'), (p) => p.size))}, `
  + `demand ${mb(sum(byLoad('demand'), (p) => p.size))}), manifest ${mb(statSync(join(packDir, 'manifest.json')).size)} MB`);
console.log(`build:site OK: ${distFiles} files, ${mb(distBytes)} MB (MiB) in ${dist}; under 240 MiB total, every file under 25 MiB; `
  + `music ${musicQuality === null ? 'original' : `libvorbis -q ${musicQuality}`}; project ${project}; Convex ${convexUrl}`);
