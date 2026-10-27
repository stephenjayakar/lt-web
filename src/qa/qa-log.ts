/**
 * QA log collector (dev/QA builds only; see docs/qa-tools.md).
 *
 * Wraps console.warn/console.error (the web port's equivalents of Python's
 * logging.warning/logging.error), uncaught errors and unhandled rejections,
 * and records each with the game context it happened in: level, floor,
 * turn, phase, state stack and running event. Repeats of the same message
 * are folded into one entry with a count so a warning raised every frame
 * does not flood the report.
 *
 * console.log/info/debug are routed through `onLog` (and silenced when
 * `quiet` is set): the engine logs every event trigger and level transition,
 * and serialising that to an attached devtools client costs real time in
 * long runs.
 */

export interface QaContext {
  level: string | null;
  floor: unknown;
  turn: number;
  phase: string;
  state: string;
  stack: string;
  event: string | null;
  frame: number;
}

export type QaLogKind = 'warn' | 'error' | 'pageerror' | 'rejection' | 'qa';

export interface QaLogEntry {
  kind: QaLogKind;
  message: string;
  count: number;
  first: QaContext;
  last: QaContext;
}

const MAX_MESSAGE = 600;
const MAX_ENTRIES = 2000;

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function formatArgs(args: unknown[]): string {
  return args.map(stringify).join(' ').slice(0, MAX_MESSAGE);
}

export class QaLog {
  readonly entries = new Map<string, QaLogEntry>();
  /** Messages whose first occurrence matches are not recorded (noise). */
  ignore: RegExp[] = [/^\[Perf\]/];
  quiet = false;
  /** Called for every console.log/info line (before `quiet` drops it). */
  onLog: ((text: string) => void) | null = null;
  /** Called after a warning/error entry is first created. */
  onEntry: ((entry: QaLogEntry) => void) | null = null;

  private context: () => QaContext;
  private original: Partial<Record<'log' | 'info' | 'debug' | 'warn' | 'error', (...args: unknown[]) => void>> = {};
  private recording = true;

  constructor(context: () => QaContext) {
    this.context = context;
  }

  install(): void {
    const consoleRef = console as unknown as Record<string, (...args: unknown[]) => void>;
    for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      const original = consoleRef[name].bind(console);
      this.original[name] = original;
      consoleRef[name] = (...args: unknown[]) => {
        if (name === 'warn' || name === 'error') {
          this.record(name, formatArgs(args));
          original(...args);
          return;
        }
        if (this.onLog) {
          const first = args[0];
          if (typeof first === 'string') this.onLog(first);
        }
        if (!this.quiet) original(...args);
      };
    }
    window.addEventListener('error', (event) => {
      const err = event.error;
      this.record('pageerror', err instanceof Error ? (err.stack ?? err.message) : String(event.message));
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      this.record('rejection', reason instanceof Error ? (reason.stack ?? reason.message) : stringify(reason));
    });
  }

  /** Print through the real console (bypasses `quiet`). */
  print(...args: unknown[]): void {
    (this.original.log ?? console.log)(...args);
  }

  record(kind: QaLogKind, message: string): QaLogEntry | null {
    if (!this.recording) return null;
    const text = message.slice(0, MAX_MESSAGE);
    const key = `${kind}|${text}`;
    let ctx: QaContext;
    try {
      // Reading the context must never recurse into another warning.
      this.recording = false;
      ctx = this.context();
    } finally {
      this.recording = true;
    }
    const existing = this.entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.last = ctx;
      return existing;
    }
    if (kind !== 'qa' && this.ignore.some((pattern) => pattern.test(text))) return null;
    if (this.entries.size >= MAX_ENTRIES) return null;
    const entry: QaLogEntry = { kind, message: text, count: 1, first: ctx, last: ctx };
    this.entries.set(key, entry);
    this.onEntry?.(entry);
    return entry;
  }

  list(): QaLogEntry[] {
    return [...this.entries.values()];
  }
}
