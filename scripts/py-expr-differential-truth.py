"""Ground truth for the py-expr differential run.

Usage:
  python3 -I scripts/py-expr-differential-truth.py \\
      test-results/py-expr-differential.json \\
      test-results/py-expr-differential-states.json

For every expression whose result differed between the old regex
translator and the new evaluator, rebuild the game state the browser used
(units, items, skills, vars, records, DB) as minimal Python objects that
mirror the LT engine's classes (SkillObject/ItemObject/prefab __getattr__ ->
None, UnitObject AttributeError, Counter vars, Data catalogs), eval() the
expression with CPython and report which evaluator agrees with Python.
"""
import json
import math
import sys
from collections import Counter

PLAYER_ALLIES = {'player', 'other'}


class Component:
    def __init__(self, nid, value):
        self.nid = nid
        self.value = value


class Data:
    """app.utilities.data.Data: a list first, a dict second (no __contains__)."""

    def __init__(self, values):
        self._list = list(values)

    def values(self):
        return list(self._list)

    def keys(self):
        return [v.nid for v in self._list]

    def items(self):
        return [(v.nid, v) for v in self._list]

    def get(self, key, fallback=None):
        for v in self._list:
            if v.nid == key:
                return v
        return fallback

    def __len__(self):
        return len(self._list)

    def __getitem__(self, idx):
        return self._list[idx]

    def __iter__(self):
        return iter(self._list)


def components_of(entries):
    return Data(Component(nid, value) for nid, value in entries)


class Prefab:
    def __init__(self, raw):
        self.nid = raw['nid']
        self.name = raw.get('name')
        self.components = components_of(raw.get('components') or [])
        for comp in self.components:
            self.__dict__[comp.nid] = comp

    def __getattr__(self, attr):
        if attr.startswith('__') and attr.endswith('__'):
            raise AttributeError(attr)
        return None


class Skill(Prefab):
    def __init__(self, raw):
        super().__init__(raw)
        self.uid = raw.get('uid')
        self.owner_nid = raw.get('owner_nid')
        self.data = raw.get('data') or {}
        self.parent_skill = None


class Item(Prefab):
    def __init__(self, raw, registry):
        super().__init__(raw)
        self.uid = raw.get('uid')
        self.owner_nid = raw.get('owner_nid')
        self.data = raw.get('data') or {}
        self._parent_uid = raw.get('parent_uid')
        self._registry = registry
        tags = self.components.get('item_tags')
        self.tags = list(tags.value) if tags and tags.value else []

    @property
    def parent_item(self):
        return self._registry.get(self._parent_uid) if self._parent_uid is not None else None


class Unit:
    def __init__(self, raw, registry):
        for key in ('nid', 'name', 'team', 'klass', 'party', 'generic', '_finished', 'dead',
                    'is_dying', 'level', 'persistent', 'tags', '_tags', 'stats', 'wexp', 'growths'):
            self.__dict__[key] = raw.get(key)
        self.position = tuple(raw['position']) if raw.get('position') else None
        self._hp = raw.get('hp')
        self._max_hp = raw.get('max_hp')
        self._stat_values = raw.get('stat_values') or {}
        self._fields = raw.get('fields') or {}
        self.skills = [Skill(s) for s in raw.get('skills') or []]
        self.items = [Item(i, registry) for i in raw.get('items') or []]
        for item in self.items:
            registry[item.uid] = item
        self._weapon_uid = raw.get('weapon_uid')
        self._registry = registry
        for key in ('traveler', 'affinity', 'ai', 'faction', 'ai_group'):
            self.__dict__[key] = raw.get(key)
        self.previous_position = tuple(raw['previous_position']) if raw.get('previous_position') else None
        self._mana = raw.get('mana') or 0
        self._accessory_uids = raw.get('accessory_uids') or []

    @property
    def accessories(self):
        return [self._registry[uid] for uid in self._accessory_uids if uid in self._registry]

    def get_mana(self):
        return self._mana

    def get_hp(self):
        return self._hp

    def get_max_hp(self):
        return self._max_hp

    def get_stat(self, nid):
        return self._stat_values.get(nid, 0)

    def get_field(self, key, default=None):
        return self._fields.get(key, default)

    def get_skill(self, nid):
        for skill in reversed(self.skills):
            if skill.nid == nid or skill.uid == nid:
                return skill
        return None

    def get_weapon(self):
        return self._registry.get(self._weapon_uid) if self._weapon_uid is not None else None

    def __getattr__(self, attr):
        if attr.startswith('__') and attr.endswith('__'):
            raise AttributeError(attr)
        raise AttributeError('UnitObject has no attribute %s' % attr)


class Region:
    def __init__(self, raw):
        self.__dict__.update(raw)
        self.position = tuple(raw['position']) if raw.get('position') else None

    def contains(self, pos):
        if not pos or not self.position:
            return False
        w, h = self.size or (1, 1)
        return self.position[0] <= pos[0] < self.position[0] + w and self.position[1] <= pos[1] < self.position[1] + h


class Level:
    def __init__(self, raw):
        self.nid = raw.get('nid')
        self.name = raw.get('name')
        self.regions = Data(Region(r) for r in raw.get('regions') or [])


class TargetSystem:
    @staticmethod
    def get_adjacent_positions(pos):
        x, y = pos
        return [(x, y - 1), (x - 1, y), (x + 1, y), (x, y + 1)]


class PathSystem:
    """Mirrors the web port's get_valid_moves stub (same inputs for both)."""

    @staticmethod
    def get_valid_moves(unit, force=False):
        if not unit.position:
            return set()
        x, y = unit.position
        return {(x, y), (x, y - 1), (x - 1, y), (x + 1, y), (x, y + 1)}


class Game:
    def __init__(self, state):
        self.item_registry = {}
        self._units = {u['nid']: Unit(u, self.item_registry) for u in state['units']}
        self.turncount = state.get('turncount')
        self.game_vars = Counter(state.get('game_vars') or {})
        self.level_vars = Counter(state.get('level_vars') or {})
        self.level = Level(state.get('level') or {})
        self.target_system = TargetSystem()
        self.path_system = PathSystem()
        self.current_party = state.get('current_party')
        self._party_orders = state.get('party_orders') or {}
        self._money = state.get('money') or 0
        self.phase = Namespace(get_current=lambda: state.get('phase'))
        self._alliances = state.get('alliances') or {}

    def allied(self, a, b):
        return self._alliances.get('%s|%s' % (a, b), a == b)

    def get_money(self):
        return self._money

    def get_team_units(self, team):
        return [u for u in self._field() if u.team == team]

    def get_all_units_in_party(self, party=None):
        party = party or self.current_party
        return [u for u in self.units if u.team == 'player' and u.persistent and u.party == party]

    def get_units_in_party(self, party=None):
        party = party or self.current_party
        order = self._party_orders.get(party, [])
        units = [u for u in self.get_all_units_in_party(party) if not u.dead]
        return sorted(units, key=lambda u: order.index(u.nid) if u.nid in order else 999999)

    @property
    def units(self):
        return list(self._units.values())

    def get_unit(self, nid):
        return self._units.get(nid)

    def get_item(self, uid):
        return self.item_registry.get(uid)

    def _field(self):
        return [u for u in self.units if u.position and not u.dead and not u.is_dying and 'Tile' not in u.tags]

    def get_all_units(self):
        return self._field()

    def get_player_units(self):
        return [u for u in self._field() if u.team == 'player']

    def get_other_units(self):
        return [u for u in self._field() if u.team == 'other']

    def get_enemy_units(self):
        return [u for u in self._field() if not self.allied('player', u.team)]

    def check_dead(self, nid):
        u = self.get_unit(nid)
        return bool(u and (u.dead or u.is_dying))

    def check_alive(self, nid):
        u = self.get_unit(nid)
        return bool(u and not (u.dead or u.is_dying))


class Records:
    def __init__(self, records):
        self._records = records

    def get(self, nid, fallback=None):
        return self._records.get(nid, fallback)


class Namespace:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def make_context(state):
    game = Game(state)
    db = Namespace(
        skills=Data(Prefab(s) for s in state['db']['skills']),
        items=Data(Prefab(i) for i in state['db']['items']),
        units=Data(Namespace(nid=u['nid'], name=u['name']) for u in state['db']['units']),
        stats=Data(Namespace(nid=n) for n in state['db']['stats']),
    )
    ctx = state['context']
    unit = game.get_unit(ctx['unit1']) if ctx.get('unit1') else None
    unit2 = game.get_unit(ctx['unit2']) if ctx.get('unit2') else None
    item = game.get_item(ctx['item_uid']) if ctx.get('item_uid') is not None else None
    item2 = game.get_item(ctx['item2_uid']) if ctx.get('item2_uid') is not None else None
    skill = None
    if ctx.get('skill_uid') is not None and unit:
        skill = next((s for s in unit.skills if s.uid == ctx['skill_uid']), None)
    region = game.level.regions.get(ctx['region']) if ctx.get('region') else None

    def resolve_unit(u):
        if isinstance(u, str):
            return game.get_unit(u)
        return u

    def has_skill(u, nid):
        u = resolve_unit(u)
        return bool(u and any(s.nid == (nid.nid if hasattr(nid, 'nid') else nid) for s in u.skills))

    def get_skill(u, nid):
        u = resolve_unit(u)
        return u.get_skill(nid) if u else None

    def v(name, fallback=None):
        var = game.level_vars.get(name, None)
        if var is None:
            var = game.game_vars.get(name, fallback)
        return var

    def is_dead(u):
        u = resolve_unit(u)
        return bool(u and u.dead)

    def resolve_pos(p):
        if isinstance(p, Unit):
            return p.position
        if isinstance(p, str):
            target = game.get_unit(p)
            return target.position if target else None
        return p

    def get_units_within_distance(position, dist=1, nid=None, team=None, tag=None, party=None):
        position = resolve_pos(position)
        res = []
        for unit in game.get_all_units():
            if tag and tag not in unit.tags:
                continue
            if nid and unit.nid != nid:
                continue
            if team and unit.team != team:
                continue
            if party and unit.party != party:
                continue
            if position and abs(unit.position[0] - position[0]) + abs(unit.position[1] - position[1]) <= dist:
                res.append(unit)
        return res

    def get_allies_within_distance(position, dist=1):
        return get_units_within_distance(position, dist, team='player')

    def get_charge(u, nid):
        u = resolve_unit(u)
        if u:
            for sk in reversed(u.skills):
                if sk.nid == nid and sk.data.get('charge'):
                    return sk.data.get('charge')
        return 0

    def get_stacks(u, nid):
        u = resolve_unit(u)
        return len([s for s in u.skills if s.nid == nid]) if u else 0

    def all_components(u, i):
        # item_system.get_all_components: skill item_overrides (none in these
        # states) plus the item's own components; no item -> overrides only.
        return list(i.components) if i else []

    def component_value(u, i, nid):
        comp = next((c for c in all_components(u, i) if c.nid == nid), None)
        return comp.value if comp else None

    item_system = Namespace(
        weapon_type=lambda u, i: component_value(u, i, 'weapon_type'),
        weapon_rank=lambda u, i: component_value(u, i, 'weapon_rank'),
        get_all_components=all_components,
        is_spell=lambda u, i: any(c.nid == 'spell' for c in all_components(u, i)),
        is_weapon=lambda u, i: any(c.nid == 'weapon' for c in all_components(u, i)),
    )

    def compute_advantage(unit1, unit2, item1, item2, advantage=True):
        # combat_calcs.compute_advantage: no item or weapon type -> None. The
        # states here never pair two typed weapons with a triangle entry.
        if not item1 or not item2:
            return None
        if not item_system.weapon_type(unit1, item1) or not item_system.weapon_type(unit2, item2):
            return None
        return None

    def get_item(u, nid):
        u = resolve_unit(u)
        if not u:
            return None
        return next((i for i in u.items if i.nid == nid or i.uid == nid), None)

    def skill_condition(skill, unit, item=None):
        # skill_system.condition -> Condition component: bool(evaluate(value,
        # unit, position=unit.position, local_args={'item', 'skill'})).
        if not item:
            item = unit.get_weapon()
        comp = skill.components.get('condition')
        if not comp:
            return True
        scope = dict(namespace)
        scope.update({'unit': unit, 'unit1': unit, 'unit2': None, 'target': None,
                      'position': unit.position, 'item': item, 'skill': skill})
        try:
            return bool(eval(comp.value.strip(), scope))
        except Exception:
            return None

    namespace = {
        'game': game, 'unit': unit, 'unit1': unit, 'unit2': unit2, 'target': unit2,
        'item': item, 'item2': item2, 'skill': skill, 'region': region,
        'position': tuple(ctx['position']) if ctx.get('position') else None,
        'target_pos': tuple(ctx['target_pos']) if ctx.get('target_pos') else None,
        'mode': ctx.get('mode'), 'DB': db, 'RECORDS': Records(state.get('records') or {}),
        'u': lambda nid: game.get_unit(nid), 'v': v, 'has_skill': has_skill, 'get_skill': get_skill,
        'is_dead': is_dead, 'item_system': item_system, 'target_system': game.target_system,
        'get_item': get_item, 'combat_calcs': Namespace(compute_advantage=compute_advantage),
        'get_units_within_distance': get_units_within_distance,
        'get_allies_within_distance': get_allies_within_distance,
        'get_charge': get_charge, 'get_stacks': get_stacks,
        'skill_system': Namespace(
            condition=skill_condition,
            check_ally=lambda a, b: bool(a and b and game.allied(a.team, b.team)),
            check_enemy=lambda a, b: not (a and b and game.allied(a.team, b.team))),
        'utils': Namespace(calculate_distance=lambda a, b: abs(a[0] - b[0]) + abs(a[1] - b[1]),
                           clamp=lambda x, lo, hi: max(lo, min(hi, x))),
        'math': math,
    }
    return namespace


def describe(value, depth=0):
    """Same rendering as describe() in tests/py-expr-differential.spec.ts."""
    if depth > 4:
        return '...'
    if value is None:
        return 'None'
    if value is True:
        return 'True'
    if value is False:
        return 'False'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return 'nan'
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if callable(value):
        return 'fn'
    if isinstance(value, range):
        value = list(value)
    if isinstance(value, (list, tuple)):
        return '[' + ', '.join(describe(v, depth + 1) for v in value) + ']'
    if isinstance(value, set):
        return 'set(' + ', '.join(sorted(describe(v, depth + 1) for v in value)) + ')'
    if isinstance(value, dict):
        return 'dict(' + ', '.join(sorted('%s: %s' % (describe(k, depth + 1), describe(v, depth + 1)) for k, v in value.items())) + ')'
    uid = getattr(value, 'uid', None) if not isinstance(value, Unit) else None
    nid = value.__dict__.get('nid') if hasattr(value, '__dict__') else None
    if uid is not None or nid is not None:
        return '<%s:%s>' % ('' if uid is None else uid, '' if nid is None else nid)
    return type(value).__name__


def equation_truth(rows_path, states_path):
    """Replay app.engine.equations.Parser for every (equation, unit) row."""
    import re
    rows = json.load(open(rows_path))
    state = json.load(open(states_path))['hub']
    game = Game(state)
    stat_nids = state['db']['stats']
    expressions = {r['nid']: r['expression'] for r in rows}
    replacement = {nid: "(unit.stats['%s'] + unit.stat_bonus('%s'))" % (nid, nid) for nid in stat_nids}
    for nid in expressions:
        replacement[nid] = "equations['%s'](equations, unit)" % nid
    equations = {}
    for nid, expression in expressions.items():
        rhs = ''.join(replacement.get(t, t) for t in re.split('([^a-zA-Z_])', expression))
        exec('def %s(equations, unit): return int(%s)' % (nid, rhs), equations)

    class EquationUnit:
        # unit.stats + unit.stat_bonus: the snapshot holds their sum.
        def __init__(self, unit):
            self._unit = unit
            self.stats = dict(unit._stat_values)

        def stat_bonus(self, nid):
            return 0

        def __getattr__(self, attr):
            return getattr(self._unit, attr)

    out = []
    for row in rows:
        unit = EquationUnit(game.get_unit(row['unit']))
        try:
            python = equations[row['nid']](equations, unit)
        except Exception as exc:  # noqa: BLE001
            python = 'FAIL %s' % type(exc).__name__
        out.append(dict(row, python=python,
                        agrees='new' if python == row['new'] else ('old' if python == row['old'] else 'neither')))
    return out


def main():
    if sys.argv[1] == '--equations':
        json.dump(equation_truth(sys.argv[2], sys.argv[3]), sys.stdout, indent=1)
        sys.stdout.write('\n')
        return
    differential = json.load(open(sys.argv[1]))
    states = json.load(open(sys.argv[2]))
    contexts = {name: make_context(state) for name, state in states.items()}
    rows = []
    for diff in differential['differences']:
        ctx = dict(contexts[diff['state']])
        try:
            value = eval(diff['expr'].strip(), ctx)
            python = describe(bool(value)) if diff['mode'] == 'condition' else describe(value)
            error = None
        except Exception as exc:  # noqa: BLE001
            python = 'False' if diff['mode'] == 'condition' else 'FAIL'
            error = '%s: %s' % (type(exc).__name__, exc)
        rows.append({
            'state': diff['state'], 'mode': diff['mode'], 'expr': diff['expr'],
            'old': diff['old'], 'new': diff['new'], 'python': python, 'python_error': error,
            'agrees': 'new' if python == diff['new'] else ('old' if python == diff['old'] else 'neither'),
        })
    json.dump(rows, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
