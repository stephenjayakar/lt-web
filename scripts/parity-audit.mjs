import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function walk(relativePath, suffix) {
  const base = path.join(root, relativePath);
  const files = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const absolute = path.join(base, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path.relative(root, absolute), suffix));
    } else if (entry.name.endsWith(suffix)) {
      files.push(absolute);
    }
  }
  return files;
}

function matches(text, expression) {
  return [...text.matchAll(expression)].map((match) => match[1]);
}

const eventCommands = read('lt-maker/app/events/event_commands.py');
const eventFunctions = read('lt-maker/app/events/event_functions.py');
const eventManager = read('src/events/event-manager.ts');
const gameStates = read('src/engine/states/game-states.ts');
const main = read('src/main.ts');

const pythonEventNids = new Set(matches(eventCommands, /^\s+nid\s*=\s*['"]([^'"]+)['"]/gm));
const validBlock = eventManager.match(/const VALID_COMMANDS.*?new Set<string>\(\[(.*?)\]\);/s)?.[1] ?? '';
const validCommands = new Set(matches(validBlock, /'([^']+)'/g));
const eventStateSource = gameStates.slice(gameStates.indexOf('export class EventState'));
const eventCases = new Set(matches(eventStateSource, /case\s+['"]([^'"]+)['"]/g));
const aliasBlock = eventManager.match(/const COMMAND_ALIASES.*?=\s*\{(.*?)\};/s)?.[1] ?? '';
const commandAliases = new Map(
  [...aliasBlock.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((match) => [match[1], match[2]]),
);
const blockingBlock = gameStates.match(/const BLOCKING_COMMANDS.*?new Set\(\[(.*?)\]\);/s)?.[1] ?? '';
const blockingCommands = new Set(matches(blockingBlock, /'([^']+)'/g));
const testSource = read('tests/harness.spec.ts');

function parsePythonStringList(body, field) {
  const source = body.match(new RegExp(`^\\s+${field}\\s*=\\s*\\[(.*?)\\]`, 'ms'))?.[1] ?? '';
  return matches(source, /['"]([^'"]+)['"]/g);
}

function parseEventCommandMetadata(source) {
  const commands = [];
  const normalized = source.replace(/\r\n/g, '\n');
  const blocks = normalized.matchAll(/^class\s+(\w+)\(EventCommand\):\n([\s\S]*?)(?=^class\s|(?![\s\S]))/gm);
  for (const match of blocks) {
    const body = match[2];
    const nid = body.match(/^\s+nid\s*=\s*['"]([^'"]+)['"]/m)?.[1];
    if (!nid) continue;
    commands.push({
      nid,
      pythonClass: match[1],
      nickname: body.match(/^\s+nickname\s*=\s*['"]([^'"]+)['"]/m)?.[1] ?? null,
      tag: body.match(/^\s+tag\s*=\s*Tags\.(\w+)/m)?.[1] ?? null,
      keywords: parsePythonStringList(body, 'keywords'),
      optionalKeywords: parsePythonStringList(body, 'optional_keywords'),
      flags: parsePythonStringList(body, '_flags'),
    });
  }
  return commands;
}

function findStubHints(source) {
  const result = new Set();
  const marker = /not yet implemented|skip for now|stub for now|ignored for now/gi;
  for (const match of source.matchAll(marker)) {
    const prefix = source.slice(Math.max(0, match.index - 900), match.index);
    const groupStart = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('return false;'));
    for (const nid of matches(prefix.slice(groupStart), /case\s+['"]([^'"]+)['"]/g)) result.add(nid);
  }
  return result;
}

const stubHints = findStubHints(eventStateSource);
const commandMetadata = parseEventCommandMetadata(eventCommands);
const pythonEventHandlers = new Map(
  [...eventFunctions.matchAll(/^def\s+(\w+)\s*\(/gm)].map((match) => [
    match[1],
    eventFunctions.slice(0, match.index).split('\n').length,
  ]),
);

function commandStatus(command) {
  if (!validCommands.has(command.nid)) return 'missing-parser';
  if (!eventCases.has(command.nid)) return 'missing-dispatch';
  if (stubHints.has(command.nid)) return 'stub-hint';
  return 'dispatched-unverified';
}

const commandManifest = commandMetadata.map((command) => ({
  ...command,
  pythonHandler: pythonEventHandlers.has(command.nid)
    ? {
        function: command.nid,
        source: 'lt-maker/app/events/event_functions.py',
        line: pythonEventHandlers.get(command.nid),
      }
    : null,
  parserRecognized: validCommands.has(command.nid),
  nicknameRecognized: command.nickname
    ? commandAliases.get(command.nickname) === command.nid || validCommands.has(command.nickname)
    : null,
  dispatcherCase: eventCases.has(command.nid),
  webBlocking: blockingCommands.has(command.nid),
  lexicalTestMention: testSource.includes(command.nid),
  status: commandStatus(command),
}));

const registeredStates = new Set(matches(main, /new\s+(\w+State)\s*\(/g));

const tsFiles = walk('src', '.ts');
const tsLines = tsFiles.reduce(
  (total, file) => total + fs.readFileSync(file, 'utf8').split(/\r?\n/).length,
  0,
);

function camelToSnake(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function parsePythonComponents(relativePath) {
  const components = [];
  for (const file of walk(relativePath, '.py').sort()) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const classes = [...source.matchAll(/^([ \t]*)class\s+(\w+)\(([^)]*)\):\n/gm)];
    for (let index = 0; index < classes.length; index += 1) {
      const match = classes[index];
      const indent = match[1].length;
      const nextPeer = classes.slice(index + 1).find((candidate) => candidate[1].length <= indent);
      const body = source.slice(match.index + match[0].length, nextPeer?.index ?? source.length);
      const memberIndent = ' '.repeat(indent + 4);
      const nid = body.match(new RegExp(`^${memberIndent}nid\\s*=\\s*['"]([^'"]+)['"]`, 'm'))?.[1];
      if (!nid) continue;
      components.push({
        nid,
        pythonClass: match[2],
        bases: match[3].split(',').map((base) => base.trim()).filter(Boolean),
        tag: body.match(new RegExp(`^${memberIndent}tag\\s*=\\s*(?:ItemTags|SkillTags)\\.(\\w+)`, 'm'))?.[1] ?? null,
        directMethods: [...new Set(matches(body, new RegExp(`^${memberIndent}def\\s+(\\w+)\\s*\\(`, 'gm')))]
          .filter((method) => !method.startsWith('_')),
        source: path.relative(root, file),
        line: source.slice(0, match.index).split('\n').length,
      });
    }
  }
  const byClass = new Map(components.map((component) => [component.pythonClass, component]));
  const resolveMethods = (component, seen = new Set()) => {
    if (component.methods) return component.methods;
    if (seen.has(component.pythonClass)) return component.directMethods;
    const nextSeen = new Set(seen).add(component.pythonClass);
    const inherited = component.bases.flatMap((base) => {
      const parent = byClass.get(base);
      return parent ? resolveMethods(parent, nextSeen) : [];
    });
    component.methods = [...new Set([...inherited, ...component.directMethods])];
    return component.methods;
  };
  for (const component of components) resolveMethods(component);
  return components;
}

function exactLiteralLocations(nid) {
  const escaped = nid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`['"]${escaped}['"]`, 'g');
  const locations = [];
  for (const file of tsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(expression)) {
      const prefix = source.slice(0, match.index);
      locations.push({
        source: path.relative(root, file),
        line: prefix.split('\n').length,
      });
    }
  }
  return locations;
}

function hasExactLiteral(source, nid) {
  const escaped = nid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"]${escaped}['"]`).test(source);
}

function buildComponentManifest(kind, relativePath, webSystemPath) {
  const components = parsePythonComponents(relativePath);
  const webHooks = matches(read(webSystemPath), /^export function\s+(\w+)/gm);
  const hooksBySnake = new Map(webHooks.map((hook) => [camelToSnake(hook), hook]));
  const rows = components.map((component) => {
    const webReferences = exactLiteralLocations(component.nid);
    const matchingWebHooks = [...new Set(component.methods
      .map((method) => hooksBySnake.get(method))
      .filter(Boolean))];
    let status = 'unreferenced';
    if (webReferences.length > 0 && matchingWebHooks.length > 0) status = 'hook-and-reference';
    else if (matchingWebHooks.length > 0) status = 'hook-only';
    else if (webReferences.length > 0) status = 'reference-only';
    return {
      ...component,
      webReferences,
      matchingWebHooks,
      lexicalTestMention: hasExactLiteral(testSource, component.nid),
      status,
    };
  });
  const componentSummary = {
    pythonComponentNids: rows.length,
    webHookExports: webHooks.length,
    referencedComponentNids: rows.filter((row) => row.webReferences.length > 0).length,
    hookMappedComponentNids: rows.filter((row) => row.matchingWebHooks.length > 0).length,
    unreferencedComponentNids: rows.filter((row) => row.webReferences.length === 0).length,
    structuralStatuses: Object.fromEntries(
      [...new Set(rows.map((row) => row.status))]
        .sort()
        .map((status) => [status, rows.filter((row) => row.status === status).length]),
    ),
  };
  return { kind, relativePath, webSystemPath, webHooks, rows, summary: componentSummary };
}

const itemComponents = buildComponentManifest(
  'item',
  'lt-maker/app/engine/item_components',
  'src/combat/item-system.ts',
);
const skillComponents = buildComponentManifest(
  'skill',
  'lt-maker/app/engine/skill_components',
  'src/combat/skill-system.ts',
);

const missingFromParser = [...pythonEventNids].filter((nid) => !validCommands.has(nid)).sort();
const missingFromDispatcher = [...pythonEventNids].filter((nid) => !eventCases.has(nid)).sort();
const summary = {
  pythonEventNids: pythonEventNids.size,
  parserRecognizedPythonNids: pythonEventNids.size - missingFromParser.length,
  dispatcherPythonNids: pythonEventNids.size - missingFromDispatcher.length,
  itemReferencedComponentNids: itemComponents.summary.referencedComponentNids,
  itemHookMappedComponentNids: itemComponents.summary.hookMappedComponentNids,
  skillReferencedComponentNids: skillComponents.summary.referencedComponentNids,
  skillHookMappedComponentNids: skillComponents.summary.hookMappedComponentNids,
  structuralStatuses: Object.fromEntries(
    [...new Set(commandManifest.map((command) => command.status))]
      .sort()
      .map((status) => [status, commandManifest.filter((command) => command.status === status).length]),
  ),
};

const eventManifestJson = `${JSON.stringify({
  sources: [
    'lt-maker/app/events/event_commands.py',
    'lt-maker/app/events/event_functions.py',
  ],
  summary,
  commands: commandManifest,
}, null, 2)}\n`;

function md(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const manifestRows = commandManifest.map((command) => [
  command.nid,
  command.pythonClass,
  command.pythonHandler ? `${command.pythonHandler.function}:${command.pythonHandler.line}` : '',
  command.tag ?? '',
  command.nickname ?? '',
  [...command.keywords, ...command.optionalKeywords.map((keyword) => `${keyword}?`)].join(', '),
  command.flags.join(', '),
  command.parserRecognized ? 'yes' : 'no',
  command.dispatcherCase ? 'yes' : 'no',
  command.webBlocking ? 'yes' : 'no',
  command.lexicalTestMention ? 'mention' : '',
  command.status,
].map(md));
const manifestMarkdown = [
  '# Event Command Parity Manifest',
  '',
  'Generated by `npm run audit:parity:write` from the checked-in Python command metadata and web source.',
  'Structural status is not a semantic parity claim; `lexicalTestMention` only means the NID appears in the test file.',
  '',
  `Summary: ${summary.parserRecognizedPythonNids}/${summary.pythonEventNids} parser-recognized; ${summary.dispatcherPythonNids}/${summary.pythonEventNids} with dispatcher cases.`,
  '',
  '| NID | Python class | Python handler:line | Tag | Nickname | Arguments | Flags | Parser | Dispatcher | Web blocking | Test | Structural status |',
  '|---|---|---|---|---|---|---|---:|---:|---:|---|---|',
  ...manifestRows.map((row) => `| ${row.join(' | ')} |`),
  '',
].join('\n');

function componentManifestJson(manifest) {
  return `${JSON.stringify({
    sources: [manifest.relativePath, manifest.webSystemPath, 'src/**/*.ts'],
    summary: manifest.summary,
    webHookExports: manifest.webHooks,
    components: manifest.rows,
  }, null, 2)}\n`;
}

function componentManifestMarkdown(manifest) {
  const title = manifest.kind === 'item' ? 'Item' : 'Skill';
  const rows = manifest.rows.map((component) => {
    const references = component.webReferences
      .slice(0, 3)
      .map((reference) => `${reference.source}:${reference.line}`);
    if (component.webReferences.length > 3) references.push(`+${component.webReferences.length - 3} more`);
    return [
      component.nid,
      component.pythonClass,
      `${component.source}:${component.line}`,
      component.tag ?? '',
      component.methods.join(', '),
      component.matchingWebHooks.join(', '),
      references.join('<br>'),
      component.lexicalTestMention ? 'mention' : '',
      component.status,
    ].map(md);
  });
  return [
    `# ${title} Component Parity Manifest`,
    '',
    'Generated by `npm run audit:parity:write` from Python component classes and exact TypeScript string references.',
    'Hook/reference status is structural discovery evidence, not a semantic parity claim.',
    '',
    `Summary: ${manifest.summary.referencedComponentNids}/${manifest.summary.pythonComponentNids} referenced in web source; ${manifest.summary.hookMappedComponentNids}/${manifest.summary.pythonComponentNids} expose at least one matching web hook.`,
    '',
    '| NID | Python class | Python source | Tag | Python hooks | Matching web hooks | Exact web references | Test | Structural status |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n');
}

const jsonPath = path.join(root, 'docs/parity/event-commands.json');
const markdownPath = path.join(root, 'docs/parity/event-commands.md');
const itemJsonPath = path.join(root, 'docs/parity/item-components.json');
const itemMarkdownPath = path.join(root, 'docs/parity/item-components.md');
const skillJsonPath = path.join(root, 'docs/parity/skill-components.json');
const skillMarkdownPath = path.join(root, 'docs/parity/skill-components.md');
const generatedFiles = new Map([
  [jsonPath, eventManifestJson],
  [markdownPath, manifestMarkdown],
  [itemJsonPath, componentManifestJson(itemComponents)],
  [itemMarkdownPath, componentManifestMarkdown(itemComponents)],
  [skillJsonPath, componentManifestJson(skillComponents)],
  [skillMarkdownPath, componentManifestMarkdown(skillComponents)],
]);

if (args.has('--write')) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  for (const [file, contents] of generatedFiles) fs.writeFileSync(file, contents);
}

if (args.has('--check')) {
  const failures = [];
  for (const [file, contents] of generatedFiles) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents) {
      failures.push(`${path.relative(root, file)} is stale; run npm run audit:parity:write`);
    }
  }
  const baseline = JSON.parse(read('scripts/parity-baseline.json'));
  for (const [key, minimum] of Object.entries(baseline.minimums)) {
    if ((summary[key] ?? 0) < minimum) failures.push(`${key} regressed: ${summary[key] ?? 0} < ${minimum}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`ERROR: ${failure}`);
    process.exitCode = 1;
  }
}

console.log('# Lex Talionis parity audit');
console.log('');
console.log(`- TypeScript source: ${tsFiles.length} files, ${tsLines} lines`);
console.log(`- Registered web states: ${registeredStates.size}`);
console.log(`- Python event-command NIDs: ${pythonEventNids.size}`);
console.log(`- Parser-recognized command names: ${validCommands.size}`);
console.log(`- Python commands recognized by parser: ${pythonEventNids.size - missingFromParser.length}/${pythonEventNids.size}`);
console.log(`- Python commands with EventState case labels: ${pythonEventNids.size - missingFromDispatcher.length}/${pythonEventNids.size}`);
console.log(`- Python item component NIDs: ${itemComponents.summary.pythonComponentNids}; exact web references: ${itemComponents.summary.referencedComponentNids}; matching hook surfaces: ${itemComponents.summary.hookMappedComponentNids}`);
console.log(`- Python skill component NIDs: ${skillComponents.summary.pythonComponentNids}; exact web references: ${skillComponents.summary.referencedComponentNids}; matching hook surfaces: ${skillComponents.summary.hookMappedComponentNids}`);
console.log('');
console.log('## Event commands not recognized by the parser');
console.log(missingFromParser.join(', ') || '(none)');
console.log('');
console.log('## Event commands without an EventState case label');
console.log(missingFromDispatcher.join(', ') || '(none)');
console.log('');
console.log('Note: hook and case-label counts are inventories, not semantic parity claims.');
