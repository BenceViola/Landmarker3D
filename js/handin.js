// Hand-ins (students) and combining them (instructors), following the 2D app.
//
// A hand-in is one zip: a landmark file per specimen, plus all of them as one
// TPS and one CSV. Opening the zip again resumes the set. Combining takes
// several students' zips (or loose .lmk.json files) and gives one TPS and CSV.

import { parseLandmarkFile, LandmarkFileError } from './landmark-file.js';
import { unzipFiles } from './zip.js';
import { toTps } from './tps.js';
import { toCsv } from './csv.js';
import {
  replicateOf, operatorOf, safeName, exportIds, docFileName, templateDifference, progress,
} from './set-model.js';

// A parsed landmark file as an export state.
export const stateOf = (parsed) => ({
  specimen: parsed.doc.specimen,
  template: parsed.template,
  points: parsed.points,
  curves: parsed.curves,
  provenance: parsed.doc.provenance || {},
  name: parsed.name,
});

/**
 * Files for a hand-in zip. `docs` are built landmark files, one per
 * specimen ({ doc, text }), with the operator already filled in.
 */
export function handInFiles(docs, { operator = '', missing = '-999', includeAdhoc = true } = {}) {
  const base = `${safeName(operator) || 'landmarks'}_landmarks`;
  const used = new Set();
  const files = [];
  for (const { doc, text } of docs) {
    const first = docFileName(doc);
    let name = first;
    for (let k = 2; used.has(name); k++) name = first.replace(/\.lmk\.json$/, `_${k}.lmk.json`);
    used.add(name);
    files.push({ name, data: text });
  }
  const states = docs.map(({ doc }) => ({
    specimen: doc.specimen,
    template: doc.template,
    points: doc.landmarks,
    curves: doc.curves || [],
    provenance: doc.provenance || {},
  }));
  const ids = exportIds(states);
  const tps = toTps(states, { ids, missing, includeAdhoc });
  files.push({ name: `${base}.tps`, data: tps.text });
  files.push({ name: `${base}.csv`, data: toCsv(states, { ids }) });
  return { files, notes: tps.notes };
}

/**
 * Read chosen files (zips and .lmk.json files) into entries:
 * [{ source, name, text }] or [{ source, name, error }].
 * `read(file)` returns the file's bytes; injectable for tests.
 */
export async function readEntries(files, read = async (f) => new Uint8Array(await f.arrayBuffer())) {
  const out = [];
  const dec = new TextDecoder();
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const parts = (await unzipFiles(await read(f))).filter((x) => /\.json$/i.test(x.name));
        if (!parts.length) out.push({ source: f.name, name: f.name, error: `“${f.name}” has no landmark files in it.` });
        for (const x of parts) out.push({ source: f.name, name: x.name.split('/').pop(), text: dec.decode(x.data) });
      } catch (err) {
        out.push({ source: f.name, name: f.name, error: `“${f.name}”: ${err.message}` });
      }
    } else {
      out.push({ source: f.name, name: f.name, text: dec.decode(await read(f)) });
    }
  }
  return out;
}

const sortKey = (st) => [String(st.specimen.id), operatorOf(st), replicateOf(st)];
const byKey = (a, b) => {
  const [x, y] = [sortKey(a), sortKey(b)];
  return (
    x[0].localeCompare(y[0], 'en', { numeric: true }) ||
    x[1].localeCompare(y[1], 'en', { numeric: true }) ||
    x[2] - y[2]
  );
};

/**
 * Combine hand-ins from several students. Files whose template differs from
 * the first accepted file are refused; an exact repeat (same specimen,
 * operator and replicate) is skipped. States come back sorted by specimen,
 * operator and replicate, with their export IDs.
 */
export function combineEntries(entries) {
  const states = [];
  const refused = [];
  const skipped = [];
  const seen = new Map();
  let template = null;
  for (const en of entries) {
    if (en.error) {
      refused.push({ source: en.source, name: en.name, reason: en.error });
      continue;
    }
    let st;
    try {
      st = stateOf(parseLandmarkFile(en.text, en.name));
    } catch (err) {
      refused.push({ source: en.source, name: en.name, reason: err instanceof LandmarkFileError ? err.message : `“${en.name}” couldn’t be read.` });
      continue;
    }
    if (template) {
      const diff = templateDifference(template, st.template);
      if (diff) {
        refused.push({ source: en.source, name: en.name, reason: `“${en.name}” was not combined: ${diff}.` });
        continue;
      }
    } else {
      template = st.template;
    }
    const key = JSON.stringify([st.specimen.id, operatorOf(st), replicateOf(st)]);
    if (seen.has(key)) {
      skipped.push({ source: en.source, name: en.name, reason: `Same specimen, operator and replicate as ${seen.get(key)}.` });
      continue;
    }
    seen.set(key, en.name);
    states.push(st);
  }
  states.sort(byKey);

  const byOperator = new Map();
  const opsPerSpecimen = new Map();
  for (const st of states) {
    const op = operatorOf(st) || '(no name)';
    const row = byOperator.get(op) || { operator: op, specimens: 0, complete: 0 };
    const pr = progress(st);
    row.specimens++;
    if (pr.done === pr.total) row.complete++;
    byOperator.set(op, row);
    const ops = opsPerSpecimen.get(st.specimen.id) || new Set();
    ops.add(operatorOf(st));
    opsPerSpecimen.set(st.specimen.id, ops);
  }
  const shared = [...opsPerSpecimen].filter(([, s]) => s.size > 1).map(([id, s]) => ({ id, operators: s.size }));
  return { states, refused, skipped, template, operators: [...byOperator.values()], shared, ids: exportIds(states) };
}
