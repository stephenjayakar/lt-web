"""Capture an EOtF run state from a real run start in a Python engine.

Boots the project, runs on_startup like the title screen, starts the hub
(level X) with its events, departs through the hub keeper's run-start event
(picking the first units offered until the sortie is full, then confirming),
and lets the real level end carry the run into the next level. Once that
level settles, the persistent game state (game vars, records, parties and
convoys, persistent units with their items and skills) is written as an
oracle run state (README "Run states"), which level sweeps feed to both
engines.

    <python> tools/oracle/capture_run_state.py -o RUN_STATE.json [--backend fork] [--seed 0]
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import py_driver  # noqa: E402
from py_driver import Engine, OracleError, _jsonable  # noqa: E402

# Choice menus the run start shows, and the option a capture picks.
SKIP_SORTIE_OPTIONS = ('Filter', 'Search', 'BonusUnit')


def _pick(choice_nid: str, data: list) -> int:
    values = [str(getattr(d, 'nid', d)) for d in data]
    if choice_nid == 'New_Party':
        for i, v in enumerate(values):
            if v.split('|')[0] not in SKIP_SORTIE_OPTIONS:
                return i
    if choice_nid == 'deploy' and 'Yes' in values:
        return values.index('Yes')
    if choice_nid == 'Run_Start' and 'Depart' in values:
        return values.index('Depart')
    return 0


def depart(e: Engine, start_event: str, max_rounds: int = 400) -> list:
    """Run the hub's run-start event, answering its menus, until a level
    other than the hub settles. Returns the choices made."""
    g = e.game
    hub = g.level_nid
    # The roam unit keeps a standing movement component under the hub's
    # menus; only free roam itself is checked for that in Engine.busy.
    real_busy = e.busy
    e.busy = lambda: bool(g.state.temp_state) if 'free_roam' in e.stack() else real_busy()
    if not g.events.trigger_specific_event(start_event, force=True):
        raise OracleError('run-start event %s did not trigger' % start_event)
    choices = []
    for _ in range(max_rounds):
        e.settle(until=lambda en: en.top() in ('player_choice', 'free', 'free_roam', 'prep_main')
                 and en.game.level_nid is not None, max_frames=20000)
        top = e.top()
        if top == 'player_choice':
            st = g.state.current_state()
            data = list(st.menu._data)
            idx = _pick(st.nid, data)
            st.menu._cursor_idx = idx
            choices.append([st.nid, str(getattr(data[idx], 'nid', data[idx]))])
            e.press('SELECT')
            continue
        if g.level_nid != hub:
            return choices
        raise OracleError('run start stopped in %s on the hub (stack %s)' % (top, e.stack()))
    raise OracleError('run start did not leave the hub')


def _unit_save(u) -> dict:
    """UnitObject.save() as JSON, with each skill's source type by nid."""
    d = u.save()
    skills = [[uid, _jsonable(src), getattr(stype, 'nid', str(stype))] for uid, src, stype in d['skills']]
    d = _jsonable(d)
    d['skills'] = skills
    return d


def capture(e: Engine) -> dict:
    """The persistent state a later level starts from."""
    g = e.game
    from app.engine.persistent_records import RECORDS
    units = [u for u in g.units if u.persistent]
    item_uids, skill_uids = set(), set()

    def collect_item(item):
        if item.uid in item_uids:
            return
        item_uids.add(item.uid)
        for sub in getattr(item, 'subitem_uids', []):
            sub_item = g.item_registry.get(sub)
            if sub_item:
                collect_item(sub_item)
    for u in units:
        for item in u.items:
            collect_item(item)
        for info in u._skills:
            skill_uids.add(info.skill_obj.uid)
    parties = []
    for party in g.parties.values():
        for item in party.convoy:
            collect_item(item)
        parties.append({'nid': party.nid, 'money': party.money,
                        'convoy': [item.uid for item in party.convoy],
                        'bexp': getattr(party, 'bexp', 0)})
    for uid in list(item_uids):  # item-granted skills
        item = g.item_registry.get(uid)
        for sk in getattr(item, 'skills', None) or []:
            skill_uids.add(sk.uid)
    return {
        'format': 'lt-oracle-run-state/1',
        'project': e.project,
        'backend': e.backend,
        'captured_level': g.level_nid,
        'game_vars': _jsonable(dict(g.game_vars)),
        'records': {r.nid: _jsonable(r.value) for r in RECORDS},
        'current_party': g.current_party,
        'parties': parties,
        'level_cap_modifier': getattr(g, 'level_cap_modifier', 0),
        'current_rng_mode': _jsonable(getattr(g, 'current_rng_mode', None)),
        'already_triggered': sorted(g.already_triggered_events),
        'units': [_unit_save(u) for u in units],
        'items': [_jsonable(g.item_registry[uid].save()) for uid in sorted(item_uids)],
        'skills': [_jsonable(g.skill_registry[uid].save()) for uid in sorted(skill_uids)
                   if uid in g.skill_registry],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--backend', default='fork', choices=['upstream', 'fork'])
    ap.add_argument('--project', default='eotf.ltproj')
    ap.add_argument('--hub', default='X')
    ap.add_argument('--start-event', default='X 8. Run_Start')
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args(argv)
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        e = Engine(args.project, args.backend)
        e.boot()
        e.run_startup()
        e.start_level(args.hub, args.seed, True, 'True Hit', 'Fixed')
        e.settle(max_frames=20000)
        choices = depart(e, args.start_event)
        state = capture(e)
        state['seed'] = args.seed
        state['choices'] = choices
    except Exception:
        traceback.print_exc()
        return 2
    finally:
        sys.stdout = real_stdout
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(state, indent=1, sort_keys=True), encoding='utf-8')
    print('captured run state at level %s: %d units, %d items, %d skills -> %s' % (
        state['captured_level'], len(state['units']), len(state['items']), len(state['skills']), args.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
