// TPS export (the format of tpsDig / tpsUtil, read by geomorph's readland.tps).
//
// 3D blocks use the LM3= header. Rows follow the template's export order,
// followed by ad hoc points. Missing landmarks, and template landmarks not
// placed yet, are written with the missing value (default -999), as in the spec.
// Coordinates are written as stored: mesh space, in the mesh's units.

import { exportOrder } from './landmark-file.js';

const fmt = (n) => String(Number(n.toFixed(6)));

// One specimen block. `adhocIds` decides which ad hoc points are written.
export function tpsBlock({ id, template, points, adhocIds = null, missing = '-999' }) {
  const byTemplate = new Map();
  for (const p of points) if (p.template_id !== null) byTemplate.set(p.template_id, p);
  const adhoc = points.filter((p) => p.template_id === null);
  const adhocList = adhocIds
    ? adhocIds.map((aid) => adhoc.find((p) => p.id === aid) || null)
    : [];

  const rows = [...exportOrder(template).map((tid) => byTemplate.get(tid) || null), ...adhocList];
  let notPlaced = 0;
  const lines = [`LM3=${rows.length}`];
  for (const p of rows) {
    if (p && p.status !== 'missing' && Array.isArray(p.position)) {
      lines.push(p.position.map(fmt).join(' '));
    } else {
      if (!p) notPlaced++;
      lines.push(`${missing} ${missing} ${missing}`);
    }
  }
  lines.push(`ID=${id}`);
  return { text: lines.join('\n') + '\n', notPlaced, rows: rows.length };
}

// Ad hoc point ids of one specimen, in id order.
export function adhocIdsOf(points) {
  return points
    .filter((p) => p.template_id === null)
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * Several specimens in one TPS, one block each, in the order given.
 * `states` are export states ({ specimen, template, points }) that share a
 * template; `ids` are the ID= values (see exportIds). Ad hoc points are
 * written only if every specimen has exactly the same ones, or the rows
 * wouldn't correspond.
 */
export function toTps(states, { ids = states.map((st) => st.specimen.id), includeAdhoc = true, missing = '-999' } = {}) {
  const notes = [];
  let adhocIds = [];
  if (includeAdhoc && states.length) {
    const sets = states.map((st) => adhocIdsOf(st.points).join('\n'));
    if (sets.every((x) => x === sets[0])) adhocIds = adhocIdsOf(states[0].points);
    else notes.push('Ad hoc points were left out of the TPS file, because the specimens don’t all have the same ones.');
  }
  let notPlaced = 0;
  const text = states
    .map((st, i) => {
      const block = tpsBlock({ id: ids[i], template: st.template, points: st.points, adhocIds, missing });
      notPlaced += block.notPlaced;
      return block.text;
    })
    .join('');
  if (notPlaced) {
    notes.push(`${notPlaced} landmark${notPlaced === 1 ? ' was' : 's were'} never placed and ${notPlaced === 1 ? 'is' : 'are'} written as missing.`);
  }
  return { text, notes, notPlaced };
}
