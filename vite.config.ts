import { defineConfig } from 'vite';
import { resolve, join, extname } from 'path';
import { createReadStream, stat, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Scan lt-maker/ and public/game-data/ for .ltproj directories at startup.
 * The result is injected as a compile-time constant via Vite's `define`.
 */
function discoverProjects(): string[] {
  const projects = new Set<string>();
  const dirs = [
    resolve(__dirname, 'lt-maker'),
    resolve(__dirname, 'public/game-data'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.endsWith('.ltproj')) {
          projects.add(entry.name);
        }
      }
    } catch { /* ignore */ }
  }
  return [...projects].sort();
}

// MIME types for game assets
const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.idx': 'application/octet-stream',
  '.txt': 'text/plain',
  '.html': 'text/html',
};

/**
 * Vite plugin: Generate a precache manifest for the service worker.
 *
 * After each production build, writes a `precache-manifest.json` to the
 * output directory. The service worker reads this to precache the app shell
 * (HTML, JS, CSS bundles with content hashes) on install.
 *
 * This avoids hardcoding hashed filenames in sw.js.
 */
function swPrecacheManifest(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'sw-precache-manifest',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    closeBundle() {
      if (config.command !== 'build') return;

      const outDir = resolve(config.root, config.build.outDir);
      const manifest: { url: string; revision: string | null }[] = [];

      // Walk the output directory and collect files to precache
      function walk(dir: string, prefix: string): void {
        let entries: ReturnType<typeof readdirSync>;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          const urlPath = prefix + entry.name;
          if (entry.isDirectory()) {
            // Skip game-data and bundles (too large, cached separately)
            if (entry.name === 'game-data' || entry.name === 'bundles') continue;
            walk(fullPath, urlPath + '/');
          } else if (entry.isFile()) {
            // Skip the manifest itself and the SW
            if (entry.name === 'precache-manifest.json' || entry.name === 'sw.js') continue;
            // Files with content hashes don't need a revision
            // Vite uses base64url hashes (mixed case + digits), e.g. index-gWOkYjRK.js
            const hasHash = /[-\.][0-9a-zA-Z_-]{6,}\.\w+$/.test(entry.name) &&
              /assets\//.test(urlPath);
            manifest.push({
              url: '/' + urlPath,
              revision: hasHash ? null : String(statSync(fullPath).mtimeMs),
            });
          }
        }
      }

      walk(outDir, '');

      writeFileSync(
        join(outDir, 'precache-manifest.json'),
        JSON.stringify(manifest, null, 2),
      );
      console.log(`[sw-precache-manifest] Generated ${manifest.length} entries`);
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    host: true,
    fs: {
      // Allow serving files from lt-maker/ (game assets, not committed)
      allow: ['..'],
    },
  },
  plugins: [
    // GET /refresh — triggers a full page reload on all connected clients.
    // Temporary dev convenience: replaces auto-watch/HMR.
    {
      name: 'manual-refresh',
      configureServer(server) {
        server.middlewares.use('/refresh', (_req, res) => {
          server.ws.send({ type: 'full-reload' });
          res.writeHead(302, { Location: '/' });
          res.end();
        });
      },
    },
    // Serve lt-maker/*.ltproj at /game-data/*.ltproj — no symlink needed.
    // The lt-maker/ directory is gitignored; users supply their own copy.
    {
      name: 'serve-game-data',
      configureServer(server) {
        const ltMakerDir = resolve(__dirname, 'lt-maker');

        server.middlewares.use('/game-data', (req, res, next) => {
          const filePath = join(ltMakerDir, decodeURIComponent(req.url ?? '/'));

          stat(filePath, (err, stats) => {
            if (err || !stats?.isFile()) {
              next();
              return;
            }

            const ext = extname(filePath).toLowerCase();
            res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Access-Control-Allow-Origin', '*');
            createReadStream(filePath).pipe(res);
          });
        });
      },
    },
    // Generate precache manifest for the service worker
    swPrecacheManifest(),
  ],
  define: {
    __AVAILABLE_PROJECTS__: JSON.stringify(discoverProjects()),
  },
  build: {
    target: 'es2022',
  },
});
