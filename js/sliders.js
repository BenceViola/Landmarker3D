// The sliders file for geomorph: which semilandmarks slide, and between
// which neighbours, for gpagen(..., curves = ...).
//
// One row per sliding semilandmark: "before", "slide", "after", given as
// row numbers (from 1) in the TPS export of the same template, the way
// geomorph's define.sliders() writes curveslide.csv. It depends only on the
// template, so it is the same for every specimen, and it is right for any
// TPS file this app writes with that template (ad hoc points come last, so
// they never shift the numbers).
//
//   - Open curve: a semilandmark slides between the points next to it on
//     the curve: other semilandmarks, or the landmark a curve end is
//     anchored on. A semilandmark at a free end is the curve's end point and
//     does not slide.
//   - Closed loop: every semilandmark slides, between its neighbours round
//     the loop (needs at least three points).

import { exportRows } from './export-rows.js';
import { nPointsOf } from './curves.js';

/**
 * The slider rows of a template: [{ before, slide, after, curve }] with row
 * numbers from 1, and `names` (the point names in TPS order, for checking).
 */
export function slidersOf(template) {
  const rows = exportRows({ template, points: [], curves: [] });
  const rowOf = new Map(rows.map((r, i) => [r.point, i + 1]));
  const out = [];
  for (const def of template.curves || []) {
    const n = nPointsOf(def);
    const semis = Array.from({ length: n }, (_, k) => rowOf.get(`${def.id}_${String(k + 1).padStart(2, '0')}`));
    if (def.closed) {
      if (n < 3) continue;
      for (let k = 0; k < n; k++) out.push({ before: semis[(k + n - 1) % n], slide: semis[k], after: semis[(k + 1) % n], curve: def.id });
      continue;
    }
    // The curve in order, with its anchoring landmarks at the ends.
    const seq = [
      ...(def.start && rowOf.has(def.start) ? [{ row: rowOf.get(def.start), fixed: true }] : []),
      ...semis.map((row) => ({ row, fixed: false })),
      ...(def.end && rowOf.has(def.end) ? [{ row: rowOf.get(def.end), fixed: true }] : []),
    ];
    for (let i = 1; i < seq.length - 1; i++) {
      if (!seq[i].fixed) out.push({ before: seq[i - 1].row, slide: seq[i].row, after: seq[i + 1].row, curve: def.id });
    }
  }
  return { sliders: out, names: rows.map((r) => r.point) };
}

// The file's text, as define.sliders() writes it (R's write.table with sep=",").
export function toSlidersCsv(template) {
  const { sliders } = slidersOf(template);
  return ['"before","slide","after"', ...sliders.map((s) => `${s.before},${s.slide},${s.after}`)].join('\n') + '\n';
}

// Does this template have anything that slides?
export const hasSliders = (template) => slidersOf(template).sliders.length > 0;

// File name next to a TPS file's base name.
export const slidersFileName = (base) => `${base}_curveslide.csv`;
