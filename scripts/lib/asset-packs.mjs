/**
 * asset-packs.mjs — Build the content-hashed asset packs the hosted static
 * site serves from /packs/ (scripts/build-site.mjs writes them; src/packs/
 * loads them).
 *
 * The hosted site (static hosting: 25 MiB per-file limit)
 * cannot ship the single 387 MB campaign zip. Everything the engine would
 * fetch under /game-data/ — the campaign project plus the engine-level shared
 * assets (scripts/stage-engine-assets.mjs) — is split into packs instead:
 *
 *   pack   a deterministic zip of whole files. Entry names are paths relative
 *          to /game-data/ (e.g. "eotf.ltproj/resources/music/X.ogg",
 *          "sprites/menus/x.png"). Its hash is the SHA-256 of the zip bytes.
 *   chunk  a ≤ CHUNK_MAX slice of a pack, written as /packs/<sha256>.bin.
 *          Small packs are one chunk whose hash equals the pack hash.
 *
 * Content-hash file names make every chunk immutable: a redeploy only adds
 * files for packs that changed, and returning browsers keep the rest in their
 * Cache Storage. Packs are grouped so an edit touches little: one pack per
 * music track, one per resource folder (hash-bucketed when a folder is
 * large), one for game_data, one for the engine assets.
 *
 * Load classes (manifest `load`):
 *   boot        needed before the title screen.
 *   background  fetched after boot (music); a request for one of its files
 *               waits for that pack.
 *   demand      fetched only when one of its files is first requested: the
 *               music intro/battle variants. Lex Talionis plays them, the web
 *               port does not yet, so they cost nothing until it does.
 *
 * Size wins that leave the game unchanged:
 *   - music files Lex Talionis can never load (not named by music.json, or an
 *     -intro/-battle variant whose flag is false) are dropped;
 *   - Python-only custom component sources (*.py) are dropped — the web port
 *     implements components in TypeScript and never requests them;
 *   - PNGs are re-encoded losslessly (pngopt.mjs, pixel-verified);
 *   - text formats (JSON, .orderkeys) are DEFLATEd inside the zip; media is
 *     STOREd (already compressed).
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, relative, sep } from 'path';
import { optimizePng } from './pngopt.mjs';
import { ZipWriter } from './zip.mjs';

/** Largest chunk file (static host limit: 25 MiB per file). */
export const CHUNK_MAX = 16 * 1024 * 1024;
/** Resource folders larger than this are split into hash buckets. */
export const GROUP_TARGET = 12 * 1024 * 1024;

/**
 * Engine-level shared assets, relative to lt-maker/. Kept in the same layout
 * under /game-data/ — the same list scripts/stage-engine-assets.mjs stages.
 */
export const ENGINE_ASSETS = [
  'sprites',
  'resources/platforms',
  'default.ltproj/resources/fonts',
];

const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const COMPRESSIBLE = new Set(['.json', '.txt', '.orderkeys', '.idx', '.csv', '.xml', '.tmx', '.tsx']);

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : name.startsWith('.') ? name.toLowerCase() : '';
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && statSync(full).isDirectory());
    if (isDir) yield* walk(full);
    else if (e.isFile() || e.isSymbolicLink()) yield full;
  }
}

const toPosix = (p) => p.split(sep).join('/');

/**
 * Which music files Lex Talionis can load: `<nid>.ogg` for every music.json
 * entry, plus `<nid>-intro.ogg` / `<nid>-battle.ogg` when the entry's intro /
 * battle flag is set (app/data/resources/sounds.py SongPrefab). Returns null
 * when there is no readable manifest (then nothing is dropped).
 */
export function loadableMusic(musicDir) {
  const manifest = join(musicDir, 'music.json');
  if (!existsSync(manifest)) return null;
  let entries;
  try {
    entries = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const keep = new Set(['music.json']);
  for (const e of entries) {
    const [nid, intro, battle] = Array.isArray(e) ? e : [e?.nid, e?.intro, e?.battle];
    if (typeof nid !== 'string') return null;
    for (const ext of ['ogg', 'mp3', 'wav']) {
      keep.add(`${nid}.${ext}`);
      if (intro) keep.add(`${nid}-intro.${ext}`);
      if (battle) keep.add(`${nid}-battle.${ext}`);
    }
  }
  return keep;
}

/**
 * Collect every file the hosted game may request, keyed by its path under
 * /game-data/.
 *
 * @param {{ projectDir: string, engineDir?: string | null }} opts
 * @returns {{ project: string, files: { rel: string, abs: string, size: number }[],
 *             excluded: { rel: string, size: number, reason: string }[] }}
 */
export function collectFiles({ projectDir, engineDir = null }) {
  const project = basename(projectDir);
  if (!project.endsWith('.ltproj')) throw new Error(`${projectDir} is not a .ltproj directory`);
  const root = realpathSync(projectDir);
  const files = [];
  const excluded = [];
  const music = loadableMusic(join(root, 'resources', 'music'));

  for (const abs of walk(root)) {
    const inner = toPosix(relative(root, abs));
    const rel = `${project}/${inner}`;
    const name = basename(abs);
    const size = statSync(abs).size;
    if (JUNK.has(name) || inner.split('/').includes('__pycache__')) {
      excluded.push({ rel, size, reason: 'os/cache junk' });
    } else if (extOf(name) === '.py' || extOf(name) === '.pyc') {
      excluded.push({ rel, size, reason: 'python source (web port never loads it)' });
    } else if (music && inner.startsWith('resources/music/') && inner.split('/').length === 3 && !music.has(name)) {
      excluded.push({ rel, size, reason: 'music not loadable via music.json' });
    } else {
      files.push({ rel, abs, size });
    }
  }

  if (engineDir) {
    const engineRoot = realpathSync(engineDir);
    for (const sub of ENGINE_ASSETS) {
      const dir = join(engineRoot, sub);
      if (!existsSync(dir)) throw new Error(`engine asset root missing: ${dir}`);
      for (const abs of walk(dir)) {
        const rel = toPosix(relative(engineRoot, abs));
        const size = statSync(abs).size;
        if (JUNK.has(basename(abs))) excluded.push({ rel, size, reason: 'os/cache junk' });
        else files.push({ rel, abs, size });
      }
    }
  }

  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.rel)) throw new Error(`duplicate pack path ${f.rel}`);
    seen.add(f.rel);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { project, files, excluded };
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * Pack name and load class for a file (before folder bucketing). Each music
 * track is its own pack; `musicLoad` picks whether main tracks download in
 * the background after boot (the default) or only on first play ('demand').
 * @returns {{ name: string, load: 'boot' | 'background' | 'demand', bucket?: string }}
 */
export function classify(rel, project, musicLoad = 'background') {
  const pre = `${project}/`;
  if (!rel.startsWith(pre)) return { name: 'engine', load: 'boot' };
  const inner = rel.slice(pre.length);
  const parts = inner.split('/');
  if (parts[0] === 'resources' && parts[1] === 'music' && parts.length === 3 && parts[2] !== 'music.json') {
    const stem = parts[2].replace(/\.[^.]+$/, '');
    const variant = /-(intro|battle)$/.test(stem);
    return { name: `music/${parts[2]}`, load: variant ? 'demand' : musicLoad };
  }
  if (parts[0] === 'resources' && parts.length >= 3) {
    return { name: `resources/${parts[1]}`, load: 'boot', bucket: `resources/${parts[1]}` };
  }
  // game_data/, top-level project files, the music manifest
  return { name: 'data', load: 'boot', bucket: 'data' };
}

function zipEntries(entries) {
  const zip = new ZipWriter();
  for (const e of entries) zip.addFile(e.rel, e.data, { compress: COMPRESSIBLE.has(extOf(e.rel)) });
  return zip.finalize();
}

/**
 * Group entries into packs. A bucketed group (a resource folder, game data)
 * whose packed size exceeds GROUP_TARGET is split into hash buckets by file
 * path, so adding or editing one file still touches one pack.
 * @returns {{ name: string, load: string, entries: object[], bytes: Buffer }[]}
 */
function assignPacks(entries, project, musicLoad) {
  const groups = new Map();
  for (const e of entries) {
    const c = classify(e.rel, project, musicLoad);
    let g = groups.get(c.name);
    if (!g) {
      g = { name: c.name, load: c.load, bucketed: !!c.bucket, entries: [] };
      groups.set(c.name, g);
    }
    g.entries.push(e);
  }
  const out = [];
  for (const g of groups.values()) {
    const bytes = zipEntries(g.entries);
    const n = g.bucketed ? Math.ceil(bytes.length / GROUP_TARGET) : 1;
    if (n <= 1) {
      out.push({ name: g.name, load: g.load, entries: g.entries, bytes });
      continue;
    }
    const buckets = Array.from({ length: n }, () => []);
    for (const e of g.entries) buckets[fnv1a(e.rel) % n].push(e);
    buckets.forEach((list, i) => {
      if (list.length) out.push({ name: `${g.name}#${i}`, load: g.load, entries: list, bytes: zipEntries(list) });
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Split bytes into ≤ max slices (at least one, even for an empty buffer). */
export function splitChunks(buf, max = CHUNK_MAX) {
  if (!(max > 0)) throw new Error('chunk size must be positive');
  const out = [];
  for (let o = 0; o < buf.length; o += max) out.push(buf.subarray(o, Math.min(o + max, buf.length)));
  if (out.length === 0) out.push(buf.subarray(0, 0));
  return out;
}

/** PNG bytes re-encoded losslessly, cached by input hash (the optimiser is slow). */
function makePngOptimizer(cacheDir) {
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  return (buf) => {
    const key = cacheDir ? join(cacheDir, `${sha256(buf)}.png`) : null;
    if (key && existsSync(key)) return readFileSync(key);
    const out = optimizePng(buf);
    if (key) {
      try { writeFileSync(key, out); } catch { /* cache is best-effort */ }
    }
    return out;
  };
}

/**
 * Build all packs.
 *
 * @param {{ projectDir: string, engineDir?: string | null, pngopt?: boolean,
 *           pngCacheDir?: string | null, chunkMax?: number,
 *           musicLoad?: 'demand' | 'background' }} opts
 */
export function buildPacks(opts) {
  const { projectDir, engineDir = null, pngopt = true, chunkMax = CHUNK_MAX, musicLoad = 'background' } = opts;
  const pngCacheDir = opts.pngCacheDir === undefined ? join(tmpdir(), 'lt-web-pngopt-v1') : opts.pngCacheDir;
  const { project, files, excluded } = collectFiles({ projectDir, engineDir });
  const shrinkPng = pngopt ? makePngOptimizer(pngCacheDir) : (b) => b;

  const entries = files.map((f) => {
    const raw = readFileSync(f.abs);
    const data = extOf(f.rel) === '.png' ? shrinkPng(raw) : raw;
    return { rel: f.rel, origSize: raw.length, data };
  });

  const packs = assignPacks(entries, project, musicLoad).map((g) => {
    const { bytes } = g;
    const chunks = splitChunks(bytes, chunkMax).map((b) => ({ hash: sha256(b), size: b.length, bytes: b }));
    return {
      name: g.name,
      load: g.load,
      hash: sha256(bytes),
      size: bytes.length,
      fileCount: g.entries.length,
      files: g.entries.map((e) => e.rel),
      origSize: g.entries.reduce((n, e) => n + e.origSize, 0),
      bytes,
      chunks,
    };
  });

  return { project, packs, excluded };
}

/**
 * The manifest record for a pack (/packs/manifest.json, read by
 * src/packs/manifest.ts). Lazy packs list their files so the client knows
 * which requests to hold.
 */
export function packRecord(p) {
  return {
    name: p.name,
    load: p.load,
    hash: p.hash,
    size: p.size,
    fileCount: p.fileCount,
    ...(p.load === 'boot' ? {} : { files: p.files }),
    chunks: p.chunks.map((c) => ({ hash: c.hash, size: c.size })),
  };
}
