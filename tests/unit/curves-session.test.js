// Curves in the session, in landmark files and in the exports.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Session, cpKey, recordHasData } from '../../js/session.js';
import { buildLandmarkFile, parseLandmarkFile, exportItems } from '../../js/landmark-file.js';
import { computeCurve, samplingOf } from '../../js/curves.js';
import { toTps } from '../../js/tps.js';
import { toCsv, exportRows } from '../../js/csv.js';
import { progress, templateDifference } from '../../js/set-model.js';
import { hit, MESH, SMALL_TEMPLATE } from '../fixtures.js';

const flat = (p) => ({ position: [p[0], p[1], 0], anchor: { face: 0, bary: [1, 0, 0] }, normal: [0, 0, 1] });

// SMALL_TEMPLATE with one curve from LM01 to LM02 (3 semilandmarks between).
function withCurve({ n = 3, ...extra } = {}) {
  const s = new Session(SMALL_TEMPLATE);
  const id = s.addCurveDef('Brow ridge');
  s.updateCurveDef(id, { start: 'LM01', end: 'LM02', n_points: n, ...extra });
  return { s, id };
}

// What the app does after each change: compute the current specimen's curves.
function recompute(s) {
  for (const def of s.curveDefs) {
    const entry = s.curve(def.id);
    if (!entry) continue;
    const r = computeCurve(def, entry, (id) => s.point(id), flat);
    s.setCurveResult(s.current, def.id, { points: r.points, length: r.length, sampling: samplingOf(def) });
  }
}

function placedCurve() {
  const { s, id } = withCurve();
  s.place('LM01', hit(0, 0, 0));
  s.place('LM02', hit(8, 0, 0));
  s.place('LM03', hit(9, 9, 0));
  s.setActive(id);
  s.place(id, hit(4, 4, 0));
  recompute(s);
  return { s, id };
}

describe('curves in the template', () => {
  test('a new curve gets the next free C id and the defaults', () => {
    const { s, id } = withCurve();
    assert.equal(id, 'C01');
    assert.deepEqual(s.curveDef('C01'), { id: 'C01', name: 'Brow ridge', n_points: 3, path: 'euclidean', spacing: 'equal_arc_length', start: 'LM01', end: 'LM02' });
    assert.equal(s.addCurveDef('Second'), 'C02');
    assert.equal(s.addCurveDef('  '), null);
  });

  test('checks: number of points, ends on landmarks, ids shared with landmarks', () => {
    const { s, id } = withCurve();
    assert.match(s.updateCurveDef(id, { n_points: 0 }), /whole number from 1/);
    assert.match(s.updateCurveDef(id, { n_points: 2.5 }), /whole number/);
    assert.match(s.updateCurveDef(id, { end: 'LM09' }), /not a landmark/);
    assert.match(s.updateCurveDef(id, { end: 'LM01' }), /same landmark/);
    assert.match(s.updateCurveDef(id, { id: 'LM02' }), /already used/);
    assert.match(s.updateDef('LM01', { id: 'C01' }), /already used/);
    assert.match(s.updateCurveDef(id, { name: '' }), /needs a name/);
  });

  test('a closed loop has no ends', () => {
    const { s, id } = withCurve();
    assert.equal(s.updateCurveDef(id, { closed: true }), null);
    assert.equal(s.curveDef(id).closed, true);
    assert.equal('start' in s.curveDef(id), false);
  });

  test('renaming or deleting a landmark updates the curve ends', () => {
    const { s, id } = withCurve();
    s.updateDef('LM01', { id: 'NAS' });
    assert.equal(s.curveDef(id).start, 'NAS');
    s.removeDef('LM02');
    assert.equal('end' in s.curveDef(id), false);
  });

  test('deleting a curve removes it from every specimen; undo brings it back', () => {
    const { s, id } = placedCurve();
    s.removeCurveDef(id);
    assert.equal(s.curveDef(id), null);
    assert.equal(s.template.curves, undefined);
    assert.deepEqual(s.current.curves, []);
    s.undo();
    assert.equal(s.curve(id).control_points.length, 1);
  });

  test('a curve’s ID is locked once it has data', () => {
    const { s, id } = placedCurve();
    assert.match(s.updateCurveDef(id, { id: 'BROW' }), /already has data/);
  });
});

describe('placing a curve', () => {
  test('landmarks first, then curves; clicks on a curve add control points and keep it selected', () => {
    const { s, id } = withCurve();
    assert.equal(s.activeId, 'LM01');
    s.place('LM01', hit(0, 0, 0));
    s.place('LM02', hit(8, 0, 0));
    s.place('LM03', hit(9, 9, 0));
    assert.equal(s.activeId, id, 'the curve is next');
    s.place(id, hit(4, 4, 0));
    s.place(id, hit(6, 2, 0));
    assert.equal(s.activeId, id);
    assert.equal(s.curve(id).control_points.length, 2);
    assert.deepEqual(s.curve(id).control_points[0], { position: [4, 4, 0], anchor: hit(4, 4, 0).anchor });
    assert.equal(s.stateOf(id), 'partial', 'no semilandmarks until computed');
    recompute(s);
    assert.equal(s.stateOf(id), 'placed');
    assert.equal(s.curve(id).points.length, 3);
    assert.equal(s.nextTodo(null), null, 'everything done');
  });

  test('progress and counts include curves', () => {
    const { s } = placedCurve();
    assert.deepEqual(s.progressOf(), { done: 4, total: 4 });
    assert.equal(s.counts().total, 4);
    assert.equal(s.counts().placed, 4);
  });

  test('Backspace takes back the last click; undo and redo work on clicks', () => {
    const { s, id } = placedCurve();
    s.place(id, hit(6, 2, 0));
    assert.equal(s.curve(id).control_points.length, 2);
    s.removeLastControlPoint(id);
    assert.equal(s.curve(id).control_points.length, 1);
    s.removeLastControlPoint(id);
    assert.equal(s.curve(id), null, 'the last click gone: the curve is to do again');
    s.undo();
    assert.equal(s.curve(id).control_points.length, 1);
  });

  test('dragging a control point is one undo step', () => {
    const { s, id } = placedCurve();
    s.beginMove();
    s.moveTo(cpKey(id, 0), hit(4, 5, 0));
    s.moveTo(cpKey(id, 0), hit(4, 6, 0));
    s.endMove();
    assert.deepEqual(s.curve(id).control_points[0].position, [4, 6, 0]);
    s.undo();
    assert.deepEqual(s.curve(id).control_points[0].position, [4, 4, 0]);
  });

  test('missing, estimated, clear and note', () => {
    const { s, id } = placedCurve();
    s.toggleEstimated(id);
    assert.equal(s.stateOf(id), 'estimated');
    s.setNote(id, 'worn');
    assert.equal(s.curve(id).note, 'worn');
    s.markMissing(id);
    assert.equal(s.stateOf(id), 'missing');
    assert.deepEqual(s.curve(id).control_points, []);
    assert.equal(s.setCurveResult(s.current, id, { points: [{ position: [1, 2, 3] }], length: 1, sampling: {} }), false, 'a missing curve gets no points');
    s.place(id, hit(1, 1, 0));
    assert.equal(s.curve(id).status, 'placed', 'clicking again un-misses it');
    s.clear(id);
    assert.equal(s.curve(id), null);
    assert.equal(s.stateOf(id), 'todo');
  });

  test('a specimen with only a curve has data', () => {
    const s = new Session({ ...SMALL_TEMPLATE, landmarks: [], curves: [{ id: 'C01', name: 'x' }] });
    assert.equal(recordHasData(s.current), false);
    s.place('C01', hit(1, 1, 1));
    assert.equal(recordHasData(s.current), true);
  });
});

describe('curves in files', () => {
  const save = (s) => buildLandmarkFile({ session: s, mesh: MESH, units: 'mm', specimenId: 'A' });

  test('saved as top-level curves (format 0.2.0), opened again unchanged', () => {
    const { s, id } = placedCurve();
    const { doc, text } = save(s);
    assert.equal(doc.version, '0.2.0');
    assert.equal(doc.curves.length, 1);
    const c = doc.curves[0];
    assert.deepEqual(Object.keys(c), ['id', 'template_id', 'status', 'control_points', 'points', 'placed_at', 'length', 'sampling']);
    assert.deepEqual(c.sampling, { path: 'euclidean', spacing: 'equal_arc_length', n_points: 3 });
    assert.equal(c.points.length, 3);
    assert.ok(c.length > 0);
    assert.deepEqual(doc.template.curves, [s.curveDef(id)]);

    const p = parseLandmarkFile(text, 'A.lmk.json');
    assert.deepEqual(p.warnings, []);
    assert.deepEqual(p.curves, doc.curves);
    const s2 = new Session(p.template);
    s2.load(p.template, p.points, p.curves);
    assert.equal(s2.stateOf(id), 'placed');
    const again = buildLandmarkFile({ session: s2, mesh: MESH, units: 'mm', specimenId: 'A', base: p.doc });
    assert.deepEqual(again.doc.curves, doc.curves);
  });

  test('a missing curve is saved with empty lists', () => {
    const { s, id } = placedCurve();
    s.markMissing(id);
    const c = save(s).doc.curves[0];
    assert.equal(c.status, 'missing');
    assert.deepEqual(c.control_points, []);
    assert.deepEqual(c.points, []);
  });

  test('bad curve definitions and entries are dropped or fixed, with a note', () => {
    const { s } = placedCurve();
    const doc = save(s).doc;
    doc.template.curves.push({ id: 'C01' }, { id: 'C02', name: 'x', start: 'LM77' });
    doc.curves.push({ id: 'C99', template_id: 'C99', status: 'placed' });
    const p = parseLandmarkFile(JSON.stringify(doc), 'A.lmk.json');
    assert.equal(p.template.curves.length, 2);
    assert.equal('start' in p.template.curves[1], false);
    assert.equal(p.curves.length, 1);
    assert.match(p.warnings.join(' '), /curve definition was unreadable/);
    assert.match(p.warnings.join(' '), /became free/);
    assert.match(p.warnings.join(' '), /kept in the file/);
    // The curve not in the template survives a save.
    const s2 = new Session(p.template);
    s2.load(p.template, p.points, p.curves);
    const again = buildLandmarkFile({ session: s2, mesh: MESH, units: 'mm', specimenId: 'A', base: p.doc });
    assert.deepEqual(again.doc.curves.map((c) => c.id), ['C01', 'C99']);
  });
});

describe('curves in exports', () => {
  const state = (s) => ({ specimen: { id: 'A', mesh: { ...MESH, units: 'mm' } }, template: s.template, points: s.points, curves: s.current.curves });

  test('export order: landmarks, then each curve’s semilandmarks, then ad hoc points', () => {
    const { s } = placedCurve();
    assert.deepEqual(exportItems(s.template).map((x) => x.id), ['LM01', 'LM02', 'LM03', 'C01']);
    const rows = exportRows(state(s));
    assert.deepEqual(rows.map((r) => r.point), ['LM01', 'LM02', 'LM03', 'C01_01', 'C01_02', 'C01_03']);
    assert.deepEqual(rows.slice(3).map((r) => [r.type, r.curve, r.index]), [['curve', 'C01', 1], ['curve', 'C01', 2], ['curve', 'C01', 3]]);
  });

  test('template export_order can put a curve between landmarks', () => {
    const { s } = placedCurve();
    s.template.export_order = ['LM01', 'C01', 'LM02'];
    assert.deepEqual(exportItems(s.template).map((x) => x.id), ['LM01', 'C01', 'LM02', 'LM03']);
  });

  test('TPS has a row per semilandmark; an unfinished curve is written as missing and counted', () => {
    const { s, id } = placedCurve();
    const tps = toTps([state(s)]);
    assert.match(tps.text, /^LM3=6\n/);
    assert.equal(tps.notPlaced, 0);
    s.clear(id);
    const unfinished = toTps([state(s)]);
    assert.match(unfinished.text, /LM3=6\n(.*\n){3}-999 -999 -999\n-999 -999 -999\n-999 -999 -999\nID=A/);
    assert.equal(unfinished.notPlaced, 3);
  });

  test('a curve with a different number of points than the template is not exported', () => {
    const { s, id } = placedCurve();
    s.updateCurveDef(id, { n_points: 5 }); // not recomputed: the 3 old points don't fit
    const rows = exportRows(state(s)).filter((r) => r.type === 'curve');
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.pos === null && r.status === 'not_done'));
  });

  test('CSV fills the curve and index columns', () => {
    const { s } = placedCurve();
    const lines = toCsv([state(s)]).trim().split('\n');
    assert.equal(lines.length, 1 + 6);
    assert.match(lines[4], /^A,A,1,,[^,]*,C01_01,C01,Brow ridge,curve,C01,1,/);
  });

  test('progress and template comparison know about curves', () => {
    const { s, id } = placedCurve();
    assert.deepEqual(progress(state(s)), { done: 4, total: 4 });
    const other = structuredClone(s.template);
    other.curves[0].n_points = 4;
    assert.match(templateDifference(s.template, other), /curves/);
    assert.equal(templateDifference(s.template, structuredClone(s.template)), null);
    s.clear(id);
    assert.deepEqual(progress(state(s)), { done: 3, total: 4 });
  });
});
