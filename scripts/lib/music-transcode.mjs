/**
 * music-transcode.mjs — Re-encode campaign music for the hosted site build
 * (scripts/build-site.mjs) so dist/ fits the static host's archive cap.
 *
 * EOtF ships ~350–490 kbps Ogg Vorbis. Each track is decoded with ffmpeg to
 * 32-bit float WAV and re-encoded by `oggenc` (vorbis-tools, i.e. the
 * reference libvorbis encoder — never ffmpeg's experimental built-in
 * "vorbis" encoder) at a VBR quality (-q 5 ≈ 160 kbps). Sample rate,
 * channel count, file name and extension stay the same.
 *
 * Tracks loop and come in intro/loop pairs, so the decoded sample count must
 * not change: every result is decoded again and its sample count compared
 * with the source's; a mismatch beyond MAX_SAMPLE_DRIFT fails the build.
 * A result that is not smaller than its source is discarded (source kept).
 *
 * Results are cached by (source SHA-256, quality, pipeline version), so
 * rebuilds are fast and pack hashes stay stable.
 */

import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { cpus, tmpdir } from 'os';
import { join } from 'path';

const PIPELINE = 'ffmpeg-f32-oggenc-v1';
/** Allowed decoded-length difference: 2 ms at 44.1 kHz. */
export const MAX_SAMPLE_DRIFT = 88;

export const DEFAULT_MUSIC_CACHE = join(tmpdir(), 'lt-web-music-v1');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`));
    });
  });
}

/** Throws unless ffmpeg, ffprobe and libvorbis' oggenc are installed. */
export function checkMusicTools() {
  for (const [cmd, arg] of [['ffmpeg', '-version'], ['ffprobe', '-version'], ['oggenc', '--version']]) {
    try {
      execFileSync(cmd, [arg], { stdio: 'pipe' });
    } catch {
      throw new Error(`${cmd} not found. Music re-encoding needs ffmpeg/ffprobe and oggenc (libvorbis; brew install ffmpeg vorbis-tools). `
        + 'Pass --music-quality off to ship the original music.');
    }
  }
  return execFileSync('oggenc', ['--version'], { encoding: 'utf8' }).trim();
}

/** { sampleRate, channels, codec } of the first audio stream. */
async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', file]);
  const s = JSON.parse(out.toString()).streams?.[0];
  if (!s) throw new Error(`no audio stream in ${file}`);
  return { codec: s.codec_name, sampleRate: Number(s.sample_rate), channels: Number(s.channels) };
}

/** Exact decoded sample-frame count (decodes the whole file). */
async function decodedFrames(file, channels) {
  const pcm = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-c:a', 'pcm_f32le', '-']);
  return pcm.length / (4 * channels);
}

/**
 * Re-encode one Ogg Vorbis file. Returns { data, sourceFrames, frames,
 * cached, kept } where `kept` means the source was smaller and is returned
 * unchanged.
 */
export async function transcodeOgg(source, { quality, cacheDir = DEFAULT_MUSIC_CACHE, label = 'track' }) {
  const key = `${createHash('sha256').update(source).digest('hex')}-q${quality}-${PIPELINE}`;
  const cacheFile = cacheDir ? join(cacheDir, `${key}.ogg`) : null;
  const metaFile = cacheDir ? join(cacheDir, `${key}.json`) : null;
  if (cacheFile && existsSync(cacheFile) && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const data = meta.kept ? source : readFileSync(cacheFile);
    return { ...meta, data, cached: true };
  }

  const dir = mkdtempSync(join(tmpdir(), 'lt-music-'));
  try {
    const src = join(dir, 'src.ogg');
    const wav = join(dir, 'pcm.wav');
    const out = join(dir, 'out.ogg');
    writeFileSync(src, source);
    const info = await probe(src);
    if (info.codec !== 'vorbis') throw new Error(`${label}: expected Ogg Vorbis, found ${info.codec}`);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'wav', wav]);
    const wavBytes = statSync(wav).size;
    await run('oggenc', ['-Q', '-q', String(quality), '-o', out, wav]);
    const outInfo = await probe(out);
    if (outInfo.sampleRate !== info.sampleRate || outInfo.channels !== info.channels) {
      throw new Error(`${label}: re-encode changed format ${info.sampleRate}/${info.channels} -> ${outInfo.sampleRate}/${outInfo.channels}`);
    }
    const sourceFrames = await decodedFrames(src, info.channels);
    const frames = await decodedFrames(out, outInfo.channels);
    if (Math.abs(frames - sourceFrames) > MAX_SAMPLE_DRIFT) {
      throw new Error(`${label}: re-encode changed length ${sourceFrames} -> ${frames} samples`);
    }
    if (wavBytes < 1000) throw new Error(`${label}: decoded to almost nothing`);
    const encoded = readFileSync(out);
    const kept = encoded.length >= source.length;
    const meta = { sourceFrames, frames, sampleRate: info.sampleRate, channels: info.channels, kept };
    if (cacheFile) {
      mkdirSync(cacheDir, { recursive: true });
      if (!kept) writeFileSync(cacheFile, encoded);
      else writeFileSync(cacheFile, Buffer.alloc(0));
      writeFileSync(metaFile, JSON.stringify(meta));
    }
    return { ...meta, data: kept ? source : encoded, cached: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Re-encode many files in parallel. `files` is [{ rel, abs }]; returns a Map
 * rel -> result. `onDone(rel, result)` reports progress.
 */
export async function transcodeAll(files, { quality, cacheDir = DEFAULT_MUSIC_CACHE, parallel = Math.max(1, cpus().length - 1), onDone } = {}) {
  const results = new Map();
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const r = await transcodeOgg(readFileSync(f.abs), { quality, cacheDir, label: f.rel });
      results.set(f.rel, r);
      onDone?.(f.rel, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, files.length) }, worker));
  return results;
}
