import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projectRoot = path.join(root, 'lt-maker/rekka.ltproj');
const outputJson = path.join(root, 'docs/parity/rekka-compat.json');
const outputMarkdown = path.join(root, 'docs/parity/rekka-compat.md');
const args = new Set(process.argv.slice(2));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
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

function sourceCommand(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const command = trimmed.split(';', 1)[0].trim().split(/\s+/, 1)[0];
  return command.replace(/:$/, '') || null;
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
  const namespaces = countBy(all.flatMap((expression) =>
    [...expression.matchAll(/\b([A-Za-z_]\w*)\s*\./g)].map((match) => match[1])));
  const forms = [
    ['list-comprehension', /\[[^\]]+\bfor\b[^\]]+\]/],
    ['generator-expression', /\b(?:any|all|sum|min|max)\s*\([^)]*\bfor\b/],
    ['floor-division', /\/\//],
    ['exponentiation', /\*\*/],
    ['membership', /\b(?:in|not in)\b/],
    ['slice-or-index', /\[[^\]]+\]/],
    ['modulo', /%/],
    ['string-join', /\.join\s*\(/],
  ].map(([name, pattern]) => ({
    name,
    uses: all.filter((expression) => pattern.test(expression)).length,
  })).filter((row) => row.uses > 0);
  return {
    conditions: [...conditions].sort(),
    evalSubstitutions: [...evals].sort(),
    loops: [...loops].sort(),
    namespaces,
    forms,
  };
}

const levels = readJson('game_data/levels.json');
const events = readJson('game_data/events.json');
const items = readJson('game_data/items.json');
const skills = readJson('game_data/skills.json');
const units = readJson('game_data/units.json');
const classes = readJson('game_data/classes.json');
const itemParity = JSON.parse(read('docs/parity/item-components.json'));
const skillParity = JSON.parse(read('docs/parity/skill-components.json'));
const itemStatuses = new Map(itemParity.components.map((row) => [row.nid, row.status]));
const skillStatuses = new Map(skillParity.components.map((row) => [row.nid, row.status]));
const itemComponents = extractComponents(items).map((row) => ({
  ...row,
  structuralStatus: itemStatuses.get(row.nid) ?? 'custom-or-unknown',
}));
const skillComponents = extractComponents(skills).map((row) => ({
  ...row,
  structuralStatus: skillStatuses.get(row.nid) ?? 'custom-or-unknown',
}));
const customComponents = [
  ...extractCustomComponents(
    'lt-maker/rekka.ltproj/resources/custom_components/custom_item_components.py',
    'item',
  ),
  ...extractCustomComponents(
    'lt-maker/rekka.ltproj/resources/custom_components/custom_skill_components.py',
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
const resourceRoot = path.join(projectRoot, 'resources');
const resourceFiles = walk(resourceRoot);
const resourceCategories = countBy(resourceFiles.map((file) =>
  path.relative(resourceRoot, file).split(path.sep)[0]));
const customSpriteFiles = resourceFiles
  .filter((file) => path.relative(resourceRoot, file).startsWith(`custom_sprites${path.sep}`))
  .map((file) => path.relative(projectRoot, file))
  .sort();

function resourceExists(relativePaths) {
  return relativePaths.some((relativePath) =>
    fs.existsSync(path.join(resourceRoot, relativePath)));
}

function auditResources() {
  const checks = [];
  const add = (category, nid, relativePaths, classification = 'required') => {
    checks.push({
      category,
      nid,
      classification,
      found: resourceExists(relativePaths),
      paths: relativePaths,
    });
  };

  for (const portrait of readJson('resources/portraits/portraits.json')) {
    add('portrait', portrait.nid, [`portraits/${portrait.nid}.png`]);
  }
  const eventSource = events.flatMap((event) => event._source ?? []).join('\n');
  for (const [nid, frameCount] of readJson('resources/panoramas/panoramas.json')) {
    const paths = frameCount > 1
      ? Array.from({ length: frameCount }, (_, index) => `panoramas/${nid}${index}.png`)
      : [`panoramas/${nid}.png`, `panoramas/${nid}0.png`];
    const referenced = eventSource.includes(`background;${nid}`) ||
      eventSource.includes(`panorama;${nid}`) ||
      nid === 'title_background';
    add('panorama', nid, paths, referenced ? 'required' : 'optional-catalog-entry');
  }
  for (const nid of readJson('resources/map_sprites/map_sprites.json')) {
    add('map-sprite-stand', nid, [`map_sprites/${nid}-stand.png`]);
    add('map-sprite-move', nid, [`map_sprites/${nid}-move.png`]);
  }
  for (const tileset of readJson('resources/tilesets/tilesets.json')) {
    add('tileset', tileset.nid, [`tilesets/${tileset.nid}.png`]);
    if (Object.keys(tileset.autotiles ?? {}).length > 0) {
      add('tileset-autotiles', tileset.nid, [`tilesets/${tileset.nid}_autotiles.png`]);
    }
  }
  for (const folder of ['icons16', 'icons32', 'icons80']) {
    for (const icon of readJson(`resources/${folder}/${folder}.json`)) {
      add(folder, icon.nid, [`${folder}/${icon.nid}.png`]);
    }
  }
  for (const animation of readJson('resources/animations/animations.json')) {
    add('map-animation', animation.nid, [`animations/${animation.nid}.png`]);
  }
  for (const combatAnimation of readJson('resources/combat_anims/combat_anims.json')) {
    for (const weaponAnimation of combatAnimation.weapon_anims) {
      const nid = `${combatAnimation.nid}-${weaponAnimation.nid}`;
      add('combat-animation', nid, [`combat_anims/${nid}.png`]);
    }
  }
  for (const effect of readJson('resources/combat_effects/combat_effects.json')) {
    // Parent spell scripts may be command-only composites which reference
    // child effects and intentionally own no sprite sheet.
    if ((effect.frames ?? []).length > 0) {
      add('combat-effect', effect.nid, [`combat_effects/${effect.nid}.png`]);
    } else {
      add('combat-effect-composite', effect.nid, [], 'metadata-only');
      checks.at(-1).found = true;
    }
  }
  for (const [nid] of readJson('resources/music/music.json')) {
    add('music', nid, ['ogg', 'mp3', 'wav'].map((extension) =>
      `music/${nid}.${extension}`));
  }
  for (const [nid] of readJson('resources/sfx/sfx.json')) {
    add('sfx', nid, ['ogg', 'mp3', 'wav'].map((extension) =>
      `sfx/${nid}.${extension}`));
  }

  const missing = checks.filter((check) => !check.found);
  return {
    checks: checks.length,
    requiredMissing: missing.filter((check) => check.classification === 'required'),
    optionalMissing: missing.filter((check) => check.classification !== 'required'),
    metadataOnly: checks.filter((check) => check.classification === 'metadata-only').length,
    categories: countBy(checks.map((check) => check.category)),
  };
}

const resourceAudit = auditResources();

const manifest = {
  generatedBy: 'node scripts/rekka-audit.mjs --write',
  project: {
    path: 'lt-maker/rekka.ltproj',
    nid: 'FE7A',
    levels: levels.length,
    events: events.length,
    items: items.length,
    skills: skills.length,
    units: units.length,
    classes: classes.length,
    files: walk(projectRoot).length,
  },
  levels: levels.map((level) => ({ nid: level.nid, name: level.name })),
  commands,
  components: {
    items: itemComponents,
    skills: skillComponents,
    custom: customComponents,
  },
  expressions,
  resources: {
    files: resourceFiles.length,
    categories: resourceCategories,
    customSprites: customSpriteFiles,
    audit: resourceAudit,
  },
};

function table(rows, columns) {
  return [
    `| ${columns.map((column) => column.label).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((row) =>
      `| ${columns.map((column) => String(row[column.key] ?? '').replaceAll('|', '\\|')).join(' | ')} |`),
  ].join('\n');
}

const riskyStatuses = new Set(['unreferenced', 'reference-only', 'custom-or-unknown']);
const riskyItems = itemComponents.filter((row) => riskyStatuses.has(row.structuralStatus));
const riskySkills = skillComponents.filter((row) => riskyStatuses.has(row.structuralStatus));
const usedCustom = customComponents.filter((row) => row.uses > 0);
const markdown = `# Rekka Compatibility Inventory

Generated by \`npm run audit:rekka:write\`. Structural status is discovery
evidence, not proof of behavior.

## Summary

- ${levels.length} levels, ${events.length} events, ${items.length} items,
  ${skills.length} skills, ${units.length} units, ${classes.length} classes
- ${itemComponents.length} distinct item component NIDs
- ${skillComponents.length} distinct skill component NIDs
- ${usedCustom.length}/${customComponents.length} custom Python components are
  referenced by current project data
- ${expressions.conditions.length} event conditions,
  ${expressions.evalSubstitutions.length} eval substitutions, and
  ${expressions.loops.length} event loops
- ${resourceFiles.length} resource files
- ${resourceAudit.checks} catalog-backed runtime resource checks,
  ${resourceAudit.requiredMissing.length} required files missing,
  ${resourceAudit.optionalMissing.length} unreferenced optional catalog entries
  missing, and ${resourceAudit.metadataOnly} command-only combat effects

## Resource audit

${table(resourceAudit.categories, [
  { key: 'nid', label: 'Category' },
  { key: 'uses', label: 'Checks' },
])}

### Missing required resources

${resourceAudit.requiredMissing.length > 0 ? table(resourceAudit.requiredMissing, [
  { key: 'category', label: 'Category' },
  { key: 'nid', label: 'NID' },
  { key: 'paths', label: 'Expected paths' },
]) : 'None.'}

### Missing optional catalog entries

${resourceAudit.optionalMissing.length > 0 ? table(resourceAudit.optionalMissing, [
  { key: 'category', label: 'Category' },
  { key: 'nid', label: 'NID' },
  { key: 'classification', label: 'Classification' },
]) : 'None.'}

## Structurally risky project-used item components

${table(riskyItems, [
  { key: 'nid', label: 'NID' },
  { key: 'uses', label: 'Uses' },
  { key: 'structuralStatus', label: 'Status' },
])}

## Structurally risky project-used skill components

${table(riskySkills, [
  { key: 'nid', label: 'NID' },
  { key: 'uses', label: 'Uses' },
  { key: 'structuralStatus', label: 'Status' },
])}

## Used project-local Python components

${table(usedCustom, [
  { key: 'kind', label: 'Kind' },
  { key: 'nid', label: 'NID' },
  { key: 'uses', label: 'Uses' },
  { key: 'hooks', label: 'Python hooks' },
])}

## Expression namespaces

${table(expressions.namespaces, [
  { key: 'nid', label: 'Namespace' },
  { key: 'uses', label: 'Occurrences' },
])}

## Event commands

${table(commands, [
  { key: 'nid', label: 'Command' },
  { key: 'uses', label: 'Uses' },
])}
`;

const json = `${JSON.stringify(manifest, null, 2)}\n`;
const generated = new Map([[outputJson, json], [outputMarkdown, markdown]]);

if (args.has('--write')) {
  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  for (const [file, contents] of generated) fs.writeFileSync(file, contents);
}

if (args.has('--check')) {
  const stale = [...generated].filter(([file, contents]) =>
    !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents);
  for (const [file] of stale) {
    console.error(`ERROR: ${path.relative(root, file)} is stale; run npm run audit:rekka:write`);
  }
  if (stale.length > 0) process.exitCode = 1;
}

console.log('# Rekka compatibility audit');
console.log(`- Levels/events: ${levels.length}/${events.length}`);
console.log(`- Item/skill component NIDs: ${itemComponents.length}/${skillComponents.length}`);
console.log(`- Used custom Python components: ${usedCustom.length}/${customComponents.length}`);
console.log(`- Conditions/evals/loops: ${expressions.conditions.length}/${expressions.evalSubstitutions.length}/${expressions.loops.length}`);
console.log(`- Structurally risky item/skill NIDs: ${riskyItems.length}/${riskySkills.length}`);
console.log(`- Resource checks/required missing/optional missing: ${resourceAudit.checks}/${resourceAudit.requiredMissing.length}/${resourceAudit.optionalMissing.length}`);
if (resourceAudit.requiredMissing.length > 0) process.exitCode = 1;
