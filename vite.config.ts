import { defineConfig } from 'vite';
import { resolve, join, extname } from 'path';
import { createReadStream, stat } from 'fs';

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

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    fs: {
      // Allow serving files from lt-maker/ (game assets, not committed)
      allow: ['..'],
    },
  },
  plugins: [
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
  ],
  build: {
    target: 'es2022',
  },
});
