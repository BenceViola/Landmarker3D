// Reference planes (spec v0.4): fitting a plane through landmarks, signed
// distances to it, and where it cuts a mesh. Pure maths, no three.js, so it
// can be tested on its own.
//
// A plane is { point: [x,y,z], normal: [x,y,z] } with a unit normal; the
// signed distance of p is normal · (p − point). Three points give the plane
// through them; more give the least-squares best fit (the normal is the
// eigenvector of the covariance matrix with the smallest eigenvalue). The
// normal points to the side given by the first three points (right-hand
// rule on (B − A) × (C − A)), so the sign of distances is stable.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

export const signedDistance = (plane, p) => dot(plane.normal, sub(p, plane.point));

// Eigen decomposition of a symmetric 3×3 matrix (Jacobi rotations).
// Returns eigenvalues ascending with matching unit eigenvectors.
export function eigenSymmetric3(m) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] }))
    .sort((x, y) => x.value - y.value);
}

/**
 * The plane through `points` ([[x,y,z], …], at least three).
 * Returns { plane, rms, max, maxIndex, exact } or { error } when the points
 * don't define a plane (fewer than three, or all on one line).
 */
export function fitPlane(points) {
  if (points.length < 3) return { error: 'too_few' };
  const n = points.length;
  const c = [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k], 0) / n);
  const spread = Math.max(...points.map((p) => norm(sub(p, c))));
  if (!(spread > 0)) return { error: 'collinear' };

  let normal;
  if (n === 3) {
    normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
    const len = norm(normal);
    // Collinear if the triangle's area is tiny compared with its size.
    if (!(len > 1e-9 * spread * spread)) return { error: 'collinear' };
    normal = normal.map((x) => x / len);
  } else {
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of points) {
      const d = sub(p, c);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
    }
    const [lo, mid, hi] = eigenSymmetric3(cov);
    // All on (nearly) one line: the middle spread vanishes compared with the largest.
    if (!(Math.sqrt(Math.max(mid.value, 0)) > 1e-6 * Math.sqrt(hi.value))) return { error: 'collinear' };
    normal = lo.vector;
    const ref = cross(sub(points[1], points[0]), sub(points[2], points[0]));
    if (dot(normal, ref) < 0) normal = normal.map((x) => -x);
  }
  const plane = { point: c, normal };
  const d = points.map((p) => signedDistance(plane, p));
  const abs = d.map(Math.abs);
  const max = Math.max(...abs);
  return {
    plane,
    exact: n === 3,
    rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / n),
    max,
    maxIndex: abs.indexOf(max),
    distances: d,
  };
}

/**
 * Where a plane cuts a triangle mesh, as line segments: a Float32Array of
 * [x1,y1,z1, x2,y2,z2, …]. `positions` is the flat vertex array, `index`
 * the triangle index (or null for one vertex triple per triangle, as in STL).
 * Each triangle whose corners lie on both sides contributes one segment.
 * A corner exactly on the plane counts as being on the positive side, so
 * the cut never gives zero-length or doubled segments.
 */
export function planeCut(positions, index, plane) {
  const [nx, ny, nz] = plane.normal;
  const off = nx * plane.point[0] + ny * plane.point[1] + nz * plane.point[2];
  const nVerts = positions.length / 3;
  const dist = new Float64Array(nVerts);
  for (let i = 0, j = 0; i < nVerts; i++, j += 3) {
    dist[i] = nx * positions[j] + ny * positions[j + 1] + nz * positions[j + 2] - off;
  }
  const nTri = index ? index.length / 3 : nVerts / 3;
  const out = [];
  const v = [0, 0, 0];
  for (let t = 0; t < nTri; t++) {
    if (index) {
      v[0] = index[3 * t];
      v[1] = index[3 * t + 1];
      v[2] = index[3 * t + 2];
    } else {
      v[0] = 3 * t;
      v[1] = 3 * t + 1;
      v[2] = 3 * t + 2;
    }
    const s0 = dist[v[0]] >= 0;
    const s1 = dist[v[1]] >= 0;
    const s2 = dist[v[2]] >= 0;
    if (s0 === s1 && s1 === s2) continue;
    const start = out.length;
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const da = dist[v[a]];
      const db = dist[v[b]];
      if (da >= 0 === db >= 0) continue;
      const u = da / (da - db);
      const ia = 3 * v[a];
      const ib = 3 * v[b];
      out.push(
        positions[ia] + (positions[ib] - positions[ia]) * u,
        positions[ia + 1] + (positions[ib + 1] - positions[ia + 1]) * u,
        positions[ia + 2] + (positions[ib + 2] - positions[ia + 2]) * u
      );
    }
    // A triangle that only touches the plane at one corner gives a segment of
    // length zero; its neighbours carry the cut through that corner.
    if (out[start] === out[start + 3] && out[start + 1] === out[start + 4] && out[start + 2] === out[start + 5]) {
      out.length = start;
    }
  }
  return new Float32Array(out);
}

// Total length of cut segments.
export function cutLength(segments) {
  let L = 0;
  for (let i = 0; i < segments.length; i += 6) {
    L += Math.hypot(segments[i + 3] - segments[i], segments[i + 4] - segments[i + 1], segments[i + 5] - segments[i + 2]);
  }
  return L;
}

/**
 * A template plane on one specimen: the positions of its landmarks, and the
 * fit when at least three are placed. `points` are the specimen's landmark
 * entries.
 */
export function planeOnSpecimen(def, points) {
  const byId = new Map(points.map((p) => [p.template_id ?? p.id, p]));
  const used = [];
  const lacking = [];
  for (const id of def.landmarks || []) {
    const p = byId.get(id);
    if (p && p.status !== 'missing' && Array.isArray(p.position)) used.push({ id, position: p.position });
    else lacking.push(id);
  }
  const fit = fitPlane(used.map((u) => u.position));
  return { used, lacking, ...fit };
}
