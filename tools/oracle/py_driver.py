"""Differential-testing oracle: drive a real Python Lex Talionis engine headless.

Two backends, both imported in place (never copied into this repo):

* ``upstream`` (default): rainlash/lt-maker from ``lt-maker/`` under the oracle
  venv (pygame-ce 2.3.2, Python 3.12).
* ``fork``: a project's own engine fork (EOtF ships one), from the directory in
  ``LT_FORK_ENGINE``, run under the fork's interpreter (``LT_FORK_PYTHON``).

A scenario JSON (see README.md) is replayed through the engine's own states,
menus and actions, and a canonical snapshot is dumped after every step.

    <python> tools/oracle/py_driver.py SCENARIO.json [--backend fork] [-o out.json]
"""
from __future__ import annotations

import argparse
import builtins
import inspect
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
    'trade', 'option_menu', 'option_child', 'free_roam', 'prep_main',
}


class OracleError(Exception):
    pass


def oracle_config() -> dict:
    """Machine-local settings (fork paths) kept outside the repo in
    $LT_ORACLE_HOME/config.json; environment variables win."""
    cfg = {}
    path = ORACLE_HOME / 'config.json'
    if path.exists():
        cfg = json.loads(path.read_text(encoding='utf-8'))
    for key, env in (('fork_engine', 'LT_FORK_ENGINE'), ('fork_python', 'LT_FORK_PYTHON')):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg


# --------------------------------------------------------------------------
# Bootstrap
# --------------------------------------------------------------------------

def _junction(link: Path, target: Path) -> None:
    if not os.path.lexists(link):
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)],
                       check=True, capture_output=True)


def _acquire_run_dir(base: str) -> Path:
    """One run dir per concurrent driver process (slot + lock file), so
    parallel runs never share saves/. A lock left by a crash is reclaimed
    after an hour."""
    import atexit
    import time
    for n in range(16):
        run_dir = ORACLE_HOME / ('%s-%d' % (base, n))
        run_dir.mkdir(parents=True, exist_ok=True)
        lock = run_dir / '.lock'
        if lock.exists() and time.time() - lock.stat().st_mtime > 3600:
            lock.unlink()
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        atexit.register(lambda: lock.exists() and lock.unlink())
        return run_dir
    raise OracleError('no free oracle run dir under %s' % ORACLE_HOME)


def _prepare_run_dir(run_dir: Path, engine_dir: Path, linked=None, copied=None) -> None:
    """The engine reads sprites/, resources/ ... and writes saves/ relative to
    cwd. Run it from a scratch dir on E: whose read-only entries are junctions
    into the engine tree, so nothing is ever written there. saves/ starts
    empty every run: persistent records (RECORDS) and configs live there and
    would otherwise leak from one scenario into the next."""
    saves = run_dir / 'saves'
    saves.mkdir(parents=True, exist_ok=True)
    for f in saves.iterdir():
        if f.is_file():
            f.unlink()
    if linked is None:  # everything except saves and bundled projects
        linked = [n for n in os.listdir(engine_dir)
                  if (engine_dir / n).is_dir() and n != 'saves' and not n.endswith('.ltproj')]
        copied = [n for n in os.listdir(engine_dir) if (engine_dir / n).is_file()]
    for name in linked:
        _junction(run_dir / name, engine_dir / name)
    for name in copied or []:
        dst = run_dir / name
        if not dst.exists() and (engine_dir / name).exists():
            shutil.copyfile(engine_dir / name, dst)


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


def bootstrap(backend: str) -> None:
    os.environ.setdefault('SDL_VIDEODRIVER', 'dummy')
    os.environ.setdefault('SDL_AUDIODRIVER', 'dummy')
    os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')
    sys.pycache_prefix = str(ORACLE_HOME / ('pycache-' + backend))
    if backend == 'upstream':
        run_dir = _acquire_run_dir('run-upstream')
        _prepare_run_dir(run_dir, LT_MAKER, _LINKED, _COPIED)
        os.chdir(run_dir)
        sys.path.insert(0, str(LT_MAKER))
        _codegen_overlay()
    elif backend == 'fork':
        engine_dir = oracle_config().get('fork_engine')
        if not engine_dir:
            raise OracleError('fork backend needs LT_FORK_ENGINE (or fork_engine in '
                              '$LT_ORACLE_HOME/config.json) pointing at the fork engine dir')
        # The fork ships its generated item/skill systems; never regenerate.
        run_dir = _acquire_run_dir('run-fork')
        _prepare_run_dir(run_dir, Path(engine_dir).resolve())
        os.chdir(run_dir)
        sys.path.insert(0, str(run_dir))
    else:
        raise OracleError('unknown backend %s' % backend)


def _call_load(fn, path: str) -> None:
    """Upstream load()s take a serialization version; the fork's predate it."""
    params = list(inspect.signature(fn).parameters)
    if len(params) >= 2 and params[1] != 'specific':
        from app.data.serialization.versions import CURRENT_SERIALIZATION_VERSION
        fn(path, CURRENT_SERIALIZATION_VERSION)
    else:
        fn(path)


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
    def __init__(self, project: str, backend: str = 'upstream'):
        self.project = project
        self.backend = backend
        self.frame = 0
        self.game = None
        self.log = []

    # -- boot --------------------------------------------------------------
    def boot(self, settings: dict | None = None) -> None:
        bootstrap(self.backend)
        import logging
        logging.basicConfig(level=logging.ERROR, stream=sys.stderr)
        from app.engine import engine
        self.engine = engine
        self._patch_clock(engine)
        from app.data.resources.resources import RESOURCES
        from app.data.database.database import DB
        from app.engine import config as cf
        self.DB = DB
        self.cf = cf
        # Both backends load the same project data the web port serves
        # (lt-maker/<project>) unless LT_ORACLE_PROJECT_DIR overrides it.
        proj = os.environ.get('LT_ORACLE_PROJECT_DIR') or str(LT_MAKER / self.project)
        if not os.path.exists(os.path.join(proj, 'metadata.json')):
            raise OracleError('project not found: %s' % proj)
        self.shims = []
        if self.backend == 'upstream':
            proj = self._shim_resources(proj)
        self.project_dir = proj
        _call_load(RESOURCES.load, proj)
        _call_load(DB.load, proj)
        # debug=0 like a shipped build: event conditions read
        # cf.SETTINGS['debug'] (default.ltproj's "Global Debug Setup") and the
        # web has no debug mode. Engine exceptions still propagate because
        # the driver calls game.state.update() itself, outside driver.run().
        base = {
            'debug': 0, 'animation': 'Never', 'music_volume': 0, 'sound_volume': 0,
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

    def _shim_resources(self, proj: str) -> str:
        """Upstream refuses to load a project missing any resource folder or
        data catalog it knows (fork projects such as EOtF lack
        resources/fonts, which their engine bundles, and game_data/credit).
        Build a shim project on E: (junctions, plus copies of the small
        game_data files) that borrows the missing pieces from default.ltproj,
        and record what was borrowed."""
        from app.data.resources.resources import Resources
        from app.data.database.database import Database
        src = Path(proj)
        default = LT_MAKER / 'default.ltproj'

        def present(d: Path, key: str) -> bool:
            return (d / key).exists() or (d / (key + '.json')).exists()
        miss_res = [k for k in Resources.save_data_types if not (src / 'resources' / k).exists()]
        miss_data = [k for k in Database.save_data_types if not present(src / 'game_data', k)]
        if not miss_res and not miss_data:
            return proj
        shim = ORACLE_HOME / 'shim' / src.name
        (shim / 'resources').mkdir(parents=True, exist_ok=True)
        (shim / 'game_data').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / 'metadata.json', shim / 'metadata.json')
        for entry in os.listdir(src / 'resources'):
            _junction(shim / 'resources' / entry, src / 'resources' / entry)
        for k in miss_res:
            _junction(shim / 'resources' / k, default / 'resources' / k)

        def mirror(s: Path, d: Path) -> None:
            if s.is_dir():
                _junction(d, s)
            elif not d.exists() or d.stat().st_size != s.stat().st_size or d.stat().st_mtime < s.stat().st_mtime:
                shutil.copy2(s, d)
        for entry in os.listdir(src / 'game_data'):
            mirror(src / 'game_data' / entry, shim / 'game_data' / entry)
        for k in miss_data:
            for name in (k, k + '.json', k + '.category.json'):
                if (default / 'game_data' / name).exists():
                    mirror(default / 'game_data' / name, shim / 'game_data' / name)
        self.shims = (['resources/%s from default.ltproj' % k for k in miss_res] +
                      ['game_data/%s from default.ltproj' % k for k in miss_data])
        return str(shim)

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
    def run_startup(self) -> None:
        """Boot to the title like the real game, which fires on_startup there
        (EOtF creates its persistent records in that event), and wait until
        the title screen idles. New Game then rebuilds the game state."""
        from app.engine import game_state
        from app.utilities import static_random
        self.static_random = static_random
        self.game = game_state.start_game()
        self.settle(until=lambda en: en.top() == 'title_start', max_frames=6000)

    def start_level(self, level_nid: str, seed: int, events: bool,
                    rng_mode: str | None = None, growths: str | None = None,
                    game_vars: dict | None = None, run_state: dict | None = None) -> None:
        from app.engine import game_state
        from app.utilities import static_random
        self.cf.SETTINGS['random_seed'] = int(seed)
        # game_state.start_level(), with the difficulty overrides applied
        # between build_new() and the level build so generic autolevels
        # already use the scenario's growth method.
        if not game_state.game:
            game_state.game = game_state.GameState()
        else:
            game_state.game.clear()
        self.game = game_state.game
        self.game.load_states(['start_level_asset_loading'])
        self.game.build_new()
        self.apply_mode(rng_mode, growths)
        if run_state:
            self.apply_run_state(run_state)
        # Run state a real playthrough would have set before this level.
        for k, v in (game_vars or {}).items():
            self.game.game_vars[k] = v
        self.game.start_level(level_nid)
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

    def apply_run_state(self, state: dict) -> None:
        """Load a captured run state (capture_run_state.py) into the fresh
        game, the way GameState.load restores units, items and skills, so
        the next level starts as it would mid-run. Units start off the map
        and lose terrain statuses, as after a real level end."""
        from app.engine import save
        from app.engine.objects.item import ItemObject
        from app.engine.objects.skill import SkillObject
        from app.engine.objects.unit import UnitObject
        from app.engine.source_type import SourceType
        from app.engine.persistent_records import RECORDS
        g = self.game
        for k, v in state.get('game_vars', {}).items():
            if k != '_random_seed':
                g.game_vars[k] = v
        for nid, value in state.get('records', {}).items():
            if nid in RECORDS.keys():
                RECORDS.update(nid, value)
            else:
                RECORDS.create(nid, value)
        for d in state.get('items', []):
            g.item_registry[d['uid']] = ItemObject.restore(d)
        for d in state.get('skills', []):
            g.skill_registry[d['uid']] = SkillObject.restore(d)
        for item in list(g.item_registry.values()):
            for sub_uid in item.subitem_uids:
                sub = g.item_registry.get(sub_uid)
                if sub:
                    item.subitems.append(sub)
                    for component in sub.components:
                        component.item = item
                    sub.parent_item = item
        for skill in list(g.skill_registry.values()):
            if skill.subskill_uid is not None and skill.subskill_uid in g.skill_registry:
                skill.subskill = g.skill_registry[skill.subskill_uid]
                skill.subskill.parent_skill = skill
        save.set_next_uids(g)
        source_types = {t.nid: t for t in SourceType}
        for d in state.get('units', []):
            d = dict(d)
            d['position'] = None
            d['skills'] = [(uid, tuple(src) if isinstance(src, list) else src, source_types[stype])
                           for uid, src, stype in d['skills'] if stype != 'terrain']
            unit = UnitObject.restore(d, g)
            g.unit_registry[unit.nid] = unit
        for p in state.get('parties', []):
            party = g.get_party(p['nid'])
            if party:
                party.money = p['money']
                party.convoy = [g.item_registry[uid] for uid in p['convoy'] if uid in g.item_registry]
                if hasattr(party, 'bexp'):
                    party.bexp = p.get('bexp', 0)
        if state.get('current_party'):
            g.current_party = state['current_party']
        if hasattr(g, 'level_cap_modifier'):
            g.level_cap_modifier = int(state.get('level_cap_modifier') or 0)
        g.already_triggered_events = list(state.get('already_triggered', []))

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
        # Asset-loading states poll worker threads against the (frame) clock;
        # join them so the outcome never depends on wall-clock speed.
        for t in getattr(self.game.state.current_state(), 'loading_threads', None) or []:
            t.join()
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
        """True while the state machine has queued changes or units are
        moving. Queued events are not checked: a running event is always the
        top state, and the fork leaves dormant entries in event_stack."""
        g = self.game
        if g.state.temp_state:
            return True
        # Free roam keeps a standing movement component for the roam unit.
        if g.movement is not None and len(g.movement) > 0 and self.top() != 'free_roam':
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
        g = self.game
        raise OracleError('settle timed out; stack=%s temp_state=%s moving=%s' % (
            self.stack(), g.state.temp_state, len(g.movement) if g.movement is not None else 0))

    # -- UI primitives -----------------------------------------------------
    def cursor(self, pos) -> None:
        g = self.game
        pos = tuple(pos)
        g.cursor.set_pos(pos)
        cur = g.cursor
        if self.top() == 'move' and cur.cur_unit:
            # Python updates the movement arrow path while the cursor walks;
            # a teleport has to rebuild it as a mouse click would.
            in_move = getattr(g.highlight, 'check_in_all_move', None) or g.highlight.check_in_move  # fork: older API
            if in_move(pos):
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
        if e.top() == 'move':
            raise OracleError('%s cannot move to %s' % (a['unit'], a['to']))

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

    def do_attack_or_wait(self, a) -> None:
        """A simple scripted player move: ``unit`` (default Player) attacks
        with its first weapon the nearest valid target (Manhattan distance,
        then x, then y) if its menu offers Attack, else waits in place."""
        e = self.e
        nid = a.get('unit', 'Player')
        u = e.game.get_unit(nid)
        if not u or not u.position or u.finished or u.team != 'player':
            return
        self.in_menu_for(nid)
        _, values = e.menu_values()
        if 'Attack' in [str(v) for v in values]:
            e.choose('Attack')
            e.settle()
            if e.top() == 'weapon_choice':
                e.press('SELECT')
                e.settle()
            e.expect('combat_targeting')
            st = e.game.state.current_state()
            ux, uy = u.position
            pos = min(st.selection.pos_list, key=lambda p: (abs(p[0] - ux) + abs(p[1] - uy), p[0], p[1]))
            self._target_and_fire(list(pos))
        else:
            e.choose('Wait')
            e.settle()

    def do_choose(self, a) -> None:
        """Pick a named option in whatever menu the top state shows."""
        self.e.choose(a['option'])
        self.e.settle(skip=a.get('skip', 'SELECT'), max_frames=a.get('max_frames', 6000))

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

def _current_music():
    """The song on top of the sound thread's stack (the dummy mixer never
    reports playback, so get_current_song() would always be None)."""
    from app.engine.sound import get_sound_thread
    stack = getattr(get_sound_thread(), 'song_stack', None)
    return stack[-1].nid if stack else None


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
            'growth_points': {k: _jsonable(v) for k, v in u.growth_points.items() if v},
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
            'generic': bool(u.generic),
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
    # Processing order: the event stack runs its last entry first.
    events = [ev.nid for ev in reversed(g.events.all_events)]
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
        'objective': _jsonable(dict(g.level.objective)) if g.level else None,
        'music': _current_music(),
        'events': events,
        'already_triggered': sorted(g.already_triggered_events),
        'rng': {'combat': sr.combat_random.state, 'growth': sr.growth_random.state,
                'other': sr.other_random.state},
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

# Projects whose players run a forked engine rather than upstream lt-maker.
FORK_PROJECTS = {'eotf.ltproj'}


def pick_backend(scn: dict, override: str | None = None) -> str:
    """CLI override, else the scenario's "engine", else fork for fork projects."""
    if override:
        return override
    if scn.get('engine'):
        return scn['engine']
    return 'fork' if scn.get('project', 'default.ltproj') in FORK_PROJECTS else 'upstream'


def load_run_state(scn: dict, base: Path | None = None):
    """A scenario's run state: inline, or a path (absolute, or relative to
    the scenario file / $LT_ORACLE_HOME)."""
    rs = scn.get('run_state')
    if rs is None or isinstance(rs, dict):
        return rs
    for cand in (Path(rs), (base or Path('.')) / rs, ORACLE_HOME / rs):
        if cand.exists():
            return json.loads(cand.read_text(encoding='utf-8'))
    raise OracleError('run state not found: %s' % rs)


def run_scenario(scn: dict, backend: str = 'upstream', base: Path | None = None) -> dict:
    """One level (``level``) with setup and actions, or a level sweep
    (``levels``): every listed level started from the same run state and
    settled, one snapshot each, failures recorded per level."""
    out = {'engine': 'python', 'backend': backend, 'scenario': scn.get('name'),
           'steps': [], 'error': None}
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # the engine prints chatter; keep stdout for JSON
    try:
        e = Engine(scn.get('project', 'default.ltproj'), backend)
        e.boot(scn.get('settings'))
        if e.shims:
            out['shims'] = e.shims
        if scn.get('startup_events', True):
            e.run_startup()
        run_state = load_run_state(scn, base)
        from app.engine.persistent_records import RECORDS
        baseline_records = RECORDS.save()
        sweep = scn.get('levels')
        for level in (sweep or [scn['level']]):
            step = {'action': {'do': 'level', 'level': str(level)} if sweep else {'do': 'start'}}
            try:
                RECORDS.restore(baseline_records)
                e.start_level(str(level), scn.get('seed', 0), scn.get('events', True),
                              scn.get('rng_mode', 'True Hit'), scn.get('growths', 'Fixed'),
                              scn.get('start_game_vars'), run_state)
                e.settle(skip=scn.get('skip', 'SELECT'), max_frames=scn.get('start_frames', 20000))
                if scn.get('through_prep') and e.top() == 'prep_main':
                    # Leave preparations like a player: the first player
                    # phase (turn 1 events) only starts after Fight.
                    e.choose('Fight')
                    # prep_main fades out for 300 ms before it leaves.
                    e.settle(until=lambda en: en.top() != 'prep_main', max_frames=600)
                    e.settle(skip=scn.get('skip', 'SELECT'), max_frames=scn.get('start_frames', 20000))
                Runner(e, scn).setup(scn.get('setup', []))
            except Exception as exc:
                traceback.print_exc()
                step['error'] = '%s: %s' % (type(exc).__name__, exc)
                if not sweep:
                    raise
            try:
                step['snapshot'] = snapshot(e)
            except Exception as exc:
                step.setdefault('error', 'snapshot failed: %s' % exc)
            out['steps'].append(step)
            # Sweep: the same actions on every level that settled into a
            # turn-based phase (free roam levels have no turns to end).
            if sweep and not step.get('error') and e.top() != 'free_roam':
                r = Runner(e, scn)
                for a in scn.get('level_actions', []):
                    act = {'action': dict(a, level=str(level))}
                    try:
                        r.run_action(a)
                    except Exception as exc:
                        traceback.print_exc()
                        act['error'] = '%s: %s' % (type(exc).__name__, exc)
                    try:
                        act['snapshot'] = snapshot(e)
                    except Exception as exc:
                        act.setdefault('error', 'snapshot failed: %s' % exc)
                    out['steps'].append(act)
                    if act.get('error'):
                        break
        if sweep:
            failed = [s['action']['level'] for s in out['steps'] if s.get('error')]
            if failed:
                out['level_errors'] = failed
            return out
        r = Runner(e, scn)
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
    ap.add_argument('--backend', choices=['upstream', 'fork'])
    args = ap.parse_args(argv)
    scn = json.loads(Path(args.scenario).read_text(encoding='utf-8'))
    result = run_scenario(scn, pick_backend(scn, args.backend), Path(args.scenario).resolve().parent)
    text = json.dumps(result, indent=1, sort_keys=True)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding='utf-8')
    else:
        print(text)
    return 1 if result['error'] else 0


if __name__ == '__main__':
    sys.exit(main())
