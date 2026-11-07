// Browser test harness: serves the app from disk, swaps the CDN copies of
// three.js for the locally installed ones, and captures files the app saves.

import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { binaryStl, asciiPly, SQUARE_VERTS } from '../fixtures.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

export async function startServer() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
      // Files are served exactly as GitHub Pages serves them: as they are on disk.
      const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const LOCAL = {
  'https://cdn.jsdelivr.net/npm/three@0.170.0/': join(ROOT, 'node_modules/three/'),
  'https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.8.3/': join(ROOT, 'node_modules/three-mesh-bvh/'),
};

export async function launch() {
  return chromium.launch();
}

// A fresh page with the app loaded and the example mesh on screen.
export async function openApp(browser, url, { width = 1280, height = 800 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  await page.route('https://cdn.jsdelivr.net/**', async (route) => {
    const u = route.request().url();
    const prefix = Object.keys(LOCAL).find((p) => u.startsWith(p));
    if (!prefix) return route.abort();
    const body = await readFile(LOCAL[prefix] + u.slice(prefix.length));
    return route.fulfill({ body, contentType: 'text/javascript' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ body: '', contentType: 'text/css' }));

  // Capture saves: replace the browser's Save dialog with an in-memory file.
  await page.addInitScript(() => {
    window.__saved = [];
    window.showSaveFilePicker = async ({ suggestedName }) => {
      const handle = {
        name: suggestedName,
        async createWritable() {
          let text = '';
          return {
            async write(t) { text += t; },
            async close() { window.__saved.push({ name: handle.name, text }); },
          };
        },
      };
      return handle;
    };
  });

  await page.goto(url);
  await ready(page);
  return { page, context, errors };
}

// Wait until no mesh is loading and the 3D view shows its instruction line.
export async function ready(page) {
  await page.waitForFunction(() => {
    const busy = document.getElementById('busy');
    const hint = document.getElementById('stage-hint');
    return busy && busy.hidden && hint && !hint.hidden;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(100); // one more frame so the camera has settled
}

export async function canvasCenter(page) {
  const box = await page.locator('#stage canvas').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A click as a person makes it: press and release on the same spot.
export async function clickAt(page, { x, y }) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

export async function saved(page) {
  return page.evaluate(() => window.__saved);
}

export async function waitForSaves(page, n) {
  await page.waitForFunction((k) => window.__saved.length >= k, n, { timeout: 10000 });
  return saved(page);
}

export async function selectTab(page, name) {
  await page.getByRole('tab', { name }).click();
}

// Mesh and landmark files written to a temp folder for upload.
export async function makeFiles() {
  const dir = await mkdtemp(join(tmpdir(), 'landmarker-e2e-'));
  const sphere = new THREE.SphereGeometry(20, 64, 48).toNonIndexed();
  sphere.translate(40, -10, 100);
  const shifted = sphere.clone();
  shifted.translate(0.5, 0, 0);

  const files = {
    dir,
    sphere: join(dir, 'BALL_001.stl'),
    sphereShifted: join(dir, 'BALL_001_v2.stl'),
    quad: join(dir, 'quad.ply'),
    lmk2d: join(dir, 'photo.lmk.json'),
    notJson: join(dir, 'broken.lmk.json'),
  };
  await writeFile(files.sphere, Buffer.from(binaryStl(sphere)));
  await writeFile(files.sphereShifted, Buffer.from(binaryStl(shifted)));
  await writeFile(files.quad, Buffer.from(asciiPly(SQUARE_VERTS, [[0, 1, 2, 3]])));
  await writeFile(files.lmk2d, JSON.stringify({
    format: 'landmark-json',
    version: '0.2.0',
    specimen: { id: 'SKULL_014', image: { file: 'a.jpg', sha256: 'x', width: 10, height: 10 } },
    template: { id: 't', version: '1', dimensions: 2, landmarks: [] },
    landmarks: [],
  }));
  await writeFile(files.notJson, '{ nope');
  return files;
}

export async function writeText(dir, name, text) {
  const p = join(dir, name);
  await writeFile(p, text);
  return p;
}

// Open a mesh through the "Open mesh…" file input and wait for it.
export async function openMesh(page, path) {
  await page.setInputFiles('#file-input', path);
  await ready(page);
}

export async function messageText(page) {
  const el = page.locator('#message');
  await el.waitFor({ state: 'visible', timeout: 10000 });
  return el.locator('p').innerText();
}
