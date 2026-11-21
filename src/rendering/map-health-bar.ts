/**
 * Python health_bar.MapHealthBar: the small bar under each map sprite does
 * not jump to the unit's HP. HealthBar.update starts a transition when the
 * displayed HP differs from the unit's, then lerps from the old value over
 * max(200 ms, |change| * frames2ms(1)) on the engine's integer ms clock.
 *
 * Python runs this from UnitSprite.update, which map_view.draw_units calls
 * for every unit each time the map is drawn, so a change made while the map
 * is hidden (a battle scene) drains once the map is back.
 */
import { getFrameCount } from '../engine/constants';

const TIME_FOR_CHANGE_MIN = 200;
/** utils.frames2ms(1) = int(16.67). */
const SPEED = Math.trunc(16.67);

interface MapHealthBarState {
  displayed: number;
  old: number;
  transition: boolean;
  timeForChange: number;
  lastUpdate: number;
}

const bars = new WeakMap<object, MapHealthBarState>();

/** Python's engine.get_time() under the port's 60 fps frame clock. */
function engineTime(): number {
  return Math.floor(getFrameCount() * 1000 / 60);
}

/**
 * HealthBar.update for `unit` toward `hp`; returns the HP the bar shows.
 * The first call for a unit shows its HP at once (UnitSprite.__init__).
 */
export function updateMapHealthBar(unit: object, hp: number, now: number = engineTime()): number {
  let bar = bars.get(unit);
  if (!bar) {
    bar = { displayed: hp, old: hp, transition: false, timeForChange: TIME_FOR_CHANGE_MIN, lastUpdate: 0 };
    bars.set(unit, bar);
    return hp;
  }
  if (bar.displayed !== hp && !bar.transition) {
    bar.transition = true;
    bar.timeForChange = Math.max(TIME_FOR_CHANGE_MIN, Math.abs(bar.displayed - hp) * SPEED);
    bar.lastUpdate = now;
  }
  if (bar.transition) {
    const time = (now - bar.lastUpdate) / bar.timeForChange;
    const t = Math.max(0, Math.min(1, time));
    bar.displayed = Math.trunc(bar.old + (hp - bar.old) * t);
    if (time >= 1) {
      bar.displayed = hp;
      bar.old = hp;
      bar.transition = false;
    }
  }
  return bar.displayed;
}

/** The HP the unit's map bar currently shows (tests, diagnostics). */
export function getMapHealthBarHp(unit: object): number | undefined {
  return bars.get(unit)?.displayed;
}
