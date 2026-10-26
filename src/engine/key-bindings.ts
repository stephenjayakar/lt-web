/**
 * key-bindings.ts — keyboard bindings for the nine game buttons.
 *
 * Python keeps one pygame key per button in cf.SETTINGS (`key_SELECT`, ...)
 * and the Controls settings page rebinds them. The web ships extra aliases
 * by default (Enter, Escape, Shift, Tab, WASD); a rebound button gets
 * exactly the chosen key, as in Python, and a button never rebound keeps
 * the defaults. Bindings are KeyboardEvent.code strings.
 */

import type { GameButton } from './input';

/** Python settings.control_order. */
export const KEY_BUTTONS: readonly GameButton[] = ['SELECT', 'BACK', 'INFO', 'AUX', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'START'];

/** The web's default keyboard map (primary key first). */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<GameButton, readonly string[]>> = {
  UP: ['ArrowUp', 'KeyW'],
  DOWN: ['ArrowDown', 'KeyS'],
  LEFT: ['ArrowLeft', 'KeyA'],
  RIGHT: ['ArrowRight', 'KeyD'],
  SELECT: ['KeyZ', 'Enter'],
  BACK: ['KeyX', 'Escape'],
  INFO: ['KeyC', 'ShiftLeft', 'ShiftRight'],
  AUX: ['KeyV', 'Tab'],
  START: ['Space'],
};

/** The config key Python stores a button's binding under. */
export function keySettingName(button: GameButton): string {
  return `key_${button}`;
}

/** Bindings per button: an override replaces that button's defaults. */
export function resolveKeyBindings(overrides: Partial<Record<GameButton, string>>): Record<GameButton, string[]> {
  const out = {} as Record<GameButton, string[]>;
  for (const button of KEY_BUTTONS) {
    const code = overrides[button];
    out[button] = code ? [code] : [...DEFAULT_KEY_BINDINGS[button]];
  }
  return out;
}

/** code -> button. An explicit override wins over another button's default. */
export function buildKeyMap(overrides: Partial<Record<GameButton, string>>): Record<string, GameButton> {
  const bindings = resolveKeyBindings(overrides);
  const map: Record<string, GameButton> = {};
  for (const button of KEY_BUTTONS) {
    if (overrides[button]) continue;
    for (const code of bindings[button]) map[code] = button;
  }
  for (const button of KEY_BUTTONS) {
    const code = overrides[button];
    if (code) map[code] = button;
  }
  return map;
}

/** engine.get_key_name: pygame-style lower-case key names. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `[${code.slice(6)}]`;
  if (code.startsWith('Arrow')) return code.slice(5).toLowerCase();
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'shift';
  const sided = code.match(/^(Control|Alt|Meta)(Left|Right)$/);
  if (sided) return `${sided[2].toLowerCase()} ${sided[1] === 'Control' ? 'ctrl' : sided[1].toLowerCase()}`;
  const named: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', Space: 'space',
  };
  if (named[code]) return named[code];
  return code.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
}

/** A button's bindings as the Controls page shows them ("z, enter"). */
export function bindingLabel(codes: readonly string[]): string {
  return [...new Set(codes.map(keyName))].join(', ');
}
