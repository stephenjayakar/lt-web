/**
 * QA auto-play policies (dev/QA builds only; see docs/qa-tools.md).
 *
 * Decides event choices, which room to enter on an EOtF Act map and which
 * services to visit in a shop/camp sub-room. Random picks use the policy's
 * own seeded generator, never the game's RNG streams, so a policy never
 * consumes a roll the game would have made.
 */

export interface ChoiceContext {
  nid: string | null;
  title: string;
  options: { label: string; value: string; enabled: boolean }[];
  backable: boolean;
  level: string | null;
  floor: unknown;
  /** Times this choice nid was answered on the current level. */
  repeats: number;
}

export type ChoiceDecision = { index: number } | { back: true };

export interface PolicyOptions {
  /** Seed for the policy's own RNG (not the game's). */
  seed: number;
  /** 'random' (default) or 'first' for unknown choices. */
  choices: 'random' | 'first';
  /**
   * Room preference on Act maps: 'random', or kinds in order of preference
   * (Combat, Event, Shop, Respite, Elite). Boss/trial rooms are always taken.
   */
  rooms: 'random' | string[];
  /** Sub-room services to talk to before leaving: 'all', 'none' or NPC nids. */
  services: 'all' | 'none' | string[];
  /** In a shop screen: 'buy' one random item per visit (default), or 'leave'. */
  shop: 'buy' | 'leave';
  /** Fixed answers by choice nid: option value/label, or an index. */
  answers: Record<string, string | number>;
  /** Sortie unit nids for EOtF's New_Party choice, in order. */
  sortie: string[];
  /** Answer a choice nid at most this many times per level, then leave it. */
  repeatLimit: number;
  /** Text entries by variable nid, typed in turn (e.g. password: [...]). */
  texts: Record<string, string[]>;
}

export const DEFAULT_POLICY: PolicyOptions = {
  seed: 1,
  choices: 'random',
  rooms: 'random',
  services: 'all',
  shop: 'buy',
  answers: {},
  sortie: [],
  repeatLimit: 4,
  // EOtF's Hallway riddle ("Who sent you here?", force_entry).
  texts: { answer: ['TACITA'] },
};

/** mulberry32: small deterministic PRNG for policy decisions. */
export class PolicyRng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  pick<T>(list: T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
}

const strip = (text: string) => text.replace(/<[^>]*>/g, '').trim();
const YES_PROMPT = /begin|proceed|enter|visit|investigate|sortie|deploy|depart|accept|continue|fight|challenge|heal/i;
const DANGER_PROMPT = /abandon|quit|give up|retire|delete|reset|forfeit|end (the|this) run|return to (the )?(hub|title)/i;
const LEAVE_OPTION = /^(leave|exit|back|done|cancel|no|nothing|skip|never ?mind|close|none|decline)\b/i;
const META_OPTION = /^(help|filter|filters|search|bonusunit)$/i;

export class Policy {
  readonly options: PolicyOptions;
  private rng: PolicyRng;
  private sortieTaken = new Set<string>();

  constructor(options: Partial<PolicyOptions>) {
    this.options = { ...DEFAULT_POLICY, ...options };
    this.rng = new PolicyRng(this.options.seed);
  }

  random(): number {
    return this.rng.next();
  }

  resetSortie(): void {
    this.sortieTaken.clear();
  }

  choose(ctx: ChoiceContext): ChoiceDecision {
    const opts = ctx.options.map((o, index) => ({ ...o, index, text: strip(o.label), val: strip(String(o.value)) }));
    const enabled = opts.filter((o) => o.enabled);
    if (enabled.length === 0) return ctx.backable ? { back: true } : { index: 0 };
    const byText = (pattern: RegExp) => enabled.find((o) => pattern.test(o.val) || pattern.test(o.text));
    const exact = (want: string) => enabled.find((o) => o.val === want || o.text === want);

    const fixed = ctx.nid ? this.options.answers[ctx.nid] : undefined;
    if (fixed !== undefined) {
      if (typeof fixed === 'number') return { index: Math.max(0, Math.min(fixed, opts.length - 1)) };
      const hit = exact(fixed);
      if (hit) return { index: hit.index };
    }

    // EOtF sortie: pick the planned units in order.
    if (ctx.nid === 'New_Party') {
      for (const nid of this.options.sortie) {
        if (this.sortieTaken.has(nid)) continue;
        const hit = enabled.find((o) => o.val === nid);
        if (hit) {
          this.sortieTaken.add(nid);
          return { index: hit.index };
        }
      }
      const unit = enabled.find((o) => !META_OPTION.test(o.val) && o.val !== 'BACK');
      if (unit) return { index: unit.index };
    }

    const yes = exact('Yes');
    const no = exact('No');
    const title = strip(ctx.title);
    if (DANGER_PROMPT.test(title)) {
      if (no) return { index: no.index };
      if (ctx.backable) return { back: true };
    }
    if (yes && (YES_PROMPT.test(title) || ['deploy', 'begin', 'exit'].includes(ctx.nid ?? ''))) {
      return { index: yes.index };
    }

    if (ctx.repeats >= this.options.repeatLimit) {
      if (ctx.backable) return { back: true };
      const leave = byText(LEAVE_OPTION);
      if (leave) return { index: leave.index };
      return { index: enabled[enabled.length - 1].index };
    }

    const useful = enabled.filter((o) => !META_OPTION.test(o.val) && !META_OPTION.test(o.text));
    const pool = useful.length > 0 ? useful : enabled;
    if (this.options.choices === 'first') return { index: pool[0].index };
    return { index: this.rng.pick(pool).index };
  }

  /**
   * Pick a room on an EOtF Act map. `rooms` maps the room unit nid to its
   * kind (the level var: Combat, Event, Shop, Respite, a boss/trial nid, or
   * 'Elite' for room4).
   */
  chooseRoom(rooms: { nid: string; kind: string }[]): string | null {
    if (rooms.length === 0) return null;
    const standard = new Set(['Combat', 'Event', 'Shop', 'Respite', 'Elite']);
    const special = rooms.filter((room) => !standard.has(room.kind) && !/^room(Ophie|Aqua)$/.test(room.nid));
    // Boss and trial floors offer only those rooms.
    if (special.length > 0) return this.rng.pick(special).nid;
    const normal = rooms.filter((room) => standard.has(room.kind));
    const prefs = this.options.rooms;
    if (prefs === 'random') {
      const pool = normal.filter((room) => room.kind !== 'Elite');
      return (pool.length > 0 ? this.rng.pick(pool) : this.rng.pick(normal.length ? normal : rooms)).nid;
    }
    for (const kind of prefs) {
      const matches = normal.filter((room) => room.kind.toLowerCase() === kind.toLowerCase());
      if (matches.length > 0) return this.rng.pick(matches).nid;
    }
    const fallback = normal.filter((room) => room.kind !== 'Elite');
    return (fallback.length > 0 ? fallback[0] : rooms[0]).nid;
  }

  wantsService(nid: string): boolean {
    const services = this.options.services;
    if (services === 'all') return true;
    if (services === 'none') return false;
    return services.includes(nid);
  }
}
