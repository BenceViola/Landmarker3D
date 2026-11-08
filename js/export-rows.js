// The rows one specimen contributes to TPS and CSV exports, shared by both:
// template landmarks and curve semilandmarks in export order, then ad hoc
// points by id.
//
// A curve gives n_points rows (C01_01, C01_02, …). They have coordinates
// only when the curve is finished with that many points; otherwise they are
// written as missing (status "missing" or "not_done"), so every specimen has
// the same rows.

import { exportItems } from './landmark-file.js';
import { nPointsOf } from './curves.js';

const hasPos = (p) => p && p.status !== 'missing' && Array.isArray(p.position);

export function exportRows(st) {
  const byTemplate = new Map();
  for (const p of st.points) if (p.template_id !== null) byTemplate.set(p.template_id, p);
  const curves = new Map((st.curves || []).map((c) => [c.template_id ?? c.id, c]));
  const rows = [];
  for (const item of exportItems(st.template)) {
    if (item.kind === 'landmark') {
      const p = byTemplate.get(item.id);
      rows.push({
        point: item.id,
        template_id: item.id,
        label: item.def.name,
        type: 'landmark',
        curve: '',
        index: '',
        pos: hasPos(p) ? p.position : null,
        status: p ? p.status : 'not_done',
        adhoc: false,
      });
      continue;
    }
    const n = nPointsOf(item.def);
    const c = curves.get(item.id);
    const ok = c && c.status !== 'missing' && Array.isArray(c.points) && c.points.length === n;
    const status = ok ? c.status || 'placed' : c?.status === 'missing' ? 'missing' : 'not_done';
    for (let k = 0; k < n; k++) {
      rows.push({
        point: `${item.id}_${String(k + 1).padStart(2, '0')}`,
        template_id: item.id,
        label: item.def.name,
        type: 'curve',
        curve: item.id,
        index: k + 1,
        pos: ok ? c.points[k].position : null,
        status,
        adhoc: false,
      });
    }
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
      curve: '',
      index: '',
      pos: hasPos(p) ? p.position : null,
      status: p.status,
      adhoc: true,
    });
  }
  return rows;
}
