// CSV export: one row per point per specimen ("long" format), for R, Python
// or a spreadsheet. The columns match the 2D app's, with a z column and the
// mesh in place of the image, so one script can read both.
//
// specimen_id and replicate are separate columns, which is what a
// measurement-error analysis (e.g. Procrustes ANOVA in geomorph) needs.
// Coordinates are as stored: mesh space, in the mesh's units. Points not
// placed have x, y, z = NA; `status` says why (missing or not_done).

import { exportOrder } from './landmark-file.js';
import { replicateOf, operatorOf } from './set-model.js';

export const CSV_HEADER =
  'tps_id,specimen_id,replicate,operator,mesh,point,template_id,label,type,curve,index,x,y,z,units,status';

const fmt = (n) => String(Number(n.toFixed(6)));
const quote = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// The rows of one specimen: template landmarks in export order, then its
// ad hoc points by id.
export function exportRows(st) {
  const byTemplate = new Map();
  for (const p of st.points) if (p.template_id !== null) byTemplate.set(p.template_id, p);
  const rows = [];
  for (const id of exportOrder(st.template)) {
    const def = st.template.landmarks.find((d) => d.id === id);
    const p = byTemplate.get(id);
    rows.push({
      point: id,
      template_id: id,
      label: def.name,
      type: 'landmark',
      pos: p && p.status !== 'missing' && Array.isArray(p.position) ? p.position : null,
      status: p ? p.status : 'not_done',
    });
  }
  const adhoc = st.points
    .filter((p) => p.template_id === null)
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  for (const p of adhoc) {
    rows.push({
      point: p.id,
      template_id: '',
      label: p.label || '',
      type: 'adhoc',
      pos: p.status !== 'missing' && Array.isArray(p.position) ? p.position : null,
      status: p.status,
    });
  }
  return rows;
}

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
          '',
          '',
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
