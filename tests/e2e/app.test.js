// End-to-end tests: the real page in headless Chromium, driven with the mouse
// and keyboard. They check what a student would see and what lands in files.

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  startServer, launch, openApp, canvasCenter, clickAt, saved, waitForSaves, selectTab,
  makeFiles, writeText, openMesh, messageText, ready,
} from './helpers.js';
import { parseLandmarkFile } from '../../js/landmark-file.js';

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
const hint = (page) => page.locator('#stage-hint').innerText();
const activeCoords = async (page) => (await page.locator('#lm-active .coords').innerText()).split(',').map(Number);

async function saveNow(page) {
  const n = (await saved(page)).length;
  await page.locator('#save-btn').click();
  const all = await waitForSaves(page, n + 1);
  return all.at(-1);
}

describe('start-up', () => {
  test('opens with the example mesh and template, ready to place the first landmark', async () => {
    const page = await start();
    assert.match(await hint(page), /Click to place\s+LM01\s+Glabella/);
    assert.match(await page.locator('#lm-progress').innerText(), /0\s+of 14 done/);
    assert.equal(await page.locator('.lm-row').count(), 14);
    await selectTab(page, 'Specimen');
    assert.equal(await page.locator('#file-name').innerText(), 'sample-pebble.stl');
    assert.equal(await page.locator('#format').innerText(), 'STL, binary');
    assert.match(await page.locator('#hash').innerText(), /^[0-9a-f]{64}$/);
  });

  // Google Fonts can be blocked (school networks) and fallback fonts vary by
  // system; on GitHub's Linux runner a wider font pushed Save under the 3D view.
  for (const [label, css] of [
    ['the intended font', ''],
    ['a wide fallback font', ':root { --font-body: Verdana, "DejaVu Sans", sans-serif; --font-display: Verdana, "DejaVu Sans", sans-serif } * { letter-spacing: 0.05em }'],
    ['larger text', 'html { font-size: 125% } .btn, .tab, h1 { zoom: 1.2 }'],
  ]) {
    test(`panel controls stay inside the panel and clickable with ${label}`, async () => {
      const page = await start();
      if (css) await page.addStyleTag({ content: css });
      const problems = await page.evaluate(() => {
        const panel = document.querySelector('.panel').getBoundingClientRect();
        const out = [];
        for (const el of document.querySelectorAll('.panel-head .btn, .panel-head .tab')) {
          const r = el.getBoundingClientRect();
          const name = el.id || el.textContent.trim();
          if (r.right > panel.right + 0.5) out.push(`${name} sticks out ${Math.round(r.right - panel.right)} px`);
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!el.contains(hit) && !(el.htmlFor && hit?.closest('label') === el)) out.push(`${name} is covered by ${hit?.tagName}`);
        }
        return out;
      });
      assert.deepEqual(problems, []);
      const n = (await saved(page)).length;
      await page.locator('#save-btn').click({ timeout: 3000 });
      await waitForSaves(page, n + 1);
    });
  }

  test('works at phone width without horizontal scrolling', async () => {
    const page = await start({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page is ${overflow}px too wide`);
  });
});

describe('placing and editing landmarks', () => {
  test('a click places the current landmark and moves to the next', async () => {
    const page = await start();
    await clickAt(page, await canvasCenter(page));
    assert.equal(await rowState(page, 'LM01'), 'Placed');
    assert.match(await hint(page), /LM02\s+Nasion/);
    assert.match(await page.locator('#lm-progress').innerText(), /1\s+of 14 done/);
    assert.equal(await page.locator('.lm-label').count(), 1, 'one marker label in the 3D view');
  });

  test('rotating the view does not place a landmark', async () => {
    const page = await start();
    const c = await canvasCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 80, c.y + 30, { steps: 8 });
    await page.mouse.up();
    assert.equal(await rowState(page, 'LM01'), 'To do');
  });

  test('clicking empty space places nothing', async () => {
    const page = await start();
    const box = await page.locator('#stage canvas').boundingBox();
    await clickAt(page, { x: box.x + box.width - 20, y: box.y + box.height - 40 });
    assert.equal(await rowState(page, 'LM01'), 'To do');
  });

  test('keyboard: missing, estimated, next/previous, undo and redo', async () => {
    const page = await start();
    await clickAt(page, await canvasCenter(page)); // LM01 placed, LM02 active
    await page.keyboard.press('m');
    assert.equal(await rowState(page, 'LM02'), 'Missing');
    await page.keyboard.press('p'); // back to LM02
    await page.keyboard.press('p'); // LM01
    await page.keyboard.press('e');
    assert.equal(await rowState(page, 'LM01'), 'Estimated');
    await page.keyboard.press('Control+z');
    assert.equal(await rowState(page, 'LM01'), 'Placed');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await rowState(page, 'LM01'), 'Estimated');
    await page.keyboard.press('Delete');
    assert.equal(await rowState(page, 'LM01'), 'To do');
  });

  test('dragging a marker moves it over the surface, and one undo puts it back', async () => {
    const page = await start();
    const c = await canvasCenter(page);
    await clickAt(page, c);
    await page.locator('.lm-row[data-id="LM01"]').click();
    const before = await activeCoords(page);

    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 60, c.y + 20, { steps: 10 });
    await page.mouse.up();
    const after = await activeCoords(page);
    const moved = Math.hypot(...after.map((v, i) => v - before[i]));
    assert.ok(moved > 1, `marker moved (${moved.toFixed(2)})`);
    assert.equal(await page.locator('.lm-row').filter({ hasText: 'Placed' }).count(), 1, 'dragging did not place anything else');

    await page.keyboard.press('Control+z');
    const back = await activeCoords(page);
    assert.deepEqual(back, before);
  });

  test('ad hoc point', async () => {
    const page = await start();
    await page.locator('#adhoc-btn').click();
    assert.match(await hint(page), /Click to add/);
    await clickAt(page, await canvasCenter(page));
    assert.equal(await rowState(page, 'AH01'), 'Placed');
    assert.match(await hint(page), /LM01/);
  });

  test('a note is kept with the point', async () => {
    const page = await start();
    await clickAt(page, await canvasCenter(page));
    await page.locator('.lm-row[data-id="LM01"]').click();
    await page.locator('#lm-note').fill('worn surface');
    await page.locator('#lm-note').press('Tab');
    const file = await saveNow(page);
    assert.equal(JSON.parse(file.text).landmarks[0].note, 'worn surface');
  });
});

describe('template editor', () => {
  test('add, rename, reorder and delete landmarks', async () => {
    const page = await start();
    await selectTab(page, 'Template');
    await page.locator('#tpl-new-name').fill('Inion');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('#tpl-bulk-box summary').click();
    await page.locator('#tpl-bulk').fill('Asterion L\n\nAsterion R');
    await page.getByRole('button', { name: 'Add all' }).click();
    assert.equal(await page.locator('.tpl-item').count(), 17);

    const name = page.locator('#tpl-name-LM15');
    await name.fill('Inion (external occipital protuberance)');
    await name.press('Tab');
    await page.getByRole('button', { name: 'Move LM15 up' }).click();
    await page.getByRole('button', { name: 'Delete LM17' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await selectTab(page, 'Landmarks');
    const ids = await page.locator('.lm-row .code').allInnerTexts();
    assert.deepEqual(ids.slice(-4), ['LM13', 'LM15', 'LM14', 'LM16']);
    assert.match(await page.locator('.lm-row[data-id="LM15"]').innerText(), /Inion \(external/);
  });

  test('the ID of a landmark with data is locked', async () => {
    const page = await start();
    await clickAt(page, await canvasCenter(page));
    await selectTab(page, 'Template');
    assert.equal(await page.locator('#tpl-id-LM01').getAttribute('readonly'), '');
    assert.equal(await page.locator('#tpl-id-LM02').getAttribute('readonly'), null);
  });

  test('a duplicate ID is refused with a message', async () => {
    const page = await start();
    await selectTab(page, 'Template');
    const id = page.locator('#tpl-id-LM02');
    await id.fill('LM03');
    await id.press('Tab');
    await page.locator('.tpl-err').waitFor();
    assert.match(await page.locator('.tpl-err').innerText(), /LM03 is already used/);
  });

  test('starting an empty template asks first', async () => {
    const page = await start();
    await selectTab(page, 'Template');
    await page.getByRole('button', { name: /Start a new empty template/ }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.locator('.tpl-item').count(), 14);
    await page.getByRole('button', { name: /Start a new empty template/ }).click();
    await page.getByRole('button', { name: 'Start empty template' }).click();
    assert.equal(await page.locator('.tpl-item').count(), 0);
  });
});

describe('saving and opening landmark files', () => {
  test('save writes a valid v0.2 file with the mesh hash; Save again writes to the same file', async () => {
    const page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    await page.keyboard.press('m');
    await selectTab(page, 'File');
    assert.equal(await page.locator('#spec-id').inputValue(), 'BALL_001', 'specimen id from the file name');
    await page.locator('#operator').fill('student01');
    await page.locator('#operator').press('Tab');

    const file = await saveNow(page);
    assert.equal(file.name, 'BALL_001.lmk.json');
    const parsed = parseLandmarkFile(file.text, file.name);
    const expectedHash = createHash('sha256').update(await readFile(files.sphere)).digest('hex');
    assert.equal(parsed.doc.specimen.mesh.sha256, expectedHash);
    assert.equal(parsed.doc.specimen.mesh.file, 'BALL_001.stl');
    assert.equal(parsed.doc.provenance.operator, 'student01');
    assert.deepEqual(parsed.points.map((p) => [p.id, p.status]), [['LM01', 'placed'], ['LM02', 'missing']]);

    // The picked point is on the sphere (centre 40,-10,100; radius 20), in file coordinates.
    const [x, y, z] = parsed.points[0].position;
    const r = Math.hypot(x - 40, y + 10, z - 100);
    assert.ok(Math.abs(r - 20) < 0.2, `point is on the surface (r = ${r.toFixed(3)})`);
    assert.ok(Number.isInteger(parsed.points[0].anchor.face));

    assert.match(await page.locator('#save-status').innerText(), /^Saved BALL_001\.lmk\.json/);
    await page.keyboard.press('Control+s');
    const all = await waitForSaves(page, 2);
    assert.equal(all[1].name, 'BALL_001.lmk.json', 'second save goes to the same file');
  });

  test('the save status shows unsaved changes', async () => {
    const page = await start();
    await openMesh(page, files.sphere);
    await selectTab(page, 'File');
    assert.match(await page.locator('#save-status').innerText(), /No changes yet/);
    await clickAt(page, await canvasCenter(page));
    assert.match(await page.locator('#save-status').innerText(), /Not saved yet/);
    assert.equal(await page.locator('#save-btn.has-changes').count(), 1);
    await saveNow(page);
    assert.equal(await page.locator('#save-btn.has-changes').count(), 0);
  });

  test('round trip: save, reload, open mesh and landmark file, points come back exactly', async () => {
    let page = await start();
    await openMesh(page, files.sphere);
    const c = await canvasCenter(page);
    await clickAt(page, c);
    await clickAt(page, { x: c.x + 40, y: c.y - 30 });
    await page.keyboard.press('m');
    const first = await saveNow(page);
    const lmkPath = await writeText(files.dir, 'roundtrip.lmk.json', first.text);
    await current.context.close();
    current = null;

    page = await start();
    await page.setInputFiles('#open-lmk-input', lmkPath);
    assert.match(await messageText(page), /Now open its mesh, BALL_001\.stl/);
    await openMesh(page, files.sphere);
    assert.equal(await rowState(page, 'LM01'), 'Placed');
    assert.equal(await rowState(page, 'LM02'), 'Placed');
    assert.equal(await rowState(page, 'LM03'), 'Missing');
    assert.match(await hint(page), /LM04/);

    const second = await saveNow(page);
    const a = JSON.parse(first.text);
    const b = JSON.parse(second.text);
    assert.deepEqual(b.landmarks, a.landmarks, 'landmarks unchanged by the round trip');
    assert.equal(b.provenance.created, a.provenance.created);
  });

  test('dropping a mesh and its landmark file together opens both', async () => {
    let page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    const first = await saveNow(page);
    await current.context.close();
    current = null;

    page = await start();
    const meshBytes = [...(await readFile(files.sphere))];
    const dt = await page.evaluateHandle(({ meshBytes, lmk }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(meshBytes)], 'BALL_001.stl'));
      d.items.add(new File([lmk], 'BALL_001.lmk.json', { type: 'application/json' }));
      return d;
    }, { meshBytes, lmk: first.text });
    await page.dispatchEvent('#stage', 'drop', { dataTransfer: dt });
    await page.waitForFunction(() => document.querySelector('.lm-row[data-id="LM01"] .lm-state')?.textContent === 'Placed', null, { timeout: 30000 });
    await ready(page);
  });

  test('opening a landmark file on a different mesh offers to snap the points', async () => {
    let page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    const first = await saveNow(page);
    const lmkPath = await writeText(files.dir, 'mismatch.lmk.json', first.text);
    await current.context.close();
    current = null;

    page = await start();
    await openMesh(page, files.sphereShifted);
    await page.setInputFiles('#open-lmk-input', lmkPath);
    assert.match(await messageText(page), /made on BALL_001\.stl, but the open mesh is BALL_001_v2\.stl/);
    await page.getByRole('button', { name: 'Use this mesh and snap points to it' }).click();
    assert.match(await messageText(page), /1 point moved onto this mesh; the largest move was 0\.\d+ mm/);
    assert.equal(await rowState(page, 'LM01'), 'Placed');
    await selectTab(page, 'File');
    assert.match(await page.locator('#save-status').innerText(), /Unsaved changes/, 'snapped positions need saving');
  });

  test('opening another mesh adds a specimen; nothing is replaced', async () => {
    const page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    await openMesh(page, files.sphereShifted);
    assert.equal(await rowState(page, 'LM01'), 'To do', 'the new specimen starts empty');
    await page.keyboard.press('[');
    await ready(page);
    assert.equal(await rowState(page, 'LM01'), 'Placed', 'the first specimen kept its landmark');
    await selectTab(page, 'Specimen');
    assert.equal(await page.locator('#file-name').innerText(), 'BALL_001.stl');
  });

  test('the example asks before it replaces specimens with unsaved landmarks', async () => {
    const page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    await selectTab(page, 'Specimen');
    await page.locator('#sample-btn').click();
    assert.match(await messageText(page), /unsaved landmarks/);
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.locator('#file-name').innerText(), 'BALL_001.stl');
  });

  test('a 2D landmark file is refused with an explanation', async () => {
    const page = await start();
    await page.setInputFiles('#open-lmk-input', files.lmk2d);
    assert.match(await messageText(page), /2D landmarks on an image/);
  });

  test('a broken landmark file is refused', async () => {
    const page = await start();
    await page.setInputFiles('#open-lmk-input', files.notJson);
    assert.match(await messageText(page), /isn’t valid JSON/);
  });

  test('a PLY with quads is refused with an explanation', async () => {
    const page = await start();
    await page.setInputFiles('#file-input', files.quad);
    assert.match(await messageText(page), /more than three corners/);
  });
});

describe('TPS export', () => {
  test('exports one LM3 block in template order, with missing values', async () => {
    const page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    await page.keyboard.press('m');
    await selectTab(page, 'File');
    await page.locator('#export-tps').click();
    assert.match(await messageText(page), /12 landmarks are still to do/);
    await page.getByRole('button', { name: 'Export anyway' }).click();
    const [file] = await waitForSaves(page, 1);
    assert.equal(file.name, 'BALL_001.tps');

    const lines = file.text.trim().split('\n');
    assert.equal(lines[0], 'LM3=14');
    assert.equal(lines.length, 16);
    assert.equal(lines[2], '-999 -999 -999');
    assert.equal(lines.at(-1), 'ID=BALL_001');
    const [x, y, z] = lines[1].split(' ').map(Number);
    assert.ok(Math.abs(Math.hypot(x - 40, y + 10, z - 100) - 20) < 0.2, 'coordinates in mesh space');
  });

  test('combining two saved files gives two blocks, sorted by specimen ID', async () => {
    const page = await start();
    await openMesh(page, files.sphere);
    await clickAt(page, await canvasCenter(page));
    const a = await saveNow(page);
    await selectTab(page, 'Specimen');
    await page.locator('#spec-id').fill('BALL_000');
    await page.locator('#spec-id').press('Tab');
    const b = await saveNow(page); // Save writes to the same file again, now with the new ID
    assert.equal(JSON.parse(b.text).specimen.id, 'BALL_000');
    const pa = await writeText(files.dir, 'a.lmk.json', a.text);
    const pb = await writeText(files.dir, 'b.lmk.json', b.text);

    await page.setInputFiles('#combine-input', [pa, pb]);
    await page.locator('#dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#dialog-content').innerText(), /2 specimens from 1 student/);
    await page.getByRole('button', { name: 'Save TPS file' }).click();
    const all = await waitForSaves(page, 3);
    const tps = all.at(-1);
    assert.equal(tps.name, 'cranium-basic_2_specimens.tps');
    const ids = tps.text.split('\n').filter((l) => l.startsWith('ID='));
    assert.deepEqual(ids, ['ID=BALL_000', 'ID=BALL_001']);
    await page.getByRole('button', { name: 'Close' }).click();
  });
});

describe('format version', () => {
  test('saved files declare format 0.2.0 and template dimensions 3', async () => {
    const page = await start();
    await clickAt(page, await canvasCenter(page));
    const file = await saveNow(page);
    const doc = JSON.parse(file.text);
    assert.equal(doc.version, '0.2.0');
    assert.equal(doc.template.dimensions, 3);
  });
});
