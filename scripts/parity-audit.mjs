import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

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
const eventManager = read('src/events/event-manager.ts');
const gameStates = read('src/engine/states/game-states.ts');
const main = read('src/main.ts');

const pythonEventNids = new Set(matches(eventCommands, /^\s+nid\s*=\s*['"]([^'"]+)['"]/gm));
const validBlock = eventManager.match(/const VALID_COMMANDS.*?new Set<string>\(\[(.*?)\]\);/s)?.[1] ?? '';
const validCommands = new Set(matches(validBlock, /'([^']+)'/g));
const eventStateSource = gameStates.slice(gameStates.indexOf('export class EventState'));
const eventCases = new Set(matches(eventStateSource, /case\s+['"]([^'"]+)['"]/g));

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
