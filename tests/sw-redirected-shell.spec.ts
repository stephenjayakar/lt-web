import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Some static hosts answer /index.html with a 30x to /. The service worker
 * used to precache that redirected response and serve it for navigations,
 * which browsers reject (net::ERR_FAILED): every reload of an installed site
 * failed, online or offline. This serves the built dist/ the same way and
 * checks reloads both online and offline.
 */

const dist = path.join(__dirname, '..', 'dist');
const swFile = path.join(__dirname, '..', 'public', 'sw.js');
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

test('service worker reloads work when the host redirects /index.html to /', async ({ browser }) => {
  test.skip(!fs.existsSync(path.join(dist, 'precache-manifest.json')), 'needs a production dist/ (npm run build)');

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://local').pathname;
    if (pathname === '/index.html') {
      res.writeHead(307, { location: '/' });
      res.end();
      return;
    }
    let file = pathname === '/sw.js' ? swFile : path.join(dist, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const context = await browser.newContext();
  try {
    // Keep the page off any real backend baked into the build.
    await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort('internetdisconnected'));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return !!navigator.serviceWorker.controller;
    }, undefined, { timeout: 30_000 });

    await page.reload({ timeout: 30_000 });
    await expect(page.locator('#game-canvas')).toBeAttached();

    await context.setOffline(true);
    await page.reload({ timeout: 30_000 });
    await expect(page.locator('#game-canvas')).toBeAttached();
  } finally {
    await context.close();
    server.close();
  }
});
