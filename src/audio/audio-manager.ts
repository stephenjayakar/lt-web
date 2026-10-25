// ============================================================
// Audio Manager — Music and SFX playback via Web Audio API
// ============================================================

/**
 * AudioManager - Handles music and sound effect playback using Web Audio API.
 *
 * Music:  loaded from resources/music/{nid}.{ogg,mp3,wav} (+ -intro/-battle
 *         variants flagged in music.json); played by MusicController, a port
 *         of Python's sound thread (channel pairs, song stack, fades).
 * SFX:    loaded from resources/sfx/{nid}.{ogg,wav}, plays once.
 *
 * Like pygame in Python LT, a looping track restarts at sample 0 once its
 * whole file has played (no loop points); Ogg Vorbis buffers are trimmed to
 * the stream's true length first (ogg-length.ts).
 */
import { DEFAULT_FADE_TIME_MS, MusicController } from './music-controller';
import type { SongObject } from './music-controller';
import { oggVorbisLength, trimToTrueLength } from './ogg-length';

export class AudioManager {
  private audioContext: AudioContext | null;
  private musicGain: GainNode | null;
  private sfxGain: GainNode | null;
  private musicVolume: number;
  private sfxVolume: number;
  private audioBufferCache: Map<string, AudioBuffer>;
  private baseUrl: string;
  /** Python's sound thread (music half): channel pairs, song stack, fades */
  private music: MusicController | null = null;
  private musicTicker: ReturnType<typeof setInterval> | null = null;
  /** Python MUSIC dict: decoded songs (song + intro; battle joins when loaded) */
  private songs: Map<string, SongObject> = new Map();
  private songLoads: Map<string, Promise<SongObject | null>> = new Map();
  private musicFlags: Promise<Map<string, { intro: boolean; battle: boolean }> | null> | null = null;
  /** Music operations run in call order (each may wait for its song to load) */
  private musicQueue: Promise<void> = Promise.resolve();
  /** Latest play request made before the browser unlocked audio */
  private pendingMusic: { nid: string; fadeMs: number; fromStart: boolean } | null;

  /** Map of currently looping SFX sources, keyed by NID */
  private loopingSfx: Map<string, AudioBufferSourceNode> = new Map();

  /**
   * Call log for test assertions (mirrors Python's `get_sound_thread()`
   * observable calls). Always populated; not used for actual playback.
   */
  readonly calls: Array<{
    op: 'play' | 'push' | 'pop' | 'stop' | 'fadeIn' | 'fadeToPause' | 'battleFadeIn' | 'battleFadeBack'
      | 'sfx' | 'sfxLoop' | 'sfxStop';
    nid?: string;
    fadeMs?: number;
  }> = [];

  constructor(baseUrl: string) {
    this.audioContext = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.musicVolume = 0.7;
    this.sfxVolume = 1.0;
    this.audioBufferCache = new Map();
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.pendingMusic = null;
  }

  /**
   * Initialize audio context (must be called after user interaction
   * to satisfy browser autoplay policies).
   */
  init(): void {
    if (this.audioContext) {
      return;
    }

    this.audioContext = new AudioContext();

    // Master gain node for music
    this.musicGain = this.audioContext.createGain();
    this.musicGain.gain.value = this.musicVolume;
    this.musicGain.connect(this.audioContext.destination);

    // Master gain node for SFX
    this.sfxGain = this.audioContext.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.audioContext.destination);

    this.music = new MusicController(this.audioContext, this.musicGain, (nid) => this.songs.get(nid) ?? null);
    // Python updates the sound thread every frame.
    this.musicTicker = setInterval(() => this.music?.update(), 16);

    // Title/level setup can request music before the browser permits an
    // AudioContext. Start the most recent request now that a user gesture has
    // unlocked audio instead of leaving the screen permanently silent.
    const pendingMusic = this.pendingMusic;
    this.pendingMusic = null;
    if (pendingMusic) {
      this.enqueueFadeIn(pendingMusic.nid, pendingMusic.fadeMs, pendingMusic.fromStart);
    }
  }

  // ------------------------------------------------------------------
  // Music — Python get_sound_thread() semantics (src/audio/music-controller.ts)
  // ------------------------------------------------------------------

  /**
   * Python fade_in: fade the current song out and the given one in over
   * `fadeMs`, pushing it onto the song stack. A song still held by a channel
   * resumes where it paused. Plays `<nid>-intro` first when music.json
   * flags one. Same song already current: no-op.
   */
  async playMusic(nid: string, fadeMs: number = DEFAULT_FADE_TIME_MS): Promise<void> {
    this.calls.push({ op: 'play', nid });
    await this.requestFadeIn(nid, fadeMs, false);
  }

  /** Python fade_in (the song stack makes every fade_in a push). */
  async pushMusic(nid: string, fadeMs: number = DEFAULT_FADE_TIME_MS): Promise<void> {
    this.calls.push({ op: 'push', nid });
    await this.requestFadeIn(nid, fadeMs, false);
  }

  /** Python fade_back (music_fade_back): back to the previous song on the stack, or stop. */
  async popMusic(fadeMs: number = DEFAULT_FADE_TIME_MS): Promise<void> {
    this.calls.push({ op: 'pop' });
    await this.enqueue(() => this.music?.fadeBack(fadeMs));
  }

  /**
   * Port of Python's phase.fade_in_phase_music / sound fade_in: `fromStart`
   * rewinds a song that would otherwise resume (restart_phase_music).
   */
  async fadeIn(nid: string, fadeMs: number = DEFAULT_FADE_TIME_MS, fromStart: boolean = false): Promise<void> {
    this.calls.push({ op: 'fadeIn', nid, fadeMs });
    await this.requestFadeIn(nid, fadeMs, fromStart);
  }

  /** Python fade_to_pause: fade the current song out and pause it (it can resume). */
  fadeToPause(fadeMs: number = DEFAULT_FADE_TIME_MS): void {
    this.calls.push({ op: 'fadeToPause', fadeMs });
    this.pendingMusic = null;
    void this.enqueue(() => this.music?.fadeToPause(fadeMs));
  }

  /**
   * Python music_clear: fade_clear(fadeMs) when fading, else clear() —
   * stops the music and empties the song stack.
   */
  stopMusic(fadeMs: number = DEFAULT_FADE_TIME_MS): void {
    this.calls.push({ op: 'stop', fadeMs });
    this.pendingMusic = null;
    void this.enqueue(() => {
      if (fadeMs > 0) this.music?.fadeClear(fadeMs);
      else this.music?.clear();
    });
  }

  /**
   * Python battle_fade_in at combat start: a song with a `-battle` variant
   * crossfades the current channel pair to it (same position); otherwise a
   * plain fade_in. Resolves to the song to hand back to battleFadeBack, or
   * null when nothing changed.
   */
  async battleFadeIn(nid: string, fadeMs: number = DEFAULT_FADE_TIME_MS, fromStart: boolean = true): Promise<SongObject | null> {
    this.calls.push({ op: 'battleFadeIn', nid, fadeMs });
    if (!this.audioContext) return null;
    this.loadSong(nid);
    let result: SongObject | null = null;
    await this.enqueue(async () => {
      await this.loadSong(nid);
      result = this.music?.battleFadeIn(nid, fadeMs, fromStart) ?? null;
    });
    return result;
  }

  /** Python battle_fade_back at combat end: crossfade back, or fade_back when restarting battle music. */
  async battleFadeBack(song: SongObject, fromStart: boolean = true): Promise<void> {
    this.calls.push({ op: 'battleFadeBack', nid: song.nid });
    await this.enqueue(() => this.music?.battleFadeBack(song, fromStart));
  }

  /** Currently-playing music track nid, or '' if none (Python: get_current_song().nid). */
  getCurrentMusicNid(): string {
    return this.music?.getCurrentSong()?.nid ?? '';
  }

  /** Read by the sound room (kept for compatibility). */
  get currentMusicNid(): string {
    return this.getCurrentMusicNid();
  }

  /** The controller (tests and debugging). */
  getMusicController(): MusicController | null {
    return this.music;
  }

  /** Resolves once every queued music operation has been applied. */
  async settleMusic(): Promise<void> {
    await this.musicQueue;
  }

  /** Clear the recorded call log (test helper). */
  clearCalls(): void {
    this.calls.length = 0;
  }

  private requestFadeIn(nid: string, fadeMs: number, fromStart: boolean): Promise<void> {
    if (!this.audioContext) {
      this.pendingMusic = { nid, fadeMs, fromStart };
      return Promise.resolve();
    }
    return this.enqueueFadeIn(nid, fadeMs, fromStart);
  }

  private enqueueFadeIn(nid: string, fadeMs: number, fromStart: boolean): Promise<void> {
    this.loadSong(nid); // start loading now, in parallel with earlier queued operations
    return this.enqueue(async () => {
      await this.loadSong(nid);
      this.music?.fadeIn(nid, fadeMs, fromStart);
    });
  }

  private enqueue(op: () => void | Promise<void>): Promise<void> {
    const run = this.musicQueue.then(op).catch((err) => console.warn('[AudioManager] music operation failed', err));
    this.musicQueue = run;
    return run;
  }

  /** music.json: nid -> intro/battle flags (Python SongPrefab). */
  private loadMusicFlags(): Promise<Map<string, { intro: boolean; battle: boolean }> | null> {
    this.musicFlags ??= (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/resources/music/music.json`);
        if (!res.ok) return null;
        const entries = await res.json() as unknown;
        if (!Array.isArray(entries)) return null;
        const flags = new Map<string, { intro: boolean; battle: boolean }>();
        for (const e of entries) {
          if (Array.isArray(e) && typeof e[0] === 'string') flags.set(e[0], { intro: !!e[1], battle: !!e[2] });
        }
        return flags;
      } catch {
        return null;
      }
    })();
    return this.musicFlags;
  }

  /**
   * Python MusicDict.get: the song and its intro, decoded. The battle
   * variant is fetched alongside (so combat never waits on its download)
   * and joins the playing pair when it arrives.
   */
  private loadSong(nid: string): Promise<SongObject | null> {
    const existing = this.songLoads.get(nid);
    if (existing) return existing;
    const load = (async (): Promise<SongObject | null> => {
      const flags = (await this.loadMusicFlags())?.get(nid) ?? { intro: false, battle: false };
      const variant = (suffix: string) =>
        this.loadAudioBuffer(`${this.baseUrl}/resources/music/${encodeURIComponent(nid + suffix)}.ogg`);
      const battleLoad = flags.battle ? variant('-battle') : null;
      const [song, intro] = await Promise.all([
        this.loadMusicBuffer(nid),
        flags.intro ? variant('-intro') : Promise.resolve(null),
      ]);
      if (!song) {
        this.songLoads.delete(nid); // allow a later retry
        return null;
      }
      if (flags.intro && !intro) console.warn(`[AudioManager] Could not load intro for ${nid}`);
      const obj: SongObject = {
        nid, song, intro, battle: null, hasIntro: !!intro, hasBattle: flags.battle, channel: null,
      };
      this.songs.set(nid, obj);
      if (battleLoad) {
        void battleLoad.then((battle) => {
          if (!battle) {
            console.warn(`[AudioManager] Could not load battle variant for ${nid}`);
            return;
          }
          obj.battle = battle;
          this.music?.battleLoaded(obj);
        });
      }
      return obj;
    })();
    this.songLoads.set(nid, load);
    return load;
  }

  /**
   * Play a sound effect once.
   */
  async playSfx(nid: string): Promise<void> {
    this.calls.push({ op: 'sfx', nid });
    if (!this.audioContext || !this.sfxGain) {
      return;
    }

    const buffer = await this.loadSfxBuffer(nid);
    if (!buffer || !this.audioContext || !this.sfxGain) {
      return;
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.connect(this.sfxGain);
    source.start(0);
  }

  /**
   * Play a sound effect in a loop until stopped.
   * If the same SFX is already looping, this is a no-op.
   */
  async playSfxLoop(nid: string): Promise<void> {
    this.calls.push({ op: 'sfxLoop', nid });
    if (!this.audioContext || !this.sfxGain) {
      return;
    }

    // Already looping — skip
    if (this.loopingSfx.has(nid)) {
      return;
    }

    const buffer = await this.loadSfxBuffer(nid);
    if (!buffer || !this.audioContext || !this.sfxGain) {
      return;
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.sfxGain);
    source.start(0);
    this.loopingSfx.set(nid, source);

    // Clean up reference if it ends for any reason
    source.onended = () => {
      this.loopingSfx.delete(nid);
    };
  }

  /**
   * Stop a looping sound effect by NID.
   */
  stopSfx(nid: string): void {
    this.calls.push({ op: 'sfxStop', nid });
    const source = this.loopingSfx.get(nid);
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
      this.loopingSfx.delete(nid);
    }
  }

  /** Set music volume (0-1) */
  setMusicVolume(vol: number): void {
    this.musicVolume = Math.max(0, Math.min(1, vol));
    if (this.musicGain && this.audioContext) {
      this.musicGain.gain.setValueAtTime(this.musicVolume, this.audioContext.currentTime);
    }
  }

  /** Set SFX volume (0-1) */
  setSfxVolume(vol: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, vol));
    if (this.sfxGain && this.audioContext) {
      this.sfxGain.gain.setValueAtTime(this.sfxVolume, this.audioContext.currentTime);
    }
  }

  getMusicVolume(): number {
    return this.musicVolume;
  }

  getSfxVolume(): number {
    return this.sfxVolume;
  }

  getContextState(): AudioContextState | 'locked' {
    return this.audioContext?.state ?? 'locked';
  }

  /** Suspend the audio context (e.g. when app is backgrounded). */
  suspendContext(): void {
    if (this.audioContext && this.audioContext.state === 'running') {
      void this.audioContext.suspend();
    }
  }

  /** Resume audio context if suspended (e.g. after tab switch) */
  resume(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Attempt to load a music buffer, trying .ogg, .mp3, .wav in order.
   * Encodes the filename portion for proper URL handling of spaces/special chars.
   */
  private async loadMusicBuffer(nid: string): Promise<AudioBuffer | null> {
    const encodedNid = encodeURIComponent(nid);
    const extensions = ['ogg', 'mp3', 'wav'];
    for (const ext of extensions) {
      const path = `${this.baseUrl}/resources/music/${encodedNid}.${ext}`;
      const buffer = await this.loadAudioBuffer(path);
      if (buffer) {
        return buffer;
      }
    }
    console.warn(`[AudioManager] Could not load music: ${nid}`);
    return null;
  }

  /**
   * Attempt to load an SFX buffer, trying .ogg, .wav in order.
   * Encodes the filename portion for proper URL handling of spaces/special chars.
   */
  private async loadSfxBuffer(nid: string): Promise<AudioBuffer | null> {
    const encodedNid = encodeURIComponent(nid);
    const extensions = ['ogg', 'wav'];
    for (const ext of extensions) {
      const path = `${this.baseUrl}/resources/sfx/${encodedNid}.${ext}`;
      const buffer = await this.loadAudioBuffer(path);
      if (buffer) {
        return buffer;
      }
    }
    console.warn(`[AudioManager] Could not load sfx: ${nid}`);
    return null;
  }

  /**
   * Load an audio file from the given URL and cache the decoded buffer.
   * Returns null if the fetch or decode fails.
   */
  private async loadAudioBuffer(path: string): Promise<AudioBuffer | null> {
    // Return from cache if available
    if (this.audioBufferCache.has(path)) {
      return this.audioBufferCache.get(path)!;
    }

    if (!this.audioContext) {
      return null;
    }

    try {
      const response = await fetch(path);
      if (!response.ok) {
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      // Read the true length before decodeAudioData detaches the bytes.
      const trueLength = oggVorbisLength(new Uint8Array(arrayBuffer));
      const decoded = await this.audioContext.decodeAudioData(arrayBuffer);
      // Chrome keeps the Vorbis block padding past the stream's end; pygame
      // (Python LT) does not. Trim it so loops restart exactly at the end.
      const ctx = this.audioContext;
      const audioBuffer = trueLength
        ? trimToTrueLength(decoded, trueLength, (ch, frames, rate) => ctx.createBuffer(ch, frames, rate))
        : decoded;
      this.audioBufferCache.set(path, audioBuffer);
      return audioBuffer;
    } catch {
      // Fetch or decode failed — silently return null so callers can try
      // the next extension.
      return null;
    }
  }
}
