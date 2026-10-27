"""Differential-testing oracle: drive the real Python Lex Talionis engine headless.

The engine is imported straight from ``lt-maker/`` (never copied). A scenario
JSON (see README.md) is replayed through the engine's own states, menus and
actions, and a canonical snapshot is dumped after every step.

    E:/BigData/lt-oracle/venv/Scripts/python tools/oracle/py_driver.py \
        tools/oracle/scenarios/default-combat-exp.json [-o out.json]
"""
from __future__ import annotations

import argparse
import builtins
import json
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LT_MAKER = Path(os.environ.get('LT_MAKER', REPO / 'lt-maker')).resolve()
ORACLE_HOME = Path(os.environ.get('LT_ORACLE_HOME', 'E:/BigData/lt-oracle'))
RUN_DIR = ORACLE_HOME / 'run'
GEN_DIR = ORACLE_HOME / 'gen'

# Read-only lt-maker entries the engine opens through cwd-relative paths.
_LINKED = ['app', 'sprites', 'resources', 'icons', 'locale']
_COPIED = ['favicon.ico', 'main_icon.ico']

FRAME_MS = 1000 / 60
BUTTONS = ('UP', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'BACK', 'INFO', 'AUX', 'START')

# States in which the driver may stop and hand control back to the scenario.
REST_STATES = {
    'free', 'menu', 'move', 'canto_wait', 'weapon_choice', 'spell_choice',
    'combat_targeting', 'targeting', 'item', 'item_child', 'item_targeting',
    'trade', 'option_menu', 'option_child',
}


class OracleError(Exception):
    pass


# --------------------------------------------------------------------------
# Bootstrap
# --------------------------------------------------------------------------

def _prepare_run_dir() -> None:
    """The engine reads sprites/, resources/ ... and writes saves/ relative to
    cwd. Run it from a scratch dir on E: whose read-only entries are junctions
    into lt-maker, so nothing is ever written into the shared lt-maker tree."""
    (RUN_DIR / 'saves').mkdir(parents=True, exist_ok=True)
    for name in _LINKED:
        link = RUN_DIR / name
        if not link.exists():
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(LT_MAKER / name)],
                           check=True, capture_output=True)
    for name in _COPIED:
        dst = RUN_DIR / name
        if not dst.exists() and (LT_MAKER / name).exists():
            shutil.copyfile(LT_MAKER / name, dst)


def _codegen_overlay() -> None:
    """lt-maker generates item_system.py, skill_system.py and the PyEv1 command
    wrappers into its own source tree at startup. Generate them into an
    overlay package dir on E: instead and append it to ``app.__path__`` so the
    namespace subpackages app.engine / app.events pick them up."""
    overlay = GEN_DIR / 'app'
    rel = [('engine', 'item_system.py'), ('engine', 'skill_system.py'),
           ('events', 'python_eventing', 'python_event_command_wrappers.py')]
    targets = {}
    for parts in rel:
        src = os.path.normcase(str(LT_MAKER.joinpath('app', *parts)))
        dst = overlay.joinpath(*parts)
        dst.parent.mkdir(parents=True, exist_ok=True)
        targets[src] = dst
    import app
    app.__path__.append(str(overlay))

    real_open = builtins.open

    def redirect_open(file, mode='r', *args, **kwargs):
        if isinstance(file, (str, os.PathLike)) and 'w' in mode:
            key = os.path.normcase(os.path.realpath(file))
            if key in targets:
                file = targets[key]
        return real_open(file, mode, *args, **kwargs)

    builtins.open = redirect_open
    try:
        from app.engine.codegen import source_generator
        source_generator.generate_all()
    finally:
        builtins.open = real_open


def bootstrap() -> None:
    os.environ.setdefault('SDL_VIDEODRIVER', 'dummy')
    os.environ.setdefault('SDL_AUDIODRIVER', 'dummy')
    os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')
    sys.pycache_prefix = str(ORACLE_HOME / 'pycache')
    _prepare_run_dir()
    os.chdir(RUN_DIR)
    sys.path.insert(0, str(LT_MAKER))
    _codegen_overlay()


# --------------------------------------------------------------------------
# Canonical helpers
# --------------------------------------------------------------------------

def _jsonable(v):
    """Coerce engine values into plain JSON (enums, tuples, sets, objects)."""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 6)
    if hasattr(v, 'value') and type(v).__module__ != 'builtins' and isinstance(getattr(v, 'value'), (str, int)):
        return v.value  # Enum
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (set, frozenset)):
        return sorted(_jsonable(x) for x in v)
    if hasattr(v, 'nid'):
        return {'$ref': getattr(v, 'nid')}
    return repr(v)


def _pos(p):
    return [int(p[0]), int(p[1])] if p is not None else None


# --------------------------------------------------------------------------
# Engine wrapper
# --------------------------------------------------------------------------

class Engine:
    def __init__(self, project: str):
        self.project = project
        self.frame = 0
        self.game = None
        self.log = []

    # -- boot --------------------------------------------------------------
    def boot(self, settings: dict | None = None) -> None:
        bootstrap()
        import logging
        logging.basicConfig(level=logging.ERROR, stream=sys.stderr)
        from app.engine import engine
        self.engine = engine
        self._patch_clock(engine)
        from app.data.resources.resources import RESOURCES
        from app.data.database.database import DB
        from app.data.serialization.versions import CURRENT_SERIALIZATION_VERSION
        from app.engine import config as cf
        self.DB = DB
        self.cf = cf
        proj = str(LT_MAKER / self.project)
        if not os.path.exists(os.path.join(proj, 'metadata.json')):
            raise OracleError('project not found: %s' % proj)
        RESOURCES.load(proj, CURRENT_SERIALIZATION_VERSION)
        DB.load(proj, CURRENT_SERIALIZATION_VERSION)
        base = {
            'debug': 1, 'animation': 'Never', 'music_volume': 0, 'sound_volume': 0,
            'mouse': 0, 'autoend_turn': 0, 'confirm_end': 0, 'text_speed': 0,
            'show_terrain': 0, 'show_objective': 0, 'autocursor': 1, 'talk_boop': 0,
        }
        base.update(settings or {})
        for k, v in base.items():
            cf.SETTINGS[k] = v
        from app.engine import driver
        driver.start(DB.constants.value('title'), from_editor=True)
        self.surf = engine.create_surface((240, 160))
        from app.engine.input_manager import get_input_manager
        self.inp = get_input_manager()

    def _patch_clock(self, engine) -> None:
        """Replace wall-clock ticks with a frame counter: every frame is
        exactly 1000/60 ms, so timed states are deterministic."""
        oracle = self

        def update_time():
            engine.constants['last_time'] = engine.constants['current_time']
            engine.constants['current_time'] = int(oracle.frame * FRAME_MS)
            engine.constants['delta_t'] = engine.constants['current_time'] - engine.constants['last_time']

        engine.update_time = update_time
        engine.get_true_time = lambda: engine.constants['current_time']

    # -- level -------------------------------------------------------------
    def start_level(self, level_nid: str, seed: int, events: bool) -> None:
        from app.engine import game_state
        from app.utilities import static_random
        self.cf.SETTINGS['random_seed'] = int(seed)
        self.game = game_state.start_level(level_nid)
        self.static_random = static_random
        if not events:
            self._suppress_events = True
            real_trigger = self.game.events.trigger
            oracle = self

            def trigger(trig, level_nid=None):
                if oracle._suppress_events:
                    return False
                return real_trigger(trig, level_nid)
            self.game.events.trigger = trigger
        else:
            self._suppress_events = False

    def apply_mode(self, rng_mode: str | None, growths: str | None) -> None:
        from app.data.database.difficulty_modes import RNGOption, GrowthOption
        if rng_mode:
            self.game.current_mode.rng_mode = RNGOption(rng_mode)
        if growths:
            self.game.current_mode.growths = GrowthOption(growths)

    # -- frames / input ----------------------------------------------------
    def step(self, button: str | None = None) -> None:
        self.frame += 1
        self.engine.update_time()
        inp = self.inp
        inp.key_up_events.clear()
        inp.key_down_events.clear()
        for b in BUTTONS:
            if inp.keys_pressed.get(b):
                inp.keys_pressed[b] = False
                inp.key_up_events.append(b)
        if button:
            inp.keys_pressed[button] = True
            inp.key_down_events.append(button)
        surf, repeat = self.game.state.update(button, self.surf)
        guard = 0
        while repeat:
            surf, repeat = self.game.state.update([], self.surf)
            guard += 1
            if guard > 1000:
                raise OracleError('state machine repeat loop at %s' % self.stack())
        from app.engine.sound import get_sound_thread
        get_sound_thread().update([])

    def press(self, button: str) -> None:
        self.step(button)
        self.step(None)  # release

    def top(self) -> str | None:
        return self.game.state.current()

    def stack(self) -> list:
        return [s.name for s in self.game.state.state]

    def busy(self) -> bool:
        """True while the state machine has queued changes, units are moving,
        events are pending, or the camera is still travelling."""
        g = self.game
        if g.state.temp_state:
            return True
        if len(g.movement) > 0:
            return True
        if g.events.event_stack:
            return True
        return False

    def settle(self, max_frames: int = 6000, until=None, skip: str = 'SELECT') -> None:
        """Run frames until a resting state is reached and stays put, pressing
        ``skip`` to advance dialog in event states (like a player tapping A)."""
        stable = 0
        last = None
        stuck = 0
        for _ in range(max_frames):
            top = self.top()
            rest = (until(self) if until else top in REST_STATES)
            if rest and not self.busy():
                stable += 1
                if stable >= 3:
                    return
                self.step(None)
                continue
            stable = 0
            if top == last and top not in ('ai', 'movement', 'combat', 'phase_change'):
                stuck += 1
            else:
                stuck = 0
            last = top
            if top in ('event', 'dialog', 'transition_in', 'transition_out', 'chapter_title') and stuck >= 2 and stuck % 2 == 0:
                self.press(skip)
            elif stuck > 600 and stuck % 60 == 0:
                # A blocking screen we don't model (exp bar, level up, banner...)
                self.press('SELECT')
            else:
                self.step(None)
        raise OracleError('settle timed out; stack=%s' % self.stack())

    # -- UI primitives -----------------------------------------------------
    def cursor(self, pos) -> None:
        g = self.game
        pos = tuple(pos)
        g.cursor.set_pos(pos)
        cur = g.cursor
        if self.top() == 'move' and cur.cur_unit:
            # Python updates the movement arrow path while the cursor walks;
            # a teleport has to rebuild it as a mouse click would.
            if g.highlight.check_in_all_move(pos):
                cur._last_valid_position = pos
            cur.path = []
            cur.path = cur._get_path()

    def expect(self, *states) -> None:
        if self.top() not in states:
            raise OracleError('expected state %s, got %s (stack %s)' % (states, self.top(), self.stack()))

    def menu_values(self):
        st = self.game.state.current_state()
        menu = getattr(st, 'menu', None)
        if menu is None:
            raise OracleError('state %s has no menu' % self.top())
        return menu, [o.get() for o in menu.options]

    def choose(self, want) -> None:
        """Move the current menu's cursor to ``want`` with real UP/DOWN presses
        (so on-hover side effects such as auto-equip run), then SELECT."""
        menu, values = self.menu_values()

        def match(v):
            if callable(want):
                return want(v)
            if isinstance(v, str):
                return v.lower() == str(want).lower()
            return getattr(v, 'nid', None) == want

        idx = next((i for i, v in enumerate(values) if match(v)), None)
        if idx is None:
            raise OracleError('option %r not in %s menu %s' % (want, self.top(), [_label(v) for v in values]))
        for _ in range(len(values) + 2):
            cur = menu.current_index
            if cur == idx:
                break
            self.press('DOWN' if idx > cur else 'UP')
            menu = getattr(self.game.state.current_state(), 'menu', menu)
        if menu.current_index != idx:
            raise OracleError('could not reach option %r in %s' % (want, self.top()))
        self.press('SELECT')

    # -- lookup ------------------------------------------------------------
    def unit(self, nid):
        u = self.game.get_unit(nid)
        if not u:
            raise OracleError('unknown unit %s' % nid)
        return u

    def target_pos(self, target):
        if isinstance(target, (list, tuple)):
            return tuple(target)
        u = self.unit(target)
        if not u.position:
            raise OracleError('target %s is off the map' % target)
        return tuple(u.position)


def _label(v):
    return getattr(v, 'nid', None) or str(v)


# --------------------------------------------------------------------------
# Scenario actions
# --------------------------------------------------------------------------

class Runner:
    def __init__(self, eng: Engine, scenario: dict):
        self.e = eng
        self.s = scenario

    # setup is applied directly through engine actions, not the UI
    def setup(self, ops: list) -> None:
        from app.engine import action, item_funcs
        g = self.e.game
        for op in ops:
            if 'unit' in op:
                u = self.e.unit(op['unit'])
                if 'team' in op:
                    action.do(action.ChangeTeam(u, op['team']))
                if 'level' in op:
                    u.level = int(op['level'])
                if 'exp' in op:
                    u.exp = int(op['exp'])
                if 'stats' in op:
                    for k, v in op['stats'].items():
                        u.stats[k] = int(v)
                if 'growths' in op:
                    for k, v in op['growths'].items():
                        u.growths[k] = int(v)
                if 'items' in op:
                    for item in list(u.items):
                        action.do(action.RemoveItem(u, item))
                    for nid in op['items']:
                        self._give(u, nid)
                for nid in op.get('add_items', []):
                    self._give(u, nid)
                for nid in op.get('add_skills', []):
                    action.do(action.AddSkill(u, nid))
                for nid in op.get('remove_skills', []):
                    action.do(action.RemoveSkill(u, nid))
                if 'position' in op:
                    if op['position'] is None:
                        action.do(action.RemoveFromMap(u))
                    elif u.position:
                        action.do(action.Teleport(u, tuple(op['position'])))
                    else:
                        action.do(action.ArriveOnMap(u, tuple(op['position'])))
                if 'stats' in op and 'hp' not in op:
                    u.set_hp(u.get_max_hp())
                if 'hp' in op:
                    action.do(action.SetHP(u, int(op['hp'])))
            elif 'game_var' in op:
                action.do(action.SetGameVar(op['game_var'], op['value']))
            elif 'level_var' in op:
                action.do(action.SetLevelVar(op['level_var'], op['value']))
            elif 'kill' in op:
                u = self.e.unit(op['kill'])
                action.do(action.Die(u))
            else:
                raise OracleError('unknown setup op %r' % op)

    def _give(self, u, nid):
        from app.engine import action, item_funcs
        item = item_funcs.create_item(u, nid)
        if not item:
            raise OracleError('unknown item %s' % nid)
        self.e.game.register_item(item)
        action.do(action.GiveItem(u, item))

    def in_menu_for(self, nid) -> None:
        """Get ``nid`` into its action menu, moving in place if needed."""
        e = self.e
        if e.top() == 'menu' and e.game.cursor.cur_unit and e.game.cursor.cur_unit.nid == nid:
            return
        u = e.unit(nid)
        self.do_move({'unit': nid, 'to': list(u.position)})

    def do_move(self, a) -> None:
        e = self.e
        e.expect('free')
        u = e.unit(a['unit'])
        e.cursor(u.position)
        e.press('SELECT')
        e.settle(until=lambda en: en.top() == 'move')
        e.cursor(a['to'])
        e.press('SELECT')
        e.settle()

    def do_wait(self, a) -> None:
        e = self.e
        if a.get('unit'):
            self.in_menu_for(a['unit'])
        if e.top() == 'canto_wait':
            e.choose('Wait')
        else:
            e.expect('menu')
            e.choose('Wait')
        e.settle()

    def _target_and_fire(self, target) -> None:
        e = self.e
        e.cursor(e.target_pos(target))
        e.press('SELECT')
        e.settle()

    def do_attack(self, a) -> None:
        e = self.e
        self.in_menu_for(a['unit'])
        e.choose('Attack')
        e.settle()
        if e.top() == 'weapon_choice':
            if a.get('item'):
                e.choose(a['item'])
            else:
                e.press('SELECT')
            e.settle()
        e.expect('combat_targeting')
        self._target_and_fire(a['target'])

    def do_spell(self, a) -> None:
        e = self.e
        self.in_menu_for(a['unit'])
        e.choose('Spells')
        e.settle()
        if e.top() == 'spell_choice':
            if a.get('item'):
                e.choose(a['item'])
            else:
                e.press('SELECT')
            e.settle()
        e.expect('combat_targeting')
        self._target_and_fire(a['target'])

    def do_use_item(self, a) -> None:
        e = self.e
        self.in_menu_for(a['unit'])
        e.choose('Item')
        e.settle()
        e.expect('item')
        e.choose(a['item'])
        e.settle()
        e.expect('item_child')
        e.choose(a.get('option', 'Use'))
        e.settle()
        if e.top() in ('item_targeting', 'combat_targeting') and a.get('target') is not None:
            self._target_and_fire(a['target'])

    def do_trade(self, a) -> None:
        e = self.e
        self.in_menu_for(a['unit'])
        e.choose('Trade')
        e.settle()
        e.expect('targeting')
        e.cursor(e.target_pos(a['with']))
        e.press('SELECT')
        e.settle()
        e.expect('trade')
        st = e.game.state.current_state()
        menu = st.menu
        initiator, partner = st.initiator, st.partner

        def hand_index(hand, nid):
            m = menu.menu1 if hand == 0 else menu.menu2
            for i, o in enumerate(m.options):
                if getattr(o.get(), 'nid', None) == nid:
                    return i
            raise OracleError('%s not in trade hand %d' % (nid, hand))

        for give in a.get('give', []):
            menu.selecting_hand = (0, hand_index(0, give))
            menu.menu1.current_index = menu.selecting_hand[1]
            e.press('SELECT')
            e.press('SELECT')  # drop into the first empty slot on the other side
        for take in a.get('take', []):
            menu.selecting_hand = (1, hand_index(1, take))
            menu.menu2.current_index = menu.selecting_hand[1]
            e.press('SELECT')
            e.press('SELECT')
        e.press('BACK')
        e.settle()

    def do_end_turn(self, a) -> None:
        e = self.e
        e.expect('free')
        # An empty tile opens the option menu in Python; use an off-unit tile.
        pos = self._empty_tile()
        e.cursor(pos)
        e.press('SELECT')
        e.settle(until=lambda en: en.top() == 'option_menu')
        e.choose('End')
        e.settle(until=lambda en: en.top() == 'free' and en.game.phase.get_current() == 'player',
                 max_frames=a.get('max_frames', 20000))

    def _empty_tile(self):
        g = self.e.game
        for y in range(g.tilemap.height):
            for x in range(g.tilemap.width):
                if not g.board.get_unit((x, y)):
                    return (x, y)
        raise OracleError('no empty tile')

    def do_event(self, a) -> None:
        e = self.e
        from app.events import triggers
        was = e._suppress_events
        e._suppress_events = False
        try:
            if a.get('script') is not None:
                src = a['script'] if isinstance(a['script'], str) else '\n'.join(a['script'])
                unit = e.unit(a['unit1']) if a.get('unit1') else None
                e.game.events._add_event_from_script(a.get('nid', 'oracle_script'), src,
                                                     triggers.GenericTrigger(unit1=unit))
            elif a.get('nid'):
                if not e.game.events.trigger_specific_event(a['nid'], force=a.get('force', False)):
                    raise OracleError('event %s did not trigger' % a['nid'])
            elif a.get('trigger'):
                trig = getattr(triggers, a['trigger'], None)
                if trig is None:
                    raise OracleError('unknown trigger class %s' % a['trigger'])
                e.game.events.trigger(trig(**a.get('args', {})))
            e.settle(skip=a.get('skip', 'SELECT'), max_frames=a.get('max_frames', 6000))
        finally:
            e._suppress_events = was

    def do_frames(self, a) -> None:
        for _ in range(int(a.get('n', 1))):
            self.e.step(None)

    def do_press(self, a) -> None:
        self.e.press(a['button'])
        if a.get('settle', True):
            self.e.settle()

    def do_settle(self, a) -> None:
        self.e.settle(skip=a.get('skip', 'SELECT'), max_frames=a.get('max_frames', 6000))

    def run_action(self, a) -> None:
        fn = getattr(self, 'do_' + a['do'], None)
        if not fn:
            raise OracleError('unknown action %s' % a['do'])
        fn(a)


# --------------------------------------------------------------------------
# Snapshot
# --------------------------------------------------------------------------

def snapshot(e: Engine) -> dict:
    g = e.game
    units = {}
    for u in g.units:
        items = []
        for it in u.items:
            items.append({
                'nid': it.nid,
                'uses': it.data.get('uses'),
                'c_uses': it.data.get('c_uses'),
                'droppable': bool(it.droppable),
            })
        skills = [s.nid for s in u.skills]
        skill_data = {}
        for s in u.skills:
            d = {k: _jsonable(v) for k, v in s.data.items()}
            if d:
                skill_data[s.nid] = d
        units[u.nid] = {
            'team': u.team,
            'party': u.party,
            'position': _pos(u.position),
            'dead': bool(u.dead),
            'hp': u.get_hp(),
            'max_hp': u.get_max_hp(),
            'level': u.level,
            'exp': u.exp,
            'klass': u.klass,
            'stats': {k: int(v) for k, v in u.stats.items()},
            'growth_points': {k: int(v) for k, v in u.growth_points.items() if v},
            'wexp': {k: _jsonable(v) for k, v in u.wexp.items() if v},
            'items': items,
            'equipped_weapon': u.equipped_weapon.nid if u.equipped_weapon else None,
            'skills': skills,
            'skill_data': skill_data,
            'finished': bool(u.finished),
            'has_attacked': bool(u.has_attacked),
            'has_traded': bool(u.has_traded),
            'has_moved': bool(u.has_moved),
            'ai': u.ai,
            'ai_group': u.ai_group,
            'traveler': u.traveler,
        }
    regions = []
    for r in g.level.regions:
        regions.append({
            'nid': r.nid,
            'region_type': _jsonable(r.region_type),
            'position': _pos(r.position),
            'size': _jsonable(r.size),
            'sub_nid': r.sub_nid,
            'time_left': r.time_left,
            'only_once': bool(r.only_once),
        })
    party = g.get_party()
    events = [ev.nid for ev in g.events.all_events]
    sr = e.static_random.r
    return {
        'frame': e.frame,
        'level': g.level_nid,
        'turn': g.turncount,
        'phase': g.phase.get_current(),
        'state': e.top(),
        'stack': e.stack(),
        'money': party.money if party else None,
        'units': units,
        'game_vars': _jsonable(dict(g.game_vars)),
        'level_vars': _jsonable(dict(g.level_vars)),
        'regions': regions,
        'events': events,
        'already_triggered': sorted(g.already_triggered_events),
        'rng': {'combat': sr.combat_random.state, 'growth': sr.growth_random.state},
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def run_scenario(scn: dict) -> dict:
    out = {'engine': 'python', 'scenario': scn.get('name'), 'steps': [], 'error': None}
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # the engine prints chatter; keep stdout for JSON
    try:
        e = Engine(scn.get('project', 'default.ltproj'))
        e.boot(scn.get('settings'))
        e.start_level(str(scn['level']), scn.get('seed', 0), scn.get('events', True))
        e.apply_mode(scn.get('rng_mode', 'True Hit'), scn.get('growths', 'Fixed'))
        e.settle(skip=scn.get('skip', 'SELECT'), max_frames=scn.get('start_frames', 20000))
        r = Runner(e, scn)
        r.setup(scn.get('setup', []))
        out['steps'].append({'action': {'do': 'start'}, 'snapshot': snapshot(e)})
        for a in scn.get('actions', []):
            try:
                r.run_action(a)
            except Exception as exc:
                out['steps'].append({'action': a, 'error': '%s: %s' % (type(exc).__name__, exc),
                                     'snapshot': snapshot(e)})
                out['error'] = 'step %d (%s) failed' % (len(out['steps']) - 1, a.get('do'))
                traceback.print_exc()
                break
            out['steps'].append({'action': a, 'snapshot': snapshot(e)})
    except Exception as exc:
        traceback.print_exc()
        out['error'] = '%s: %s' % (type(exc).__name__, exc)
    finally:
        sys.stdout = real_stdout
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('scenario')
    ap.add_argument('-o', '--out')
    args = ap.parse_args(argv)
    scn = json.loads(Path(args.scenario).read_text(encoding='utf-8'))
    result = run_scenario(scn)
    text = json.dumps(result, indent=1, sort_keys=True)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding='utf-8')
    else:
        print(text)
    return 1 if result['error'] else 0


if __name__ == '__main__':
    sys.exit(main())
