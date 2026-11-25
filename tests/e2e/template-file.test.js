// Browser tests for template files: saving one from the Template tab and
// opening it again (button, "Open landmark files", drag and drop).

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, openApp, canvasCenter, clickAt, waitForSaves, selectTab, makeFiles, writeText } from './helpers.js';

let server, url, browser, current, files;

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
const S = (page, fn, arg) => page.evaluate(fn, arg);
const message = (page) => page.locator('#message').innerText();

const OTHER = {
  id: 'mandible-basic', name: 'Mandible', version: '1.0', dimensions: 3,
  landmarks: [{ id: 'LM01', name: 'Gnathion' }, { id: 'M02', name: 'Gonion L' }, { id: 'M03', name: 'Gonion R' }],
  curves: [{ id: 'C01', name: 'Lower border', n_points: 8, path: 'geodesic', spacing: 'equal_arc_length', start: 'M02', end: 'M03' }],
};

describe('template files', () => {
  test('Save template file writes the template on its own, named after its ID', async () => {
    const page = await start();
    await selectTab(page, 'Template');
    await page.getByRole('button', { name: 'Save template file' }).click();
    const [file] = await waitForSaves(page, 1);
    assert.equal(file.name, 'cranium-basic.template.json');
    const t = JSON.parse(file.text);
    assert.equal(t.format, undefined, 'the bare template, as the 2D app saves it');
    assert.equal(t.dimensions, 3);
    assert.deepEqual(t.landmarks, await S(page, () => window.__lmk.session.template.landmarks));
    assert.match(await message(page), /Saved the template to cranium-basic\.template\.json/);
  });

  test('Open template file… replaces the template; placed points it doesn’t list become ad hoc points; undo brings it back', async () => {
    const page = await start();
    const c = await canvasCenter(page);
    await clickAt(page, c); // LM01 Glabella
    await clickAt(page, { x: c.x + 40, y: c.y }); // LM02
    const path = await writeText(files.dir, 'mandible.template.json', JSON.stringify(OTHER));
    await selectTab(page, 'Template');
    await page.setInputFiles('#open-template-input', path);
    await page.waitForFunction(() => window.__lmk.session.template.id === 'mandible-basic');
    assert.match(await message(page), /Now using the template “Mandible” \(3 landmarks, 1 curve\)\. 1 point of landmarks it doesn’t list is kept as an? ad hoc point/);
    const pts = await S(page, () => window.__lmk.session.points.map((p) => [p.id, p.template_id, p.label ?? null]));
    assert.deepEqual(pts.find((p) => p[0] === 'LM01'), ['LM01', 'LM01', null], 'LM01 is in both templates');
    assert.deepEqual(pts.find((p) => p[0] === 'LM02'), ['LM02', null, 'Nasion'], 'kept, with its name');
    // The Template tab shows the new landmarks and curve.
    await page.waitForFunction(() => document.querySelector('#template-editor').innerText.includes('Gonion L'));
    assert.match(await page.locator('#template-editor').innerText(), /Lower border/);

    await page.keyboard.press('Control+z');
    assert.equal(await S(page, () => window.__lmk.session.template.id), 'cranium-basic');
    assert.equal(await S(page, () => window.__lmk.session.point('LM02').template_id), 'LM02');
  });

  test('a 2D template is refused with a reason, and nothing changes', async () => {
    const page = await start();
    const path = await writeText(files.dir, 'fish.template.json', JSON.stringify({ id: 'fish', name: 'Fish', dimensions: 2, landmarks: [{ id: 'A', name: 'a' }] }));
    await selectTab(page, 'Template');
    await page.setInputFiles('#open-template-input', path);
    await page.waitForFunction(() => /2D template/.test(document.querySelector('#message').innerText));
    assert.equal(await S(page, () => window.__lmk.session.template.id), 'cranium-basic');
  });

  test('a .template.json chosen with “Open landmark files” or dropped on the window opens as a template', async () => {
    const page = await start();
    const path = await writeText(files.dir, 'mandible2.template.json', JSON.stringify(OTHER));
    await selectTab(page, 'File');
    await page.setInputFiles('#open-lmk-input', path);
    await page.waitForFunction(() => window.__lmk.session.template.id === 'mandible-basic');

    // Drop: a DataTransfer with the file, as the browser builds one.
    await page.evaluate(() => window.__lmk.session.newTemplate());
    const text = JSON.stringify({ ...OTHER, id: 'dropped' });
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'dropped.template.json', { type: 'application/json' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, text);
    await page.waitForFunction(() => window.__lmk.session.template.id === 'dropped');
  });

  test('a saved template opens again unchanged (round trip)', async () => {
    const page = await start();
    await page.evaluate(() => {
      const s = window.__lmk.session;
      const c = s.addCurveDef('Sagittal suture');
      s.updateCurveDef(c, { start: 'LM03', end: 'LM04', n_points: 12 });
    });
    const before = await S(page, () => structuredClone(window.__lmk.session.template));
    await selectTab(page, 'Template');
    await page.getByRole('button', { name: 'Save template file' }).click();
    const [file] = await waitForSaves(page, 1);
    const path = await writeText(files.dir, 'roundtrip.template.json', file.text);
    await page.evaluate(() => window.__lmk.session.newTemplate());
    await page.setInputFiles('#open-template-input', path);
    await page.waitForFunction(() => window.__lmk.session.template.id === 'cranium-basic');
    assert.deepEqual(await S(page, () => window.__lmk.session.template), before);
  });
});
