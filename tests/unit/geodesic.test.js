// Shortest paths across the surface (geodesic curves).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology, edgePath, geodesicSegment, tighten } from '../../js/geodesic.js';
import { computeCurve, pathLength } from '../../js/curves.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const radius = (p) => Math.hypot(p[0], p[1]);

// A triangle soup (STL style: every triangle repeats its corners) from a
// grid of points: grid[i][j] -> [x,y,z]; quads between neighbours, wrapping
// round in i when `wrap`.
function soup(grid, { wrap = false, flip = false } = {}) {
  const tris = [];
  const ni = grid.length;
  const nj = grid[0].length;
  for (let i = 0; i < (wrap ? ni : ni - 1); i++) {
    const i2 = (i + 1) % ni;
    for (let j = 0; j < nj - 1; j++) {
      const a = grid[i][j], b = grid[i2][j], c = grid[i2][j + 1], d = grid[i][j + 1];
      if (flip) tris.push(a, c, b, a, d, c);
      else tris.push(a, b, c, a, c, d);
    }
  }
  return tris;
}
const toArray = (tris) => new Float32Array(tris.flat());

// A thin-walled tube: outer wall radius 10, inner wall 9.5, height -5..5,
// closed at both ends by flat rings. The walls are one connected surface.
function tube(segments = 120, rings = 21) {
  const ring = (r, z) => Array.from({ length: segments }, (_, k) => [r * Math.cos((2 * Math.PI * k) / segments), r * Math.sin((2 * Math.PI * k) / segments), z]);
  const col = (r) => Array.from({ length: rings }, (_, j) => -5 + (10 * j) / (rings - 1));
  // Profile around the wall's cross-section: up the outer wall, across the top, down the inner wall, across the bottom.
  const profile = [
    ...col().map((z) => [10, z]),
    [9.75, 5],
    ...col().reverse().map((z) => [9.5, z]),
    [9.75, -5],
    [10, -5],
  ];
  const grid = Array.from({ length: segments }, (_, k) => profile.map(([r, z]) => {
    const t = (2 * Math.PI * k) / segments;
    return [r * Math.cos(t), r * Math.sin(t), z];
  }));
  void ring;
  return toArray(soup(grid, { wrap: true }));
}

// The nearest point on that tube, with the surface's outward normal.
function tubeProject(p) {
  const r = radius(p) || 1e-9;
  const ux = p[0] / r, uy = p[1] / r;
  const z = Math.max(-5, Math.min(5, p[2]));
  const cands = [
    { position: [10 * ux, 10 * uy, z], normal: [ux, uy, 0] },
    { position: [9.5 * ux, 9.5 * uy, z], normal: [-ux, -uy, 0] },
  ];
  const rr = Math.max(9.5, Math.min(10, r));
  cands.push({ position: [rr * ux, rr * uy, 5], normal: [0, 0, 1] }, { position: [rr * ux, rr * uy, -5], normal: [0, 0, -1] });
  let best = null;
  for (const c of cands) if (!best || dist(c.position, p) < dist(best.position, p)) best = c;
  return best;
}

// A unit-ish sphere (radius R) as a latitude-longitude mesh.
const R = 10;
function sphere(nLon = 96, nLat = 48) {
  const grid = Array.from({ length: nLon }, (_, i) =>
    Array.from({ length: nLat + 1 }, (_, j) => {
      const th = (Math.PI * j) / nLat;
      const ph = (2 * Math.PI * i) / nLon;
      // Rounded, so the poles' corners are exactly the same point (as in a real file).
      return [R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), R * Math.cos(th)].map((v) => Math.round(v * 1e6) / 1e6);
    })
  );
  return toArray(soup(grid, { wrap: true }));
}
const sphereProject = (p) => {
  const L = Math.hypot(...p);
  return { position: p.map((x) => (x / L) * R), normal: p.map((x) => x / L) };
};

// The triangle of a soup nearest to a point (by centroid), for a test's start and end faces.
function faceNear(pos, P) {
  let best = -1;
  let bd = Infinity;
  for (let f = 0; f < pos.length / 9; f++) {
    const c = [0, 1, 2].map((k) => (pos[9 * f + k] + pos[9 * f + 3 + k] + pos[9 * f + 6 + k]) / 3);
    const d = dist(c, P);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

describe('which triangles share corners', () => {
  test('repeated STL corners are welded; face order and the file’s geometry are untouched', () => {
    const pos = sphere(24, 12);
    const copy = pos.slice();
    const topo = buildTopology(pos, null);
    assert.deepEqual(pos, copy, 'the file’s positions are not changed');
    assert.equal(topo.tri.length, pos.length / 3);
    // 24 × 11 ring corners + 2 poles (the poles repeat 24 times in the grid).
    assert.equal(topo.nVerts, 24 * 11 + 2);
    // Face f's welded corners are at the file's corner positions, in the file's order.
    for (const f of [0, 7, 100, pos.length / 9 - 1]) {
      for (let k = 0; k < 3; k++) {
        const v = topo.tri[3 * f + k];
        for (let c = 0; c < 3; c++) assert.ok(topo.verts[3 * v + c] === pos[9 * f + 3 * k + c]); // === : -0 is 0
      }
    }
    assert.ok(topo.edge > 0);
  });

  test('corners a hair apart (a seam with rounding differences) are joined; corners clearly apart are not', () => {
    // Two triangles sharing the edge (10,0,0)-(0,10,0); the second's copy of one corner is off by 1e-9 of the size.
    const tris = (dx) => new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10 + dx, 0, 0, 10, 10, 0, 0, 10, 0]);
    assert.equal(buildTopology(tris(0), null).nVerts, 4);
    assert.equal(buildTopology(tris(1e-6), null).nVerts, 4, 'within a millionth of the size: one corner');
    assert.equal(buildTopology(tris(1e-3), null).nVerts, 5, 'a visible gap: two corners');
  });

  test('a mesh with a seam (a lathed tube, first and last column a hair apart) is one surface', () => {
    const pos = tube();
    // Shift the seam's corners (angle 0, x ≈ 0, z > 0) by a hair, as exporters do.
    const seam = pos.slice();
    for (let i = 0; i < seam.length; i += 3) if (Math.abs(seam[i + 1]) < 1e-9 && seam[i] > 0) seam[i + 1] = 2e-6;
    const topo = buildTopology(seam, null);
    const P = [10 * Math.cos(-0.5), 10 * Math.sin(-0.5), 0];
    const Q = [10 * Math.cos(0.5), 10 * Math.sin(0.5), 0];
    const { path } = geodesicSegment(topo, P, faceNear(seam, P), Q, faceNear(seam, Q), tubeProject);
    assert.ok(Math.abs(pathLength(path) - 10) < 0.1, `short way across the seam: ${pathLength(path).toFixed(3)}`);
  });

  test('an indexed mesh (PLY style) gives the same table', () => {
    const pos = sphere(24, 12);
    const topo = buildTopology(pos, null);
    const index = new Uint32Array(pos.length / 3).map((_, i) => i);
    const indexed = buildTopology(pos, index);
    assert.equal(indexed.nVerts, topo.nVerts);
    assert.deepEqual(indexed.tri, topo.tri);
  });
});

describe('shortest paths across the surface', () => {
  test('on a sphere: within 1 % of the great-circle distance, and on the surface', () => {
    const pos = sphere();
    const topo = buildTopology(pos, null);
    const P = sphereProject([1, 0.2, 0.3]).position;
    const Q = sphereProject([-0.2, 1, -0.4]).position;
    const { path, ok } = geodesicSegment(topo, P, faceNear(pos, P), Q, faceNear(pos, Q), sphereProject);
    assert.ok(ok);
    const exact = R * Math.acos((P[0] * Q[0] + P[1] * Q[1] + P[2] * Q[2]) / (R * R));
    const L = pathLength(path);
    assert.ok(Math.abs(L - exact) / exact < 0.01, `length ${L.toFixed(3)} vs great circle ${exact.toFixed(3)}`);
    for (const p of path) assert.ok(Math.abs(Math.hypot(...p) - R) < 1e-6);
    assert.deepEqual(path[0], P);
    assert.deepEqual(path[path.length - 1], Q);
  });

  test('pulling tight shortens the edge route', () => {
    const pos = sphere();
    const topo = buildTopology(pos, null);
    const P = sphereProject([1, 0.2, 0.3]).position;
    const Q = sphereProject([-0.2, 1, -0.4]).position;
    const corners = edgePath(topo, P, faceNear(pos, P), Q, faceNear(pos, Q));
    const raw = [P, ...corners.map((v) => [...topo.verts.slice(3 * v, 3 * v + 3)]), Q];
    const tight = tighten(raw, sphereProject, { edge: topo.edge * 0.5 });
    assert.ok(pathLength(tight) < pathLength(raw));
  });

  test('a thin-walled tube: the path stays on the outer wall, where straight lines jump to the inner wall', () => {
    const pos = tube();
    const topo = buildTopology(pos, null);
    const at = (deg) => [10 * Math.cos((deg * Math.PI) / 180), 10 * Math.sin((deg * Math.PI) / 180), 0.3];
    const P = at(5);
    const Q = at(125);
    const { path, ok } = geodesicSegment(topo, P, faceNear(pos, P), Q, faceNear(pos, Q), tubeProject);
    assert.ok(ok);
    for (const p of path) assert.ok(Math.abs(radius(p) - 10) < 0.02, `point at radius ${radius(p).toFixed(3)}`);
    const exact = 10 * ((120 * Math.PI) / 180);
    assert.ok(Math.abs(pathLength(path) - exact) / exact < 0.01, `length ${pathLength(path).toFixed(3)} vs ${exact.toFixed(3)}`);

    // The same two clicks as a "euclidean" curve: the straight line passes near the inner wall.
    const cps = { status: 'placed', control_points: [{ position: P }, { position: Q }] };
    const straight = computeCurve({ n_points: 5, path: 'euclidean' }, cps, () => null, tubeProject);
    assert.ok(straight.points.some((p) => Math.abs(radius(p.position) - 9.5) < 0.01), 'euclidean jumps to the inner wall');
  });

  test('a geodesic curve: route between each pair of points, semilandmarks on the outer wall, the path used is recorded', () => {
    const pos = tube();
    const topo = buildTopology(pos, null);
    const at = (deg) => {
      const position = [10 * Math.cos((deg * Math.PI) / 180), 10 * Math.sin((deg * Math.PI) / 180), 0];
      return { position, anchor: { face: faceNear(pos, position), bary: [1, 0, 0] } };
    };
    const route = (P, fp, Q, fq) => geodesicSegment(topo, P, fp, Q, fq, tubeProject);
    const entry = { status: 'placed', control_points: [at(0), at(90), at(180)] };
    const r = computeCurve({ n_points: 7, path: 'geodesic' }, entry, () => null, tubeProject, { route });
    assert.equal(r.used, 'geodesic');
    assert.equal(r.warning, null);
    assert.equal(r.points.length, 7);
    for (const p of r.points) assert.ok(Math.abs(radius(p.position) - 10) < 0.02);
    assert.ok(Math.abs(r.length - 10 * Math.PI) / (10 * Math.PI) < 0.01);
    // A closed loop around the tube.
    const loop = computeCurve({ n_points: 12, path: 'geodesic', closed: true }, { status: 'placed', control_points: [at(0), at(120), at(240)] }, () => null, tubeProject, { route });
    assert.ok(Math.abs(loop.length - 20 * Math.PI) / (20 * Math.PI) < 0.01, `loop ${loop.length}`);
    // Without a route (mesh not prepared), it falls back to euclidean and says so.
    assert.equal(computeCurve({ path: 'geodesic' }, entry, () => null, tubeProject).used, 'euclidean');
  });

  test('two separate pieces: no route, a straight line and a warning', () => {
    const a = sphere(24, 12);
    const b = a.map((v, i) => (i % 3 === 0 ? v + 50 : v)); // a second sphere 50 to the side
    const pos = new Float32Array([...a, ...b]);
    const topo = buildTopology(pos, null);
    const P = [10, 0, 0];
    const Q = [40, 0, 0];
    const r = geodesicSegment(topo, P, faceNear(pos, P), Q, faceNear(pos, Q), () => null);
    assert.equal(r.ok, false);
    assert.deepEqual(r.path, [P, Q]);
    const route = (p, fp, q, fq) => geodesicSegment(topo, p, fp, q, fq, () => null);
    const cps = { status: 'placed', control_points: [{ position: P, anchor: { face: faceNear(pos, P) } }, { position: Q, anchor: { face: faceNear(pos, Q) } }] };
    const c = computeCurve({ path: 'geodesic', n_points: 3 }, cps, () => null, (p) => ({ position: p }), { route });
    assert.deepEqual(c.warning, { code: 'apart' });
  });

  test('two points on the same triangle: the straight line between them', () => {
    const pos = sphere();
    const topo = buildTopology(pos, null);
    const f = 500;
    const P = [0, 1, 2].map((k) => (pos[9 * f + k] * 2 + pos[9 * f + 3 + k]) / 3);
    const Q = [0, 1, 2].map((k) => (pos[9 * f + k] + pos[9 * f + 6 + k] * 2) / 3);
    assert.deepEqual(geodesicSegment(topo, P, f, Q, f, sphereProject).path, [P, Q]);
  });

  test('speed: a million triangles', () => {
    const pos = sphere(1000, 500);
    assert.ok(pos.length / 9 >= 1e6);
    let t0 = performance.now();
    const topo = buildTopology(pos, null);
    const build = performance.now() - t0;
    const P = sphereProject([1, 0, 0.2]).position;
    const Q = sphereProject([0, 1, -0.2]).position;
    const fp = faceNear(pos, P);
    const fq = faceNear(pos, Q);
    t0 = performance.now();
    const { ok } = geodesicSegment(topo, P, fp, Q, fq, sphereProject);
    const query = performance.now() - t0;
    assert.ok(ok);
    console.log(`  1M triangles: corner table ${build.toFixed(0)} ms, one path ${query.toFixed(0)} ms`);
    assert.ok(build < 4000, `table ${build} ms`);
    assert.ok(query < 1000, `path ${query} ms`);
  });
});
