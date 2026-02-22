/**
 * asset-bundle.ts — Client-side .ltproj asset bundle loader.
 *
 * Instead of making hundreds of individual HTTP requests for game data,
 * the entire .ltproj can be packed into a single zip file. This module:
 *
 * 1. Downloads the zip archive
 * 2. Extracts files into an in-memory store (Map<path, Blob>)
 * 3. Provides a BundledResourceManager that intercepts fetch calls
 *    and serves from the in-memory store
 *
 * The zip format is parsed manually using only built-in browser APIs
 * (no external zip library needed). Uses DecompressionStream for DEFLATE.
 *
 * Bundle creation: run `node scripts/bundle-assets.mjs <ltproj-path>`
 * to create the zip. The zip is served as a static file alongside the app.
 */

// ---------------------------------------------------------------------------
// Zip parser (minimal, handles the subset we need)
// ---------------------------------------------------------------------------

interface ZipEntry {
  filename: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;  // 0=stored, 8=deflate
  dataOffset: number;
}

/**
 * Parse a zip file's central directory to extract file entries.
 * We read the End of Central Directory record, then walk the central directory.
 */
function parseZipDirectory(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries: ZipEntry[] = [];

  // Find End of Central Directory record (signature 0x06054b50)
  // Search backwards from the end (comment may be up to 65535 bytes)
  let eocdOffset = -1;
  const searchStart = Math.max(0, bytes.length - 65535 - 22);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid zip: End of Central Directory not found');
  }

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);

  // Walk central directory entries (signature 0x02014b50)
  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`Invalid central directory entry at offset ${offset}`);
    }

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const filenameBytes = bytes.slice(offset + 46, offset + 46 + filenameLength);
    const filename = new TextDecoder().decode(filenameBytes);

    // Calculate actual data offset from local file header
    // Local header: signature(4) + version(2) + flags(2) + method(2) + time(2) + date(2) + crc(4) + compressed(4) + uncompressed(4) + nameLen(2) + extraLen(2) = 30 bytes + name + extra
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;

    // Skip directories
    if (!filename.endsWith('/')) {
      entries.push({
        filename,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        dataOffset,
      });
    }

    offset += 46 + filenameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Decompress a DEFLATE-compressed buffer using the browser's DecompressionStream.
 * Falls back to raw copy for stored (method=0) entries.
 */
async function decompressEntry(
  buffer: ArrayBuffer,
  entry: ZipEntry,
): Promise<Uint8Array> {
  const compressed = new Uint8Array(buffer, entry.dataOffset, entry.compressedSize);

  if (entry.compressionMethod === 0) {
    // Stored (no compression)
    return compressed.slice();
  }

  if (entry.compressionMethod === 8) {
    // DEFLATE — use DecompressionStream if available
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new DecompressionStream('deflate-raw');
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      // Write compressed data
      writer.write(compressed);
      writer.close();

      // Read decompressed output
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
      }

      // Concatenate
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }

    // Fallback: manual inflate (simplified for small files)
    throw new Error(
      'DecompressionStream not available — cannot extract DEFLATE entries. ' +
      'Use a modern browser (Chrome 80+, Firefox 113+, Safari 16.4+).'
    );
  }

  throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
}

// ---------------------------------------------------------------------------
// AssetBundle — in-memory store of extracted files
// ---------------------------------------------------------------------------

export interface BundleProgress {
  phase: 'downloading' | 'extracting' | 'caching' | 'done';
  loaded: number;  // bytes downloaded or files extracted
  total: number;   // total bytes or total files
  message: string;
}

export type ProgressCallback = (progress: BundleProgress) => void;

export class AssetBundle {
  /** Map from relative path (e.g. "game_data/items/Iron_Sword.json") to blob URL */
  private files: Map<string, string> = new Map();
  /** Map from relative path to raw data (for JSON parsing without re-fetching) */
  private rawData: Map<string, Uint8Array> = new Map();
  /** The project prefix stripped from filenames (e.g. "default.ltproj/") */
  private prefix: string = '';

  /**
   * Download and extract a zip bundle.
   *
   * @param url — URL of the zip file (e.g. "/bundles/default.ltproj.zip")
   * @param onProgress — optional progress callback
   */
  async load(url: string, onProgress?: ProgressCallback): Promise<void> {
    // --- Download ---
    onProgress?.({
      phase: 'downloading',
      loaded: 0,
      total: 0,
      message: 'Downloading asset bundle...',
    });

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download bundle: HTTP ${response.status}`);
    }

    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
    let buffer: ArrayBuffer;

    if (response.body && contentLength > 0) {
      // Stream download with progress
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress?.({
          phase: 'downloading',
          loaded,
          total: contentLength,
          message: `Downloading... ${formatSize(loaded)} / ${formatSize(contentLength)}`,
        });
      }

      // Concatenate chunks
      buffer = new ArrayBuffer(loaded);
      const combined = new Uint8Array(buffer);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      buffer = await response.arrayBuffer();
    }

    // --- Parse zip ---
    onProgress?.({
      phase: 'extracting',
      loaded: 0,
      total: 0,
      message: 'Parsing zip archive...',
    });

    const entries = parseZipDirectory(buffer);

    // Detect common prefix (e.g. "default.ltproj/")
    if (entries.length > 0) {
      const firstSlash = entries[0].filename.indexOf('/');
      if (firstSlash > 0) {
        const candidate = entries[0].filename.substring(0, firstSlash + 1);
        if (entries.every((e) => e.filename.startsWith(candidate))) {
          this.prefix = candidate;
        }
      }
    }

    // --- Extract ---
    const total = entries.length;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const data = await decompressEntry(buffer, entry);

      // Strip the common prefix to get the relative path
      let relPath = entry.filename;
      if (this.prefix && relPath.startsWith(this.prefix)) {
        relPath = relPath.substring(this.prefix.length);
      }

      // Store raw data
      this.rawData.set(relPath, data);

      // Create blob URL for image/audio access
      const mimeType = getMimeType(relPath);
      const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      this.files.set(relPath, blobUrl);

      if (i % 50 === 0 || i === total - 1) {
        onProgress?.({
          phase: 'extracting',
          loaded: i + 1,
          total,
          message: `Extracting... ${i + 1} / ${total} files`,
        });
      }
    }

    onProgress?.({
      phase: 'done',
      loaded: total,
      total,
      message: `Bundle loaded: ${total} files`,
    });
  }

  /**
   * Check if a file exists in the bundle.
   */
  has(path: string): boolean {
    return this.files.has(path);
  }

  /**
   * Get a blob URL for a file in the bundle.
   * Used for image/audio loading (can be assigned to img.src).
   */
  getBlobUrl(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  /**
   * Get the raw bytes of a file in the bundle.
   * Used for JSON parsing, text reading, etc.
   */
  getRaw(path: string): Uint8Array | null {
    return this.rawData.get(path) ?? null;
  }

  /**
   * Get a file as a string (UTF-8 decoded).
   */
  getText(path: string): string | null {
    const raw = this.rawData.get(path);
    if (!raw) return null;
    return new TextDecoder().decode(raw);
  }

  /**
   * Get a file as parsed JSON.
   */
  getJson<T>(path: string): T | null {
    const text = this.getText(path);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /**
   * List all files in the bundle.
   */
  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Get the total number of files.
   */
  get fileCount(): number {
    return this.files.size;
  }

  /**
   * Release all blob URLs and clear memory.
   */
  dispose(): void {
    for (const url of this.files.values()) {
      URL.revokeObjectURL(url);
    }
    this.files.clear();
    this.rawData.clear();
  }
}

// ---------------------------------------------------------------------------
// BundledResourceManager — wraps ResourceManager to serve from bundle
// ---------------------------------------------------------------------------

/**
 * Create a fetch override that intercepts requests and serves from the bundle.
 * This patches the global fetch so ResourceManager works transparently.
 *
 * Usage:
 *   const bundle = new AssetBundle();
 *   await bundle.load('/bundles/default.ltproj.zip');
 *   installBundleFetchInterceptor(bundle, '/game-data/default.ltproj');
 *   // Now new ResourceManager('/game-data/default.ltproj') reads from the bundle
 */
export function installBundleFetchInterceptor(
  bundle: AssetBundle,
  baseUrl: string,
): () => void {
  const normalizedBase = baseUrl.replace(/\/$/, '') + '/';
  const originalFetch = window.fetch;

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

    // Check if this request is for a bundled asset
    if (url.startsWith(normalizedBase)) {
      const relativePath = url.substring(normalizedBase.length);
      const raw = bundle.getRaw(relativePath);

      if (raw) {
        const mimeType = getMimeType(relativePath);
        return Promise.resolve(
          new Response(raw.buffer as ArrayBuffer, {
            status: 200,
            statusText: 'OK',
            headers: {
              'Content-Type': mimeType,
              'Content-Length': String(raw.length),
              'X-Served-From': 'asset-bundle',
            },
          })
        );
      }
      // File not in bundle — fall through to network
    }

    return originalFetch.call(window, input, init);
  } as typeof window.fetch;

  // Return a cleanup function to restore original fetch
  return () => {
    window.fetch = originalFetch;
  };
}

/**
 * Patch the Image loading to use bundle blob URLs.
 * This handles `img.src = url` assignments used by ResourceManager.loadImage().
 *
 * Unlike fetch interception, Image loading goes through the browser's native
 * loader, so we need to provide blob URLs.
 */
export function installBundleImageInterceptor(
  bundle: AssetBundle,
  baseUrl: string,
): () => void {
  const normalizedBase = baseUrl.replace(/\/$/, '') + '/';

  // Override Image constructor to intercept src assignments
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (!origDescriptor || !origDescriptor.set) {
    console.warn('[AssetBundle] Cannot intercept Image.src — falling back to fetch only');
    return () => {};
  }

  const origSrcSetter = origDescriptor.set;
  const origSrcGetter = origDescriptor.get!;

  // Store blob URL mappings so the getter returns the original URL
  const blobToOriginal = new WeakMap<HTMLImageElement, string>();

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    get() {
      return blobToOriginal.get(this) ?? origSrcGetter.call(this);
    },
    set(value: string) {
      if (typeof value === 'string' && value.startsWith(normalizedBase)) {
        const relativePath = value.substring(normalizedBase.length);
        const blobUrl = bundle.getBlobUrl(relativePath);
        if (blobUrl) {
          blobToOriginal.set(this, value);
          origSrcSetter.call(this, blobUrl);
          return;
        }
      }
      origSrcSetter.call(this, value);
    },
    configurable: true,
    enumerable: true,
  });

  return () => {
    Object.defineProperty(HTMLImageElement.prototype, 'src', origDescriptor);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.idx': 'application/octet-stream',
    '.txt': 'text/plain',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
