// Curves with equally spaced semilandmarks (spec: Curves). Pure maths, no
// three.js: the surface is reached through a `project` function, so this can
// be tested on its own.
//
// Two kinds of path between the clicked points (and the end landmarks):
//
//   "geodesic"   the shortest route across the surface (geodesic.js). The
//                default for new curves.
//   "euclidean"  straight segments, cut into many short steps, each moved
//                to the nearest point on the surface. Fast, but where the
//                straight line passes closer to another surface (across a
//                thin bone, a deep groove) the path can jump to it.
//
// The semilandmarks are then spaced equally along the path and put on the
// surface too (with anchor and normal, like landmarks).
//
// `n_points` counts the semilandmarks between anchored ends: a curve from
// LM01 to LM02 with n_points 5 has 5 points strictly between the two
// landmarks, which are not exported twice. A free end gets a semilandmark of
// its own. A closed loop gets n_points spread evenly around it.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

export const DEFAULT_POINTS = 10;
export const MAX_CURVE_POINTS = 500;
export const PATHS = ['geodesic', 'euclidean'];
export const pathOf = (def) => (def?.path === 'geodesic' ? 'geodesic' : 'euclidean');
export const nPointsOf = (def) => (Number.isInteger(def?.n_points) && def.n_points > 0 ? def.n_points : DEFAULT_POINTS);

/**
 * The points the path goes through, in order: the start landmark (if
 * anchored), the clicked points, the end landmark. `pointOf(id)` gives a
 * landmark entry. Returns { ctrl, faces, a, b, error }: `faces` gives the
 * triangle each point is on (from its anchor, or null); a/b are 1 when the
 * start/end is anchored on a landmark.
 */
export function curveInputs(def, entry, pointOf) {
  const cps = (entry?.control_points || []).filter((c) => Array.isArray(c.position));
  const ctrl = cps.map((c) => c.position);
  const faces = cps.map((c) => (Number.isInteger(c.anchor?.face) ? c.anchor.face : null));
  let a = 0;
  let b = 0;
  let error = null;
  if (!def.closed) {
    const placed = (id) => {
      const p = pointOf(id);
      return p && p.status !== 'missing' && Array.isArray(p.position) ? p : null;
    };
    const faceOf = (p) => (Number.isInteger(p.anchor?.face) ? p.anchor.face : null);
    if (def.start) {
      const p = placed(def.start);
      if (p) {
        ctrl.unshift(p.position);
        faces.unshift(faceOf(p));
        a = 1;
      } else error = { code: 'start', id: def.start };
    }
    if (def.end) {
      const p = placed(def.end);
      if (p) {
        ctrl.push(p.position);
        faces.push(faceOf(p));
        b = 1;
      } else error ??= { code: 'end', id: def.end };
    }
  }
  return { ctrl, faces, a, b, error };
}

// Straight segments through P cut into steps no longer than `step`.
export function densify(P, closed, step) {
  const pts = closed ? [...P, P[0]] : P;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const len = dist(pts[i - 1], pts[i]);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 1; j <= k; j++) out.push(j === k ? pts[i] : lerp(pts[i - 1], pts[i], j / k));
  }
  return out;
}

export function pathLength(D) {
  let L = 0;
  for (let i = 1; i < D.length; i++) L += dist(D[i - 1], D[i]);
  return L;
}

/**
 * n positions at equal arc length along the path D (as in the 2D app).
 * a/b = 1 leave out an anchored start/end; a closed path gets n points
 * around the loop starting at its first point.
 */
export function resample(D, n, a, b, closed) {
  const cum = [0];
  for (let i = 1; i < D.length; i++) cum.push(cum[i - 1] + dist(D[i - 1], D[i]));
  const L = cum[cum.length - 1];
  if (!(L > 0) || n < 1) return [];
  let at;
  if (closed) at = (k) => (k * L) / n;
  else {
    const den = n - 1 + a + b;
    // spec: with one point it sits in the middle of the path, whichever ends are anchored
    at = n === 1 ? () => L / 2 : (k) => ((k + a) * L) / den;
  }
  const out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const d = at(k);
    while (j < cum.length - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1];
    out.push(lerp(D[j - 1], D[j], seg > 0 ? (d - cum[j - 1]) / seg : 0));
  }
  return out;
}

/**
 * Compute one curve on one specimen.
 *   def      template curve ({ n_points, start, end, closed, ... })
 *   entry    specimen curve entry ({ control_points, status, ... })
 *   pointOf  id -> landmark entry of the same specimen
 *   project  [x,y,z] -> { position, anchor?, normal? } on the surface, or null
 *   route    (for "geodesic") (P, faceP, Q, faceQ) -> { path, ok }: the
 *            surface path between two points; without it the curve is
 *            computed as "euclidean"
 * Returns { path, points, length, error, warning, used }: `path` is the
 * surface path (positions, for drawing), `points` the semilandmarks as the
 * file stores them, `used` the kind of path computed. `error` is null, or
 * { code: 'start' | 'end', id } (place that landmark first) or
 * { code: 'few' } (not enough points yet). `warning` is { code: 'apart' }
 * when two points have no route between them across the surface (separate
 * pieces of the mesh); that stretch is then a straight line.
 */
export function computeCurve(def, entry, pointOf, project, { steps = 600, route = null } = {}) {
  const { ctrl, faces, a, b, error } = curveInputs(def, entry, pointOf);
  const need = def.closed ? 3 : 2;
  const used = pathOf(def) === 'geodesic' && route ? 'geodesic' : 'euclidean';
  const trace = (closed) => {
    if (used === 'euclidean') {
      const step = chord(ctrl, closed) / steps;
      return { path: step > 0 ? onSurface(densify(ctrl, closed, step), project) : [], apart: false };
    }
    const pts = closed ? [...ctrl, ctrl[0]] : ctrl;
    const fs = closed ? [...faces, faces[0]] : faces;
    const out = [pts[0]];
    let apart = false;
    for (let i = 1; i < pts.length; i++) {
      const r = route(pts[i - 1], fs[i - 1], pts[i], fs[i]);
      if (!r.ok) apart = true;
      out.push(...r.path.slice(1));
    }
    return { path: out, apart };
  };
  if (error || ctrl.length < need) {
    const path = !error && ctrl.length >= 2 ? trace(false).path : [];
    return { path, points: [], length: 0, error: error || { code: 'few', need }, warning: null, used };
  }
  const closed = !!def.closed;
  if (!(chord(ctrl, closed) > 0)) return { path: [], points: [], length: 0, error: { code: 'few', need }, warning: null, used };
  const { path, apart } = trace(closed);
  const length = pathLength(path);
  const points = resample(path, nPointsOf(def), a, b, closed).map((p) => {
    const s = project(p);
    if (!s) return { position: p.map(round) };
    const out = { position: s.position };
    if (s.anchor) out.anchor = s.anchor;
    if (s.normal) out.normal = s.normal;
    return out;
  });
  return { path, points, length: round(length), error: null, warning: apart ? { code: 'apart' } : null, used };
}

const round = (n) => Math.round(n * 1e6) / 1e6; // spec: up to 6 decimal places
const chord = (P, closed) => pathLength(closed ? [...P, P[0]] : P);
const onSurface = (D, project) => D.map((p) => project(p)?.position || p);

// What a file stores for the curve: the sampling actually used.
export function samplingOf(def, used = pathOf(def)) {
  return { path: used, spacing: 'equal_arc_length', n_points: nPointsOf(def) };
}

// Is the curve finished on this specimen (counts as done)?
export const curveDone = (entry) =>
  !!entry && (entry.status === 'missing' || (Array.isArray(entry.points) && entry.points.length > 0));

// A short state word for the curve: 'todo' | 'partial' | 'placed' | 'estimated' | 'missing'.
export function curveState(entry) {
  if (!entry) return 'todo';
  if (entry.status === 'missing') return 'missing';
  if (entry.points?.length) return entry.status === 'estimated' ? 'estimated' : 'placed';
  return entry.control_points?.length ? 'partial' : 'todo';
}
