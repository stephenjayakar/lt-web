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
import { join, relative, dirname, basename } from 'path';
import { deflateRawSync } from 'zlib';

// ---------------------------------------------------------------------------
// Zip file writer (minimal implementation)
// ---------------------------------------------------------------------------

class ZipWriter {
  constructor() {
    /** @type {{ header: Buffer, data: Buffer, filename: string, crc: number, compressedSize: number, uncompressedSize: number, offset: number, compressionMethod: number }[]} */
    this.entries = [];
    this.offset = 0;
    /** @type {Buffer[]} */
    this.parts = [];
  }

  /**
   * Add a file to the zip.
   * @param {string} filename — path within the zip
   * @param {Buffer} data — file contents
   */
  addFile(filename, data) {
    const crc = crc32(data);
    const uncompressedSize = data.length;

    // Try to compress with DEFLATE
    let compressionMethod = 8; // DEFLATE
    let compressedData = deflateRawSync(data, { level: 6 });

    // If compression didn't help, store uncompressed
    if (compressedData.length >= data.length) {
      compressionMethod = 0; // STORED
      compressedData = data;
    }

    const compressedSize = compressedData.length;
    const filenameBuffer = Buffer.from(filename, 'utf-8');

    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);  // signature
    localHeader.writeUInt16LE(20, 4);           // version needed
    localHeader.writeUInt16LE(0, 6);            // general purpose flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);           // last mod time
    localHeader.writeUInt16LE(0, 12);           // last mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(filenameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);           // extra field length

    const entryOffset = this.offset;

    this.parts.push(localHeader, filenameBuffer, compressedData);
    this.offset += localHeader.length + filenameBuffer.length + compressedData.length;

    this.entries.push({
      filename,
      crc,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      offset: entryOffset,
    });
  }

  /**
   * Finalize and return the complete zip file as a Buffer.
   * @returns {Buffer}
   */
  finalize() {
    const centralDirParts = [];
    const cdStart = this.offset;

    for (const entry of this.entries) {
      const filenameBuffer = Buffer.from(entry.filename, 'utf-8');
      const cdEntry = Buffer.alloc(46);

      cdEntry.writeUInt32LE(0x02014b50, 0);   // central dir signature
      cdEntry.writeUInt16LE(20, 4);            // version made by
      cdEntry.writeUInt16LE(20, 6);            // version needed
      cdEntry.writeUInt16LE(0, 8);             // flags
      cdEntry.writeUInt16LE(entry.compressionMethod, 10);
      cdEntry.writeUInt16LE(0, 12);            // last mod time
      cdEntry.writeUInt16LE(0, 14);            // last mod date
      cdEntry.writeUInt32LE(entry.crc, 16);
      cdEntry.writeUInt32LE(entry.compressedSize, 20);
      cdEntry.writeUInt32LE(entry.uncompressedSize, 24);
      cdEntry.writeUInt16LE(filenameBuffer.length, 28);
      cdEntry.writeUInt16LE(0, 30);            // extra field length
      cdEntry.writeUInt16LE(0, 32);            // file comment length
      cdEntry.writeUInt16LE(0, 34);            // disk number start
      cdEntry.writeUInt16LE(0, 36);            // internal file attributes
      cdEntry.writeUInt32LE(0, 38);            // external file attributes
      cdEntry.writeUInt32LE(entry.offset, 42); // relative offset of local header

      centralDirParts.push(cdEntry, filenameBuffer);
    }

    const centralDir = Buffer.concat(centralDirParts);
    const cdSize = centralDir.length;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);         // EOCD signature
    eocd.writeUInt16LE(0, 4);                  // disk number
    eocd.writeUInt16LE(0, 6);                  // CD start disk
    eocd.writeUInt16LE(this.entries.length, 8); // entries on this disk
    eocd.writeUInt16LE(this.entries.length, 10); // total entries
    eocd.writeUInt32LE(cdSize, 12);            // central dir size
    eocd.writeUInt32LE(cdStart, 16);           // central dir offset
    eocd.writeUInt16LE(0, 20);                 // comment length

    return Buffer.concat([...this.parts, centralDir, eocd]);
  }
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

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
  const relativePath = relative(ltprojPath, filePath);
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
