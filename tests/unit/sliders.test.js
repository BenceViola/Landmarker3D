// The geomorph sliders file (curveslide.csv).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slidersOf, toSlidersCsv, hasSliders, slidersFileName } from '../../js/sliders.js';
import { exportRows } from '../../js/export-rows.js';
import { handInFiles } from '../../js/handin.js';
import { buildLandmarkFile } from '../../js/landmark-file.js';
import { Session } from '../../js/session.js';
import { MESH, SMALL_TEMPLATE, hit } from '../fixtures.js';

// SMALL_TEMPLATE has LM01..LM03; curves are added per test.
const tpl = (...curves) => ({ ...structuredClone(SMALL_TEMPLATE), curves });
const rows = (t) => slidersOf(t).sliders.map((s) => [s.before, s.slide, s.after]);

describe('which points slide', () => {
  test('a curve anchored at both ends: every semilandmark slides, the ends on their landmarks', () => {
    // Rows: LM01 LM02 LM03, then C01_01..C01_03 at rows 4..6.
    const t = tpl({ id: 'C01', name: 'c', n_points: 3, start: 'LM01', end: 'LM02' });
    assert.deepEqual(slidersOf(t).names, ['LM01', 'LM02', 'LM03', 'C01_01', 'C01_02', 'C01_03']);
    assert.deepEqual(rows(t), [[1, 4, 5], [4, 5, 6], [5, 6, 2]]);
  });

  test('a free end is the curve’s end point and does not slide', () => {
    const start = tpl({ id: 'C01', name: 'c', n_points: 3, start: 'LM03' });
    assert.deepEqual(rows(start), [[3, 4, 5], [4, 5, 6]]);
    const free = tpl({ id: 'C01', name: 'c', n_points: 4 });
    assert.deepEqual(rows(free), [[4, 5, 6], [5, 6, 7]]);
    assert.deepEqual(rows(tpl({ id: 'C01', name: 'c', n_points: 1 })), [], 'one free point: nothing to slide');
    assert.deepEqual(rows(tpl({ id: 'C01', name: 'c', n_points: 1, start: 'LM01', end: 'LM02' })), [[1, 4, 2]]);
  });

  test('a closed loop: every point slides between its neighbours round the loop', () => {
    const t = tpl({ id: 'C01', name: 'c', n_points: 4, closed: true });
    assert.deepEqual(rows(t), [[7, 4, 5], [4, 5, 6], [5, 6, 7], [6, 7, 4]]);
    assert.deepEqual(rows(tpl({ id: 'C01', name: 'c', n_points: 2, closed: true })), [], 'too short to slide');
  });

  test('several curves, and an export order that puts a curve between landmarks', () => {
    const t = tpl(
      { id: 'C01', name: 'a', n_points: 2, start: 'LM01', end: 'LM02' },
      { id: 'C02', name: 'b', n_points: 2, start: 'LM02', end: 'LM03' }
    );
    assert.deepEqual(rows(t), [[1, 4, 5], [4, 5, 2], [2, 6, 7], [6, 7, 3]]);
    t.export_order = ['LM01', 'C01', 'LM02', 'C02', 'LM03'];
    // Rows: LM01 1, C01_01 2, C01_02 3, LM02 4, C02_01 5, C02_02 6, LM03 7.
    assert.deepEqual(rows(t), [[1, 2, 3], [2, 3, 4], [4, 5, 6], [5, 6, 7]]);
    // The numbers are the TPS rows: check against the export's own order.
    const names = exportRows({ template: t, points: [], curves: [] }).map((r) => r.point);
    assert.deepEqual(names, ['LM01', 'C01_01', 'C01_02', 'LM02', 'C02_01', 'C02_02', 'LM03']);
  });

  test('no curves: no sliders', () => {
    assert.equal(hasSliders(SMALL_TEMPLATE), false);
    assert.equal(hasSliders(tpl({ id: 'C01', name: 'c', n_points: 3, start: 'LM01' })), true);
  });
});

describe('the file', () => {
  test('written as geomorph’s define.sliders() writes curveslide.csv', () => {
    const t = tpl({ id: 'C01', name: 'c', n_points: 2, start: 'LM01', end: 'LM02' });
    assert.equal(toSlidersCsv(t), '"before","slide","after"\n1,4,5\n4,5,2\n');
    assert.equal(slidersFileName('anna_landmarks'), 'anna_landmarks_curveslide.csv');
  });

  test('the hand-in includes it when the template has curves, and not otherwise', () => {
    const s = new Session(tpl({ id: 'C01', name: 'c', n_points: 2, start: 'LM01', end: 'LM02' }));
    s.place('LM01', hit(0, 0, 0));
    const doc = buildLandmarkFile({ session: s, mesh: MESH, units: 'mm', specimenId: 'A', operator: 'anna' });
    const names = handInFiles([doc], { operator: 'anna' }).files.map((f) => f.name);
    assert.deepEqual(names, ['A.lmk.json', 'anna_landmarks.tps', 'anna_landmarks.csv', 'anna_landmarks_curveslide.csv']);
    const plain = buildLandmarkFile({ session: new Session(SMALL_TEMPLATE), mesh: MESH, units: 'mm', specimenId: 'A', operator: 'anna' });
    assert.equal(handInFiles([plain], { operator: 'anna' }).files.some((f) => /curveslide/.test(f.name)), false);
  });
});
