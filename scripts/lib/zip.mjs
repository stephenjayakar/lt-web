/**
 * zip.mjs — Minimal deterministic zip writer shared by the asset scripts.
 *
 * Entries carry zeroed timestamps and no extra fields, so identical input
 * (same names, same bytes, same order) always produces identical archive
 * bytes. The asset-pack uploader relies on that: a pack's content hash only
 * changes when one of its files does.
 *
 * The reader is src/data/asset-bundle.ts (STORED and DEFLATE entries only).
 * Only uses Node.js built-ins.
 */

import { deflateRawSync } from 'zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

export function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class ZipWriter {
  constructor() {
    /** @type {{ filename: string, crc: number, compressedSize: number, uncompressedSize: number, compressionMethod: number, offset: number }[]} */
    this.entries = [];
    this.offset = 0;
    /** @type {Buffer[]} */
    this.parts = [];
  }

  /**
   * Add a file to the zip.
   * @param {string} filename — path within the zip
   * @param {Buffer} data — file contents
   * @param {{ compress?: boolean }} [options] — compress=false always STOREs
   *   (for already-compressed media, where DEFLATE only costs time)
   */
  addFile(filename, data, options = {}) {
    const crc = crc32(data);
    const uncompressedSize = data.length;

    let compressionMethod = 0; // STORED
    let compressedData = data;
    if (options.compress !== false) {
      const deflated = deflateRawSync(data, { level: 6 });
      // Keep DEFLATE only when it actually helps.
      if (deflated.length < data.length) {
        compressionMethod = 8;
        compressedData = deflated;
      }
    }

    const compressedSize = compressedData.length;
    const filenameBuffer = Buffer.from(filename, 'utf-8');

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
    if (this.entries.length > 0xFFFF || this.offset > 0xFFFFFFFF) {
      throw new Error('zip too large for the non-zip64 format');
    }
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

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);           // EOCD signature
    eocd.writeUInt16LE(0, 4);                    // disk number
    eocd.writeUInt16LE(0, 6);                    // CD start disk
    eocd.writeUInt16LE(this.entries.length, 8);  // entries on this disk
    eocd.writeUInt16LE(this.entries.length, 10); // total entries
    eocd.writeUInt32LE(centralDir.length, 12);   // central dir size
    eocd.writeUInt32LE(cdStart, 16);             // central dir offset
    eocd.writeUInt16LE(0, 20);                   // comment length

    return Buffer.concat([...this.parts, centralDir, eocd]);
  }
}
