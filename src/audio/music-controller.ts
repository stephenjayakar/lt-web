/**
 * music-controller.ts — Port of lt-maker/app/engine/sound.py's music player
 * (SongObject, Channel, ChannelPair, DefaultSoundController) onto Web Audio.
 *
 * Python model, kept here:
 * - Four ChannelPairs in a stack; the top one is current. A new song takes
 *   the oldest pair. The song stack remembers what fade_back returns to, and
 *   a song still owning its pair resumes where it was paused (unless
 *   from_start).
 * - Each pair has a "music" channel and a "battle" channel that play
 *   together. The music channel plays `<nid>-intro` once (when music.json
 *   flags it), then `<nid>`; the battle channel plays `<nid>-battle` (when
 *   flagged), silent (crossfade volume 0) until crossfade() swaps them over
 *   DEFAULT_FADE_TIME_MS, keeping both positions.
 * - Both channels share one pygame end event: whenever either sound ends,
 *   both restart (music → song after the intro; battle → from 0). So the
 *   intro boundary restarts the battle file, and afterwards both loop with
 *   the period of the shorter file.
 * - Volumes are crossfade × local × global, stepped linearly per update.
 *
 * Web specifics: instead of reacting to end events a frame late, the end
 * boundaries are scheduled sample-accurately (intro → song via start(when),
 * the loop period via loopEnd), which gives the same restart points without
 * the gap. pygame pause/unpause is emulated by remembering the timeline
 * position. num_plays is always -1 (no web caller passes it). A battle file
 * that finishes loading after its pair started joins in sync.
 */

export const DEFAULT_FADE_TIME_MS = 400;

export interface SongObject {
  nid: string;
  song: AudioBuffer;
  intro: AudioBuffer | null;
  /** null until loaded (or when music.json has no battle variant) */
  battle: AudioBuffer | null;
  /** music.json flags */
  hasIntro: boolean;
  hasBattle: boolean;
  /** pair currently holding this song (Python SongObject.channel) */
  channel: ChannelPair | null;
}

type ChannelState = 'stopped' | 'paused' | 'playing' | 'fade_out' | 'fade_in' | 'crossfade_out' | 'crossfade_in';
type LastState = 'stopped' | 'paused' | 'playing';

const PLAYING_STATES: readonly ChannelState[] = ['playing', 'crossfade_out', 'fade_in', 'crossfade_in'];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class Channel {
  readonly name: 'music' | 'battle';
  readonly gain: GainNode;
  fadeInTime: number = DEFAULT_FADE_TIME_MS;
  fadeOutTime: number = DEFAULT_FADE_TIME_MS;
  localVolume: number = 0;
  crossfadeVolume: number = 1;
  currentSong: SongObject | null = null;
  playedIntro: boolean = false;
  lastState: LastState = 'stopped';
  state: ChannelState = 'stopped';
  lastUpdate: number = 0;

  private pair: ChannelPair;
  private ctx: BaseAudioContext;

  constructor(name: 'music' | 'battle', pair: ChannelPair, ctx: BaseAudioContext, output: AudioNode) {
    this.name = name;
    this.pair = pair;
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(output);
  }

  /** Python Channel.update minus end events (scheduled by the pair). Returns true on a finished fade. */
  update(now: number): boolean {
    if (this.state === 'fade_out' || this.state === 'crossfade_out') {
      const progress = clamp01((now - this.lastUpdate) / this.fadeOutTime);
      if (this.state === 'fade_out') this.localVolume = 1 - progress;
      else this.crossfadeVolume = 1 - progress;
      this.resetVolume();
      if (progress >= 1) {
        if (this.state === 'fade_out') {
          if (this.lastState === 'playing') {
            this.state = 'paused';
            this.lastState = 'paused';
            this.pair.pauseSound();
          } else {
            // told to fade out without ever starting to play
            this.state = 'stopped';
          }
          return true;
        }
        this.state = 'playing';
        this.lastState = 'playing';
      }
    }
    if (this.state === 'fade_in' || this.state === 'crossfade_in') {
      const progress = clamp01((now - this.lastUpdate) / this.fadeInTime);
      if (this.state === 'fade_in') this.localVolume = progress;
      else this.crossfadeVolume = progress;
      this.resetVolume();
      if (progress >= 1) {
        this.state = 'playing';
        this.lastState = 'playing';
        return true;
      }
    }
    return false;
  }

  setFadeInTime(ms: number): void { this.fadeInTime = Math.max(ms, 1); }
  setFadeOutTime(ms: number): void { this.fadeOutTime = Math.max(ms, 1); }

  fadeOut(now: number): void {
    // Immediately finish crossfading
    if (this.state === 'crossfade_out') {
      this.crossfadeVolume = 0;
      this.resetVolume();
      this.lastState = 'playing';
    } else if (this.state === 'crossfade_in') {
      this.crossfadeVolume = 1;
      this.resetVolume();
      this.lastState = 'playing';
    }
    this.state = 'fade_out';
    this.lastUpdate = now;
  }

  crossfadeIn(now: number): void {
    this.lastState = 'playing';
    this.state = 'crossfade_in';
    this.lastUpdate = now;
  }

  crossfadeOut(now: number): void {
    this.lastState = 'playing';
    this.state = 'crossfade_out';
    this.lastUpdate = now;
  }

  resetVolume(): void {
    const v = clamp01(this.crossfadeVolume * this.localVolume);
    const g = this.gain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v, t + 0.016);
  }

  isPlayingState(): boolean {
    return PLAYING_STATES.includes(this.state);
  }
}

interface ScheduledSource {
  channel: 'music' | 'battle';
  node: AudioBufferSourceNode;
  buffer: AudioBuffer;
  /** context time the node starts */
  when: number;
}

export class ChannelPair {
  readonly nid: number;
  readonly channel: Channel;
  readonly battle: Channel;
  battleMode: boolean = false;
  currentSong: SongObject | null = null;

  private ctx: BaseAudioContext;
  /** pygame channels: one shared timeline (both sounds start together) */
  private timeline: 'stopped' | 'playing' | 'paused' = 'stopped';
  /** context time of timeline position 0 */
  private origin: number = 0;
  /** timeline position when paused (seconds) */
  private pausedAt: number = 0;
  /** length of the intro phase in this play (0: no intro) */
  private introLen: number = 0;
  private sources: ScheduledSource[] = [];

  constructor(nid: number, ctx: BaseAudioContext, output: AudioNode) {
    this.nid = nid;
    this.ctx = ctx;
    this.channel = new Channel('music', this, ctx, output);
    this.battle = new Channel('battle', this, ctx, output);
    this.battle.crossfadeVolume = 0;
    this.battle.resetVolume();
  }

  // --- Python ChannelPair API ---------------------------------------------

  isPlaying(): boolean {
    return this.channel.isPlayingState() || this.battle.isPlayingState();
  }

  isFadingOut(): boolean {
    return this.channel.state === 'fade_out';
  }

  update(now: number): boolean {
    const a = this.channel.update(now);
    const b = this.battle.update(now);
    return a || b;
  }

  setCurrentSong(song: SongObject): void {
    song.channel = this;
    this.currentSong = song;
    for (const ch of [this.channel, this.battle]) {
      ch.currentSong = song;
      ch.playedIntro = false;
    }
  }

  crossfade(now: number): void {
    if (this.battleMode) {
      this.battleMode = false;
      this.channel.crossfadeIn(now);
      this.battle.crossfadeOut(now);
    } else {
      this.battleMode = true;
      this.channel.crossfadeOut(now);
      this.battle.crossfadeIn(now);
    }
  }

  setFadeInTime(ms: number): void {
    this.channel.setFadeInTime(ms);
    this.battle.setFadeInTime(ms);
  }

  setFadeOutTime(ms: number): void {
    this.channel.setFadeOutTime(ms);
    this.battle.setFadeOutTime(ms);
  }

  clear(): void {
    if (this.currentSong) this.currentSong.channel = null;
    this.currentSong = null;
    this.stopSound();
    for (const ch of [this.channel, this.battle]) {
      ch.currentSong = null;
      ch.playedIntro = false;
      ch.lastState = 'stopped';
      ch.state = 'stopped';
    }
  }

  /**
   * Channel.fade_in for both channels. The two pygame channels always share
   * their last state, and both sounds start together, so one decision on
   * the shared timeline covers both.
   */
  fadeIn(now: number): void {
    if (this.channel.lastState === 'paused') this.unpauseSound();
    else if (this.channel.lastState === 'stopped') this.play();
    if (!this.busy()) this.play(); // sometimes possible with weird timings
    for (const ch of [this.channel, this.battle]) {
      ch.lastState = 'playing';
      ch.state = 'fade_in';
      ch.lastUpdate = now;
    }
  }

  fadeOut(now: number): void {
    this.channel.fadeOut(now);
    this.battle.fadeOut(now);
  }

  pause(): void {
    this.pauseSound();
    for (const ch of [this.channel, this.battle]) {
      ch.lastState = 'paused';
      ch.state = 'paused';
    }
  }

  resume(): void {
    this.unpauseSound();
    for (const ch of [this.channel, this.battle]) {
      ch.lastState = 'playing';
      ch.state = 'playing';
    }
  }

  stop(): void {
    this.stopSound();
    for (const ch of [this.channel, this.battle]) {
      ch.playedIntro = false;
      ch.lastState = 'stopped';
      ch.state = 'stopped';
    }
  }

  // --- sound (pygame mixer channel) emulation -----------------------------

  /** pygame Channel.get_busy() for the music channel. */
  busy(): boolean {
    return this.timeline === 'playing' && !!this.currentSong;
  }

  /** Channel._play on both channels: intro (once) or song, and the battle file, from 0. */
  private play(): void {
    const song = this.currentSong;
    if (!song) return;
    let intro = 0;
    if (song.intro && !this.channel.playedIntro) {
      intro = song.intro.duration;
      // The shared end event: a battle file shorter than the intro ends the intro early.
      if (song.battle) intro = Math.min(intro, song.battle.duration);
      this.channel.playedIntro = true;
    }
    this.introLen = intro;
    this.timeline = 'playing';
    this.scheduleFrom(0);
  }

  pauseSound(): void {
    if (this.timeline !== 'playing') return;
    this.pausedAt = Math.max(0, this.ctx.currentTime - this.origin);
    this.stopSources();
    this.timeline = 'paused';
  }

  private unpauseSound(): void {
    if (this.timeline !== 'paused') return;
    this.timeline = 'playing';
    this.scheduleFrom(this.pausedAt);
  }

  private stopSound(): void {
    this.stopSources();
    this.timeline = 'stopped';
    this.pausedAt = 0;
    this.introLen = 0;
  }

  /** A battle buffer finished loading: join the running timeline in sync. */
  battleLoaded(song: SongObject): void {
    if (song !== this.currentSong || this.timeline !== 'playing' || !song.battle) return;
    const pos = this.ctx.currentTime - this.origin;
    if (song.battle.duration < song.song.duration) {
      // The loop period shrinks to the battle file's length: reschedule both.
      this.scheduleFrom(pos);
      return;
    }
    this.scheduleBattle(song, pos);
  }

  /** Both files restart whenever the shorter one ends: loop period. */
  private loopPeriod(song: SongObject): number {
    return song.battle ? Math.min(song.song.duration, song.battle.duration) : song.song.duration;
  }

  private scheduleFrom(pos: number): void {
    const song = this.currentSong;
    this.stopSources();
    if (!song) return;
    const t = this.ctx.currentTime;
    this.origin = t - pos;
    const period = this.loopPeriod(song);
    const I = this.introLen;
    const loopFrom = (buffer: AudioBuffer, channel: 'music' | 'battle', when: number, offset: number) => {
      const node = this.source(buffer, channel);
      node.loop = true;
      node.loopStart = 0;
      node.loopEnd = period < buffer.duration ? period : 0;
      node.start(when, offset % period);
      this.sources.push({ channel, node, buffer, when });
    };
    const once = (buffer: AudioBuffer, channel: 'music' | 'battle', offset: number, until: number) => {
      const node = this.source(buffer, channel);
      node.start(t, offset);
      node.stop(until);
      this.sources.push({ channel, node, buffer, when: t });
    };
    if (pos < I) {
      const introEnd = t + (I - pos);
      if (song.intro) once(song.intro, 'music', pos, introEnd);
      loopFrom(song.song, 'music', introEnd, 0);
    } else {
      loopFrom(song.song, 'music', t, pos - I);
    }
    this.scheduleBattle(song, pos);
  }

  /** The battle channel's sounds for timeline position `pos` (restarting at the intro boundary). */
  private scheduleBattle(song: SongObject, pos: number): void {
    if (!song.battle) return;
    const battle = song.battle;
    const t = this.ctx.currentTime;
    const period = this.loopPeriod(song);
    const I = this.introLen;
    const add = (when: number, offset: number, loop: boolean, until: number | null) => {
      const node = this.source(battle, 'battle');
      node.loop = loop;
      if (loop) {
        node.loopStart = 0;
        node.loopEnd = period < battle.duration ? period : 0;
      }
      node.start(when, loop ? offset % period : offset);
      if (until !== null) node.stop(until);
      this.sources.push({ channel: 'battle', node, buffer: battle, when });
    };
    if (pos < I) {
      const introEnd = t + (I - pos);
      add(t, pos, false, introEnd);
      add(introEnd, 0, true, null);
    } else {
      add(t, pos - I, true, null);
    }
  }

  private source(buffer: AudioBuffer, channel: 'music' | 'battle'): AudioBufferSourceNode {
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(channel === 'music' ? this.channel.gain : this.battle.gain);
    return node;
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.node.stop();
      } catch {
        // never started
      }
      s.node.disconnect();
    }
    this.sources = [];
  }

  /** Introspection for tests and debugging. */
  describe(): {
    timeline: string; position: number; introLen: number;
    sources: { channel: string; buffer: AudioBuffer; loop: boolean; loopStart: number; loopEnd: number; when: number }[];
  } {
    const position = this.timeline === 'playing' ? this.ctx.currentTime - this.origin : this.pausedAt;
    return {
      timeline: this.timeline,
      position,
      introLen: this.introLen,
      sources: this.sources.map((s) => ({
        channel: s.channel, buffer: s.buffer, loop: s.node.loop, loopStart: s.node.loopStart, loopEnd: s.node.loopEnd, when: s.when,
      })),
    };
  }
}

type GlobalMusicState =
  | 'stopped' | 'playing' | 'fade_in' | 'fade_out_to_pause' | 'fade_out_to_stop'
  | 'fade_out_to_play' | 'fade_out_to_fade_in' | 'paused';

const FADE_OUT_STATES: readonly GlobalMusicState[] = [
  'fade_out_to_play', 'fade_out_to_stop', 'fade_out_to_pause', 'fade_out_to_fade_in',
];

/** Python DefaultSoundController (music half). Songs come pre-loaded via `getSong`. */
export class MusicController {
  readonly channelStack: ChannelPair[];
  readonly songStack: SongObject[] = [];
  state: GlobalMusicState = 'stopped';

  private getSong: (nid: string) => SongObject | null;
  private now: () => number;

  constructor(ctx: BaseAudioContext, output: AudioNode, getSong: (nid: string) => SongObject | null,
    now: () => number = () => performance.now()) {
    this.getSong = getSong;
    this.now = now;
    this.channelStack = [0, 2, 4, 6].map((nid) => new ChannelPair(nid, ctx, output));
  }

  get currentChannel(): ChannelPair {
    return this.channelStack[this.channelStack.length - 1];
  }

  clear(): void {
    this.stop();
    for (const channel of this.channelStack) channel.clear();
    this.songStack.length = 0;
  }

  fadeClear(fadeOut: number = DEFAULT_FADE_TIME_MS): void {
    this.currentChannel.setFadeOutTime(fadeOut);
    this.currentChannel.fadeOut(this.now());
    this.songStack.length = 0;
    this.state = 'fade_out_to_stop';
  }

  fadeToStop(fadeOut: number = DEFAULT_FADE_TIME_MS): void {
    this.currentChannel.setFadeOutTime(fadeOut);
    this.currentChannel.fadeOut(this.now());
    this.state = 'fade_out_to_stop';
  }

  fadeToPause(fadeOut: number = DEFAULT_FADE_TIME_MS): void {
    this.currentChannel.setFadeOutTime(fadeOut);
    this.currentChannel.fadeOut(this.now());
    this.state = 'fade_out_to_pause';
  }

  pause(): void {
    this.currentChannel.pause();
    this.state = 'paused';
  }

  resume(): void {
    this.currentChannel.resume();
    this.state = 'playing';
  }

  isPlaying(): boolean {
    return this.currentChannel.isPlaying();
  }

  private setNextSong(song: SongObject, fadeIn: number): void {
    const oldest = this.channelStack[0];
    oldest.clear();
    this.channelStack.splice(0, 1);
    this.channelStack.push(oldest);
    oldest.setFadeInTime(fadeIn);
    oldest.setCurrentSong(song);
  }

  battleFadeIn(nextSongNid: string, fade: number = DEFAULT_FADE_TIME_MS, fromStart: boolean = true): SongObject | null {
    const song = this.getSong(nextSongNid);
    if (!song) {
      console.warn(`[Music] Song '${nextSongNid}' does not exist`);
      return null;
    }
    if (song.hasBattle) {
      this.crossfade(fade);
      return song;
    }
    return this.fadeIn(nextSongNid, fade, fromStart);
  }

  battleFadeBack(song: SongObject, fromStart: boolean = true): void {
    if (song.hasBattle) this.crossfade();
    else if (fromStart) this.fadeBack();
  }

  crossfade(fade: number = DEFAULT_FADE_TIME_MS): boolean {
    this.currentChannel.setFadeInTime(fade);
    this.currentChannel.setFadeOutTime(fade);
    this.currentChannel.crossfade(this.now());
    return true;
  }

  getCurrentSong(): SongObject | null {
    if (this.isPlaying() && this.songStack.length) return this.songStack[this.songStack.length - 1];
    return null;
  }

  fadeIn(nextSongNid: string, fadeIn: number = DEFAULT_FADE_TIME_MS, fromStart: boolean = false): SongObject | null {
    const nextSong = this.getSong(nextSongNid);
    if (!nextSong) {
      console.warn(`[Music] Song '${nextSongNid}' does not exist`);
      return null;
    }
    let anyMusicIsPlaying = this.isPlaying();
    const currentSong = this.getCurrentSong();
    if (currentSong === nextSong) return null; // song already present

    const now = this.now();
    if (anyMusicIsPlaying) {
      this.currentChannel.setFadeOutTime(fadeIn);
      this.currentChannel.fadeOut(now);
      this.state = 'fade_out_to_fade_in';
    } else if (FADE_OUT_STATES.includes(this.state)) {
      anyMusicIsPlaying = true; // so we don't fade in immediately
      this.state = 'fade_out_to_fade_in';
    } else {
      this.state = 'fade_in';
    }

    const idx = this.songStack.indexOf(nextSong);
    if (idx >= 0) {
      // pull up to the top of the stack
      this.songStack.splice(idx, 1);
      this.songStack.push(nextSong);
      const pair = nextSong.channel;
      if (pair && pair.currentSong === nextSong) {
        if (fromStart) pair.stop(); // so the fade in starts from the beginning
        this.channelStack.splice(this.channelStack.indexOf(pair), 1);
        this.channelStack.push(pair);
        pair.setFadeInTime(fadeIn);
        if (!anyMusicIsPlaying) pair.fadeIn(now);
      } else {
        this.setNextSong(nextSong, fadeIn);
      }
    } else {
      this.songStack.push(nextSong);
      const oldest = this.channelStack[0];
      if (oldest.isFadingOut()) anyMusicIsPlaying = false;
      this.setNextSong(nextSong, fadeIn);
      if (!anyMusicIsPlaying) nextSong.channel!.fadeIn(now);
    }
    return this.songStack[this.songStack.length - 1];
  }

  fadeBack(fadeOut: number = DEFAULT_FADE_TIME_MS): void {
    if (!this.songStack.length) return;
    const current = this.currentChannel;
    current.setFadeOutTime(fadeOut);
    current.fadeOut(this.now());
    this.songStack.pop();
    this.state = this.songStack.length ? 'fade_out_to_fade_in' : 'fade_out_to_stop';
    // move the current channel to the bottom
    this.channelStack.splice(this.channelStack.indexOf(current), 1);
    this.channelStack.unshift(current);
  }

  stop(): void {
    this.currentChannel.stop();
    this.state = 'stopped';
  }

  update(): void {
    const now = this.now();
    let anyChanges = false;
    for (const channel of this.channelStack) {
      if (channel.update(now)) anyChanges = true;
    }
    if (anyChanges) {
      if (this.state === 'fade_out_to_fade_in') {
        this.currentChannel.fadeIn(now);
        this.state = 'fade_in';
      } else if (this.state === 'fade_out_to_stop') {
        this.stop();
      } else if (this.state === 'fade_out_to_pause') {
        this.pause();
      } else if (this.state === 'fade_in') {
        this.state = 'playing';
      }
    }
    if (this.state === 'playing' && !this.isPlaying()) {
      console.warn('[Music] In PLAYING state but not playing music');
      this.currentChannel.setFadeInTime(1);
      this.currentChannel.fadeIn(now);
    }
  }

  /** A battle variant finished loading after its song started. */
  battleLoaded(song: SongObject): void {
    song.channel?.battleLoaded(song);
  }
}
