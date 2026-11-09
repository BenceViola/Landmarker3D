import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCurve, resample, densify, pathLength, curveInputs, curveState, curveDone, nPointsOf } from '../../js/curves.js';

const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} ≉ ${b}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// A sphere of radius R at the origin as "the surface".
const R = 10;
const sphere = (p) => {
  const L = Math.hypot(...p);
  return { position: p.map((x) => (x / L) * R), anchor: { face: 0, bary: [1, 0, 0] }, normal: p.map((x) => x / L) };
};
// A flat surface z = 0.
const flat = (p) => ({ position: [p[0], p[1], 0] });
const noLandmarks = () => null;
const cps = (...pts) => ({ status: 'placed', control_points: pts.map((position) => ({ position })) });

describe('resampling', () => {
  test('free ends: n points from end to end, equally spaced', () => {
    const pts = resample([[0, 0, 0], [10, 0, 0]], 5, 0, 0, false);
    assert.deepEqual(pts.map((p) => p[0]), [0, 2.5, 5, 7.5, 10]);
  });
  test('anchored ends are left out: n points strictly between', () => {
    const pts = resample([[0, 0, 0], [12, 0, 0]], 3, 1, 1, false);
    assert.deepEqual(pts.map((p) => p[0]), [3, 6, 9]);
    const one = resample([[0, 0, 0], [12, 0, 0]], 3, 1, 0, false);
    assert.deepEqual(one.map((p) => p[0]), [4, 8, 12]);
  });
  test('closed loop: n points spread around, none repeated', () => {
    const sq = densify([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], true, 0.1);
    close(pathLength(sq), 4);
    const pts = resample(sq, 8, 0, 0, true);
    assert.equal(pts.length, 8);
    for (let i = 0; i < 8; i++) close(dist(pts[i], pts[(i + 1) % 8]), 0.5, 1e-9);
  });
  test('a single point goes in the middle', () => {
    assert.deepEqual(resample([[0, 0, 0], [4, 0, 0]], 1, 0, 0, false), [[2, 0, 0]]);
    // also with one or both ends anchored (spec: with one point it sits in the middle of the path)
    for (const [a, b] of [[1, 0], [0, 1], [1, 1]]) assert.deepEqual(resample([[0, 0, 0], [4, 0, 0]], 1, a, b, false), [[2, 0, 0]], `a=${a} b=${b}`);
  });
});

describe('computing a curve on a surface', () => {
  test('on a flat surface the path is the polyline and its length is exact', () => {
    const r = computeCurve({ n_points: 4 }, cps([0, 0, 0], [3, 0, 0], [3, 4, 0]), noLandmarks, flat);
    assert.equal(r.error, null);
    close(r.length, 7);
    assert.equal(r.points.length, 4);
    // Equal spacing along the path: 0, 7/3, 14/3, 7.
    const along = (p) => (p[1] === 0 ? p[0] : 3 + p[1]);
    r.points.forEach((p, k) => close(along(p.position), (7 * k) / 3, 1e-9));
  });

  test('on a sphere the path follows the surface: every point on it, length the great-circle arc', () => {
    const r = computeCurve({ n_points: 9 }, cps([R, 0, 0], [0, R, 0]), noLandmarks, sphere);
    for (const p of r.points) close(Math.hypot(...p.position), R, 1e-5);
    for (const p of r.path) close(Math.hypot(...p), R, 1e-5);
    close(r.length, (Math.PI / 2) * R, 1e-3);
    // Equal arc spacing: neighbouring points 1/8 of the quarter circle apart (chord).
    const chord = 2 * R * Math.sin(Math.PI / 32);
    for (let i = 1; i < 9; i++) close(dist(r.points[i - 1].position, r.points[i].position), chord, 1e-3);
    assert.ok(r.points[0].anchor && r.points[0].normal, 'semilandmarks carry anchor and normal');
  });

  test('anchored ends come from the landmarks and are not repeated in the points', () => {
    const lms = { LM01: { status: 'placed', position: [0, 0, 0] }, LM02: { status: 'placed', position: [10, 0, 0] } };
    const def = { n_points: 4, start: 'LM01', end: 'LM02' };
    const r = computeCurve(def, cps([5, 5, 0]), (id) => lms[id], flat);
    assert.equal(r.points.length, 4);
    const L = 2 * Math.hypot(5, 5);
    close(r.length, L);
    // First semilandmark one fifth of the way along, not on LM01.
    close(dist(r.points[0].position, [0, 0, 0]), L / 5, 1e-9);
  });

  test('an anchored landmark that isn’t placed (or is missing) stops the curve with a reason', () => {
    const def = { start: 'LM01', end: 'LM02' };
    const lms = { LM02: { status: 'missing', position: null } };
    const r = computeCurve(def, cps([1, 0, 0], [2, 0, 0]), (id) => lms[id], flat);
    assert.deepEqual(r.error, { code: 'start', id: 'LM01' });
    assert.deepEqual(r.points, []);
    const only = curveInputs({ end: 'LM02' }, cps([1, 0, 0]), (id) => lms[id]);
    assert.deepEqual(only.error, { code: 'end', id: 'LM02' });
  });

  test('too few points: no semilandmarks yet (2 for an open curve, 3 for a loop)', () => {
    assert.equal(computeCurve({}, cps([0, 0, 0]), noLandmarks, flat).error.code, 'few');
    const loop = computeCurve({ closed: true }, cps([0, 0, 0], [1, 0, 0]), noLandmarks, flat);
    assert.equal(loop.error.code, 'few');
    assert.equal(loop.points.length, 0);
    const ok = computeCurve({ closed: true, n_points: 6 }, cps([0, 0, 0], [1, 0, 0], [0, 1, 0]), noLandmarks, flat);
    assert.equal(ok.points.length, 6);
    close(ok.length, 2 + Math.SQRT2);
  });

  test('a closed loop ignores start and end', () => {
    const lms = { LM01: { status: 'placed', position: [9, 9, 0] } };
    const r = computeCurve({ closed: true, start: 'LM01', n_points: 3 }, cps([0, 0, 0], [1, 0, 0], [0, 1, 0]), (id) => lms[id], flat);
    assert.equal(r.error, null);
    close(r.length, 2 + Math.SQRT2);
  });

  test('defaults and states', () => {
    assert.equal(nPointsOf({}), 10);
    assert.equal(nPointsOf({ n_points: 3 }), 3);
    assert.equal(curveState(null), 'todo');
    assert.equal(curveState({ control_points: [{}] , points: [] }), 'partial');
    assert.equal(curveState({ status: 'estimated', points: [{}] }), 'estimated');
    assert.equal(curveState({ status: 'missing' }), 'missing');
    assert.equal(curveDone({ control_points: [{}], points: [] }), false);
    assert.equal(curveDone({ status: 'missing' }), true);
  });

  test('speed: 500 points over a long path', () => {
    const t0 = performance.now();
    const pts = Array.from({ length: 30 }, (_, i) => [Math.cos(i / 5) * R, Math.sin(i / 5) * R, i * 0.1]);
    const r = computeCurve({ n_points: 500 }, cps(...pts), noLandmarks, sphere);
    assert.equal(r.points.length, 500);
    assert.ok(performance.now() - t0 < 200);
  });
});
