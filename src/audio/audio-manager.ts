// ============================================================
// Audio Manager — Music and SFX playback via Web Audio API
// ============================================================

/**
 * AudioManager - Handles music and sound effect playback using Web Audio API.
 *
 * Music:  loaded from resources/music/{nid}.{ogg,mp3,wav}, loops, crossfades.
 * SFX:    loaded from resources/sfx/{nid}.{ogg,wav}, plays once.
 */
export class AudioManager {
  private audioContext: AudioContext | null;
  private musicGain: GainNode | null;
  private sfxGain: GainNode | null;
  private currentMusic: AudioBufferSourceNode | null;
  private currentMusicNid: string;
  private musicVolume: number;
  private sfxVolume: number;
  private audioBufferCache: Map<string, AudioBuffer>;
  private baseUrl: string;
  private musicStack: string[];

  constructor(baseUrl: string) {
    this.audioContext = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.currentMusic = null;
    this.currentMusicNid = '';
    this.musicVolume = 0.7;
    this.sfxVolume = 1.0;
    this.audioBufferCache = new Map();
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.musicStack = [];
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
  }

  /**
   * Play background music with crossfade.
   * If the same track is already playing, this is a no-op.
   * Fades out the current track over 500ms, then starts the new one.
   */
  async playMusic(nid: string): Promise<void> {
    if (!this.audioContext || !this.musicGain) {
      return;
    }

    // Don't restart the same track
    if (nid === this.currentMusicNid && this.currentMusic) {
      return;
    }

    // Try loading the buffer (ogg -> mp3 -> wav)
    const buffer = await this.loadMusicBuffer(nid);
    if (!buffer || !this.audioContext || !this.musicGain) {
      return;
    }

    // Fade out current music
    if (this.currentMusic) {
      this.fadeOutAndStop(this.currentMusic, this.musicGain, 500);

      // Create a new gain node for the incoming track so the fade-out
      // of the old track doesn't interfere.
      this.musicGain = this.audioContext.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.audioContext.destination);
    }

    // Create new source
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.musicGain);

    // Fade in from 0 over 500ms
    this.musicGain.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.musicGain.gain.linearRampToValueAtTime(
      this.musicVolume,
      this.audioContext.currentTime + 0.5,
    );

    source.start(0);
    this.currentMusic = source;
    this.currentMusicNid = nid;
  }

  /**
   * Stop music with an optional fade-out duration.
   * @param fadeMs Fade-out duration in milliseconds (default 500).
   */
  stopMusic(fadeMs: number = 500): void {
    if (!this.currentMusic || !this.musicGain || !this.audioContext) {
      return;
    }

    this.fadeOutAndStop(this.currentMusic, this.musicGain, fadeMs);
    this.currentMusic = null;
    this.currentMusicNid = '';

    // Prepare a fresh gain node for future music
    this.musicGain = this.audioContext.createGain();
    this.musicGain.gain.value = this.musicVolume;
    this.musicGain.connect(this.audioContext.destination);
  }

  /**
   * Push the current music onto a stack and play a new track.
   * Use popMusic() to restore the previous track.
   */
  async pushMusic(nid: string): Promise<void> {
    if (this.currentMusicNid) {
      this.musicStack.push(this.currentMusicNid);
    }
    await this.playMusic(nid);
  }

  /**
   * Pop the music stack and resume the previous track.
   * If the stack is empty, stops music.
   */
  async popMusic(): Promise<void> {
    const previousNid = this.musicStack.pop();
    if (previousNid) {
      await this.playMusic(previousNid);
    } else {
      this.stopMusic();
    }
  }

  /**
   * Play a sound effect once.
   */
  async playSfx(nid: string): Promise<void> {
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
   */
  private async loadMusicBuffer(nid: string): Promise<AudioBuffer | null> {
    const extensions = ['ogg', 'mp3', 'wav'];
    for (const ext of extensions) {
      const path = `${this.baseUrl}/resources/music/${nid}.${ext}`;
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
   */
  private async loadSfxBuffer(nid: string): Promise<AudioBuffer | null> {
    const extensions = ['ogg', 'wav'];
    for (const ext of extensions) {
      const path = `${this.baseUrl}/resources/sfx/${nid}.${ext}`;
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
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      this.audioBufferCache.set(path, audioBuffer);
      return audioBuffer;
    } catch {
      // Fetch or decode failed — silently return null so callers can try
      // the next extension.
      return null;
    }
  }

  /**
   * Fade out a source node via its gain node and stop it after the fade.
   */
  private fadeOutAndStop(
    source: AudioBufferSourceNode,
    gain: GainNode,
    fadeMs: number,
  ): void {
    if (!this.audioContext) {
      return;
    }

    const fadeSec = fadeMs / 1000;
    const now = this.audioContext.currentTime;

    // Ramp gain to 0
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fadeSec);

    // Schedule the source to stop after the fade completes
    try {
      source.stop(now + fadeSec);
    } catch {
      // Source may already be stopped; ignore.
    }
  }
}
