/**
 * QA jump-to for Embrace of the Fog (dev/QA builds only; see
 * docs/qa-tools.md).
 *
 * Builds a realistic mid-run state through the project's own run setup:
 *
 * 1. records: a returning player (tutorial/intro records set, Progress 3),
 *    the requested owned units, sortie slots, game length, density and any
 *    extra records;
 * 2. New Game through TitleNewState (start save included), so the hub's
 *    `0. Setup` event loads the owned units and creates the per-run vars;
 * 3. in the hub: party customisation through event commands (autolevel_to,
 *    promote, give_item, give_money), the floor/Game_Level the run would
 *    have reached, set_next_chapter to the Act, then `8. Run_Start` with the
 *    sortie choice answered by the policy (upgrades, tonics, money and the
 *    win_game -> Global_Level_End -> Act intro chain all run for real);
 * 4. optionally a battle/trial/boss level entered the way Talk_Room does
 *    (in_combat, next_reward, set_next_chapter, skip_save, win_game).
 */

export interface UnitSpec {
  nid: string;
  level?: number;
  /** Promote (to the class's first promotion, or to `klass`). */
  promote?: boolean;
  klass?: string;
  /** Level after promotion (autolevel_to again). */
  promotedLevel?: number;
  items?: string[];
}

export interface JumpSpec {
  act?: number;
  floor?: number;
  /** Alternate Act variant (Act_NA; EOtF Alter_Act 2). */
  alter?: boolean;
  /** A battle level to enter from the Act map, e.g. '16', 'Adrius', 'Bootes'. */
  level?: string;
  /** next_reward for `level` (default by level tags). */
  reward?: string;
  /** Game_Speed record: 1 = long (15 floors per Act), 2 = short (10). */
  gameSpeed?: 1 | 2;
  density?: number;
  party?: (string | UnitSpec)[];
  /** Party level when a unit spec has none (default: by floor). */
  partyLevel?: number;
  /** Promote every party unit that can promote (default: Act 2+). */
  promoted?: boolean;
  money?: number;
  records?: Record<string, unknown>;
  gameVars?: Record<string, unknown>;
  /** Game RNG seed (_random_seed). */
  seed?: number;
  /** Keep EOtF's tutorial popups (default: skipped like a returning player). */
  tutorials?: boolean;
  /**
   * QA stat boost: change_stats +N to every stat (+2N HP) on each party unit,
   * then a full heal. Off by default; lets the simple auto-play AI survive
   * deep floors so later content can be reached and exercised.
   */
  boost?: number;
}

export interface JumpHost {
  game: any;
  records: { get(nid: string): unknown; update(nid: string, value: unknown): void; create(nid: string, value?: unknown): void; has(nid: string): boolean };
  waitFor(pred: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  runScript(lines: string[], nid?: string): void;
  setSortie(nids: string[]): void;
  note(text: string): void;
}

export interface JumpResult {
  level: string | null;
  floor: unknown;
  state: string | null;
  party: { nid: string; klass: string; level: number; hp: number; items: string[] }[];
}

/** Records EOtF sets the first time a tutorial or intro has been shown. */
const TUTORIAL_RECORDS = [
  'watched_intro', 'watched_outro', 'controls_first_time', 'rooms_first_time', 'Camp_First_Time',
  'Shop_First_Time', 'Event_First_Time', 'boss_info_first_time', 'depart_first_time',
  'game_length_first_time', 'trace_first_time', 'tonic_first_time', 'flame_first_time',
  'essence_first_time', 'lore_first_time', 'temp_gacha_first_time', 'support_first_time',
  'diff_first_time', 'eleven_first_time', 'challenge_first_time', 'music_first_time',
  'streamer_mode_first_time', 'wardrobe_first_time', 'bar_first_time', 'bossMS_first_time',
  'blacksmith_first_time', 'contractor_first_time', 'desk_first_time', 'tuneup_first_time',
  'wardrobe_notif_first_time', 'bar_notif_first_time', 'bar_notif_second_time',
];

export const DEFAULT_PARTY = ['Player', 'Gorbat', 'Pilus', 'Viran'];

export function floorsPerAct(gameSpeed: number): number {
  return gameSpeed === 2 ? 10 : 15;
}

/** Global_Level_End's per-floor Game_Level increment. */
export function gameLevelIncrement(gameSpeed: number, density: number): number {
  if (gameSpeed === 2) {
    if (density > 10) return 1.2 + 0.02 * (density - 10);
    if (density > 0) return 0.8 + 0.04 * density;
    return 0.6;
  }
  if (density > 10) return 0.9 + 0.015 * (density - 10);
  if (density > 0) return 0.6 + 0.03 * density;
  return 0.45;
}

function normaliseUnit(spec: string | UnitSpec): UnitSpec {
  return typeof spec === 'string' ? { nid: spec } : { ...spec };
}

/** Event-command argument: EOtF unit/item nids never contain ';'. */
function arg(value: unknown): string {
  return String(value).replace(/;/g, '');
}

function literal(value: unknown): string {
  return JSON.stringify(value).replace(/;/g, '');
}

export async function jumpEotf(host: JumpHost, spec: JumpSpec): Promise<JumpResult> {
  const { game } = host;
  const gameSpeed = spec.gameSpeed ?? 1;
  const perAct = floorsPerAct(gameSpeed);
  const act = spec.act ?? (spec.floor ? Math.min(4, Math.floor((spec.floor - 1) / perAct) + 1) : 1);
  const floor = spec.floor ?? (act - 1) * perAct + 1;
  const density = spec.density ?? 0;
  const party = (spec.party && spec.party.length > 0 ? spec.party : DEFAULT_PARTY).map(normaliseUnit);
  const promoted = spec.promoted ?? floor > perAct;
  const defaultLevel = spec.partyLevel ?? Math.max(1, Math.round(1 + floor * 0.8));
  for (const unit of party) {
    if (!game.db.units.get(unit.nid)) throw new Error(`jump: unknown unit "${unit.nid}"`);
  }

  // 1. Records (persistent; the profile is a fresh browser context).
  await host.waitFor(() => {
    const top = game.state.getCurrentState()?.name ?? '';
    return top.startsWith('title') && !game.eventManager?.hasActiveEvents();
  }, 'title screen after on_startup', 60_000);
  const setRecord = (nid: string, value: unknown) => {
    if (host.records.has(nid)) host.records.update(nid, value);
    else host.records.create(nid, value);
  };
  if (spec.tutorials !== true) for (const nid of TUTORIAL_RECORDS) setRecord(nid, 1);
  setRecord('Progress', 3);
  setRecord('Game_Speed', gameSpeed);
  setRecord('current_density', density);
  setRecord('highest_density', Math.max(density, Number(host.records.get('highest_density') ?? 0)));
  const owned = new Set<string>(['Player', ...party.map((u) => u.nid)]);
  setRecord('Available_Units', [...owned]);
  setRecord('Seen_Units', [...owned]);
  const sortie = party.map((u) => u.nid);
  // Run_Start sorties min(owned, 4 + Sortie_Slot) units.
  const slots = Math.max(0, sortie.length - 4);
  if (slots > 0) setRecord('Sortie_Slot', slots);
  for (const [nid, value] of Object.entries(spec.records ?? {})) setRecord(nid, value);

  // 2. New Game (TitleNewState's own path: buildNew, first level, start save).
  game.initDifficulty?.();
  const titleNew = (game.state as any).allStates?.get('title_new');
  if (!titleNew?.buildNewGame) throw new Error('jump: TitleNewState.buildNewGame not found');
  const mode = game.currentMode;
  await titleNew.buildNewGame(0);
  if (!game.currentMode) game.currentMode = mode;
  if (spec.seed !== undefined) {
    game.gameVars.set('_random_seed', spec.seed);
    game.gameVars.delete('_combat_random_seed');
    game.gameVars.delete('_growth_random_seed');
    game.gameVars.delete('_other_random_seed');
  }
  await host.waitFor(() => game.currentLevel?.nid === 'X' && game.state.getCurrentState()?.name === 'free_roam'
    && !game.eventManager?.hasActiveEvents(), 'hub (X) free roam', 90_000);

  // 3. Party, floor, Act, then the real Run_Start.
  const lines: string[] = [];
  for (const unit of party) {
    const level = unit.level ?? defaultLevel;
    if (level > 1) lines.push(`autolevel_to;${arg(unit.nid)};${level}`);
    const prefab = game.db.units.get(unit.nid);
    const klass = game.db.classes.get(prefab?.klass);
    const wantPromote = unit.promote ?? (promoted && (klass?.turns_into?.length ?? 0) > 0);
    if (unit.klass && unit.klass !== prefab?.klass) {
      lines.push(`${wantPromote ? 'promote' : 'change_class'};${arg(unit.nid)};${arg(unit.klass)};silent`);
    } else if (wantPromote && klass?.turns_into?.length) {
      lines.push(`promote;${arg(unit.nid)};${arg(klass.turns_into[0])};silent`);
    }
    if (unit.promotedLevel) lines.push(`autolevel_to;${arg(unit.nid)};${unit.promotedLevel}`);
    if (spec.boost && spec.boost > 0) {
      const b = Math.floor(spec.boost);
      lines.push(`change_stats;${arg(unit.nid)};HP,${2 * b},STR,${b},MAG,${b},SKL,${b},SPD,${b},LCK,${b},DEF,${b},RES,${b};immediate`);
      lines.push(`heal;${arg(unit.nid)};999`);
    }
    for (const item of unit.items ?? []) lines.push(`give_item;${arg(unit.nid)};${arg(item)};no_banner`);
  }
  if (spec.money) lines.push(`give_money;${Math.floor(spec.money)};Player;no_banner`);
  for (const [nid, value] of Object.entries(spec.gameVars ?? {})) lines.push(`game_var;${arg(nid)};${literal(value)}`);
  // Global_Level_End (fired by Run_Start's win_game) adds one floor and one
  // Game_Level step, so preset the values the previous floor would have had.
  const increment = gameLevelIncrement(gameSpeed, density);
  lines.push(`game_var;Floor;${floor - 1}`);
  lines.push(`game_var;Game_Level;${(increment * (floor - 1)).toFixed(4)}`);
  if (spec.alter) lines.push('game_var;Alter_Act;2');
  const actNid = `Act_${act}${spec.alter ? 'A' : ''}`;
  if (!game.db.levels.get(actNid)) throw new Error(`jump: no level ${actNid}`);
  lines.push(`set_next_chapter;${actNid}`);
  lines.push('trigger_script;X 8. Run_Start');
  host.setSortie(sortie);
  host.note(`jump: floor ${floor} (${actNid}), party ${sortie.join(',')}`);
  host.runScript(lines, 'QA_Jump_Setup');
  await host.waitFor(() => game.currentLevel?.nid === actNid && game.state.getCurrentState()?.name === 'free_roam'
    && !game.eventManager?.hasActiveEvents(), `${actNid} free roam`, 120_000);

  // 4. Optional battle level, entered the way Talk_Room does.
  if (spec.level) {
    const target = game.db.levels.get(spec.level);
    if (!target) throw new Error(`jump: unknown level "${spec.level}"`);
    const tags: string[] = target.tags ?? [];
    const reward = spec.reward ?? (tags.includes('Boss_Map') ? 'Boss' : tags.includes('Trial_Map') ? 'Money' : 'Weapons+');
    const script = ['game_var;in_combat;1', `game_var;next_reward;${literal(reward)}`];
    if (tags.includes('Trial_Map')) script.push(`game_var;subboss;${literal(String(spec.level).toLowerCase())}`);
    script.push(`game_var;seen_maps;v('seen_maps') + [${literal(spec.level)}]`);
    script.push(`set_next_chapter;${arg(spec.level)}`, 'skip_save;t', 'win_game');
    host.runScript(script, 'QA_Jump_Level');
    await host.waitFor(() => {
      const top = game.state.getCurrentState()?.name;
      return game.currentLevel?.nid === spec.level && !game.eventManager?.hasActiveEvents()
        && (top === 'prep_main' || top === 'free');
    }, `level ${spec.level} ready`, 120_000);
  }

  const partyUnits = (game.getUnitsInParty?.() ?? []) as any[];
  return {
    level: game.currentLevel?.nid ?? null,
    floor: game.gameVars.get('Floor'),
    state: game.state.getCurrentState()?.name ?? null,
    party: partyUnits.map((u) => ({
      nid: u.nid,
      klass: u.klass,
      level: u.level,
      hp: u.currentHp,
      items: (u.items ?? []).map((i: any) => i.nid),
    })),
  };
}
