import { defineConfig } from 'vite';
import { resolve, join, extname } from 'path';
import { cpSync, createReadStream, stat, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
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
        const isDirectory = entry.isDirectory() ||
          (entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory());
        if (isDirectory && entry.name.endsWith('.ltproj')) {
          projects.add(entry.name);
        }
      }
    } catch { /* ignore */ }
  }
  return [...projects].sort();
}

/**
 * Python SPRITES (app/sprites.py load_sprites): every PNG under a root, keyed
 * by file name without extension, walked top-down (a directory's own files,
 * then its subdirectories). Later entries overwrite earlier ones, as in the
 * Python dict. Values are posix paths relative to the root.
 */
function spriteIndex(root: string): Record<string, string> {
  const index: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory());
      if (isDir) subdirs.push(entry.name);
      else if (entry.name.endsWith('.png')) index[entry.name.slice(0, -4)] = rel + entry.name;
    }
    for (const sub of subdirs) walk(join(dir, sub), `${rel}${sub}/`);
  };
  walk(root, '');
  return index;
}

/**
 * Engine sprites (lt-maker/sprites, served at /game-data/sprites/) and each
 * project's resources/custom_sprites, which Python loads on top of them.
 * `fork` indexes public/fork-sprites/ (served at /game-data/fork-sprites/ and
 * packed with the engine assets): the private engine fork EOtF ships on has
 * its own copies of some engine sprites and a few of its own, such as the
 * unit dex's selector glow. A project on the fork prefers them; other
 * projects use them only when upstream has no sprite of that name.
 */
function discoverSprites(): {
  engine: Record<string, string>;
  fork: Record<string, string>;
  projects: Record<string, Record<string, string>>;
} {
  const roots = [resolve(__dirname, 'lt-maker'), resolve(__dirname, 'public/game-data')];
  const engineRoot = roots.map((r) => join(r, 'sprites')).find((r) => existsSync(r));
  const projects: Record<string, Record<string, string>> = {};
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.ltproj') || projects[name]) continue;
      const custom = join(root, name, 'resources/custom_sprites');
      if (existsSync(custom)) projects[name] = spriteIndex(custom);
    }
  }
  const forkRoot = resolve(__dirname, 'public/fork-sprites');
  return {
    engine: engineRoot ? spriteIndex(engineRoot) : {},
    fork: existsSync(forkRoot) ? spriteIndex(forkRoot) : {},
    projects,
  };
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
            // Skip game-data, bundles and packs (too large, cached separately)
            if (entry.name === 'game-data' || entry.name === 'bundles' || entry.name === 'packs') continue;
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

      const manifestJson = JSON.stringify(manifest, null, 2);
      writeFileSync(join(outDir, 'precache-manifest.json'), manifestJson);

      // A changed external manifest alone does not trigger the browser's
      // service-worker update algorithm. Stamp its digest into the copied
      // worker so every changed app shell installs a fresh cache.
      const swPath = join(outDir, 'sw.js');
      if (existsSync(swPath)) {
        const revision = createHash('sha256').update(manifestJson).digest('hex').slice(0, 16);
        writeFileSync(swPath, `${readFileSync(swPath, 'utf8')}\n// precache-revision:${revision}\n`);
      }
      console.log(`[sw-precache-manifest] Generated ${manifest.length} entries`);
    },
  };
}

/**
 * `npm run build:site` (scripts/build-site.mjs) sets LT_SITE_BUILD=1: the
 * hosted static site. Game assets ship as content-hashed packs under
 * dist/packs/ (written by build-site after Vite), so public/ is copied
 * without game-data/, bundles/ or test hooks, and __LT_HOSTED__ switches the
 * client to src/packs/.
 */
const siteBuild = process.env.LT_SITE_BUILD === '1';
// fork-sprites ship inside the engine pack (scripts/lib/asset-packs.mjs).
const SITE_EXCLUDED_PUBLIC = new Set(['game-data', 'bundles', 'fork-sprites', 'soak-seed.json']);

function copyPublicShell(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'copy-public-shell',
    apply: 'build',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    writeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const publicDir = config.publicDir;
      if (!publicDir || !existsSync(publicDir)) return;
      for (const entry of readdirSync(publicDir)) {
        if (SITE_EXCLUDED_PUBLIC.has(entry)) continue;
        cpSync(join(publicDir, entry), join(outDir, entry), { recursive: true, dereference: true });
      }
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
        const forkSpritesDir = resolve(__dirname, 'public/fork-sprites');

        server.middlewares.use('/game-data', (req, res, next) => {
          const url = decodeURIComponent(req.url ?? '/');
          const filePath = url.startsWith('/fork-sprites/')
            ? join(forkSpritesDir, url.slice('/fork-sprites/'.length))
            : join(ltMakerDir, url);

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
    // Hosted site: copy public/ minus the game assets (runs before closeBundle)
    ...(siteBuild ? [copyPublicShell()] : []),
    // Generate precache manifest for the service worker
    swPrecacheManifest(),
  ],
  define: {
    __AVAILABLE_PROJECTS__: JSON.stringify(siteBuild ? [] : discoverProjects()),
    __LT_HOSTED__: JSON.stringify(siteBuild),
    __LT_SPRITES__: JSON.stringify(discoverSprites()),
  },
  build: {
    target: 'es2022',
    copyPublicDir: !siteBuild,
  },
});
