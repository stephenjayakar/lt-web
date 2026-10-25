/**
 * Music intro/battle variants and the song stack — src/audio/music-controller.ts
 * against lt-maker/app/engine/sound.py:
 * - the -intro plays once, then the main file loops;
 * - battle_fade_in crossfades to the -battle file at the same position and
 *   battle_fade_back crossfades back, again keeping the position;
 * - fade_in to another song pauses the first; fade_back resumes it where it
 *   paused.
 *
 * The controller renders into an OfflineAudioContext with synthetic tones
 * (each section a different frequency), suspending the render to apply the
 * operations at exact times, and the output frequency is measured per window.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error — plain ESM build script without type declarations
import { checkMusicTools } from '../scripts/lib/music-transcode.mjs';

async function blankPage(page: Page): Promise<void> {
  await page.route('**/__music-test/index.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('/__music-test/index.html');
}

/** Frequency (Hz) measured in each [from, to] window of the rendered output. */
type Window = [number, number];

test.describe('music intro and battle variants (offline render)', () => {
  test('intro plays once then the song loops; battle swap keeps the position both ways', async ({ page }) => {
    await blankPage(page);
    const freqs = await page.evaluate(async () => {
      const { MusicController } = await import('/src/audio/music-controller.ts');
      const RATE = 44100;
      const ctx = new OfflineAudioContext(2, RATE * 5, RATE);
      // tone buffer: sections of [seconds, Hz]
      const tone = (sections: [number, number][]) => {
        const total = sections.reduce((n, [s]) => n + Math.round(s * RATE), 0);
        const buf = ctx.createBuffer(2, total, RATE);
        let i = 0;
        for (const [sec, hz] of sections) {
          const n = Math.round(sec * RATE);
          for (let k = 0; k < n; k++, i++) {
            const v = 0.5 * Math.sin(2 * Math.PI * hz * (k / RATE));
            buf.getChannelData(0)[i] = v;
            buf.getChannelData(1)[i] = v;
          }
        }
        return buf;
      };
      const song = {
        nid: 'Song',
        intro: tone([[0.5, 660]]),
        song: tone([[1, 440], [1, 550]]),
        battle: tone([[1, 880], [1, 990]]),
        hasIntro: true, hasBattle: true, channel: null,
      };
      let clock = 0;
      const music = new MusicController(ctx, ctx.destination, (nid) => (nid === 'Song' ? song : null), () => clock);
      // advance the controller clock past a fade (battle_fade_back uses the 400 ms default)
      const settle = () => { for (let i = 0; i < 260; i++) { clock += 2; music.update(); } };

      music.fadeIn('Song', 1);
      settle();
      // t=1.0: combat starts — Song has a -battle file: crossfade in place
      ctx.suspend(1.0).then(() => { music.battleFadeIn('Song', 1); settle(); void ctx.resume(); });
      // t=2.6: combat ends — crossfade back
      ctx.suspend(2.6).then(() => {
        const s = music.getCurrentSong();
        if (s) music.battleFadeBack(s, true);
        settle();
        void ctx.resume();
      });
      const out = await ctx.startRendering();
      const data = out.getChannelData(0);
      const measure = ([from, to]: [number, number]) => {
        let crossings = 0;
        for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i++) {
          if ((data[i - 1] < 0) !== (data[i] < 0)) crossings++;
        }
        return Math.round(crossings / 2 / (to - from));
      };
      const windows: [number, number][] = [
        [0.05, 0.45],  // intro
        [0.55, 0.95],  // song, first half
        [1.05, 1.45],  // battle at loop position 0.55..0.95: first half
        [1.55, 2.45],  // battle second half (a restart would still be 880 here)
        [2.65, 3.45],  // back to song at loop position 0.15..0.95 (second loop): first half
        [3.55, 4.45],  // song second half
        [4.55, 4.95],  // looped again without replaying the intro
      ];
      return windows.map((w) => measure(w));
    });
    const expected = [660, 440, 880, 990, 440, 550, 440];
    freqs.forEach((f, i) => expect(Math.abs(f - expected[i]), `window ${i}: ${f} Hz`).toBeLessThan(6));
  });

  test('fade_in to another song pauses the first; fade_back resumes it where it paused', async ({ page }) => {
    await blankPage(page);
    const result = await page.evaluate(async () => {
      const { MusicController } = await import('/src/audio/music-controller.ts');
      const RATE = 44100;
      const ctx = new OfflineAudioContext(2, RATE * 4, RATE);
      const tone = (sections: [number, number][]) => {
        const total = sections.reduce((n, [s]) => n + Math.round(s * RATE), 0);
        const buf = ctx.createBuffer(2, total, RATE);
        let i = 0;
        for (const [sec, hz] of sections) {
          const n = Math.round(sec * RATE);
          for (let k = 0; k < n; k++, i++) buf.getChannelData(0)[i] = 0.5 * Math.sin(2 * Math.PI * hz * (k / RATE));
        }
        return buf;
      };
      const songs: Record<string, unknown> = {
        Map: { nid: 'Map', intro: null, battle: null, song: tone([[1, 440], [1, 550]]), hasIntro: false, hasBattle: false, channel: null },
        Event: { nid: 'Event', intro: null, battle: null, song: tone([[2, 330]]), hasIntro: false, hasBattle: false, channel: null },
      };
      let clock = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const music = new MusicController(ctx, ctx.destination, (nid) => (songs[nid] as any) ?? null, () => clock);
      const settle = () => { for (let i = 0; i < 6; i++) { clock += 2; music.update(); } };
      music.fadeIn('Map', 1);
      settle();
      const stacks: string[][] = [];
      ctx.suspend(0.5).then(() => {
        music.fadeIn('Event', 1);
        settle();
        stacks.push(music.songStack.map((s) => s.nid));
        void ctx.resume();
      });
      ctx.suspend(1.5).then(() => {
        music.fadeBack(1);
        settle();
        stacks.push(music.songStack.map((s) => s.nid));
        void ctx.resume();
      });
      const out = await ctx.startRendering();
      const data = out.getChannelData(0);
      const measure = (from: number, to: number) => {
        let c = 0;
        for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i++) if ((data[i - 1] < 0) !== (data[i] < 0)) c++;
        return Math.round(c / 2 / (to - from));
      };
      return {
        stacks,
        freqs: [measure(0.05, 0.45), measure(0.55, 1.45), measure(1.55, 1.95), measure(2.05, 2.95)],
      };
    });
    expect(result.stacks).toEqual([['Map', 'Event'], ['Map']]);
    // Map 440 -> Event 330 -> Map resumes at 0.5 s (440 for 0.5 s more), then 550
    const expected = [440, 330, 440, 550];
    result.freqs.forEach((f, i) => expect(Math.abs(f - expected[i]), `window ${i}: ${f} Hz`).toBeLessThan(6));
  });
});

// ---------------------------------------------------------------------------
// AudioManager: music.json flags drive variant loading; battle_fade_in path
// ---------------------------------------------------------------------------

function hasTools(): boolean {
  try {
    checkMusicTools();
    return true;
  } catch {
    return false;
  }
}

function oggTone(dir: string, name: string, hz: number, seconds: number): Buffer {
  const wav = join(dir, `${name}.wav`);
  const ogg = join(dir, `${name}.ogg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=${hz}:sample_rate=44100:duration=${seconds},aformat=channel_layouts=stereo`,
    '-c:a', 'pcm_f32le', wav], { stdio: 'pipe' });
  execFileSync('oggenc', ['-Q', '-q', '4', '-o', ogg, wav], { stdio: 'pipe' });
  return readFileSync(ogg);
}

test.describe('AudioManager music variants', () => {
  test.skip(!hasTools(), 'needs ffmpeg and oggenc (vorbis-tools)');

  test('music.json flags load the intro and prefetch the battle file; battle swap crossfades the pair', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-music-variants-'));
    try {
      const files: Record<string, Buffer> = {
        'Song.ogg': oggTone(dir, 'song', 440, 2),
        'Song-intro.ogg': oggTone(dir, 'intro', 660, 0.75),
        'Song-battle.ogg': oggTone(dir, 'battle', 880, 2),
        'Plain.ogg': oggTone(dir, 'plain', 330, 1.5),
        'Plain-intro.ogg': oggTone(dir, 'plainintro', 300, 0.5), // flag false: must not load
      };
      const requested: string[] = [];
      await page.route('**/__mv/**', async (route) => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname);
        if (path.endsWith('/index.html')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
        const name = path.split('/').pop()!;
        requested.push(name);
        if (name === 'music.json') {
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify([['Song', true, true], ['Plain', false, false]]) });
        }
        const body = files[name];
        return body ? route.fulfill({ contentType: 'audio/ogg', body }) : route.fulfill({ status: 404, body: '' });
      });
      await page.goto('/__mv/index.html');

      const r = await page.evaluate(async () => {
        const { AudioManager } = await import('/src/audio/audio-manager.ts');
        const am = new AudioManager('/__mv');
        am.init();
        await am.playMusic('Song', 1);
        // wait for the prefetched battle file to join
        const ctl = am.getMusicController()!;
        for (let i = 0; i < 100 && !ctl.currentChannel.describe().sources.some((s) => s.channel === 'battle'); i++) {
          await new Promise((res) => setTimeout(res, 20));
        }
        const first = ctl.currentChannel.describe();
        const song = await am.battleFadeIn('Song', 50, true);
        const pair = ctl.currentChannel;
        const afterIn = { battleMode: pair.battleMode, music: pair.channel.state, battle: pair.battle.state };
        await new Promise((res) => setTimeout(res, 150));
        const swapped = { musicVol: pair.channel.crossfadeVolume, battleVol: pair.battle.crossfadeVolume };
        await am.battleFadeBack(song!, true);
        await new Promise((res) => setTimeout(res, 500));
        const back = { battleMode: pair.battleMode, musicVol: pair.channel.crossfadeVolume, battleVol: pair.battle.crossfadeVolume };
        // a song without variants: battle_fade_in falls back to fade_in (pushes it)
        const plain = await am.battleFadeIn('Plain', 1, true);
        await am.settleMusic();
        await new Promise((res) => setTimeout(res, 100)); // Song fades out, then Plain fades in
        return {
          sources: first.sources.map((s) => ({ channel: s.channel, loop: s.loop, duration: Math.round(s.buffer.duration * 100) / 100, at: s.when - first.sources[0].when })),
          introLen: first.introLen,
          songNid: song?.nid ?? null,
          afterIn, swapped, back,
          plainNid: plain?.nid ?? null,
          stack: ctl.songStack.map((s) => s.nid),
          current: am.getCurrentMusicNid(),
        };
      });

      // intro once on the music channel, then the song loops from the intro's end;
      // the battle file plays alongside and restarts at the same boundary
      expect(r.introLen).toBeCloseTo(0.75, 2);
      const music = r.sources.filter((s) => s.channel === 'music');
      const battle = r.sources.filter((s) => s.channel === 'battle');
      expect(music.map((s) => [s.loop, s.duration])).toEqual([[false, 0.75], [true, 2]]);
      expect(music[1].at).toBeCloseTo(0.75, 2);
      expect(battle.map((s) => s.loop)).toEqual([false, true]);
      expect(battle[1].at).toBeCloseTo(0.75, 2);

      expect(r.songNid).toBe('Song');
      expect(r.afterIn).toEqual({ battleMode: true, music: 'crossfade_out', battle: 'crossfade_in' });
      expect(r.swapped).toEqual({ musicVol: 0, battleVol: 1 });
      expect(r.back).toEqual({ battleMode: false, musicVol: 1, battleVol: 0 });

      expect(r.plainNid).toBe('Plain');
      expect(r.stack).toEqual(['Song', 'Plain']);
      expect(r.current).toBe('Plain');
      expect(requested).toContain('Song-intro.ogg');
      expect(requested).toContain('Song-battle.ogg');
      expect(requested).not.toContain('Plain-intro.ogg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
