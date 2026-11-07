// Browser tests for specimen sets: several meshes, switching, the
// three-mesh limit, hand-ins and combining them.

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launch, openApp, canvasCenter, clickAt, saved, waitForSaves, selectTab,
  makeFiles, writeText, messageText, ready, stripItems, openMeshes,
} from './helpers.js';
import { unzipFiles } from '../../js/zip.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
const loadedCount = (page) => page.evaluate(() => window.__lmk.specimens.store.size);
const currentId = (page) => page.evaluate(() => window.__lmk.session.current.specimen.id);
const [A, B, C, D] = ['SET_001', 'SET_002', 'SET_003', 'SET_004'];

async function switchKey(page, key) {
  await page.keyboard.press(key);
  await ready(page);
}

async function setOperator(page, name) {
  await selectTab(page, 'File');
  await page.locator('#operator').fill(name);
  await page.locator('#operator').press('Tab');
}

async function handIn(page) {
  const n = (await saved(page)).length;
  await page.locator('#handin-btn').click();
  const prompt = page.getByRole('button', { name: 'Download hand-in anyway' });
  if (await prompt.isVisible().catch(() => false)) await prompt.click();
  const all = await waitForSaves(page, n + 1);
  const zip = all.at(-1);
  const entries = await unzipFiles(new Uint8Array(zip.bytes));
  return { name: zip.name, bytes: zip.bytes, files: Object.fromEntries(entries.map((e) => [e.name, new TextDecoder().decode(e.data)])) };
}

describe('opening several meshes', () => {
  test('each mesh becomes a specimen with a picture in the strip', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 3));
    const items = await stripItems(page);
    assert.deepEqual(items.map((x) => x.id), [A, B, C], 'the example made way');
    assert.ok(items.every((x) => x.hasPicture), 'every specimen has a picture');
    assert.ok(items.every((x) => x.count === '0/14' && !x.done));
    assert.equal(items.find((x) => x.current).id, A, 'the first one is shown');
  });

  test('opening the same mesh twice does not add it twice', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await openMeshes(page, [files.balls[0]]);
    assert.equal((await stripItems(page)).length, 2);
    assert.match(await messageText(page), /already open/);
  });

  test('a PLY with quads among good meshes is reported; the others open', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0], files.quad, files.balls[1]]);
    assert.deepEqual((await stripItems(page)).map((x) => x.id), [A, B]);
    assert.match(await messageText(page), /more than three corners/);
  });
});

describe('working through a set', () => {
  test('landmarks stay with their specimen when switching with [ and ]', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 3));
    const c = await canvasCenter(page);
    await clickAt(page, c);
    await clickAt(page, { x: c.x + 30, y: c.y + 10 });
    await switchKey(page, ']');
    assert.equal(await currentId(page), B);
    assert.equal(await rowState(page, 'LM01'), 'To do');
    await clickAt(page, c);
    await switchKey(page, ']');
    await switchKey(page, ']'); // wraps round to the first
    assert.equal(await currentId(page), A);
    assert.equal(await rowState(page, 'LM02'), 'Placed');
    const items = await stripItems(page);
    assert.deepEqual(items.map((x) => x.count), ['2/14', '1/14', '0/14']);
    assert.equal(await page.locator('.lm-label').count(), 2, 'only this specimen’s markers are shown');
  });

  test('clicking a thumbnail switches to that specimen', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 3));
    await page.locator(`#strip .thumb[aria-label^="${C}"]`).click();
    await ready(page);
    assert.equal(await currentId(page), C);
    await selectTab(page, 'Specimen');
    assert.equal(await page.locator('#file-name').innerText(), `${C}.stl`);
    assert.match(await page.locator('#spec-pos').innerText(), /3 of 3/);
  });

  test('at most three meshes are kept in memory; others are read again when needed', async () => {
    const page = await start();
    await openMeshes(page, files.balls);
    assert.equal((await stripItems(page)).length, 4);
    assert.ok((await loadedCount(page)) <= 3, 'never more than three loaded');
    await clickAt(page, await canvasCenter(page)); // place on the first specimen
    for (let i = 0; i < 4; i++) {
      await switchKey(page, ']');
      assert.ok((await loadedCount(page)) <= 3);
    }
    assert.equal(await currentId(page), A, 'back at the first one, read again from its file');
    assert.equal(await rowState(page, 'LM01'), 'Placed');
    assert.equal(await page.locator('.lm-label').count(), 1);
    // Next to LM01's marker: the view is restored, so the centre is LM01 itself.
    const c = await canvasCenter(page);
    await clickAt(page, { x: c.x + 40, y: c.y - 30 });
    assert.equal(await rowState(page, 'LM02'), 'Placed', 'picking works on a re-read mesh');
  });

  test('undo goes back to the specimen the change was made on', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await clickAt(page, await canvasCenter(page));
    await switchKey(page, ']');
    await page.keyboard.press('Control+z');
    await ready(page);
    assert.equal(await currentId(page), A);
    assert.equal(await rowState(page, 'LM01'), 'To do');
  });

  test('a template change applies to every specimen', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await selectTab(page, 'Template');
    await page.locator('#tpl-new-name').fill('Inion');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const items = await stripItems(page);
    assert.deepEqual(items.map((x) => x.count), ['0/15', '0/15']);
  });

  test('the count turns green when a specimen is finished', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    for (let i = 0; i < 14; i++) await page.keyboard.press('m');
    const [first] = await stripItems(page);
    assert.equal(first.count, '14/14');
    assert.equal(first.done, true);
  });

  test('removing a specimen from the set', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 3));
    await switchKey(page, ']');
    await selectTab(page, 'Specimen');
    await page.getByRole('button', { name: `Remove ${B} from the set…` }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await ready(page);
    assert.deepEqual((await stripItems(page)).map((x) => x.id), [A, C]);
  });

  test('renaming a specimen', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await selectTab(page, 'Specimen');
    await page.locator('#spec-id').fill(B);
    await page.locator('#spec-id').press('Tab');
    assert.match(await messageText(page), /already called SET_002/);
    await page.locator('#spec-id').fill('FISH_A');
    await page.locator('#spec-id').press('Tab');
    assert.equal((await stripItems(page))[0].id, 'FISH_A');
  });
});

describe('hand-in', () => {
  test('needs the operator name, then gives one zip with every specimen, TPS and CSV', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 3));
    await clickAt(page, await canvasCenter(page));
    await selectTab(page, 'File');
    await page.locator('#handin-btn').click();
    assert.match(await messageText(page), /Type your name/);

    await setOperator(page, 'student07');
    const h = await handIn(page);
    assert.equal(h.name, 'student07_landmarks.zip');
    assert.deepEqual(Object.keys(h.files).sort(), [`${A}.lmk.json`, `${B}.lmk.json`, `${C}.lmk.json`, 'student07_landmarks.csv', 'student07_landmarks.tps']);
    const doc = JSON.parse(h.files[`${A}.lmk.json`]);
    assert.equal(doc.provenance.operator, 'student07');
    assert.equal(doc.landmarks.length, 1);
    const tps = h.files['student07_landmarks.tps'];
    assert.deepEqual(tps.split('\n').filter((l) => l.startsWith('ID=')), [`ID=${A}`, `ID=${B}`, `ID=${C}`]);
    assert.equal(h.files['student07_landmarks.csv'].trim().split('\n').length, 1 + 3 * 14);
  });

  test('the example mesh is not part of a hand-in', async () => {
    const page = await start();
    await setOperator(page, 'student07');
    await page.locator('#handin-btn').click();
    assert.match(await messageText(page), /Open your own meshes first/);
  });

  test('opening a hand-in resumes the set once the meshes are open again', async () => {
    let page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await clickAt(page, await canvasCenter(page));
    await page.keyboard.press('m');
    await switchKey(page, ']');
    await clickAt(page, await canvasCenter(page));
    await setOperator(page, 'student07');
    const h = await handIn(page);
    const zipPath = join(files.dir, 'resume.zip');
    await writeFile(zipPath, Buffer.from(h.bytes));
    await current.context.close();
    current = null;

    page = await start();
    await page.setInputFiles('#open-lmk-input', zipPath);
    assert.match(await messageText(page), /Opened 2 specimens\. Now open their 2 meshes/);
    let items = await stripItems(page);
    assert.deepEqual(items.map((x) => [x.id, x.count, x.waiting]), [[A, '2/14', `Open ${A}.stl`], [B, '1/14', `Open ${B}.stl`]]);
    assert.match(await page.locator('#stage-hint').innerText(), /Open SET_001\.stl/);

    await openMeshes(page, files.balls.slice(0, 2));
    items = await stripItems(page);
    assert.ok(items.every((x) => x.hasPicture));
    assert.equal(await currentId(page), A);
    assert.equal(await rowState(page, 'LM01'), 'Placed');
    assert.equal(await rowState(page, 'LM02'), 'Missing');
    assert.equal(await page.locator('#operator').inputValue(), 'student07');
  });

  test('a mesh and its hand-in can be dropped together', async () => {
    let page = await start();
    await openMeshes(page, [files.balls[0]]);
    await clickAt(page, await canvasCenter(page));
    await setOperator(page, 'ana');
    const h = await handIn(page);
    await current.context.close();
    current = null;

    page = await start();
    const mesh = [...(await import('node:fs')).readFileSync(files.balls[0])];
    const dt = await page.evaluateHandle(({ mesh, zip }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(mesh)], 'SET_001.stl'));
      d.items.add(new File([new Uint8Array(zip)], 'ana_landmarks.zip', { type: 'application/zip' }));
      return d;
    }, { mesh, zip: h.bytes });
    await page.dispatchEvent('#stage', 'drop', { dataTransfer: dt });
    await page.waitForFunction(() => document.querySelector('.lm-row[data-id="LM01"] .lm-state')?.textContent === 'Placed', null, { timeout: 30000 });
    await ready(page);
    assert.equal((await stripItems(page)).length, 1);
  });

  test('landmark files with another template are refused', async () => {
    const page = await start();
    await openMeshes(page, [files.balls[0]]);
    await clickAt(page, await canvasCenter(page));
    const other = JSON.stringify({
      format: 'landmark-json', version: '0.2.0',
      specimen: { id: 'X', mesh: { file: 'x.stl', sha256: 'ab'.repeat(32), units: 'mm' } },
      template: { id: 'mandible', version: '1', dimensions: 3, landmarks: [{ id: 'M1', name: 'Gonion' }] },
      landmarks: [],
    });
    await page.setInputFiles('#open-lmk-input', await writeText(files.dir, 'other.lmk.json', other));
    assert.match(await messageText(page), /uses the template “mandible”, not “cranium-basic”/);
    assert.equal((await stripItems(page)).length, 1);
  });

  test('a mesh with the right name but different contents gets the points snapped onto it', async () => {
    let page = await start();
    await openMeshes(page, [files.sphere]);
    await clickAt(page, await canvasCenter(page));
    const first = (await (async () => { await page.locator('#save-btn').click(); return (await waitForSaves(page, 1))[0]; })());
    const lmk = await writeText(files.dir, 'snap.lmk.json', first.text);
    await current.context.close();
    current = null;

    page = await start();
    await page.setInputFiles('#open-lmk-input', lmk);
    await openMeshes(page, [files.renamed]);
    assert.match(await messageText(page), /isn’t the same file BALL_001 was landmarked on.*1 point moved onto it/);
    assert.equal(await rowState(page, 'LM01'), 'Placed');
  });
});

describe('exports and combining', () => {
  test('CSV of the set: one row per landmark per specimen', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await clickAt(page, await canvasCenter(page));
    await selectTab(page, 'File');
    await page.locator('#export-csv').click();
    await page.getByRole('button', { name: 'Export anyway' }).click();
    const [csv] = await waitForSaves(page, 1);
    assert.equal(csv.name, 'specimens_landmarks.csv');
    const rows = csv.text.trim().split('\n');
    assert.equal(rows[0], 'tps_id,specimen_id,replicate,operator,mesh,point,template_id,label,type,curve,index,x,y,z,units,status');
    assert.equal(rows.length, 1 + 2 * 14);
    assert.match(rows[1], /^SET_001,SET_001,1,,SET_001\.stl,LM01,LM01,Glabella,landmark,,,[-\d.]+,[-\d.]+,[-\d.]+,mm,placed$/);
    assert.match(rows[2], /,NA,NA,NA,mm,not_done$/);
  });

  test('TPS of the set: one block per specimen', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 3));
    await setOperator(page, 'ana');
    await page.locator('#export-tps').click();
    await page.getByRole('button', { name: 'Export anyway' }).click();
    const [tps] = await waitForSaves(page, 1);
    assert.equal(tps.name, 'ana_landmarks.tps');
    assert.deepEqual(tps.text.split('\n').filter((l) => l.startsWith('ID=')), [`ID=${A}`, `ID=${B}`, `ID=${C}`]);
  });

  test('combining two students’ hand-ins: shared specimens get the student’s name', async () => {
    const page = await start();
    await openMeshes(page, files.balls.slice(0, 2));
    await clickAt(page, await canvasCenter(page));
    await setOperator(page, 'ana');
    const ana = await handIn(page);
    await setOperator(page, 'ben');
    const ben = await handIn(page);
    const pa = join(files.dir, 'ana.zip');
    const pb = join(files.dir, 'ben.zip');
    await writeFile(pa, Buffer.from(ana.bytes));
    await writeFile(pb, Buffer.from(ben.bytes));

    await page.setInputFiles('#combine-input', [pa, pb]);
    await page.locator('#dialog').waitFor({ state: 'visible' });
    const text = await page.locator('#dialog-content').innerText();
    assert.match(text, /4 specimens from 2 students/);
    assert.match(text, /Done by more than one student: SET_001 \(2\), SET_002 \(2\)/);
    await page.getByRole('button', { name: 'Save CSV file' }).click();
    const n = (await saved(page)).length;
    const csv = (await waitForSaves(page, n)).at(-1);
    const ids = [...new Set(csv.text.trim().split('\n').slice(1).map((l) => l.split(',')[0]))];
    assert.deepEqual(ids, ['SET_001_ana', 'SET_001_ben', 'SET_002_ana', 'SET_002_ben']);
    await page.getByRole('button', { name: 'Close' }).click();
    assert.equal((await stripItems(page)).length, 2, 'the open set is unchanged');
  });
});
