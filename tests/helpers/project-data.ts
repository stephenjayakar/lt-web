/**
 * Filesystem readers for .ltproj game data.
 *
 * Many "count-lock" assertions only inspect authored JSON — which component
 * NIDs appear on which prefabs, and with what value shape. Those need no
 * engine and no browser, but running them through Playwright's `page` fixture
 * boots the whole project (3,000+ files for EotF) once per spec file just to
 * read a catalog.
 *
 * Reading the catalogs directly keeps those checks in the same runner and the
 * same `expect` API while cutting the per-file boot entirely. Tests that
 * exercise engine behaviour — hooks firing, combat math, event execution —
 * still belong in the browser.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ComponentEntry = [string, unknown];

export interface Prefab {
  nid: string;
  name?: string;
  components: ComponentEntry[];
  [key: string]: unknown;
}

const projectCache = new Map<string, Map<string, Prefab[]>>();

export function projectRoot(project = 'eotf.ltproj'): string {
  return path.join(process.cwd(), 'lt-maker', project);
}

/** True when the project is installed; specs skip themselves when it is not. */
export function projectInstalled(project = 'eotf.ltproj'): boolean {
  return fs.existsSync(path.join(projectRoot(project), 'game_data/levels.json'));
}

/**
 * Read one `game_data/<catalog>.json` catalog. Results are cached per process,
 * so a worker parses each catalog at most once no matter how many specs ask.
 */
export function catalog(name: string, project = 'eotf.ltproj'): Prefab[] {
  let byProject = projectCache.get(project);
  if (!byProject) {
    byProject = new Map();
    projectCache.set(project, byProject);
  }
  const cached = byProject.get(name);
  if (cached) return cached;

  const file = path.join(projectRoot(project), 'game_data', `${name}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Prefab[];
  const records = parsed.map((record) => ({
    ...record,
    components: Array.isArray(record.components) ? record.components : [],
  }));
  byProject.set(name, records);
  return records;
}

export const items = (project?: string): Prefab[] => catalog('items', project);
export const skills = (project?: string): Prefab[] => catalog('skills', project);

/**
 * Every `[nid, value]` pair for `componentNid`, in catalog order.
 *
 * Catalog order is the authored order, which is what the engine iterates, so
 * asserting on the sequence pins ordering as well as membership.
 */
export function componentUses(
  records: Prefab[],
  componentNid: string,
): Array<[string, unknown]> {
  const uses: Array<[string, unknown]> = [];
  for (const record of records) {
    for (const [nid, value] of record.components) {
      if (nid === componentNid) uses.push([record.nid, value]);
    }
  }
  return uses;
}

/** NIDs of prefabs carrying `componentNid`, in catalog order. */
export function prefabsWithComponent(
  records: Prefab[],
  componentNid: string,
): string[] {
  return componentUses(records, componentNid).map(([nid]) => nid);
}

/** Total number of uses of `componentNid` across the catalog. */
export function componentUseCount(
  records: Prefab[],
  componentNid: string,
): number {
  return componentUses(records, componentNid).length;
}
