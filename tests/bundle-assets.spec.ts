/**
 * scripts/bundle-assets.mjs: the packaged campaign zip must use '/' entry
 * names on every OS. AssetBundle looks files up by URL path, so a bundle
 * built on Windows with '\' separators loaded but every lookup 404'd.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Entry names from the zip's central directory. */
function zipEntryNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    names.push(buf.toString('utf8', i + 46, i + 46 + nameLen));
    i += 45 + nameLen + extraLen + commentLen;
  }
  return names;
}

test('bundle-assets writes posix zip entry names', () => {
  const root = mkdtempSync(join(tmpdir(), 'lt-bundle-'));
  try {
    const proj = join(root, 'demo.ltproj');
    mkdirSync(join(proj, 'game_data', 'levels'), { recursive: true });
    writeFileSync(join(proj, 'metadata.json'), '{}');
    writeFileSync(join(proj, 'game_data', 'constants.json'), '[]');
    writeFileSync(join(proj, 'game_data', 'levels', '0.json'), '{}');
    const out = join(root, 'demo.zip');
    execFileSync(process.execPath, ['scripts/bundle-assets.mjs', proj, out], { stdio: 'pipe' });
    const names = zipEntryNames(readFileSync(out)).sort();
    expect(names).toEqual([
      'demo.ltproj/game_data/constants.json',
      'demo.ltproj/game_data/levels/0.json',
      'demo.ltproj/metadata.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
