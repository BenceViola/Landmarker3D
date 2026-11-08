// CSV export: one row per point per specimen ("long" format), for R, Python
// or a spreadsheet. The columns match the 2D app's, with a z column and the
// mesh in place of the image, so one script can read both.
//
// specimen_id and replicate are separate columns, which is what a
// measurement-error analysis (e.g. Procrustes ANOVA in geomorph) needs.
// Coordinates are as stored: mesh space, in the mesh's units. Points not
// placed have x, y, z = NA; `status` says why (missing or not_done).

import { exportRows } from './export-rows.js';
import { replicateOf, operatorOf } from './set-model.js';

export const CSV_HEADER =
  'tps_id,specimen_id,replicate,operator,mesh,point,template_id,label,type,curve,index,x,y,z,units,status';

const fmt = (n) => String(Number(n.toFixed(6)));
const quote = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export { exportRows };

export function toCsv(states, { ids = states.map((st) => st.specimen.id) } = {}) {
  const lines = [CSV_HEADER];
  states.forEach((st, i) => {
    const units = st.specimen.mesh?.units || 'unknown';
    for (const r of exportRows(st)) {
      lines.push(
        [
          ids[i],
          st.specimen.id,
          replicateOf(st),
          operatorOf(st),
          st.specimen.mesh?.file || '',
          r.point,
          r.template_id,
          r.label,
          r.type,
          r.curve,
          r.index,
          ...(r.pos ? r.pos.map(fmt) : ['NA', 'NA', 'NA']),
          units,
          r.status,
        ]
          .map(quote)
          .join(',')
      );
    }
  });
  return lines.join('\n') + '\n';
}
