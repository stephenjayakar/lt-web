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

function explicitPythonNids(relativePath) {
  const nids = [];
  for (const file of walk(relativePath, '.py')) {
    nids.push(...matches(fs.readFileSync(file, 'utf8'), /^\s+nid\s*=\s*['"]([^'"]+)['"]/gm));
  }
  return new Set(nids);
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
  const blocks = source.matchAll(/^class\s+(\w+)\(EventCommand\):\n([\s\S]*?)(?=^class\s|\Z)/gm);
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

const pythonItemNids = explicitPythonNids('lt-maker/app/engine/item_components');
const pythonSkillNids = explicitPythonNids('lt-maker/app/engine/skill_components');
const itemHooks = matches(read('src/combat/item-system.ts'), /^export function\s+(\w+)/gm);
const skillHooks = matches(read('src/combat/skill-system.ts'), /^export function\s+(\w+)/gm);
const registeredStates = new Set(matches(main, /new\s+(\w+State)\s*\(/g));

const tsFiles = walk('src', '.ts');
const tsLines = tsFiles.reduce(
  (total, file) => total + fs.readFileSync(file, 'utf8').split(/\r?\n/).length,
  0,
);

const missingFromParser = [...pythonEventNids].filter((nid) => !validCommands.has(nid)).sort();
const missingFromDispatcher = [...pythonEventNids].filter((nid) => !eventCases.has(nid)).sort();
const summary = {
  pythonEventNids: pythonEventNids.size,
  parserRecognizedPythonNids: pythonEventNids.size - missingFromParser.length,
  dispatcherPythonNids: pythonEventNids.size - missingFromDispatcher.length,
  structuralStatuses: Object.fromEntries(
    [...new Set(commandManifest.map((command) => command.status))]
      .sort()
      .map((status) => [status, commandManifest.filter((command) => command.status === status).length]),
  ),
};

const manifestJson = `${JSON.stringify({
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

const jsonPath = path.join(root, 'docs/parity/event-commands.json');
const markdownPath = path.join(root, 'docs/parity/event-commands.md');

if (args.has('--write')) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, manifestJson);
  fs.writeFileSync(markdownPath, manifestMarkdown);
}

if (args.has('--check')) {
  const failures = [];
  if (!fs.existsSync(jsonPath) || fs.readFileSync(jsonPath, 'utf8') !== manifestJson) {
    failures.push('docs/parity/event-commands.json is stale; run npm run audit:parity:write');
  }
  if (!fs.existsSync(markdownPath) || fs.readFileSync(markdownPath, 'utf8') !== manifestMarkdown) {
    failures.push('docs/parity/event-commands.md is stale; run npm run audit:parity:write');
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
console.log(`- Python item component NIDs: ${pythonItemNids.size}; web item hook exports: ${itemHooks.length}`);
console.log(`- Python skill component NIDs: ${pythonSkillNids.size}; web skill hook exports: ${skillHooks.length}`);
console.log('');
console.log('## Event commands not recognized by the parser');
console.log(missingFromParser.join(', ') || '(none)');
console.log('');
console.log('## Event commands without an EventState case label');
console.log(missingFromDispatcher.join(', ') || '(none)');
console.log('');
console.log('Note: hook and case-label counts are inventories, not semantic parity claims.');
