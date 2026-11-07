// Rules for sets of specimens, shared with the 2D app (landmarker2D) so both
// apps name, combine and compare specimens the same way.
//
// An "export state" is one specimen's data in the shape of a landmark file:
//   { specimen: { id, replicate?, mesh: {...} }, template, points, provenance }
// Session records and opened files are both turned into this shape.

import { exportOrder } from './landmark-file.js';
import { replicateOf } from './session.js';

export { replicateOf };

export const operatorOf = (st) => String(st.provenance?.operator ?? '').trim();

// Safe for file names and TPS IDs: letters, digits, "-", "_" and ".".
export const safeName = (v) =>
  String(v ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '');

const meshSha = (st) => String(st.specimen?.mesh?.sha256 || '').toLowerCase();

// Replicates of one specimen: same specimen ID and the same mesh file.
export const sameSpecimen = (a, b) => a.specimen.id === b.specimen.id && meshSha(a) === meshSha(b);

// The next free replicate number for a specimen.
export const nextReplicate = (states, st) =>
  Math.max(0, ...states.filter((x) => sameSpecimen(x, st)).map(replicateOf)) + 1;

/**
 * IDs for a combined export (spec: Replicates). Every ID gets _<operator>
 * when any specimen comes from more than one operator, and _r<n> when any
 * specimen has more than one replicate, so IDs stay unique and parallel.
 * Otherwise the ID is the specimen ID alone.
 */
export function exportIds(states) {
  const ops = new Map();
  const reps = new Map();
  for (const st of states) {
    const id = st.specimen.id;
    if (!ops.has(id)) {
      ops.set(id, new Set());
      reps.set(id, new Set());
    }
    ops.get(id).add(operatorOf(st));
    reps.get(id).add(replicateOf(st));
  }
  const byOp = [...ops.values()].some((s) => s.size > 1);
  const byRep = [...reps.values()].some((s) => s.size > 1);
  return states.map(
    (st) =>
      st.specimen.id +
      (byOp ? '_' + (safeName(operatorOf(st)) || 'unknown') : '') +
      (byRep ? '_r' + replicateOf(st) : '')
  );
}

// <id>.lmk.json, or <id>_r<n>.lmk.json for later replicates.
export const docFileName = (st) =>
  `${safeName(st.specimen.id) || 'specimen'}${replicateOf(st) > 1 ? '_r' + replicateOf(st) : ''}.lmk.json`;

// null when two templates give the same export rows, otherwise why they differ.
export function templateDifference(a, b) {
  const sig = (t) =>
    JSON.stringify({
      ids: (t.landmarks || []).map((d) => d.id),
      curves: (t.curves || []).map((c) => [c.id, c.n_points ?? 10]),
      order: exportOrder(t),
    });
  if ((a.id || '') !== (b.id || '')) return `it uses the template “${b.id}”, not “${a.id}”`;
  if (sig(a) !== sig(b)) return `its version of the template “${b.id}” has different landmarks or a different order`;
  return null;
}

// Template landmarks done (placed, estimated or missing) out of all.
export function progress(st) {
  const ids = new Set(st.points.filter((p) => p.template_id !== null).map((p) => p.template_id));
  const total = st.template.landmarks.length;
  return { done: st.template.landmarks.filter((d) => ids.has(d.id)).length, total };
}

// The template's landmark ids in random order, for a replicate placed blind.
export function shuffledOrder(template, rand = Math.random) {
  const ids = template.landmarks.map((d) => d.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

/**
 * How far apart replicates of the same specimen landed, per landmark, over
 * every pair of replicates. Replicates share the mesh, so coordinates are
 * compared directly, without alignment. Distances are in the mesh's units
 * when all replicated specimens use the same units. Landmarks whose average
 * is more than twice the median of all landmarks are flagged.
 */
export function repeatability(states) {
  const groups = new Map();
  for (const st of states) {
    const key = JSON.stringify([st.specimen.id, meshSha(st)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(st);
  }
  const reps = [...groups.values()].filter((g) => g.length > 1);
  const all = reps.flat();
  const unitSet = new Set(all.map((st) => st.specimen.mesh?.units || 'unknown'));
  const units = unitSet.size === 1 && !unitSet.has('unknown') ? [...unitSet][0] : 'mesh units';
  const template = states[0]?.template || { landmarks: [] };

  const rows = template.landmarks.map((def) => {
    const d = [];
    let specimens = 0;
    for (const g of reps) {
      const pts = g
        .map((st) => st.points.find((p) => p.template_id === def.id))
        .filter((p) => p && p.status !== 'missing' && Array.isArray(p.position))
        .map((p) => p.position);
      if (pts.length < 2) continue;
      specimens++;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) d.push(Math.hypot(...pts[i].map((v, k) => v - pts[j][k])));
      }
    }
    return {
      id: def.id,
      name: def.name,
      specimens,
      pairs: d.length,
      mean: d.length ? d.reduce((a, b) => a + b, 0) / d.length : null,
      max: d.length ? Math.max(...d) : null,
    };
  });

  const means = rows.filter((r) => r.pairs).map((r) => r.mean).sort((a, b) => a - b);
  const mid = means.length >> 1;
  const median = means.length ? (means.length % 2 ? means[mid] : (means[mid - 1] + means[mid]) / 2) : null;
  for (const r of rows) r.flag = !!(r.pairs && median > 0 && r.mean > 2 * median);
  return { rows, units, median, specimens: reps.map((g) => ({ id: g[0].specimen.id, replicates: g.length })) };
}
