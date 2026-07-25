/**
 * strict-mode.ts - Report unimplemented commands and components
 *
 * In development or strict mode (?strict=true), failures are reported loudly
 * with thrown errors. In production, warnings are logged once per unique NID.
 */

/** Track warned NIDs to avoid duplicate console.warn calls. */
const warnedNids = new Set<string>();

/**
 * Check if strict mode is enabled.
 * Strict mode is on ONLY with an explicit ?strict=true query param.
 * It must not key off import.meta.env.DEV: the Playwright harness runs
 * against the Vite dev server, and bundled projects (e.g. rekka) may
 * intentionally reference unimplemented components — DEV-throwing would
 * fail their compatibility suites. Loud-by-default in dev is provided by
 * the once-per-nid console.warn below instead.
 */
export function isStrictMode(): boolean {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    return params.get('strict') === 'true';
  }
  return false;
}

/**
 * Report an unimplemented command, component, or other feature.
 *
 * @param kind - The type of unimplemented feature ('command', 'item-component', 'skill-component')
 * @param nid - The NID/identifier of the unimplemented feature
 * @param context - Optional additional context (e.g., where it was encountered)
 *
 * In strict mode, throws an Error.
 * In production, logs a warning once per unique nid.
 */
export function reportUnimplemented(
  kind: 'command' | 'item-component' | 'skill-component' | 'expression',
  nid: string,
  context?: string,
): void {
  const key = `${kind}:${nid}`;

  // Warn once per unique nid
  if (!warnedNids.has(key)) {
    warnedNids.add(key);
    const contextStr = context ? ` (${context})` : '';
    console.warn(`[StrictMode] Unimplemented ${kind}: "${nid}"${contextStr}`);
  }

  // In strict mode, throw
  if (isStrictMode()) {
    const contextStr = context ? ` in ${context}` : '';
    throw new Error(`Unimplemented ${kind}: "${nid}"${contextStr}`);
  }
}

/**
 * Clear the warning deduplication set (for testing).
 */
export function clearWarnedNids(): void {
  warnedNids.clear();
}
