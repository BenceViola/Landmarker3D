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

// Several parsed landmark files into one TPS. All must use the same template
// (same id and same export order), or the rows wouldn't correspond.
// Throws an Error with a readable message if they don't match.
export function combineTps(files, { includeAdhoc = true, missing = '-999' } = {}) {
  if (!files.length) throw new Error('No landmark files were chosen.');
  const ref = files[0];
  const refOrder = exportOrder(ref.template).join('\n');
  for (const f of files.slice(1)) {
    if (f.template.id !== ref.template.id || exportOrder(f.template).join('\n') !== refOrder) {
      throw new Error(
        `“${f.name}” uses a different template (${f.template.id}, ${f.template.landmarks.length} landmarks) from “${ref.name}” (${ref.template.id}, ${ref.template.landmarks.length} landmarks). Only files made with the same template can be combined.`
      );
    }
  }

  // Ad hoc points only line up if every file has exactly the same ones.
  const notes = [];
  let adhocIds = [];
  if (includeAdhoc) {
    const sets = files.map((f) => adhocIdsOf(f.points).join('\n'));
    if (sets.every((s) => s === sets[0])) adhocIds = adhocIdsOf(ref.points);
    else notes.push('Ad hoc points were left out, because the files don’t all have the same ones.');
  }

  const sorted = [...files].sort((a, b) =>
    String(a.doc.specimen.id).localeCompare(String(b.doc.specimen.id), 'en', { numeric: true })
  );
  let notPlaced = 0;
  const text = sorted
    .map((f) => {
      const block = tpsBlock({ id: f.doc.specimen.id, template: f.template, points: f.points, adhocIds, missing });
      notPlaced += block.notPlaced;
      return block.text;
    })
    .join('');
  if (notPlaced) notes.push(`${notPlaced} landmark${notPlaced === 1 ? ' was' : 's were'} never placed and ${notPlaced === 1 ? 'is' : 'are'} written as missing.`);

  const ids = sorted.map((f) => String(f.doc.specimen.id));
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) notes.push(`Specimen ID${dupes.length === 1 ? '' : 's'} used more than once: ${dupes.join(', ')}.`);

  return { text, notes, count: files.length };
}
