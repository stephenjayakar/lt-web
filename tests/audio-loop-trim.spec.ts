/**
 * Music loop trimming: Chrome's decodeAudioData keeps Vorbis block padding
 * past the end of an Ogg stream, which pygame (Python LT) discards. The
 * engine trims every decoded Ogg buffer to the granule length of the
 * stream's last page (src/audio/ogg-length.ts) so a looping track restarts
 * exactly at its true end.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error — plain ESM build script without type declarations
import { checkMusicTools, transcodeOgg } from '../scripts/lib/music-transcode.mjs';
import { oggVorbisLength } from '../src/audio/ogg-length';

const RATE = 44100;
const SILENT_LEAD = 1000;              // samples of silence before the tone
const FRAMES = 3 * RATE + 1237;        // not a multiple of any Vorbis block size

function hasTools(): boolean {
  try {
    checkMusicTools();
    return true;
  } catch {
    return false;
  }
}

/** A q10 stereo tone: SILENT_LEAD silent samples, then a sine to FRAMES. */
function makeTone(dir: string): Buffer {
  const wav = join(dir, 'tone.wav');
  const ogg = join(dir, 'tone.ogg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=${RATE},volume=4,adelay=${SILENT_LEAD}S:all=1,aformat=channel_layouts=stereo,atrim=end_sample=${FRAMES}`,
    '-c:a', 'pcm_f32le', wav], { stdio: 'pipe' });
  execFileSync('oggenc', ['-Q', '-q', '10', '-o', ogg, wav], { stdio: 'pipe' });
  return readFileSync(ogg);
}

test.describe('music loop trim', () => {
  test.skip(!hasTools(), 'needs ffmpeg/ffprobe and oggenc (vorbis-tools)');

  let dir: string;
  let original: Buffer;
  let reencoded: Buffer;

  test.beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lt-loop-trim-'));
    original = makeTone(dir);
    reencoded = (await transcodeOgg(original, { quality: 5, cacheDir: null, label: 'tone' })).data;
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('the Ogg parser reads the true length from the last page granule', () => {
    for (const bytes of [original, reencoded]) {
      expect(oggVorbisLength(new Uint8Array(bytes))).toEqual({ frames: FRAMES, sampleRate: RATE, channels: 2 });
    }
    expect(oggVorbisLength(new Uint8Array(Buffer.from('RIFF....WAVEfmt ')))).toBeNull();
    expect(oggVorbisLength(new Uint8Array(0))).toBeNull();
    // a stream cut mid-page still reports the last complete page
    const cut = oggVorbisLength(new Uint8Array(original.subarray(0, original.length - 100)));
    expect(cut).not.toBeNull();
    expect(cut!.frames).toBeLessThan(FRAMES);
  });

  test('looping music buffers end at the true sample count, original and re-encoded', async ({ page }) => {
    await page.route('**/__audio-test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/index.html')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
      if (path.endsWith('/resources/music/Original.ogg')) return route.fulfill({ contentType: 'audio/ogg', body: original });
      if (path.endsWith('/resources/music/Reencoded.ogg')) return route.fulfill({ contentType: 'audio/ogg', body: reencoded });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('/__audio-test/index.html');

    const result = await page.evaluate(async () => {
      const { AudioManager } = await import('/src/audio/audio-manager.ts');
      const out: Record<string, unknown> = {};
      for (const nid of ['Original', 'Reencoded']) {
        const bytes = await (await fetch(`/__audio-test/resources/music/${nid}.ogg`)).arrayBuffer();
        const raw = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes);
        const am = new AudioManager('/__audio-test');
        am.init();
        await am.playMusic(nid, 0);
        const src = (am as unknown as { currentMusic: AudioBufferSourceNode | null }).currentMusic!;
        const buf = src.buffer!;
        const ch = buf.getChannelData(0);
        let firstSound = -1;
        for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 0.05) { firstSound = i; break; }
        out[nid] = {
          rawLength: raw.length,
          length: buf.length,
          rate: buf.sampleRate,
          loop: src.loop,
          loopStart: src.loopStart,
          loopEnd: src.loopEnd,
          firstSound,
        };
        am.stopMusic(0);
      }
      return out;
    }) as Record<string, { rawLength: number; length: number; rate: number; loop: boolean; loopStart: number; loopEnd: number; firstSound: number }>;

    for (const nid of ['Original', 'Reencoded']) {
      const r = result[nid];
      // Chrome pads the decode past the true end; this is what the trim removes.
      expect(r.rawLength).toBeGreaterThanOrEqual(FRAMES);
      expect(r.length).toBe(Math.round(FRAMES * r.rate / RATE));
      // The whole (trimmed) buffer loops, as pygame replays the whole file.
      expect(r.loop).toBe(true);
      expect(r.loopStart).toBe(0);
      expect(r.loopEnd === 0 || Math.abs(r.loopEnd - FRAMES / RATE) < 1e-6).toBe(true);
      // Trimming cuts the tail only: the start is not shifted.
      expect(Math.abs(r.firstSound - SILENT_LEAD * r.rate / RATE)).toBeLessThan(8);
    }
    expect(result.Original.rawLength).toBeGreaterThan(FRAMES); // the fixture really exercises the padding
  });
});
