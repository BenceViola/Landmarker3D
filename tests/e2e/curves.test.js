// Browser tests for curves: defining one in the Template tab, tracing it on
// the mesh, editing the clicked points, saving and opening it again.

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launch, openApp, canvasCenter, clickAt, waitForSaves, selectTab, makeFiles, writeText, openMeshes,
} from './helpers.js';

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
const curveOf = (page, id = 'C01') => S(page, (i) => window.__lmk.session.curve(i), id);
const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// Add a curve in the Template tab, from LM01 to LM02 with n points.
async function addCurve(page, { name = 'Brow ridge', start = 'LM01', end = 'LM02', n = 6 } = {}) {
  await selectTab(page, 'Template');
  await page.locator('#tpl-new-curve').fill(name);
  await page.getByRole('button', { name: 'Add curve' }).click();
  const row = page.locator('[data-crow="C01"]');
  await row.locator('[data-cedit="n_points"]').fill(String(n));
  await row.locator('[data-cedit="n_points"]').press('Tab');
  if (start) await row.locator('[data-cedit="start"]').selectOption(start);
  if (end) await row.locator('[data-cedit="end"]').selectOption(end);
  await frame(page);
  await selectTab(page, 'Landmarks');
}

// Place LM01 and LM02 left and right of the middle of the view.
async function placeEnds(page) {
  const c = await canvasCenter(page);
  await clickAt(page, { x: c.x - 60, y: c.y - 20 });
  await clickAt(page, { x: c.x + 60, y: c.y - 20 });
  return c;
}

async function trace(page, c, offsets = [[-20, 25], [20, 25]]) {
  await page.locator('.lm-row[data-id="C01"]').click();
  for (const [dx, dy] of offsets) await clickAt(page, { x: c.x + dx, y: c.y + dy });
  await frame(page);
}

describe('defining a curve', () => {
  test('the Template tab adds a curve with its points and end landmarks; the Landmarks list shows it', async () => {
    const page = await start();
    await addCurve(page);
    const def = await S(page, () => window.__lmk.session.curveDef('C01'));
    assert.deepEqual(def, { id: 'C01', name: 'Brow ridge', n_points: 6, path: 'geodesic', spacing: 'equal_arc_length', start: 'LM01', end: 'LM02' });
    assert.match(await page.locator('#lm-list').innerText(), /Curves\s+C01\s+Brow ridge\s+To do/i);
    // Wrong input is refused with a reason.
    await selectTab(page, 'Template');
    const n = page.locator('[data-crow="C01"] [data-cedit="n_points"]');
    await n.fill('0');
    await n.press('Tab');
    assert.match(await page.locator('[data-crow="C01"] .tpl-err').innerText(), /whole number from 1/);
  });
});

describe('tracing a curve', () => {
  test('clicks along the curve give evenly spaced semilandmarks between the end landmarks', async () => {
    const page = await start();
    await addCurve(page);
    const c = await placeEnds(page);
    await trace(page, c);
    const curve = await curveOf(page);
    assert.equal(curve.control_points.length, 2);
    assert.equal(curve.points.length, 6);
    assert.ok(curve.length > 0);
    assert.deepEqual(curve.sampling, { path: 'geodesic', spacing: 'equal_arc_length', n_points: 6 });
    assert.ok(curve.points.every((p) => p.anchor && p.normal), 'semilandmarks are on the surface');
    assert.match(await page.locator('#curve-summary').innerText(), /2 clicks · 6 of 6 points · [\d.]+ mm long/);
    assert.match(await page.locator('#stage-hint').innerText(), /Click along C01/);
    // Clicks on a curve don't move on to another landmark.
    assert.equal(await S(page, () => window.__lmk.session.activeId), 'C01');
    // Spacing along the path is even: neighbouring semilandmarks about equally far apart.
    const gaps = curve.points.slice(1).map((p, i) => Math.hypot(...p.position.map((v, k) => v - curve.points[i].position[k])));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(gaps.every((g) => Math.abs(g - mean) < mean * 0.25), `even gaps ${gaps.map((g) => g.toFixed(2))}`);
  });

  test('an end landmark that isn’t placed yet is named', async () => {
    const page = await start();
    await addCurve(page, { start: 'LM05' });
    const c = await canvasCenter(page);
    await trace(page, c, [[-20, 25], [20, 25]]);
    assert.match(await page.locator('.active-problem').innerText(), /Place LM05 first: the curve starts there/);
    assert.equal((await curveOf(page)).points.length, 0);
  });

  test('Backspace takes back the last click; Delete clears the curve; undo brings it back', async () => {
    const page = await start();
    await addCurve(page);
    const c = await placeEnds(page);
    await trace(page, c, [[-20, 25], [0, 35], [20, 25]]);
    await page.keyboard.press('Backspace');
    assert.equal((await curveOf(page)).control_points.length, 2);
    assert.equal(await S(page, () => window.__lmk.session.stateOf('LM02')), 'placed', 'Backspace did not clear a landmark');
    await page.keyboard.press('Delete');
    assert.equal(await curveOf(page), null);
    await page.keyboard.press('Control+z');
    assert.equal((await curveOf(page)).control_points.length, 2);
  });

  test('dragging a clicked point moves it and the semilandmarks follow; one undo puts it back', async () => {
    const page = await start();
    await addCurve(page);
    const c = await placeEnds(page);
    await trace(page, c, [[0, 30]]);
    const before = await curveOf(page);
    const key = await page.evaluate(({ x, y }) => window.__lmk.curveView.hitTest(x, y), { x: c.x, y: c.y + 30 });
    assert.equal(key, 'C01#0', 'the diamond is under the cursor');
    await page.mouse.move(c.x, c.y + 30);
    await page.mouse.down();
    await page.mouse.move(c.x + 10, c.y + 60, { steps: 8 });
    await page.mouse.up();
    await frame(page);
    const after = await curveOf(page);
    assert.equal(after.control_points.length, 1, 'dragging added no point');
    assert.notDeepEqual(after.control_points[0].position, before.control_points[0].position);
    assert.notDeepEqual(after.points[2].position, before.points[2].position, 'semilandmarks recomputed');
    await page.keyboard.press('Control+z');
    await frame(page);
    assert.deepEqual((await curveOf(page)).control_points, before.control_points);
  });

  test('moving an end landmark moves the curve', async () => {
    const page = await start();
    await addCurve(page);
    const c = await placeEnds(page);
    await trace(page, c, [[0, 30]]);
    const before = (await curveOf(page)).points;
    await page.locator('.lm-row[data-id="LM01"]').click();
    await clickAt(page, { x: c.x - 80, y: c.y });
    await frame(page);
    assert.notDeepEqual((await curveOf(page)).points[0].position, before[0].position);
  });

  test('missing and estimated', async () => {
    const page = await start();
    await addCurve(page);
    const c = await placeEnds(page);
    await trace(page, c);
    await page.keyboard.press('e');
    assert.equal(await S(page, () => window.__lmk.session.stateOf('C01')), 'estimated');
    await page.keyboard.press('m');
    assert.equal(await S(page, () => window.__lmk.session.stateOf('C01')), 'missing');
    assert.match(await page.locator('#lm-list').innerText(), /C01\s+Brow ridge\s+Missing/);
  });
});

describe('along the surface or straight lines', () => {
  // Two points on the outer wall of the thin tube, 120° apart, as clicks.
  // The tube's mesh has a seam at 0° (corners repeated a hair apart).
  async function traceOnTube(page, path) {
    await openMeshes(page, [files.tube]);
    await page.evaluate((path) => {
      const { session: s, picker } = window.__lmk;
      const id = s.addCurveDef('Around the tube');
      s.updateCurveDef(id, { n_points: 9, path });
      s.setActive(id);
      for (const deg of [-60, 60]) { // across the lathe's seam at 0°
        const t = (deg * Math.PI) / 180;
        s.place(id, picker.snap([20 * Math.sin(t), 2, 20 * Math.cos(t)]).fields);
      }
    }, path);
    await page.waitForFunction(() => window.__lmk.session.curve('C01')?.points?.length === 9);
    return curveOf(page);
  }
  const radius = (p) => Math.hypot(p.position[0], p.position[2]);

  test('along the surface, the curve stays on the outer wall of a thin tube', async () => {
    const page = await start();
    const curve = await traceOnTube(page, 'geodesic');
    assert.equal(curve.sampling.path, 'geodesic');
    for (const p of curve.points) assert.ok(Math.abs(radius(p) - 20) < 0.05, `radius ${radius(p).toFixed(3)}`);
    const arc = 20 * ((120 * Math.PI) / 180);
    assert.ok(Math.abs(curve.length - arc) / arc < 0.01, `length ${curve.length} vs ${arc.toFixed(3)}`);
  });

  test('with straight lines, the same clicks jump to the inner wall; the Template tab switches between the two', async () => {
    const page = await start();
    const straight = await traceOnTube(page, 'euclidean');
    assert.equal(straight.sampling.path, 'euclidean');
    assert.ok(straight.points.some((p) => Math.abs(radius(p) - 19) < 0.05), 'some points on the inner wall');

    await selectTab(page, 'Template');
    await page.locator('[data-crow="C01"] details').evaluate((d) => (d.open = true));
    await page.locator('[data-crow="C01"] [data-cedit="path"]').selectOption('geodesic');
    await page.waitForFunction(() => window.__lmk.session.curve('C01')?.sampling?.path === 'geodesic');
    const curve = await curveOf(page);
    for (const p of curve.points) assert.ok(Math.abs(radius(p) - 20) < 0.05);
    assert.match(await page.locator('[data-crow="C01"] summary').innerText(), /along the surface/);
  });
});

describe('saving and opening', () => {
  test('the curve is saved with the specimen and comes back when the file is opened', async () => {
    let page = await start();
    await openMeshes(page, [files.sphere]);
    await addCurve(page);
    const c = await placeEnds(page);
    await trace(page, c);
    const traced = await curveOf(page);
    await page.locator('#save-btn').click();
    const [file] = await waitForSaves(page, 1);
    const doc = JSON.parse(file.text);
    assert.equal(doc.version, '0.2.0');
    assert.equal(doc.template.curves[0].id, 'C01');
    assert.deepEqual(doc.curves[0].points, traced.points);
    const lmk = await writeText(files.dir, 'curve.lmk.json', file.text);
    await current.context.close();
    current = null;

    page = await start();
    await page.setInputFiles('#open-lmk-input', lmk);
    await openMeshes(page, [files.sphere]);
    await frame(page);
    const back = await curveOf(page);
    assert.deepEqual(back.control_points, traced.control_points);
    assert.deepEqual(back.points, traced.points, 'recomputing on the same mesh gives the same points');
    assert.match(await page.locator('#lm-list').innerText(), /C01\s+Brow ridge\s+Placed/);
    assert.equal(await page.evaluate(() => window.__lmk.curveView.pathOf('C01').length > 10), true, 'drawn');
  });
});
