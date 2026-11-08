import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitPlane, signedDistance, eigenSymmetric3, planeCut, cutLength, planeOnSpecimen } from '../../js/planes.js';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} ≉ ${b}`);
const closeVec = (a, b, eps = 1e-9) => a.forEach((x, i) => close(x, b[i], eps, `[${i}]`));

// Seeded random numbers, so failures can be reproduced.
function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

describe('fitting a plane', () => {
  test('three points: the plane through them, normal by the right-hand rule', () => {
    const r = fitPlane([[0, 0, 5], [1, 0, 5], [0, 1, 5]]);
    assert.equal(r.exact, true);
    closeVec(r.plane.normal, [0, 0, 1]);
    close(r.rms, 0);
    const flipped = fitPlane([[0, 0, 5], [0, 1, 5], [1, 0, 5]]);
    closeVec(flipped.plane.normal, [0, 0, -1], 1e-12);
  });

  test('more points: least-squares fit recovers a known plane from noisy points', () => {
    const rand = rng(42);
    const n = new THREE.Vector3(1, 2, -0.5).normalize();
    const p0 = new THREE.Vector3(10, -4, 30);
    const u = new THREE.Vector3(0, 0, 1).cross(n).normalize();
    const w = n.clone().cross(u);
    const pts = [];
    for (let i = 0; i < 200; i++) {
      const q = p0.clone().addScaledVector(u, (rand() - 0.5) * 60).addScaledVector(w, (rand() - 0.5) * 40).addScaledVector(n, (rand() - 0.5) * 0.2);
      pts.push(q.toArray());
    }
    const r = fitPlane(pts);
    assert.equal(r.exact, false);
    const dotN = Math.abs(r.plane.normal[0] * n.x + r.plane.normal[1] * n.y + r.plane.normal[2] * n.z);
    assert.ok(dotN > 0.99999, `normal recovered (|cos| = ${dotN})`);
    close(signedDistance(r.plane, p0.toArray()), 0, 0.02, 'known point lies on the fit');
    assert.ok(r.rms > 0.03 && r.rms < 0.07, `rms ≈ noise sd (${r.rms})`);
  });

  test('the fit minimises squared distances (no tilted plane does better)', () => {
    const rand = rng(7);
    const pts = Array.from({ length: 30 }, () => [rand() * 10, rand() * 10, rand() * 0.5 + rand() * 0.3]);
    const r = fitPlane(pts);
    const ss = (pl) => pts.reduce((s, p) => s + signedDistance(pl, p) ** 2, 0);
    const best = ss(r.plane);
    for (let k = 0; k < 50; k++) {
      const tilt = [r.plane.normal[0] + (rand() - 0.5) * 0.05, r.plane.normal[1] + (rand() - 0.5) * 0.05, r.plane.normal[2]];
      const len = Math.hypot(...tilt);
      assert.ok(ss({ point: r.plane.point, normal: tilt.map((x) => x / len) }) >= best - 1e-9);
    }
  });

  test('a best fit keeps the side given by the first three points', () => {
    const pts = [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0.01]];
    assert.ok(fitPlane(pts).plane.normal[2] < 0, 'same as the first three: (B−A)×(C−A) points down');
  });

  test('reports the largest distance and which point it is', () => {
    const r = fitPlane([[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0], [5, 5, 1]]);
    assert.equal(r.maxIndex, 4);
    assert.ok(r.max > 0.5);
    assert.equal(r.distances.length, 5);
  });

  test('points on one line, or too few, give no plane', () => {
    assert.equal(fitPlane([[0, 0, 0], [1, 1, 1]]).error, 'too_few');
    assert.equal(fitPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2]]).error, 'collinear');
    assert.equal(fitPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3.0000000001]]).error, 'collinear');
    assert.equal(fitPlane([[1, 1, 1], [1, 1, 1], [1, 1, 1]]).error, 'collinear');
  });

  test('eigen decomposition of a symmetric matrix', () => {
    const e = eigenSymmetric3([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
    for (const { value, vector } of e) {
      const Av = [4 * vector[0] + vector[1], vector[0] + 3 * vector[1] + vector[2], vector[1] + 2 * vector[2]];
      closeVec(Av, vector.map((x) => x * value), 1e-9);
    }
    assert.ok(e[0].value <= e[1].value && e[1].value <= e[2].value);
  });
});

describe('cutting a mesh', () => {
  test('a sphere cut through its centre gives a circle of its radius', () => {
    const g = new THREE.SphereGeometry(20, 96, 64);
    g.translate(5, -3, 40);
    const plane = { point: [5, -3, 40], normal: [0, 0.6, 0.8] };
    const seg = planeCut(g.attributes.position.array, g.index.array, plane);
    assert.ok(seg.length > 0);
    for (let i = 0; i < seg.length; i += 3) {
      const p = [seg[i], seg[i + 1], seg[i + 2]];
      close(signedDistance(plane, p), 0, 1e-4, 'on the plane');
      const r = Math.hypot(p[0] - 5, p[1] + 3, p[2] - 40);
      assert.ok(r > 19.9 && r <= 20.0001, `on the sphere (r = ${r})`);
    }
    const L = cutLength(seg);
    assert.ok(Math.abs(L - 2 * Math.PI * 20) / (2 * Math.PI * 20) < 0.005, `circumference (${L})`);
  });

  test('works the same for STL-style triangles without an index', () => {
    const g = new THREE.SphereGeometry(10, 48, 32);
    const plane = { point: [0, 2, 0], normal: [0, 1, 0] };
    const a = planeCut(g.attributes.position.array, g.index.array, plane);
    const flat = g.toNonIndexed();
    const b = planeCut(flat.attributes.position.array, null, plane);
    assert.equal(a.length, b.length);
    close(cutLength(a), cutLength(b), 1e-3);
  });

  test('a plane that misses the mesh gives nothing', () => {
    const g = new THREE.BoxGeometry(2, 2, 2);
    assert.equal(planeCut(g.attributes.position.array, g.index.array, { point: [0, 0, 5], normal: [0, 0, 1] }).length, 0);
  });

  test('a plane through mesh vertices gives clean segments, not zero-length ones', () => {
    const g = new THREE.BoxGeometry(2, 2, 2, 2, 2, 2); // has vertices at z = 0
    const seg = planeCut(g.attributes.position.array, g.index.array, { point: [0, 0, 0], normal: [0, 0, 1] });
    for (let i = 0; i < seg.length; i += 6) {
      const len = Math.hypot(seg[i + 3] - seg[i], seg[i + 4] - seg[i + 1], seg[i + 5] - seg[i + 2]);
      assert.ok(len > 1e-6, 'no zero-length segment');
    }
  });

  test('speed: a million triangles in well under a second', () => {
    const g = new THREE.TorusKnotGeometry(10, 3, 2500, 200).toNonIndexed(); // 1,000,000 triangles
    const t0 = performance.now();
    planeCut(g.attributes.position.array, null, { point: [0, 0, 0], normal: [1, 0, 0] });
    const ms = performance.now() - t0;
    assert.ok(ms < 800, `${ms.toFixed(0)} ms`);
  });
});

describe('a template plane on a specimen', () => {
  const def = { id: 'PL01', name: 'Midsagittal', landmarks: ['LM01', 'LM02', 'LM03', 'LM04'] };
  const pt = (id, position, status = 'placed') => ({ id, template_id: id, status, position });

  test('uses placed landmarks, lists the ones it lacks', () => {
    const r = planeOnSpecimen(def, [pt('LM01', [0, 0, 0]), pt('LM02', [1, 0, 0]), pt('LM03', [0, 1, 0]), pt('LM04', null, 'missing')]);
    assert.deepEqual(r.used.map((u) => u.id), ['LM01', 'LM02', 'LM03']);
    assert.deepEqual(r.lacking, ['LM04']);
    assert.equal(r.exact, true);
  });

  test('not enough landmarks placed: no plane', () => {
    const r = planeOnSpecimen(def, [pt('LM01', [0, 0, 0]), pt('LM03', [0, 1, 0])]);
    assert.equal(r.error, 'too_few');
    assert.deepEqual(r.lacking, ['LM02', 'LM04']);
  });
});
