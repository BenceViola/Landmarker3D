// Shortest paths across a mesh surface ("geodesic" curves). Pure maths, no
// three.js; the surface is reached through a `project` function, as in
// curves.js, so this can be tested on its own.
//
// How a path between two points on the surface is found:
//
//   1. Which triangles share corners. STL files repeat every corner, so the
//      corners are matched by position into a welded list. This is a
//      separate table; the file's own geometry and face order are untouched,
//      and the table is indexed by the file's face numbers.
//   2. The shortest route along triangle edges (A* search, a Dijkstra that
//      heads towards the goal), from the corners of the start triangle to
//      the corners of the end triangle.
//   3. Edges zigzag, so the route is then pulled tight on the surface: each
//      point moves towards the middle of its neighbours and back onto the
//      surface, first with a few points far apart, then with more points
//      closer together. A move that would put a point on a surface facing
//      the other way (the other side of a thin bone) is refused, so the path
//      stays on the side it started on.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Corner sharing for a triangle mesh. `positions` is the flat vertex array,
 * `index` the triangle index (or null: one vertex triple per triangle, as
 * in STL). Returns { verts, tri, start, adj, edge }:
 *   verts  welded corner positions (Float32Array, 3 per corner)
 *   tri    welded corners of file face f at tri[3f..3f+2]
 *   start/adj  neighbours of corner v are adj[start[v] .. start[v+1]-1]
 *   edge   mean edge length
 */
export function buildTopology(positions, index) {
  const nRaw = positions.length / 3;
  const nTri = index ? index.length / 3 : nRaw / 3;
  // Weld corners that are the same point. Exported meshes sometimes repeat a
  // corner with coordinates that differ in the last decimal places (seams),
  // so corners closer than a millionth of the mesh's size count as one. The
  // corners are sorted into a grid of cells four times that size; a corner
  // near a cell's edge also looks in the neighbouring cell.
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nRaw; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[3 * i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = diag * 1e-6;
  const cell = tol * 4;
  let size = 1;
  while (size < nRaw * 1.5) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Int32Array(size * 3);
  const mask = size - 1;
  const weldOf = new Int32Array(nRaw);
  const firstRaw = new Int32Array(nRaw);
  let nVerts = 0;
  const hash = (a, b, c) => (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
  const q = [0, 0, 0];
  const base = [0, 0, 0];
  const alt = [0, 0, 0];
  for (let i = 0; i < nRaw; i++) {
    for (let k = 0; k < 3; k++) {
      q[k] = (positions[3 * i + k] - lo[k]) / cell;
      base[k] = Math.round(q[k]);
      const f = q[k] - base[k];
      alt[k] = f > 0.25 ? base[k] + 1 : f < -0.25 ? base[k] - 1 : base[k];
    }
    let found = -1;
    // The corner's own cell first, then the neighbours it is close to.
    for (let m = 0; m < 8 && found < 0; m++) {
      const a = m & 1 ? alt[0] : base[0];
      const b = m & 2 ? alt[1] : base[1];
      const c = m & 4 ? alt[2] : base[2];
      if (m && ((m & 1 && a === base[0]) || (m & 2 && b === base[1]) || (m & 4 && c === base[2]))) continue;
      for (let h = hash(a, b, c); table[h] >= 0; h = (h + 1) & mask) {
        if (keys[3 * h] !== a || keys[3 * h + 1] !== b || keys[3 * h + 2] !== c) continue;
        const w = table[h];
        const r = 3 * firstRaw[w];
        const d = Math.hypot(positions[r] - positions[3 * i], positions[r + 1] - positions[3 * i + 1], positions[r + 2] - positions[3 * i + 2]);
        if (d <= tol) {
          found = w;
          break;
        }
      }
    }
    if (found < 0) {
      let h = hash(base[0], base[1], base[2]);
      while (table[h] >= 0) h = (h + 1) & mask;
      table[h] = nVerts;
      keys[3 * h] = base[0];
      keys[3 * h + 1] = base[1];
      keys[3 * h + 2] = base[2];
      firstRaw[nVerts] = i;
      found = nVerts++;
    }
    weldOf[i] = found;
  }
  const verts = new Float32Array(3 * nVerts);
  for (let w = 0; w < nVerts; w++) {
    const r = 3 * firstRaw[w];
    verts[3 * w] = positions[r];
    verts[3 * w + 1] = positions[r + 1];
    verts[3 * w + 2] = positions[r + 2];
  }
  const tri = new Int32Array(3 * nTri);
  for (let t = 0; t < 3 * nTri; t++) tri[t] = weldOf[index ? index[t] : t];

  // Neighbours (each edge is listed once per triangle that uses it; the
  // search doesn't mind the repeats).
  const deg = new Int32Array(nVerts + 1);
  for (let t = 0; t < nTri; t++) {
    deg[tri[3 * t]] += 2;
    deg[tri[3 * t + 1]] += 2;
    deg[tri[3 * t + 2]] += 2;
  }
  const start = new Int32Array(nVerts + 1);
  for (let v = 0; v < nVerts; v++) start[v + 1] = start[v] + deg[v];
  const fill = start.slice(0, nVerts);
  const adj = new Int32Array(start[nVerts]);
  let sum = 0;
  for (let t = 0; t < nTri; t++) {
    const a = tri[3 * t];
    const b = tri[3 * t + 1];
    const c = tri[3 * t + 2];
    adj[fill[a]++] = b; adj[fill[a]++] = c;
    adj[fill[b]++] = a; adj[fill[b]++] = c;
    adj[fill[c]++] = a; adj[fill[c]++] = b;
    sum += vdist(verts, a, b) + vdist(verts, b, c) + vdist(verts, c, a);
  }
  return { verts, tri, start, adj, edge: nTri ? sum / (3 * nTri) : 0, nVerts, work: null };
}

function vdist(V, a, b) {
  return Math.hypot(V[3 * a] - V[3 * b], V[3 * a + 1] - V[3 * b + 1], V[3 * a + 2] - V[3 * b + 2]);
}
const vpos = (V, v) => [V[3 * v], V[3 * v + 1], V[3 * v + 2]];

// A binary min-heap of (key, value) pairs in typed arrays, grown as needed.
class Heap {
  constructor(n = 1024) {
    this.k = new Float64Array(n);
    this.v = new Int32Array(n);
    this.n = 0;
  }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2);
      const v = new Int32Array(this.n * 2);
      k.set(this.k);
      v.set(this.v);
      this.k = k;
      this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop() {
    const top = this.v[0];
    const key = this.k[--this.n];
    const val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = key;
    this.v[i] = val;
    return top;
  }
}

/**
 * Shortest route along edges from point P (on face fp) to Q (on face fq).
 * Returns the welded corners in order, [] when P and Q share a triangle, or
 * null when no route exists (separate pieces of the mesh) or the search
 * gave up after `maxVisits` corners.
 */
export function edgePath(topo, P, fp, Q, fq, { maxVisits = 4e6 } = {}) {
  const { verts: V, tri, start, adj, nVerts } = topo;
  if (fp === fq) return [];
  // Search arrays are kept between calls; only the corners touched are reset.
  const w = (topo.work ||= { g: new Float64Array(nVerts).fill(Infinity), prev: new Int32Array(nVerts), done: new Uint8Array(nVerts), touched: [] });
  for (const v of w.touched) {
    w.g[v] = Infinity;
    w.done[v] = 0;
  }
  w.touched.length = 0;
  const qx = Q[0];
  const qy = Q[1];
  const qz = Q[2];
  const hq = (v) => Math.hypot(V[3 * v] - qx, V[3 * v + 1] - qy, V[3 * v + 2] - qz);
  const goal = new Set([tri[3 * fq], tri[3 * fq + 1], tri[3 * fq + 2]]);
  const heap = new Heap();
  for (let k = 0; k < 3; k++) {
    const v = tri[3 * fp + k];
    const g = Math.hypot(V[3 * v] - P[0], V[3 * v + 1] - P[1], V[3 * v + 2] - P[2]);
    if (g < w.g[v]) {
      if (w.g[v] === Infinity) w.touched.push(v);
      w.g[v] = g;
      w.prev[v] = -1;
      heap.push(g + hq(v), v);
    }
  }
  let best = Infinity;
  let bestV = -1;
  let visits = 0;
  while (heap.n) {
    const f = heap.k[0];
    if (f >= best) break; // nothing left can beat the best route found
    const u = heap.pop();
    if (w.done[u]) continue;
    w.done[u] = 1;
    if (++visits > maxVisits) return null;
    if (goal.has(u)) {
      const total = w.g[u] + hq(u);
      if (total < best) {
        best = total;
        bestV = u;
      }
    }
    const gu = w.g[u];
    for (let e = start[u]; e < start[u + 1]; e++) {
      const v = adj[e];
      if (w.done[v]) continue;
      const g = gu + vdist(V, u, v);
      if (g < w.g[v]) {
        if (w.g[v] === Infinity) w.touched.push(v);
        w.g[v] = g;
        w.prev[v] = u;
        heap.push(g + hq(v), v);
      }
    }
  }
  if (bestV < 0) return null;
  const out = [];
  for (let v = bestV; v >= 0; v = w.prev[v]) out.push(v);
  return out.reverse();
}

// Points along a polyline at (at most) the given spacing, keeping both ends.
function respace(pts, spacing) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / spacing));
  const out = [pts[0]];
  let j = 1;
  for (let k = 1; k < n; k++) {
    const d = (k * L) / n;
    while (j < cum.length - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1];
    const u = seg > 0 ? (d - cum[j - 1]) / seg : 0;
    const a = pts[j - 1];
    const b = pts[j];
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Pull a path tight on the surface, ends fixed. `project(p)` gives
 * { position, normal } on the surface nearest p. Works from coarse to fine
 * spacing; returns the new path.
 */
export function tighten(path, project, { edge = 0, maxPoints = 240, iterations = 60 } = {}) {
  if (path.length < 3) return path;
  let L = 0;
  for (let i = 1; i < path.length; i++) L += dist(path[i - 1], path[i]);
  if (!(L > 0)) return path;
  const finest = Math.max(edge, L / maxPoints);
  let spacing = Math.max(finest, L / 8);
  let pts = path;
  for (;;) {
    pts = respace(pts, spacing);
    // New points lie on short chords between surface points; put them on the surface.
    const proj = pts.map((p, i) => (i === 0 || i === pts.length - 1 ? null : project(p)));
    pts = pts.map((p, i) => proj[i]?.position || p);
    const normals = pts.map((p, i) => proj[i]?.normal || project(p)?.normal || null);
    for (let it = 0; it < iterations; it++) {
      let moved = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1];
        const b = pts[i + 1];
        const p = pts[i];
        // Halfway towards the middle of the neighbours, then back onto the surface.
        const t = [(p[0] + (a[0] + b[0]) / 2) / 2, (p[1] + (a[1] + b[1]) / 2) / 2, (p[2] + (a[2] + b[2]) / 2) / 2];
        const s = project(t);
        if (!s) continue;
        const n0 = normals[i];
        // Refuse a jump to a surface facing another way (the other side of a thin wall).
        if (n0 && s.normal && dot(n0, s.normal) < 0.2) continue;
        if (dist(s.position, p) > spacing) continue;
        moved = Math.max(moved, dist(s.position, p));
        pts[i] = s.position;
        if (s.normal) normals[i] = s.normal;
      }
      if (moved < finest * 1e-3) break;
    }
    if (spacing <= finest * 1.01) break;
    spacing = Math.max(finest, spacing / 2);
  }
  return pts;
}

/**
 * The surface path from P to Q (points on faces fp, fq). Returns
 * { path, ok }: ok is false when no route along the surface was found (the
 * points are on separate pieces of the mesh), and the path is then the
 * straight line between them.
 */
export function geodesicSegment(topo, P, fp, Q, fq, project, opts = {}) {
  const corners = edgePath(topo, P, fp, Q, fq, opts);
  if (corners === null) return { path: [P, Q], ok: false };
  const raw = [P, ...corners.map((v) => vpos(topo.verts, v)), Q];
  return { path: tighten(raw, project, { edge: topo.edge * 0.5, ...opts }), ok: true };
}
