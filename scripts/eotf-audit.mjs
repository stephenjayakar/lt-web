import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projectRoot = path.join(root, 'lt-maker/eotf.ltproj');
const outputJson = path.join(root, 'docs/parity/eotf-compat.json');
const outputMarkdown = path.join(root, 'docs/parity/eotf-compat.md');
const args = new Set(process.argv.slice(2));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readProjectJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nid, uses]) => ({ nid, uses }));
}

function extractComponents(records) {
  return countBy(records.flatMap((record) =>
    Array.isArray(record.components)
      ? record.components.map((component) => component[0]).filter(Boolean)
      : []));
}

function extractCustomComponents(relativePath, kind) {
  const source = read(relativePath);
  const rows = [];
  const classes = [...source.matchAll(/^class\s+(\w+)\([^)]*\):/gm)];
  for (let index = 0; index < classes.length; index += 1) {
    const match = classes[index];
    const body = source.slice(
      (match.index ?? 0) + match[0].length,
      classes[index + 1]?.index ?? source.length,
    );
    const nid = body.match(/^\s+nid\s*=\s*['"]([^'"]+)['"]/m)?.[1];
    if (!nid) continue;
    rows.push({
      nid,
      kind,
      pythonClass: match[1],
      hooks: [...body.matchAll(/^\s+def\s+(\w+)\s*\(/gm)].map((hook) => hook[1]),
    });
  }
  return rows;
}

function readSupportSet(exportName) {
  const source = read('src/engine/eotf-component-support.ts');
  const match = source.match(
    new RegExp(`export const ${exportName} = new Set(?:<[^>]+>)?\\(\\[([\\s\\S]*?)\\]\\);`),
  );
  if (!match) throw new Error(`Could not read ${exportName}`);
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]));
}

function sourceCommand(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  return trimmed.split(';', 1)[0].trim().replace(/:$/, '') || null;
}

function eventExpressions(events) {
  const conditions = new Set(events.map((event) => event.condition).filter(Boolean));
  const evals = new Set();
  const loops = new Set();
  for (const event of events) {
    for (const line of event._source ?? []) {
      const trimmed = line.trim();
      const conditional = trimmed.match(/^(?:if|elif);(.+)$/);
      if (conditional) conditions.add(conditional[1]);
      const loop = trimmed.match(/^for;(.+)$/);
      if (loop) loops.add(loop[1]);
      for (const match of trimmed.matchAll(/\{(?:e|eval):([^{}]+)\}/g)) evals.add(match[1]);
    }
  }
  const all = [...conditions, ...evals, ...loops];
  return {
    conditions: [...conditions].sort(),
    evalSubstitutions: [...evals].sort(),
    loops: [...loops].sort(),
    namespaces: countBy(all.flatMap((expression) =>
      [...expression.matchAll(/\b([A-Za-z_]\w*)\s*\./g)].map((match) => match[1]))),
  };
}

const intentionalMissingResources = new Map([
  ['portrait:BloodyTalon',
    'Stale catalog alias; the active unit references the shipped BloodyTalon_Old portrait.'],
  ['icons16:TerrariaLuckyHorseshoeSheet',
    'Unused catalog variant; authored items reference the shipped _4 sheet.'],
  ['icons16:TerrariaLuckyHorseshoeSheet_1',
    'Unused catalog variant; authored items reference the shipped _4 sheet.'],
  ['icons16:TerrariaLuckyHorseshoeSheet_2',
    'Unused catalog variant; authored items reference the shipped _4 sheet.'],
  ['icons16:TerrariaLuckyHorseshoeSheet_3',
    'Unused catalog variant; authored items reference the shipped _4 sheet.'],
  ['icons16:Twin Revolvers',
    'Unused catalog alias; authored items reference the shipped Twin Revolvers_1 sheet.'],
  ['icons16:Rifle',
    'Unused catalog alias; authored items reference the shipped Rifle_1 sheet.'],
  ['icons16:type_icons',
    'Unused catalog alias; no gameplay data references it and last_type_icons is shipped.'],
]);

function auditResources() {
  const resourceRoot = path.join(projectRoot, 'resources');
  const checks = [];
  const exists = (relativePaths) =>
    relativePaths.some((relativePath) => fs.existsSync(path.join(resourceRoot, relativePath)));
  const add = (category, nid, relativePaths) => {
    const found = exists(relativePaths);
    const reason = intentionalMissingResources.get(`${category}:${nid}`) ?? null;
    checks.push({
      category,
      nid,
      found,
      paths: relativePaths,
      status: found ? 'present' : reason ? 'intentional-missing' : 'unclassified-missing',
      reason,
    });
  };

  for (const portrait of readProjectJson('resources/portraits/portraits.json')) {
    add('portrait', portrait.nid, [`portraits/${portrait.nid}.png`]);
  }
  for (const nid of readProjectJson('resources/map_sprites/map_sprites.json')) {
    add('map-sprite-stand', nid, [`map_sprites/${nid}-stand.png`]);
    add('map-sprite-move', nid, [`map_sprites/${nid}-move.png`]);
  }
  for (const [nid, frames] of readProjectJson('resources/panoramas/panoramas.json')) {
    if (frames > 1) {
      for (let index = 0; index < frames; index += 1) {
        add('panorama', `${nid}${index}`, [`panoramas/${nid}${index}.png`]);
      }
    } else {
      add('panorama', nid, [`panoramas/${nid}.png`, `panoramas/${nid}0.png`]);
    }
  }
  for (const animation of readProjectJson('resources/animations/animations.json')) {
    add('map-animation', animation.nid, [`animations/${animation.nid}.png`]);
  }
  for (const [nid] of readProjectJson('resources/music/music.json')) {
    add('music', nid, ['ogg', 'mp3', 'wav'].map((extension) => `music/${nid}.${extension}`));
  }
  for (const [nid] of readProjectJson('resources/sfx/sfx.json')) {
    add('sfx', nid, ['ogg', 'mp3', 'wav'].map((extension) => `sfx/${nid}.${extension}`));
  }
  for (const folder of ['icons16', 'icons32', 'icons80']) {
    for (const icon of readProjectJson(`resources/${folder}/${folder}.json`)) {
      add(folder, icon.nid, [`${folder}/${icon.nid}.png`]);
    }
  }

  const missing = checks.filter((check) => !check.found);
  return {
    checks: checks.length,
    missing,
    unclassifiedMissing: missing.filter((check) => !check.reason),
    categories: countBy(checks.map((check) => check.category)),
  };
}

if (!fs.existsSync(projectRoot)) {
  throw new Error('EotF project not found at lt-maker/eotf.ltproj');
}

const metadata = readProjectJson('metadata.json');
const levels = readProjectJson('game_data/levels.json');
const events = readProjectJson('game_data/events.json');
const items = readProjectJson('game_data/items.json');
const skills = readProjectJson('game_data/skills.json');
const units = readProjectJson('game_data/units.json');
const classes = readProjectJson('game_data/classes.json');
const itemParity = JSON.parse(read('docs/parity/item-components.json'));
const skillParity = JSON.parse(read('docs/parity/skill-components.json'));
const itemStatuses = new Map(itemParity.components.map((row) => [row.nid, row.status]));
const skillStatuses = new Map(skillParity.components.map((row) => [row.nid, row.status]));
const verifiedItems = readSupportSet('EOTF_ITEM_COMPONENTS');
const verifiedSkills = readSupportSet('EOTF_SKILL_COMPONENTS');
const itemComponents = extractComponents(items).map((row) => ({
  ...row,
  structuralStatus: itemStatuses.get(row.nid) ?? 'project-local-or-unknown',
  semanticStatus: verifiedItems.has(row.nid) ? 'verified' : 'unverified',
}));
const skillComponents = extractComponents(skills).map((row) => ({
  ...row,
  structuralStatus: skillStatuses.get(row.nid) ?? 'project-local-or-unknown',
  semanticStatus: verifiedSkills.has(row.nid) ? 'verified' : 'unverified',
}));
const customComponents = [
  ...extractCustomComponents(
    'lt-maker/eotf.ltproj/resources/custom_components/custom_item_components.py',
    'item',
  ),
  ...extractCustomComponents(
    'lt-maker/eotf.ltproj/resources/custom_components/custom_skill_components.py',
    'skill',
  ),
].map((row) => ({
  ...row,
  uses: (row.kind === 'item' ? itemComponents : skillComponents)
    .find((component) => component.nid === row.nid)?.uses ?? 0,
}));
const commands = countBy(events.flatMap((event) =>
  (event._source ?? []).map(sourceCommand).filter(Boolean)));
const expressions = eventExpressions(events);
const resourceFiles = walk(path.join(projectRoot, 'resources'));
const resources = auditResources();

const manifest = {
  generatedBy: 'npm run audit:eotf:write',
  project: {
    path: 'lt-maker/eotf.ltproj',
    nid: metadata.project,
    version: metadata.version,
    levels: levels.length,
    events: events.length,
    items: items.length,
    skills: skills.length,
    units: units.length,
    classes: classes.length,
    files: walk(projectRoot).length,
  },
  commands,
  components: {
    items: itemComponents,
    skills: skillComponents,
    custom: customComponents,
  },
  expressions,
  resources: {
    files: resourceFiles.length,
    ...resources,
  },
};

function table(rows, columns) {
  if (rows.length === 0) return 'None.';
  return [
    `| ${columns.map((column) => column.label).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((row) =>
      `| ${columns.map((column) => String(row[column.key] ?? '').replaceAll('|', '\\|')).join(' | ')} |`),
  ].join('\n');
}

const unverifiedItems = itemComponents.filter((row) => row.semanticStatus !== 'verified');
const unverifiedSkills = skillComponents.filter((row) => row.semanticStatus !== 'verified');
const usedCustom = customComponents.filter((row) => row.uses > 0);
const markdown = `# Embrace of the Fog Compatibility Inventory

Generated by \`npm run audit:eotf:write\`. Structural status comes from the
engine-wide parity audit. Semantic status is deliberately count-locked: a
component is verified only after its EotF value shapes and Python hooks have
focused browser coverage.

## Summary

- Project metadata: ${metadata.project} ${metadata.version}
- ${levels.length} levels, ${events.length} events, ${items.length} items,
  ${skills.length} skills, ${units.length} units, and ${classes.length} classes
- ${itemComponents.length} item-component NIDs; ${unverifiedItems.length} unverified
- ${skillComponents.length} skill-component NIDs; ${unverifiedSkills.length} unverified
- ${usedCustom.length}/${customComponents.length} project-local Python components
  are referenced by current data
- ${commands.length} event command NIDs
- ${expressions.conditions.length} event conditions,
  ${expressions.evalSubstitutions.length} eval substitutions, and
  ${expressions.loops.length} loops
- ${resourceFiles.length} resource files; ${resources.missing.length} missing
  catalog-backed files across ${resources.checks} checks

## Unverified item components

${table(unverifiedItems, [
  { key: 'nid', label: 'NID' },
  { key: 'uses', label: 'Uses' },
  { key: 'structuralStatus', label: 'Engine audit status' },
])}

## Unverified skill components

${table(unverifiedSkills, [
  { key: 'nid', label: 'NID' },
  { key: 'uses', label: 'Uses' },
  { key: 'structuralStatus', label: 'Engine audit status' },
])}

## Used project-local Python components

${table(usedCustom, [
  { key: 'kind', label: 'Kind' },
  { key: 'nid', label: 'NID' },
  { key: 'uses', label: 'Uses' },
  { key: 'hooks', label: 'Python hooks' },
])}

## Missing catalog-backed resources

${table(resources.missing, [
  { key: 'category', label: 'Category' },
  { key: 'nid', label: 'NID' },
  { key: 'status', label: 'Status' },
  { key: 'reason', label: 'Classification' },
  { key: 'paths', label: 'Expected paths' },
])}

## Event commands

${table(commands, [
  { key: 'nid', label: 'Command' },
  { key: 'uses', label: 'Uses' },
])}
`;

const generated = new Map([
  [outputJson, `${JSON.stringify(manifest, null, 2)}\n`],
  [outputMarkdown, markdown],
]);

if (args.has('--write')) {
  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  for (const [file, contents] of generated) fs.writeFileSync(file, contents);
}

if (args.has('--check')) {
  const stale = [...generated].filter(([file, contents]) =>
    !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents);
  for (const [file] of stale) {
    console.error(`ERROR: ${path.relative(root, file)} is stale; run npm run audit:eotf:write`);
  }
  if (stale.length > 0) process.exitCode = 1;
  for (const resource of resources.unclassifiedMissing) {
    console.error(`ERROR: unclassified missing resource ${resource.category}:${resource.nid}`);
  }
  if (resources.unclassifiedMissing.length > 0) process.exitCode = 1;
}

console.log('# Embrace of the Fog compatibility audit');
console.log(`- Levels/events: ${levels.length}/${events.length}`);
console.log(`- Item/skill component NIDs: ${itemComponents.length}/${skillComponents.length}`);
console.log(`- Unverified item/skill NIDs: ${unverifiedItems.length}/${unverifiedSkills.length}`);
console.log(`- Used custom Python components: ${usedCustom.length}/${customComponents.length}`);
console.log(`- Conditions/evals/loops: ${expressions.conditions.length}/${expressions.evalSubstitutions.length}/${expressions.loops.length}`);
console.log(`- Resource checks/intentional/unclassified missing: ${resources.checks}/${resources.missing.length - resources.unclassifiedMissing.length}/${resources.unclassifiedMissing.length}`);
