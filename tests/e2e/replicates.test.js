// Browser tests for replicates (format v0.3): landmarking a specimen again,
// the repeatability summary, and replicate-aware files and exports.

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  startServer, launch, openApp, canvasCenter, clickAt, saved, waitForSaves, selectTab,
  makeFiles, messageText, ready, stripItems, openMeshes,
} from './helpers.js';
import { unzipFiles } from '../../js/zip.js';

let server, url, browser, files, current;

before(async () => {
  ({ server, url } = await startServer());
  browser = await launch();
  files = await makeFiles();
});
after(async () => {
  await browser?.close();
  server?.close();
});
afterEach(async () => {
  if (!current) return;
  const { context, errors } = current;
  current = null;
  await context.close();
  assert.deepEqual(errors, [], 'no errors in the browser console');
});

async function start(opts) {
  current = await openApp(browser, url, opts);
  return current.page;
}

const rowState = (page, id) => page.locator(`.lm-row[data-id="${id}"] .lm-state`).innerText();
const cur = (page) => page.evaluate(() => {
  const s = window.__lmk.session;
  return { id: s.current.specimen.id, rep: s.current.specimen.replicate ?? 1, order: s.current.order, active: s.activeId };
});

async function again(page, { random = false } = {}) {
  await selectTab(page, 'Specimen');
  if (random) await page.locator('label:has(#rep-shuffle)').click();
  await page.getByRole('button', { name: /^Landmark .* again$/ }).click();
  await ready(page);
}

async function saveNow(page) {
  const n = (await saved(page)).length;
  await page.locator('#save-btn').click();
  return (await waitForSaves(page, n + 1)).at(-1);
}

describe('landmarking again', () => {
  test('a replicate starts empty, next to its specimen, with the earlier points hidden', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await clickAt(page, await canvasCenter(page));
    assert.equal(await page.locator('.lm-label').count(), 1);

    await again(page);
    assert.match(await messageText(page), /Replicate 2 of SET_001: place the landmarks again\. Your earlier points are hidden/);
    assert.deepEqual(await cur(page), { id: 'SET_001', rep: 2, order: null, active: 'LM01' });
    assert.equal(await rowState(page, 'LM01'), 'To do');
    assert.equal(await page.locator('.lm-label').count(), 0, 'replicate 1’s marker is not shown');
    const items = await stripItems(page);
    assert.deepEqual(items.map((x) => [x.id, x.count, x.current]), [['SET_001', '1/14', false], ['SET_001', '0/14', true], ['SET_002', '0/14', false]]);
    assert.match(await page.locator('#strip .thumb[aria-current="true"] .cap').innerText(), /SET_001 r2/);

    // Clicking places on the replicate, and the first replicate keeps its point.
    await clickAt(page, await canvasCenter(page));
    await page.keyboard.press('[');
    await ready(page);
    assert.equal((await cur(page)).rep, 1);
    assert.equal(await rowState(page, 'LM01'), 'Placed');
  });

  test('replicate buttons switch between replicates', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0]]);
    await again(page);
    await again(page);
    assert.equal((await cur(page)).rep, 3);
    await page.getByRole('button', { name: /^r1 / }).click();
    await ready(page);
    assert.equal((await cur(page)).rep, 1);
  });

  test('random order: landmarks are offered in a shuffled order', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0]]);
    await again(page, { random: true });
    const c = await cur(page);
    assert.equal(c.order.length, 14);
    assert.deepEqual([...c.order].sort(), Array.from({ length: 14 }, (_, i) => `LM${String(i + 1).padStart(2, '0')}`));
    assert.equal(c.active, c.order[0], 'starts with the first of the shuffled order');
    await page.keyboard.press('m');
    assert.equal((await cur(page)).active, c.order[1]);
  });

  test('Landmark again needs the mesh on screen', async () => {
    const page = await start();
    const doc = JSON.stringify({
      format: 'landmark-json', version: '0.2.0',
      specimen: { id: 'X', mesh: { file: 'x.stl', sha256: 'ab'.repeat(32), units: 'mm' } },
      template: { id: 'cranium-basic', version: '1.0', dimensions: 3, landmarks: [{ id: 'LM01', name: 'Glabella' }] },
      landmarks: [],
    });
    const p = join(files.dir, 'waiting.lmk.json');
    await writeFile(p, doc);
    await page.setInputFiles('#open-lmk-input', p);
    await selectTab(page, 'Specimen');
    assert.equal(await page.getByRole('button', { name: 'Landmark X again' }).isDisabled(), true);
  });
});

describe('repeatability', () => {
  test('the summary shows how far apart replicates landed, in mm', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0]]);
    const c = await canvasCenter(page);
    await clickAt(page, c);
    await again(page);
    await clickAt(page, { x: c.x + 25, y: c.y });
    await selectTab(page, 'Specimen');
    await page.getByRole('button', { name: 'Repeatability…' }).click();
    await page.locator('#dialog').waitFor({ state: 'visible' });
    const text = await page.locator('#dialog-content').innerText();
    assert.match(text, /1 specimen landmarked more than once \(SET_001 ×2\)/);
    assert.match(text, /Average \(mm\)/);
    const row = await page.locator('#dialog-content tbody tr').first().innerText();
    const [, , avg] = row.split('\t');
    assert.ok(Number(avg) > 0.5, `LM01 moved between replicates (${avg} mm)`);
    assert.match(text, /Not placed on two replicates yet: LM02/);
    await page.getByRole('button', { name: 'Close' }).click();
  });

  test('the summary button waits until a specimen has two replicates', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0]]);
    await selectTab(page, 'Specimen');
    assert.equal(await page.getByRole('button', { name: 'Repeatability…' }).isDisabled(), true);
  });
});

describe('replicate files and exports', () => {
  test('a replicate saves as <id>_r2.lmk.json, format 0.3.0', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0]]);
    await clickAt(page, await canvasCenter(page));
    const r1 = await saveNow(page);
    await again(page);
    await clickAt(page, await canvasCenter(page));
    const r2 = await saveNow(page);
    assert.equal(r1.name, 'SET_001.lmk.json');
    assert.equal(r2.name, 'SET_001_r2.lmk.json');
    const d1 = JSON.parse(r1.text);
    const d2 = JSON.parse(r2.text);
    assert.equal(d1.version, '0.2.0');
    assert.equal('replicate' in d1.specimen, false);
    assert.equal(d2.version, '0.3.0');
    assert.equal(d2.specimen.replicate, 2);
    assert.equal(d2.specimen.mesh.sha256, d1.specimen.mesh.sha256);
  });

  test('hand-in with replicates: _r files, _r IDs in TPS, replicate column in CSV; it resumes', async () => {
    let page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await clickAt(page, await canvasCenter(page));
    await again(page);
    await clickAt(page, await canvasCenter(page));
    await selectTab(page, 'File');
    await page.locator('#operator').fill('ana');
    await page.locator('#operator').press('Tab');
    await page.locator('#handin-btn').click();
    await page.getByRole('button', { name: 'Download hand-in anyway' }).click();
    const [zip] = await waitForSaves(page, 1);
    const parts = Object.fromEntries((await unzipFiles(new Uint8Array(zip.bytes))).map((e) => [e.name, new TextDecoder().decode(e.data)]));
    assert.deepEqual(Object.keys(parts).sort(), ['SET_001.lmk.json', 'SET_001_r2.lmk.json', 'SET_002.lmk.json', 'ana_landmarks.csv', 'ana_landmarks.tps']);
    assert.deepEqual(parts['ana_landmarks.tps'].split('\n').filter((l) => l.startsWith('ID=')), ['ID=SET_001_r1', 'ID=SET_001_r2', 'ID=SET_002_r1']);
    const csvRows = parts['ana_landmarks.csv'].trim().split('\n').slice(1).map((l) => l.split(','));
    assert.deepEqual([...new Set(csvRows.map((r) => `${r[0]}|${r[1]}|${r[2]}`))], ['SET_001_r1|SET_001|1', 'SET_001_r2|SET_001|2', 'SET_002_r1|SET_002|1']);

    const zipPath = join(files.dir, 'reps.zip');
    await writeFile(zipPath, Buffer.from(zip.bytes));
    await current.context.close();
    current = null;

    page = await start();
    await page.setInputFiles('#open-lmk-input', zipPath);
    await openMeshes(page, [files.balls[0]]);
    const items = await stripItems(page);
    assert.deepEqual(items.map((x) => [x.id, x.count, x.hasPicture]), [['SET_001', '1/14', true], ['SET_001', '1/14', true], ['SET_002', '0/14', false]]);
    const reps = await page.evaluate(() => window.__lmk.session.records.map((r) => r.specimen.replicate ?? 1));
    assert.deepEqual(reps, [1, 2, 1]);
    assert.ok((await page.evaluate(() => window.__lmk.specimens.store.size)) <= 3);
  });
});
