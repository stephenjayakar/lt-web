import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUTPUT_JSON = path.join(ROOT, 'docs/parity/states.json');
const OUTPUT_MD = path.join(ROOT, 'docs/parity/states.md');

const MERGED = {
  ability_multi_item_choice: 'menu',
  ability_submenu_choice: 'menu',
  alert: 'event',
  attacker: 'combat',
  attacker_partner: 'combat',
  base_codex_child: 'base_codex',
  base_convos_child: 'base_convos',
  base_guide: 'base_codex',
  base_library: 'base_codex',
  base_market_select: 'shop',
  canto_wait: 'menu',
  chapter_title: 'event',
  class_change: 'item_use',
  class_change_choice: 'promotion_choice',
  combat_targeting: 'targeting',
  combat_trade: 'trade',
  defender: 'combat',
  defender_partner: 'combat',
  dying: 'combat',
  exp: 'combat',
  feat_choice: 'promotion_choice',
  init: 'combat',
  item: 'menu',
  item_child: 'menu',
  move_camera: 'movement',
  optimize_all_choice: 'prep_pick',
  option_child: 'option_menu',
  overworld_on_node: 'overworld',
  overworld_party_option_menu: 'overworld_game_option_menu',
  party_transfer_confirm: 'party_transfer',
  player_choice: 'event',
  prep_formation: 'prep_map',
  prep_formation_menu: 'prep_map',
  prep_formation_select: 'prep_map',
  prep_gba_main: 'prep_main',
  prep_gba_map: 'prep_map',
  prep_items: 'base_manage',
  prep_manage: 'base_manage',
  prep_manage_select: 'base_manage',
  prep_market: 'shop',
  prep_pick_units: 'prep_pick',
  prep_restock: 'supply_items',
  prep_trade: 'trade',
  prep_trade_select: 'trade',
  prep_use: 'item_use',
  promotion: 'promotion_choice',
  repair_shop: 'shop',
  spell_choice: 'weapon_choice',
  start_level_asset_loading: 'title',
  status_upkeep: 'phase_change',
  subitem_child: 'menu',
  text_confirm: 'text_entry',
  title_all_saves: 'load_menu',
  title_extras: 'title_main',
  title_load: 'load_menu',
  title_new: 'level_select',
  title_new_child: 'level_select',
  title_restart: 'load_menu',
  title_save: 'save_menu',
  title_start: 'title',
  title_wait: 'title',
  transition_double_pop: 'state-machine',
  transition_in: 'state-machine',
  transition_out: 'state-machine',
  transition_pop: 'state-machine',
  transition_to: 'state-machine',
  transition_to_with_pop: 'state-machine',
  unit_menu: 'menu',
  unlock_select: 'item_targeting',
  wait: 'menu',
};

const OPEN = new Set(['dialog_log', 'objective_menu']);

function walk(directory, extension) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, extension));
    else if (entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

function pythonStates() {
  const states = new Map();
  for (const file of walk(path.join(ROOT, 'lt-maker/app/engine'), '.py')) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const classMatch = lines[index].match(/^(\s*)class\s+(\w+)\(([^)]*State[^)]*)\)\s*:/);
      if (!classMatch) continue;
      const indent = classMatch[1].length;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const line = lines[cursor];
        if (line.trim() && line.search(/\S/) <= indent) break;
        const nameMatch = line.match(/^\s+name\s*=\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
          states.set(nameMatch[1], {
            className: classMatch[2],
            source: path.relative(ROOT, file),
          });
          break;
        }
      }
    }
  }
  return states;
}

function webStates() {
  const states = new Map();
  for (const file of walk(path.join(ROOT, 'src/engine'), '.ts')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/readonly name\s*=\s*['"]([^'"]+)['"]/g)) {
      states.set(match[1], path.relative(ROOT, file));
    }
  }
  return states;
}

function buildInventory() {
  const python = pythonStates();
  const web = webStates();
  const rows = [...python].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, info]) => {
      if (web.has(name)) {
        return { name, ...info, status: 'exact', webState: name, webSource: web.get(name) };
      }
      if (MERGED[name]) {
        const webState = MERGED[name];
        return {
          name,
          ...info,
          status: 'merged',
          webState,
          webSource: web.get(webState) ?? 'src/engine/state-machine.ts',
        };
      }
      if (OPEN.has(name)) {
        return { name, ...info, status: 'open', webState: null, webSource: null };
      }
      throw new Error(`Unclassified Python state: ${name}`);
    });
  return {
    generatedBy: 'scripts/state-parity.mjs',
    summary: {
      python: rows.length,
      exact: rows.filter((row) => row.status === 'exact').length,
      merged: rows.filter((row) => row.status === 'merged').length,
      open: rows.filter((row) => row.status === 'open').length,
      web: web.size,
    },
    rows,
  };
}

function markdown(inventory) {
  const { summary } = inventory;
  const lines = [
    '# Runtime state parity inventory',
    '',
    '> Generated by `npm run audit:states:write`; do not hand-edit.',
    '',
    `Python runtime states: **${summary.python}** · exact web states: **${summary.exact}** · documented mergers: **${summary.merged}** · open flows: **${summary.open}** · registered web states: **${summary.web}**`,
    '',
    '| Python state | Python class/source | Status | Web state/source |',
    '|---|---|---|---|',
  ];
  for (const row of inventory.rows) {
    const pythonCell = `${row.className}<br>${row.source}`;
    const webCell = row.webState ? `${row.webState}<br>${row.webSource}` : '—';
    lines.push(`| ${row.name} | ${pythonCell} | ${row.status} | ${webCell} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const inventory = buildInventory();
const json = `${JSON.stringify(inventory, null, 2)}\n`;
const md = markdown(inventory);
const write = process.argv.includes('--write');

if (write) {
  fs.writeFileSync(OUTPUT_JSON, json);
  fs.writeFileSync(OUTPUT_MD, md);
} else {
  for (const [file, expected] of [[OUTPUT_JSON, json], [OUTPUT_MD, md]]) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) {
      console.error(`${path.relative(ROOT, file)} is stale; run npm run audit:states:write`);
      process.exitCode = 1;
    }
  }
}

console.log(
  `States: ${inventory.summary.python} Python; ${inventory.summary.exact} exact; ` +
  `${inventory.summary.merged} merged; ${inventory.summary.open} open; ${inventory.summary.web} web`,
);
