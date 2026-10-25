/**
 * Hosted-site asset packs: the build-time packer (scripts/lib/asset-packs.mjs)
 * and the browser loader (src/packs/) that downloads, verifies, caches and
 * reassembles them before handing zips to AssetBundle.
 */
import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { deflateSync } from 'zlib';
// @ts-expect-error — plain ESM build script without type declarations
import { buildPacks, packRecord, splitChunks as splitChunksNode } from '../scripts/lib/asset-packs.mjs';
// @ts-expect-error — plain ESM build script without type declarations
import { decodePng } from '../scripts/lib/pngopt.mjs';
// @ts-expect-error — plain ESM build script without type declarations
import { checkMusicTools, transcodeOgg } from '../scripts/lib/music-transcode.mjs';
import { joinChunks, parseManifest, splitChunks } from '../src/packs/manifest';

interface BuiltChunk { hash: string; size: number; bytes: Buffer }
interface BuiltPack {
  name: string; load: string; hash: string; size: number; fileCount: number;
  files: string[]; bytes: Buffer; chunks: BuiltChunk[];
}
interface Built { project: string; packs: BuiltPack[]; excluded: { rel: string; reason: string }[] }

const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

/** A plain 8-bit RGBA PNG with a few colours (the optimiser palettises it). */
function rgbaPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const palette = [[128, 160, 128, 255], [255, 0, 0, 255], [0, 0, 0, 0]][((Math.imul(x * 7919 + y, 2654435761) >>> 0) >>> 13) % 3];
      raw.set(palette, o);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function noise(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

/** A tiny project + engine tree exercising every packing rule. */
function makeFixture(): { root: string; projectDir: string; engineDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lt-packs-test-'));
  const put = (rel: string, data: string | Buffer) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  const proj = 'lt-maker/demo.ltproj';
  put(`${proj}/metadata.json`, '{"project":"demo"}');
  put(`${proj}/game_data/constants.json`, JSON.stringify([['game_nid', 'demo']]));
  put(`${proj}/game_data/items/.orderkeys`, '["Iron_Sword"]');
  put(`${proj}/game_data/items/Iron_Sword.json`, JSON.stringify({ nid: 'Iron_Sword', pad: 'x'.repeat(4000) }));
  put(`${proj}/resources/portraits/portraits.json`, '[{"nid":"Eirika"}]');
  put(`${proj}/resources/portraits/Eirika.png`, rgbaPng(64, 64));
  put(`${proj}/resources/music/music.json`, JSON.stringify([['Theme', true, false], ['Battle Song', false, false]]));
  put(`${proj}/resources/music/Theme.ogg`, noise(10000, 1));         // background, 3 chunks at 4 KiB
  put(`${proj}/resources/music/Theme-intro.ogg`, noise(1200, 2));    // demand (intro flag set)
  put(`${proj}/resources/music/Battle Song.ogg`, noise(900, 3));     // background, a space in the name
  put(`${proj}/resources/music/Battle Song-intro.ogg`, noise(500, 4)); // dropped: intro flag false
  put(`${proj}/resources/music/Orphan.ogg`, noise(700, 5));          // dropped: not in music.json
  put(`${proj}/resources/custom_components/custom_item_components.py`, 'print("hi")'); // dropped
  put(`${proj}/resources/.DS_Store`, 'junk');                        // dropped
  put('lt-maker/sprites/menus/menu_bg.png', rgbaPng(8, 8));
  put('lt-maker/resources/platforms/Grass.png', rgbaPng(8, 4));
  put('lt-maker/default.ltproj/resources/fonts/fonts.json', '[]');
  return { root, projectDir: join(root, proj), engineDir: join(root, 'lt-maker') };
}

const CHUNK = 4096;

function build(fixture: { projectDir: string; engineDir: string }, overrides?: Map<string, Buffer>): Built {
  return buildPacks({ ...fixture, pngCacheDir: null, chunkMax: CHUNK, overrides }) as Built;
}

test.describe('asset pack builder', () => {
  test('drops files the engine never loads and classifies the rest', () => {
    const fx = makeFixture();
    try {
      const { project, packs, excluded } = build(fx);
      expect(project).toBe('demo.ltproj');
      expect(excluded.map((e) => e.rel).sort()).toEqual([
        'demo.ltproj/resources/.DS_Store',
        'demo.ltproj/resources/custom_components/custom_item_components.py',
        'demo.ltproj/resources/music/Battle Song-intro.ogg',
        'demo.ltproj/resources/music/Orphan.ogg',
      ]);
      const byName = Object.fromEntries(packs.map((p) => [p.name, p]));
      expect(Object.keys(byName).sort()).toEqual([
        'data', 'engine', 'music/Battle Song.ogg', 'music/Theme-intro.ogg', 'music/Theme.ogg',
        'resources/music', 'resources/portraits',
      ]);
      expect(byName['music/Theme.ogg'].load).toBe('background');
      expect(byName['music/Theme-intro.ogg'].load).toBe('demand');
      expect(byName.data.load).toBe('boot');
      expect(byName.data.files).toContain('demo.ltproj/game_data/items/.orderkeys');
      expect(byName.engine.files.sort()).toEqual([
        'default.ltproj/resources/fonts/fonts.json', 'resources/platforms/Grass.png', 'sprites/menus/menu_bg.png',
      ]);
      // lazy packs list their files in the manifest; boot packs do not
      expect(packRecord(byName['music/Theme.ogg']).files).toEqual(['demo.ltproj/resources/music/Theme.ogg']);
      expect(packRecord(byName.data).files).toBeUndefined();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('packs are deterministic, chunked under the limit, and content-hashed', () => {
    const fx = makeFixture();
    try {
      const a = build(fx);
      const b = build(fx);
      expect(b.packs.map((p) => p.hash)).toEqual(a.packs.map((p) => p.hash));
      for (const p of a.packs) {
        expect(p.hash).toBe(sha(p.bytes));
        expect(p.chunks.reduce((n, c) => n + c.size, 0)).toBe(p.size);
        expect(Buffer.concat(p.chunks.map((c) => c.bytes)).equals(p.bytes)).toBe(true);
        for (const c of p.chunks) {
          expect(c.size).toBeLessThanOrEqual(CHUNK);
          expect(c.hash).toBe(sha(c.bytes));
        }
      }
      const theme = a.packs.find((p) => p.name === 'music/Theme.ogg')!;
      expect(theme.chunks.length).toBe(3);
      // one changed file changes exactly one pack
      writeFileSync(join(fx.projectDir, 'resources/music/Theme-intro.ogg'), noise(1200, 99));
      const c = build(fx);
      const changed = c.packs.filter((p, i) => p.hash !== a.packs[i].hash).map((p) => p.name);
      expect(changed).toEqual(['music/Theme-intro.ogg']);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('PNG re-encoding is pixel-identical and smaller', () => {
    const fx = makeFixture();
    try {
      const original = rgbaPng(64, 64);
      const { packs } = build(fx);
      const portraits = packs.find((p) => p.name === 'resources/portraits')!;
      // the stored entry is the last STOREd PNG in the zip: find it by its signature
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const at = portraits.bytes.indexOf(sig);
      const iend = portraits.bytes.indexOf(Buffer.from('IEND'), at) + 8;
      const stored = portraits.bytes.subarray(at, iend);
      expect(stored.length).toBeLessThan(original.length);
      const before = decodePng(original);
      const after = decodePng(stored);
      expect(after.w).toBe(before.w);
      expect(after.h).toBe(before.h);
      expect(Buffer.compare(after.rgba, before.rgba)).toBe(0);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('chunk split/join round-trips at the boundaries', () => {
    for (const n of [0, 1, 4095, 4096, 4097, 3 * 4096, 3 * 4096 + 7]) {
      const data = new Uint8Array(noise(n, n + 1));
      const parts = splitChunks(data, 4096);
      expect(parts.length).toBe(Math.max(1, Math.ceil(n / 4096)));
      expect(parts.every((p) => p.byteLength <= 4096)).toBe(true);
      expect(new Uint8Array(joinChunks(parts))).toEqual(data);
      // the build script's splitter cuts at the same offsets
      const nodeParts: Buffer[] = splitChunksNode(Buffer.from(data), 4096);
      expect(nodeParts.map((p) => p.length)).toEqual(parts.map((p) => p.byteLength));
    }
  });

  test('manifest validation rejects malformed input', () => {
    const h = 'a'.repeat(64);
    const ok = { project: 'x.ltproj', packs: [{ name: 'p', load: 'boot', hash: h, size: 3, fileCount: 1, chunks: [{ hash: h, size: 3 }] }] };
    expect(parseManifest(ok).packs[0].name).toBe('p');
    expect(() => parseManifest({ packs: 'nope' })).toThrow(/packs/);
    expect(() => parseManifest({ ...ok, packs: [{ ...ok.packs[0], hash: 'zz' }] })).toThrow(/hash/);
    expect(() => parseManifest({ ...ok, packs: [{ ...ok.packs[0], size: 4 }] })).toThrow(/chunk sizes/);
    expect(() => parseManifest({ ...ok, packs: [{ ...ok.packs[0], load: 'demand' }] })).toThrow(/without files/);
  });
});

// ---------------------------------------------------------------------------
// Browser loader
// ---------------------------------------------------------------------------

const BASE = '/__packs-test';

interface Served { hits: Map<string, number>; corrupt: Set<string> }

async function servePacks(page: Page, built: Built): Promise<Served> {
  const chunks = new Map<string, Buffer>();
  for (const p of built.packs) for (const c of p.chunks) chunks.set(c.hash, c.bytes);
  const manifest = { version: 1, project: built.project, packs: built.packs.map(packRecord) };
  const served: Served = { hits: new Map(), corrupt: new Set() };
  await page.route(`**${BASE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname.slice(BASE.length + 1);
    if (path === 'index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>packs</title>' });
      return;
    }
    if (path === 'manifest.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest) });
      return;
    }
    const hash = path.replace(/\.bin$/, '');
    const bytes = chunks.get(hash);
    if (!bytes) {
      await route.fulfill({ status: 404, body: 'nope' });
      return;
    }
    served.hits.set(hash, (served.hits.get(hash) ?? 0) + 1);
    const body = served.corrupt.has(hash) ? Buffer.from(bytes).fill(7, 0, 16) : bytes;
    await route.fulfill({ contentType: 'application/octet-stream', body });
  });
  await page.goto(`${BASE}/index.html`);
  return served;
}

const totalHits = (s: Served, hashes: string[]) => hashes.reduce((n, h) => n + (s.hits.get(h) ?? 0), 0);

test.describe('hosted asset pack loader', () => {
  let fx: ReturnType<typeof makeFixture>;
  let built: Built;

  test.beforeAll(() => {
    fx = makeFixture();
    built = build(fx);
  });
  test.afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  test('boots from the network, serves /game-data, then reloads from Cache Storage', async ({ page }) => {
    const served = await servePacks(page, built);
    const bootHashes = built.packs.filter((p) => p.load === 'boot').flatMap((p) => p.chunks.map((c) => c.hash));
    const demand = built.packs.find((p) => p.load === 'demand')!;

    const first = await page.evaluate(async (base) => {
      await caches.delete('lt-packs-v1');
      const { bootHostedPacks, loadPackManifest } = await import('/src/packs/hosted.ts');
      const manifest = await loadPackManifest(base);
      const loader = await bootHostedPacks(manifest, { base });
      const constants = await (await fetch('/game-data/demo.ltproj/game_data/constants.json')).json();
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('portrait failed'));
        img.src = '/game-data/demo.ltproj/resources/portraits/Eirika.png';
      });
      const engineImg = new Image();
      await new Promise<void>((resolve, reject) => {
        engineImg.onload = () => resolve();
        engineImg.onerror = () => reject(new Error('menu sprite failed'));
        engineImg.src = '/game-data/sprites/menus/menu_bg.png';
      });
      const missing = await fetch('/game-data/demo.ltproj/resources/portraits/Nobody.png');
      return {
        constants,
        portrait: [img.naturalWidth, img.naturalHeight],
        engine: engineImg.naturalWidth,
        missing: missing.status,
        downloaded: loader.downloadedBytes,
        cached: loader.cachedBytes,
      };
    }, BASE);

    expect(first.constants).toEqual([['game_nid', 'demo']]);
    expect(first.portrait).toEqual([64, 64]);
    expect(first.engine).toBe(8);
    expect(first.missing).toBe(404);
    expect(first.downloaded).toBeGreaterThan(0);
    expect(first.cached).toBe(0);
    expect(totalHits(served, bootHashes)).toBe(bootHashes.length);
    // demand packs are never fetched unless a file in them is requested
    expect(totalHits(served, demand.chunks.map((c) => c.hash))).toBe(0);

    // a returning visit: everything comes from Cache Storage
    served.hits.clear();
    await page.reload();
    const second = await page.evaluate(async (base) => {
      const { bootHostedPacks, loadPackManifest } = await import('/src/packs/hosted.ts');
      const loader = await bootHostedPacks(await loadPackManifest(base), { base });
      const text = await (await fetch('/game-data/demo.ltproj/game_data/items/Iron_Sword.json')).json();
      return { downloaded: loader.downloadedBytes, cached: loader.cachedBytes, nid: text.nid };
    }, BASE);
    expect(second.nid).toBe('Iron_Sword');
    expect(second.downloaded).toBe(0);
    expect(second.cached).toBeGreaterThan(0);
    expect(totalHits(served, bootHashes)).toBe(0);
  });

  test('lazy packs: requests wait for background packs; demand packs load on first request', async ({ page }) => {
    const served = await servePacks(page, built);
    const theme = built.packs.find((p) => p.name === 'music/Theme.ogg')!;
    const intro = built.packs.find((p) => p.name === 'music/Theme-intro.ogg')!;
    const themeBytes = built.packs.find((p) => p.name === 'music/Theme.ogg')!;
    expect(themeBytes.chunks.length).toBe(3); // reassembled from 3 chunk files

    const result = await page.evaluate(async (base) => {
      await caches.delete('lt-packs-v1');
      const { bootHostedPacks, loadPackManifest } = await import('/src/packs/hosted.ts');
      const loader = await bootHostedPacks(await loadPackManifest(base), { base });
      // requested right away: waits for its background pack instead of 404ing
      const theme = await fetch('/game-data/demo.ltproj/resources/music/Theme.ogg');
      const themeLen = (await theme.arrayBuffer()).byteLength;
      const spaced = await fetch('/game-data/demo.ltproj/resources/music/Battle%20Song.ogg');
      const introBefore = loader.isLoaded('music/Theme-intro.ogg');
      const intro = await fetch('/game-data/demo.ltproj/resources/music/Theme-intro.ogg');
      const introLen = (await intro.arrayBuffer()).byteLength;
      const dropped = await fetch('/game-data/demo.ltproj/resources/music/Orphan.ogg');
      return {
        themeStatus: theme.status, themeLen, spaced: spaced.status, introBefore,
        introStatus: intro.status, introLen, dropped: dropped.status,
      };
    }, BASE);

    expect(result.themeStatus).toBe(200);
    expect(result.themeLen).toBe(10000);
    expect(result.spaced).toBe(200);
    expect(result.introBefore).toBe(false);
    expect(result.introStatus).toBe(200);
    expect(result.introLen).toBe(1200);
    expect(result.dropped).toBe(404);
    expect(totalHits(served, theme.chunks.map((c) => c.hash))).toBe(3);
    expect(totalHits(served, intro.chunks.map((c) => c.hash))).toBe(1);
  });

  test('damaged downloads are retried then rejected; damaged cache entries are refetched; stale entries pruned', async ({ page }) => {
    const served = await servePacks(page, built);
    const data = built.packs.find((p) => p.name === 'data')!;
    const dataHash = data.chunks[0].hash;
    served.corrupt.add(dataHash);

    const failed = await page.evaluate(async ({ base }) => {
      const { PackLoader } = await import('/src/packs/pack-loader.ts');
      const { MemoryChunkCache } = await import('/src/packs/chunk-cache.ts');
      const { staticChunkFetcher, loadPackManifest } = await import('/src/packs/hosted.ts');
      const loader = new PackLoader({
        manifest: await loadPackManifest(base), cache: new MemoryChunkCache(),
        fetchChunk: staticChunkFetcher(base), retryDelayMs: 0,
      });
      try {
        await loader.loadBoot();
        return 'loaded';
      } catch (err) {
        return String(err);
      }
    }, { base: BASE });
    expect(failed).toContain('arrived damaged');
    expect(served.hits.get(dataHash)).toBe(3); // three attempts

    served.corrupt.clear();
    served.hits.clear();
    const recovered = await page.evaluate(async ({ base, dataHash }) => {
      const { PackLoader } = await import('/src/packs/pack-loader.ts');
      const { MemoryChunkCache } = await import('/src/packs/chunk-cache.ts');
      const { staticChunkFetcher, loadPackManifest } = await import('/src/packs/hosted.ts');
      const cache = new MemoryChunkCache();
      await cache.put(dataHash, new Uint8Array([1, 2, 3]).buffer); // wrong size: ignored and replaced
      await cache.put('f'.repeat(64), new Uint8Array([9]).buffer);  // not in the manifest: pruned
      const loader = new PackLoader({
        manifest: await loadPackManifest(base), cache, fetchChunk: staticChunkFetcher(base), retryDelayMs: 0,
      });
      await loader.loadBoot();
      const nid = loader.bundle.getJson<{ nid: string }>('demo.ltproj/game_data/items/Iron_Sword.json')?.nid;
      const replaced = (await cache.get(dataHash))?.byteLength;
      const removed = await loader.pruneCache();
      return { nid, replaced, removed, keys: (await cache.keys()).length };
    }, { base: BASE, dataHash });
    expect(recovered.nid).toBe('Iron_Sword');
    expect(recovered.replaced).toBe(data.chunks[0].size);
    expect(recovered.removed).toBe(1);
    expect(served.hits.get(dataHash)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Re-encoded music (build:site --music-quality)
// ---------------------------------------------------------------------------

function hasMusicTools(): boolean {
  try {
    checkMusicTools();
    return true;
  } catch {
    return false;
  }
}

/** A high-bitrate stereo 44.1 kHz Ogg Vorbis tone with an odd sample count. */
function makeToneOgg(dir: string, frames: number): Buffer {
  const wav = join(dir, 'tone.wav');
  const ogg = join(dir, 'tone.ogg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=44100,aformat=channel_layouts=stereo,atrim=end_sample=${frames}`,
    '-c:a', 'pcm_f32le', wav], { stdio: 'pipe' });
  execFileSync('oggenc', ['-Q', '-q', '10', '-o', ogg, wav], { stdio: 'pipe' });
  return readFileSync(ogg);
}

test.describe('re-encoded music', () => {
  test.skip(!hasMusicTools(), 'needs ffmpeg/ffprobe and oggenc (vorbis-tools)');

  const FRAMES = 3 * 44100 + 1237; // not a multiple of any Vorbis block size

  test('libvorbis re-encode keeps format and exact length, decodes and loops in the engine', async ({ page }) => {
    const fx = makeFixture();
    try {
      const source = makeToneOgg(fx.root, FRAMES);
      const r = await transcodeOgg(source, { quality: 5, cacheDir: null, label: 'tone' });
      expect(r.kept).toBe(false);
      expect(r.data.length).toBeLessThan(source.length);
      expect(r.sampleRate).toBe(44100);
      expect(r.channels).toBe(2);
      expect(r.sourceFrames).toBe(FRAMES);
      expect(r.frames).toBe(FRAMES);
      expect(r.data.subarray(0, 4).toString('latin1')).toBe('OggS');

      const rel = 'demo.ltproj/resources/music/Theme.ogg';
      const built = build(fx, new Map([[rel, r.data]]));
      await servePacks(page, built);
      const played = await page.evaluate(async (base) => {
        await caches.delete('lt-packs-v1');
        const { bootHostedPacks, loadPackManifest } = await import('/src/packs/hosted.ts');
        const { AudioManager } = await import('/src/audio/audio-manager.ts');
        await bootHostedPacks(await loadPackManifest(base), { base });
        const am = new AudioManager('/game-data/demo.ltproj');
        am.init();
        await am.playMusic('Theme', 0);
        const internal = am as unknown as { currentMusic: AudioBufferSourceNode | null; currentMusicNid: string };
        const src = internal.currentMusic;
        const buf = src?.buffer ?? null;
        let rms = 0;
        if (buf) {
          const ch = buf.getChannelData(0);
          for (let i = 0; i < ch.length; i++) rms += ch[i] * ch[i];
          rms = Math.sqrt(rms / ch.length);
        }
        return {
          nid: internal.currentMusicNid,
          loop: src?.loop ?? null,
          duration: buf?.duration ?? null,
          channels: buf?.numberOfChannels ?? null,
          rms,
        };
      }, BASE);
      const lengths = await page.evaluate(async ([a, b]) => {
        const decode = async (b64: string) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const ctx = new OfflineAudioContext(2, 1, 44100);
          return (await ctx.decodeAudioData(bytes.buffer)).length;
        };
        return { source: await decode(a), reencoded: await decode(b), rate: new AudioContext().sampleRate };
      }, [source.toString('base64'), r.data.toString('base64')]);
      expect(played.nid).toBe('Theme');
      expect(played.loop).toBe(true);
      expect(played.channels).toBe(2);
      // Chrome's Vorbis decoder ignores the end-of-stream trim, so it pads to
      // the last block for the original and the re-encode alike: the loop the
      // engine plays must be exactly as long as the original's.
      expect(lengths.reencoded).toBe(lengths.source);
      expect(Math.abs(lengths.reencoded - FRAMES)).toBeLessThan(2048);
      // decodeAudioData resamples to the context rate; duration is preserved
      expect(Math.abs(played.duration! - lengths.source / 44100)).toBeLessThan(0.001);
      expect(played.rms).toBeGreaterThan(0.03); // ffmpeg sine (amplitude 1/8): audible, not silence
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
