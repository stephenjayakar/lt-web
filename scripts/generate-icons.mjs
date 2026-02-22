#!/usr/bin/env node
/**
 * Generate PWA icon PNGs (192x192 and 512x512) as minimal valid PNGs.
 * Uses only Node.js built-ins — no canvas dependency needed.
 * Creates a solid dark-blue square with a gold "LT" rendered as pixel art.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';

function createPng(size) {
  // Create RGBA pixel data: dark blue background with gold "LT" pixel art
  const pixels = new Uint8Array(size * size * 4);
  const bg = [10, 10, 46, 255];   // #0a0a2e
  const fg = [232, 212, 77, 255]; // #e8d44d (gold)

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = bg[0];
    pixels[i * 4 + 1] = bg[1];
    pixels[i * 4 + 2] = bg[2];
    pixels[i * 4 + 3] = bg[3];
  }

  // Draw "LT" as pixel art in the center
  // Each "pixel" of the letter is (size/16) actual pixels
  const u = Math.floor(size / 16);
  const ox = Math.floor(size / 2) - u * 4; // offset x
  const oy = Math.floor(size / 2) - u * 3; // offset y

  function drawBlock(bx, by) {
    for (let dy = 0; dy < u; dy++) {
      for (let dx = 0; dx < u; dx++) {
        const px = ox + bx * u + dx;
        const py = oy + by * u + dy;
        if (px >= 0 && px < size && py >= 0 && py < size) {
          const idx = (py * size + px) * 4;
          pixels[idx] = fg[0];
          pixels[idx + 1] = fg[1];
          pixels[idx + 2] = fg[2];
          pixels[idx + 3] = fg[3];
        }
      }
    }
  }

  // "L" (5 blocks tall, 3 wide at bottom)
  for (let y = 0; y < 5; y++) drawBlock(0, y);
  drawBlock(1, 4);
  drawBlock(2, 4);

  // "T" (3 wide at top, 1 center for 4 below)
  drawBlock(4, 0);
  drawBlock(5, 0);
  drawBlock(6, 0);
  for (let y = 1; y < 5; y++) drawBlock(5, y);

  // Build PNG file
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const combined = Buffer.concat([typeBytes, data]);
    const crcVal = crc32(combined);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, combined, crcBuf]);
  }

  // CRC32 table
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

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);  // width
  ihdr.writeUInt32BE(size, 4);  // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT — raw image data with filter byte per row
  const rawData = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rawData[y * (size * 4 + 1)] = 0; // filter: None
    pixels.copy
      ? Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4)
          .copy(rawData, y * (size * 4 + 1) + 1)
      : rawData.set(
          pixels.slice(y * size * 4, (y + 1) * size * 4),
          y * (size * 4 + 1) + 1,
        );
  }
  // Actually copy properly
  const rawBuf = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rawBuf[y * (size * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < size * 4; x++) {
      rawBuf[y * (size * 4 + 1) + 1 + x] = pixels[y * size * 4 + x];
    }
  }

  const compressed = deflateSync(rawBuf);

  // IEND
  const iend = Buffer.alloc(0);

  const png = Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', iend),
  ]);

  return png;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', createPng(192));
writeFileSync('public/icons/icon-512.png', createPng(512));
console.log('Generated public/icons/icon-192.png and public/icons/icon-512.png');
