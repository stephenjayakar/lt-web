/**
 * manifest.ts — The hosted asset-pack manifest (served by Convex at
 * GET /pack/manifest, built by scripts/upload-packs.mjs) and the chunk helpers
 * shared by the loader and tests.
 *
 * A pack is a zip of whole files whose entry names are paths relative to
 * /game-data/. It is stored as one or more chunks (≤ 16 MiB, the unit served
 * by one Convex HTTP response), each addressed by the SHA-256 of its bytes.
 */

export type PackLoad = 'boot' | 'background' | 'demand';

export interface PackChunkRef {
  hash: string;
  size: number;
}

export interface PackInfo {
  name: string;
  load: PackLoad;
  /** SHA-256 of the whole pack (the zip) */
  hash: string;
  size: number;
  fileCount: number;
  /** Paths (relative to /game-data/) — present for lazy packs */
  files?: string[];
  chunks: PackChunkRef[];
}

export interface PackManifest {
  project: string | null;
  packs: PackInfo[];
}

const HASH = /^[0-9a-f]{64}$/;
const LOADS: readonly PackLoad[] = ['boot', 'background', 'demand'];

/** Validate an untrusted manifest. Throws with a readable message. */
export function parseManifest(value: unknown): PackManifest {
  const bad = (why: string): never => {
    throw new Error(`Invalid asset manifest: ${why}`);
  };
  if (!value || typeof value !== 'object') bad('not an object');
  const raw = value as { project?: unknown; packs?: unknown };
  if (raw.project !== null && raw.project !== undefined && typeof raw.project !== 'string') bad('project');
  if (!Array.isArray(raw.packs)) bad('packs');
  const packs = (raw.packs as unknown[]).map((p, i): PackInfo => {
    const pack = (p ?? {}) as Record<string, unknown>;
    const where = `pack ${i}`;
    if (typeof pack.name !== 'string' || !pack.name) bad(`${where} name`);
    if (!LOADS.includes(pack.load as PackLoad)) bad(`${where} load`);
    if (typeof pack.hash !== 'string' || !HASH.test(pack.hash)) bad(`${where} hash`);
    if (typeof pack.size !== 'number' || pack.size < 0) bad(`${where} size`);
    if (!Array.isArray(pack.chunks) || pack.chunks.length === 0) bad(`${where} chunks`);
    const chunks = (pack.chunks as unknown[]).map((c): PackChunkRef => {
      const chunk = (c ?? {}) as Record<string, unknown>;
      if (typeof chunk.hash !== 'string' || !HASH.test(chunk.hash)) bad(`${where} chunk hash`);
      if (typeof chunk.size !== 'number' || chunk.size < 0) bad(`${where} chunk size`);
      return { hash: chunk.hash as string, size: chunk.size as number };
    });
    if (chunks.reduce((n, c) => n + c.size, 0) !== pack.size) bad(`${where} chunk sizes`);
    let files: string[] | undefined;
    if (pack.files !== undefined) {
      if (!Array.isArray(pack.files) || !pack.files.every((f) => typeof f === 'string')) bad(`${where} files`);
      files = pack.files as string[];
    }
    if (pack.load !== 'boot' && !files?.length) bad(`${where} lazy pack without files`);
    return {
      name: pack.name as string,
      load: pack.load as PackLoad,
      hash: pack.hash as string,
      size: pack.size as number,
      fileCount: typeof pack.fileCount === 'number' ? pack.fileCount : files?.length ?? 0,
      ...(files ? { files } : {}),
      chunks,
    };
  });
  return { project: (raw.project as string | null | undefined) ?? null, packs };
}

/** Concatenate chunk bytes into one buffer (the pack). */
export function joinChunks(parts: readonly Uint8Array[]): ArrayBuffer {
  if (parts.length === 1 && parts[0].byteOffset === 0 && parts[0].byteLength === parts[0].buffer.byteLength
    && parts[0].buffer instanceof ArrayBuffer) {
    return parts[0].buffer;
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out.buffer;
}

/** Split bytes into ≤ max slices (mirror of scripts/lib/asset-packs.mjs). */
export function splitChunks(data: Uint8Array, max: number): Uint8Array[] {
  if (!(max > 0)) throw new Error('chunk size must be positive');
  const out: Uint8Array[] = [];
  for (let o = 0; o < data.byteLength; o += max) out.push(data.subarray(o, Math.min(o + max, data.byteLength)));
  if (out.length === 0) out.push(data.subarray(0, 0));
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
