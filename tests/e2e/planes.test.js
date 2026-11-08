// Browser tests for planes (format v0.4): planes from landmarks in the
// template, planes from three clicks, the cut line, cutting away one side,
// distance tables, and saving.

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, openApp, canvasCenter, clickAt, saved, waitForSaves, selectTab } from './helpers.js';

let server, url, browser, current;

before(async () => {
  ({ server, url } = await startServer());
  browser = await launch();
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

const OFFSETS = [[-60, -30], [50, -40], [10, 50], [-30, 30], [40, 20]];
const placedCount = (page) => page.evaluate(() => window.__lmk.session.points.filter((p) => p.status !== 'missing').length);

// Place the first n template landmarks by clicking around the middle of the view.
async function placeSome(page, n) {
  const c = await canvasCenter(page);
  for (let i = 0; i < n; i++) {
    const [dx, dy] = OFFSETS[i];
    await clickAt(page, { x: c.x + dx, y: c.y + dy });
    await page.waitForFunction((k) => window.__lmk.session.points.length >= k, i + 1);
  }
}

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function untickAll(page) {
  const ticked = page.locator('[data-act="lm-pick"]:checked');
  while (await ticked.count()) await ticked.first().click();
}

async function addPlane(page, ids) {
  await selectTab(page, 'Planes');
  await page.getByRole('button', { name: '+ Plane from landmarks' }).click();
  // Untick the guessed landmarks, then tick the wanted ones in order.
  await untickAll(page);
  for (const id of ids) await page.locator(`[data-act="lm-pick"][data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Add plane' }).click();
  await frame(page);
}

describe('planes from landmarks', () => {
  test('a plane through three landmarks is drawn, cuts the mesh and is saved as v0.4', async () => {
    const page = await start();
    await placeSome(page, 3);
    await addPlane(page, ['LM01', 'LM02', 'LM03']);

    const row = page.locator('.plane-row').first();
    assert.match(await row.innerText(), /Midsagittal/);
    assert.match(await row.innerText(), /Through 3 landmarks/);
    const segs = await page.evaluate(() => window.__lmk.planeView.segmentsOf('PL01'));
    assert.ok(segs > 10, `the cut line has segments (${segs})`);

    // The template holds the plane; the specimen file is written as 0.4.0.
    const tpl = await page.evaluate(() => window.__lmk.session.template.planes);
    assert.deepEqual(tpl, [{ id: 'PL01', name: 'Midsagittal', landmarks: ['LM01', 'LM02', 'LM03'] }]);
    await page.locator('#save-btn').click();
    const [file] = await waitForSaves(page, 1);
    const doc = JSON.parse(file.text);
    assert.equal(doc.version, '0.4.0');
    assert.deepEqual(doc.template.planes, tpl);
  });

  test('selecting a plane shows distances; the defining landmarks lie on it', async () => {
    const page = await start();
    await placeSome(page, 4);
    await addPlane(page, ['LM01', 'LM02', 'LM03']);
    // A new plane is selected; clicking it again would unselect it.
    assert.equal(await page.locator('.plane-main').first().getAttribute('aria-pressed'), 'true');
    const table = page.locator('#pl-mid');
    await table.waitFor();
    const rows = await table.locator('tbody tr').allInnerTexts();
    assert.equal(rows.length, 4);
    for (const r of rows.slice(0, 3)) assert.match(r, /\b-?0\.00\b/, `defining landmark on the plane: ${r}`);
    assert.match(rows[0], /plane/);
  });

  test('a plane appears once three of its landmarks are placed', async () => {
    const page = await start();
    await placeSome(page, 2);
    await addPlane(page, ['LM01', 'LM02', 'LM03']);
    assert.match(await page.locator('.plane-row').first().innerText(), /Place LM03 first/);
    assert.equal(await page.evaluate(() => window.__lmk.planeView.segmentsOf('PL01')), 0);

    // Placing LM03 (the current landmark) makes the plane.
    const c = await canvasCenter(page);
    await clickAt(page, { x: c.x + OFFSETS[2][0], y: c.y + OFFSETS[2][1] });
    await frame(page);
    assert.match(await page.locator('.plane-row').first().innerText(), /Through 3 landmarks/);
    const before = await page.evaluate(() => window.__lmk.planeView.segmentsOf('PL01'));
    assert.ok(before > 0);
  });

  test('fewer than three landmarks are refused; deleting a landmark removes it from planes', async () => {
    const page = await start();
    await selectTab(page, 'Planes');
    await page.getByRole('button', { name: '+ Plane from landmarks' }).click();
    await untickAll(page);
    await page.locator('[data-act="lm-pick"][data-id="LM01"]').click();
    await page.getByRole('button', { name: 'Add plane' }).click();
    assert.match(await page.locator('.plane-editor [role="alert"]').innerText(), /three/i);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await addPlane(page, ['LM01', 'LM02', 'LM03', 'LM04']);
    await page.evaluate(() => window.__lmk.session.removeDef('LM04'));
    const planes = await page.evaluate(() => window.__lmk.session.template.planes);
    assert.deepEqual(planes[0].landmarks, ['LM01', 'LM02', 'LM03']);
  });

  test('cutting away one side clips the mesh, and picking ignores the hidden side', async () => {
    const page = await start();
    await placeSome(page, 3);
    await addPlane(page, ['LM01', 'LM02', 'LM03']);
    // A new plane is selected; clicking it again would unselect it.
    assert.equal(await page.locator('.plane-main').first().getAttribute('aria-pressed'), 'true');
    await page.locator('#pl-cutaway').selectOption('front');
    await frame(page);
    const clip = await page.evaluate(() => ({
      planes: window.__lmk.viewer.material.clippingPlanes?.length || 0,
      keep: typeof window.__lmk.picker.keep,
    }));
    assert.deepEqual(clip, { planes: 1, keep: 'function' });

    await page.locator('#pl-cutaway').selectOption('none');
    await frame(page);
    const off = await page.evaluate(() => ({
      planes: window.__lmk.viewer.material.clippingPlanes?.length || 0,
      keep: window.__lmk.picker.keep,
    }));
    assert.deepEqual(off, { planes: 0, keep: null });
  });

  test('removing a plane takes it out of the template and the file goes back to its old version', async () => {
    const page = await start();
    await placeSome(page, 3);
    await addPlane(page, ['LM01', 'LM02', 'LM03']);
    await page.getByRole('button', { name: /^Edit Midsagittal/ }).click();
    await page.getByRole('button', { name: 'Delete plane…' }).click();
    await page.locator('.plane-editor').getByRole('button', { name: 'Delete', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__lmk.session.template.planes), undefined);
    await page.locator('#save-btn').click();
    const [file] = await waitForSaves(page, 1);
    assert.equal(JSON.parse(file.text).version, '0.2.0');
  });
});

describe('planes from clicks', () => {
  test('three clicks make a plane for exploring; they place no landmarks and are not saved', async () => {
    const page = await start();
    await selectTab(page, 'Planes');
    await page.getByRole('button', { name: '+ Plane from 3 clicks' }).click();
    assert.match(await page.locator('#stage-hint').innerText(), /Click 3 more points/);
    const c = await canvasCenter(page);
    for (const [dx, dy] of OFFSETS.slice(0, 3)) await clickAt(page, { x: c.x + dx, y: c.y + dy });
    await frame(page);

    assert.equal(await placedCount(page), 0, 'no landmarks placed');
    assert.match(await page.locator('.plane-row').first().innerText(), /Clicked plane 1/);
    assert.ok((await page.evaluate(() => window.__lmk.planeView.segmentsOf('C1'))) > 0);
    // Clicks place landmarks again afterwards.
    await clickAt(page, { x: c.x, y: c.y });
    assert.equal(await placedCount(page), 1);

    await page.locator('#save-btn').click();
    const [file] = await waitForSaves(page, 1);
    const doc = JSON.parse(file.text);
    assert.equal(doc.version, '0.2.0');
    assert.equal(doc.template.planes, undefined);
  });

  test('Esc cancels picking', async () => {
    const page = await start();
    await selectTab(page, 'Planes');
    await page.getByRole('button', { name: '+ Plane from 3 clicks' }).click();
    const c = await canvasCenter(page);
    await clickAt(page, { x: c.x, y: c.y });
    assert.match(await page.locator('#stage-hint').innerText(), /Click 2 more points/);
    await page.keyboard.press('Escape');
    assert.doesNotMatch(await page.locator('#stage-hint').innerText(), /more point/);
    await clickAt(page, { x: c.x, y: c.y });
    assert.equal(await placedCount(page), 1, 'clicks place landmarks again');
  });
});

describe('layout', () => {
  test('five tabs fit the panel on a narrow screen', async () => {
    const page = await start({ width: 390, height: 800 });
    const over = await page.evaluate(() => {
      const list = document.querySelector('.tablist');
      return [...list.children].some((t) => t.getBoundingClientRect().right > list.getBoundingClientRect().right + 1);
    });
    assert.equal(over, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await selectTab(page, 'Planes');
    assert.ok(await page.locator('#tab-planes').isVisible());
  });
});
