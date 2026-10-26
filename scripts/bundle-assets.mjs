#!/usr/bin/env node
/**
 * bundle-assets.mjs — Pack a .ltproj directory into a single zip file.
 *
 * Usage:
 *   node scripts/bundle-assets.mjs [ltproj-path] [output-path]
 *
 * Defaults:
 *   ltproj-path: lt-maker/default.ltproj
 *   output-path: public/bundles/default.ltproj.zip
 *
 * The zip contains all files from the .ltproj directory, preserving the
 * directory structure. The top-level directory in the zip matches the
 * .ltproj directory name (e.g., "default.ltproj/game_data/items/...").
 *
 * Only uses Node.js built-ins (fs, path, zlib) — no external dependencies.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative, dirname, basename, sep } from 'path';
import { ZipWriter } from './lib/zip.mjs';

// ---------------------------------------------------------------------------
// Walk directory recursively
// ---------------------------------------------------------------------------

function* walkDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const ltprojPath = args[0] || 'lt-maker/default.ltproj';
const outputPath = args[1] || 'public/bundles/default.ltproj.zip';

// Validate input
try {
  const stat = statSync(ltprojPath);
  if (!stat.isDirectory()) {
    console.error(`Error: ${ltprojPath} is not a directory`);
    process.exit(1);
  }
} catch {
  console.error(`Error: ${ltprojPath} does not exist`);
  console.error('Make sure you have the lt-maker directory with a .ltproj project.');
  process.exit(1);
}

console.log(`Bundling ${ltprojPath} -> ${outputPath}`);

const zip = new ZipWriter();
const projectName = basename(ltprojPath); // e.g., "default.ltproj"
let fileCount = 0;
let totalSize = 0;

for (const filePath of walkDir(ltprojPath)) {
  // Zip entry names always use '/' (on Windows, relative() yields '\').
  const relativePath = relative(ltprojPath, filePath).split(sep).join('/');
  const zipPath = `${projectName}/${relativePath}`;
  const data = readFileSync(filePath);

  zip.addFile(zipPath, data);
  fileCount++;
  totalSize += data.length;

  if (fileCount % 100 === 0) {
    console.log(`  ... ${fileCount} files processed`);
  }
}

console.log(`\nTotal: ${fileCount} files, ${(totalSize / 1024 / 1024).toFixed(1)} MB uncompressed`);

// Write output
mkdirSync(dirname(outputPath), { recursive: true });
const zipData = zip.finalize();
writeFileSync(outputPath, zipData);

console.log(`Bundle: ${(zipData.length / 1024 / 1024).toFixed(1)} MB compressed`);
console.log(`Compression ratio: ${((1 - zipData.length / totalSize) * 100).toFixed(1)}%`);
console.log(`\nDone! Bundle saved to ${outputPath}`);
