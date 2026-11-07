// The File tab and everything around saving and opening:
//   - the operator name that goes into every file
//   - Save / Save as for the current specimen's .lmk.json
//   - opening landmark files and hand-in zips into the set, matched to
//     meshes by SHA-256; offering to snap points onto a different mesh
//   - the hand-in zip, TPS and CSV export of the whole set
//   - combining students' hand-ins (instructors)
//   - warning before unsaved landmarks are lost

import { buildLandmarkFile, parseLandmarkFile, LandmarkFileError } from './landmark-file.js';
import { replicateOf } from './session.js';
import { toTps } from './tps.js';
import { toCsv } from './csv.js';
import { zipFiles } from './zip.js';
import { handInFiles, readEntries, combineEntries, stateOf } from './handin.js';
import { exportIds, safeName, docFileName, templateDifference } from './set-model.js';
import { saveFile, prepareSaving, canSaveInPlace } from './file-io.js';

const $ = (id) => document.getElementById(id);
const OPERATOR_KEY = 'landmarker.operator';
const UNITS = new Set(['mm', 'cm', 'm', 'um', 'unknown']);
const JSON_TYPES = [{ description: 'Landmark file', accept: { 'application/json': ['.json'] } }];
const TPS_TYPES = [{ description: 'TPS file', accept: { 'text/plain': ['.tps'] } }];
const CSV_TYPES = [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }];
const ZIP_TYPES = [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }];

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function setupFiles(app) {
  const { session, ui, specimens } = app;
  let handedIn = null; // { name, at } of the last hand-in

  prepareSaving();

  // ---- Operator ------------------------------------------------------------

  try {
    $('operator').value = localStorage.getItem(OPERATOR_KEY) || '';
  } catch {
    /* storage unavailable: start empty */
  }
  $('operator').addEventListener('change', (e) => {
    try {
      localStorage.setItem(OPERATOR_KEY, e.target.value.trim());
    } catch {
      /* not remembered, still used */
    }
    for (const r of realRecords()) if (r.points.length) r.dirty = true;
    renderStatus();
  });
  const operator = () => $('operator').value.trim();

  // ---- Dirty tracking ------------------------------------------------------

  session.addEventListener('change', (e) => {
    const kind = e.detail.kind;
    if (['active', 'load', 'reset', 'set', 'switch', 'move'].includes(kind)) {
      renderStatus();
      return;
    }
    if (kind === 'template') {
      for (const r of session.records) if (r.points.length) r.dirty = true;
    }
    if (!session.current.isSample || kind !== 'template') session.current.dirty = true;
    renderStatus();
  });

  const realRecords = () => session.records.filter((r) => !r.isSample);
  const unsaved = () => realRecords().filter((r) => r.dirty && r.points.length);

  window.addEventListener('beforeunload', (e) => {
    if (!unsaved().length) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---- Buttons -------------------------------------------------------------

  $('save-btn').addEventListener('click', () => save());
  $('save-file').addEventListener('click', () => save());
  $('save-as').addEventListener('click', () => save({ as: true }));
  $('save-as').hidden = !canSaveInPlace; // elsewhere every save asks anyway
  $('open-lmk-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) openLandmarkFiles(files);
  });
  $('handin-btn').addEventListener('click', handIn);
  $('export-tps').addEventListener('click', () => exportSet('tps'));
  $('export-csv').addEventListener('click', () => exportSet('csv'));
  $('combine-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) combine(files);
  });

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save({ as: e.shiftKey });
    }
  });

  // ---- Status --------------------------------------------------------------

  function renderStatus() {
    const rec = session.current;
    const el = $('save-status');
    const time = rec.savedAt ? rec.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let text;
    if (!rec.specimen.mesh) text = 'Open a mesh to start.';
    else if (rec.dirty && rec.points.length) text = rec.savedName ? `Unsaved changes since ${rec.action} ${rec.savedName}` : 'Not saved yet';
    else if (rec.savedName) text = `${rec.action === 'saved' ? 'Saved' : 'Opened'} ${rec.savedName}${time && rec.action === 'saved' ? ` at ${time}` : ''}`;
    else if (handedIn && !rec.dirty && rec.points.length) text = `In the hand-in ${handedIn.name}`;
    else text = 'No changes yet';
    el.textContent = text;
    const dirty = rec.dirty && rec.points.length > 0;
    el.classList.toggle('is-dirty', dirty);
    $('save-btn').classList.toggle('has-changes', dirty);
    $('save-btn').title = dirty ? 'Save this specimen’s landmarks (unsaved changes) · Ctrl/⌘ S' : 'Save this specimen’s landmarks · Ctrl/⌘ S';
  }

  // ---- Building files ------------------------------------------------------

  function docFor(rec) {
    rec.created ||= stamp();
    return buildLandmarkFile({
      template: session.template,
      points: rec.points,
      mesh: rec.specimen.mesh,
      specimenId: rec.specimen.id || 'specimen',
      notes: rec.specimen.notes || '',
      operator: operator(),
      base: rec.base,
      created: rec.created,
      replicate: replicateOf(rec),
    });
  }

  // Export states for the set: real specimens with a mesh (or the example
  // when nothing else is open).
  function exportRecords() {
    const real = realRecords().filter((r) => r.specimen.mesh);
    return real.length ? real : session.records.filter((r) => r.specimen.mesh);
  }
  const statesOf = (recs) =>
    recs.map((r) => ({ specimen: { ...r.specimen }, template: session.template, points: r.points, provenance: { operator: operator() } }));

  // ---- Saving one specimen -------------------------------------------------

  async function save({ as = false } = {}) {
    const rec = session.current;
    if (!rec.specimen.mesh) {
      ui.showMessage('error', 'Open a mesh before saving landmarks.');
      return false;
    }
    const { text, doc } = docFor(rec);
    let res;
    try {
      res = await saveFile({ filename: docFileName(doc), data: text, handle: as ? null : rec.handle, types: JSON_TYPES });
    } catch (err) {
      ui.showMessage('error', err.message);
      return false;
    }
    if (res.status === 'cancelled') return false;
    rec.handle = res.handle || null;
    rec.base = doc;
    rec.dirty = false;
    rec.savedName = res.name;
    rec.savedAt = new Date();
    rec.action = 'saved';
    renderStatus();
    app.renderStrip();
    return true;
  }

  // ---- Opening landmark files and hand-ins ---------------------------------

  async function openLandmarkFiles(files) {
    ui.clearMessage();
    const entries = await readEntries(files);
    const problems = [];
    const parsed = [];
    for (const en of entries) {
      if (en.error) {
        problems.push(en.error);
        continue;
      }
      try {
        parsed.push(parseLandmarkFile(en.text, en.name));
      } catch (err) {
        if (!(err instanceof LandmarkFileError)) console.error(err);
        problems.push(err instanceof LandmarkFileError ? err.message : `Couldn’t read “${en.name}”.`);
      }
    }
    if (!parsed.length) {
      if (problems.length) ui.showMessage('error', problems.join(' '));
      return;
    }

    // One file that matches no mesh while an empty specimen's mesh is on
    // screen: offer to put its points on that mesh.
    const cur = session.current;
    if (
      parsed.length === 1 && !problems.length && !cur.isSample && cur.specimen.mesh && !cur.points.length &&
      app.state.mesh && !session.records.some((r) => specimens.shaOf(r) === parsed[0].doc.specimen.mesh.sha256?.toLowerCase())
    ) {
      return promptMismatch(parsed[0]);
    }
    addToSet(parsed, problems);
  }

  function addToSet(parsed, problems = []) {
    const added = [];
    for (const p of parsed) {
      const rec = addParsed(p, problems);
      if (rec) added.push(rec);
    }
    if (!added.length) {
      if (problems.length) ui.showMessage('error', problems.join(' '));
      return;
    }
    const first = added[0];
    if (!session.switchTo(first.uid)) specimens.show(first);
    app.renderAll();

    const waiting = [...new Set(added.filter((r) => specimens.meshState(r) === 'missing').map((r) => r.specimen.mesh.file))];
    let msg = added.length === 1 ? `Opened ${first.savedName}.` : `Opened ${plural(added.length, 'specimen')}.`;
    if (waiting.length === 1) msg += ` Now open its mesh, ${waiting[0]}.`;
    else if (waiting.length > 1) msg += ` Now open their ${waiting.length} meshes (you can select them all at once).`;
    const warnings = parsed.flatMap((p) => p.warnings.map((w) => `${p.name}: ${w}`));
    const text = [msg, ...problems, ...warnings].join(' ');
    if (waiting.length) {
      ui.showPrompt({ kind: 'note', text, actions: [{ label: waiting.length === 1 ? `Open ${waiting[0]}…` : 'Open meshes…', primary: true, run: app.openMeshPicker }, { label: 'Later', run: () => {} }] });
    } else {
      ui.showMessage('note', text);
    }
  }

  // Add one opened landmark file to the set. Returns the record, or null
  // (with the reason in `problems`).
  function addParsed(p, problems) {
    const doc = p.doc;
    const sha = String(doc.specimen.mesh.sha256 || '').toLowerCase();
    const rep = replicateOf(doc);

    // The template: an empty set (or the example) takes the file's; otherwise it must match.
    const blank = specimens.sampleOnly() || (!session.template.landmarks.length && !session.records.some((r) => r.points.length));
    if (!blank) {
      const diff = templateDifference(session.template, p.template);
      if (diff) {
        problems.push(`“${p.name}” was not opened: ${diff}. All specimens in a set use the same template.`);
        return null;
      }
    }

    const fields = {
      points: p.points,
      base: doc,
      created: doc.provenance?.created || null,
      savedName: p.name,
      savedAt: null,
      action: 'opened',
      dirty: false,
      handle: null,
    };
    if (doc.provenance?.operator && !operator()) $('operator').value = doc.provenance.operator;
    const units = UNITS.has(doc.specimen.mesh.units) ? doc.specimen.mesh.units : 'mm';
    const specimen = { ...structuredClone(doc.specimen), mesh: { ...doc.specimen.mesh, sha256: sha, units } };

    const sameMesh = session.records.filter((r) => !r.isSample && specimens.shaOf(r) === sha);
    const slot = sameMesh.find((r) => replicateOf(r) === rep);
    if (slot && slot.points.length) {
      problems.push(`${slot.specimen.id}${rep > 1 ? ` (replicate ${rep})` : ''} is already open, so “${p.name}” was skipped.`);
      return null;
    }
    if (blank) {
      if (specimens.sampleOnly()) {
        const rec = specimens.addSpecimen({ specimen, ...fields });
        session.load(p.template, p.points);
        return rec;
      }
      session.load(p.template, session.points);
    }
    if (slot) {
      // Its mesh is already open: fill the specimen in.
      Object.assign(slot, fields, { specimen: { ...specimen, mesh: { ...specimen.mesh, file: slot.specimen.mesh.file } } });
      return slot;
    }
    const sibling = sameMesh[0];
    const after = sameMesh.at(-1) || null;
    return specimens.addSpecimen({ specimen, ...fields, file: sibling?.file || null, thumb: sibling?.thumb || null }, { after });
  }

  function promptMismatch(p) {
    const want = p.doc.specimen.mesh;
    const cur = session.current;
    const sameName = want.file === cur.specimen.mesh.file;
    ui.showPrompt({
      kind: 'note',
      text: sameName
        ? `“${p.name}” was made on a different version of ${want.file}: the file contents don’t match. The landmarks may not sit on this surface.`
        : `“${p.name}” was made on ${want.file}, but the open mesh is ${cur.specimen.mesh.file}. The landmarks may not sit on this surface.`,
      actions: [
        { label: `Open ${want.file}…`, primary: true, run: () => { addToSet([p]); app.openMeshPicker(); } },
        { label: 'Use this mesh and snap points to it', run: () => applySnapped(p) },
        { label: 'Cancel', run: () => {} },
      ],
    });
  }

  function applySnapped(p) {
    const cur = session.current;
    const diff = session.records.some((r) => r !== cur && r.points.length) ? templateDifference(session.template, p.template) : null;
    if (diff) {
      ui.showMessage('error', `“${p.name}” was not opened: ${diff}. All specimens in a set use the same template.`);
      return;
    }
    session.load(p.template, p.points);
    Object.assign(cur, {
      base: p.doc,
      created: p.doc.provenance?.created || null,
      savedName: p.name,
      savedAt: null,
      action: 'opened',
      handle: null,
      specimen: { ...structuredClone(p.doc.specimen), mesh: cur.specimen.mesh },
    });
    const { count, max } = specimens.snapPoints([cur]);
    cur.dirty = true;
    app.renderAll();
    const u = cur.specimen.mesh.units;
    ui.showMessage(
      'note',
      `Opened ${p.name}. ${plural(count, 'point')} moved onto this mesh; the largest move was ${max.toFixed(3)} ${u && u !== 'unknown' ? u.replace('um', 'µm') : 'units'}. Save to keep the snapped positions.`
    );
  }

  // ---- Hand-in -------------------------------------------------------------

  async function handIn() {
    const recs = realRecords().filter((r) => r.specimen.mesh);
    if (!recs.length) {
      ui.showMessage('error', 'Open your own meshes first. The example mesh is not part of a hand-in.');
      return;
    }
    if (!operator()) {
      ui.showMessage('error', 'Type your name or student number under Operator first. It goes into every file of the hand-in.');
      $('operator').focus();
      return;
    }
    const docs = recs.map(docFor);
    const { files, notes } = handInFiles(docs, { operator: operator(), missing: missingValue(), includeAdhoc: $('tps-adhoc').checked });
    const unfinished = recs.filter((r) => { const pr = session.progressOf(r); return pr.done < pr.total; });
    const name = `${safeName(operator()) || 'hand-in'}_landmarks.zip`;
    const go = async () => {
      let res;
      try {
        res = await saveFile({ filename: name, data: zipFiles(files), types: ZIP_TYPES });
      } catch (err) {
        ui.showMessage('error', err.message);
        return;
      }
      if (res.status === 'cancelled') return;
      handedIn = { name: res.name, at: new Date() };
      for (const r of recs) r.dirty = false;
      renderStatus();
      app.renderStrip();
      ui.showMessage('note', `Saved the hand-in ${res.name}: ${plural(recs.length, 'specimen')}, with TPS and CSV.${notes.length ? ' ' + notes.join(' ') : ''}`);
    };
    if (unfinished.length) {
      ui.showPrompt({
        kind: 'note',
        text: `${plural(unfinished.length, 'specimen is', 'specimens are')} not finished: ${unfinished.map((r) => r.specimen.id).join(', ')}. Landmarks still to do are written as missing in the TPS file.`,
        actions: [{ label: 'Download hand-in anyway', primary: true, run: go }, { label: 'Cancel', run: () => {} }],
      });
    } else {
      go();
    }
  }

  // ---- Export of the set ---------------------------------------------------

  function missingValue() {
    return $('tps-missing').value.trim() || '-999';
  }

  function exportSet(kind) {
    const recs = exportRecords();
    if (!recs.length) {
      ui.showMessage('error', 'Open a mesh and place landmarks before exporting.');
      return;
    }
    const states = statesOf(recs);
    const ids = exportIds(states);
    const base = recs.length === 1 ? safeName(recs[0].specimen.id) || 'specimen' : `${safeName(operator()) || 'specimens'}_landmarks`;
    const todo = recs.reduce((n, r) => { const pr = session.progressOf(r); return n + pr.total - pr.done; }, 0);
    const what = recs.length === 1 ? recs[0].specimen.id : plural(recs.length, 'specimen');
    const go = () => {
      if (kind === 'tps') {
        const out = toTps(states, { ids, missing: missingValue(), includeAdhoc: $('tps-adhoc').checked });
        writeExport(`${base}.tps`, out.text, TPS_TYPES, what, out.notes.filter((n) => !/never placed/.test(n)));
      } else {
        writeExport(`${base}.csv`, toCsv(states, { ids }), CSV_TYPES, what, []);
      }
    };
    if (todo) {
      const m = missingValue();
      ui.showPrompt({
        kind: 'note',
        text: `${plural(todo, 'landmark is', 'landmarks are')} still to do. ${todo === 1 ? 'It' : 'They'} will be written as missing (${kind === 'tps' ? `${m} ${m} ${m}` : 'NA, with status not_done'}).`,
        actions: [{ label: 'Export anyway', primary: true, run: go }, { label: 'Cancel', run: () => {} }],
      });
    } else {
      go();
    }
  }

  async function writeExport(filename, text, types, what, notes) {
    let res;
    try {
      const frameFilename = filename.endsWith('.tps') ? `${filename}.txt` : filename;
      res = await saveFile({ filename, frameFilename, data: text, types });
    } catch (err) {
      ui.showMessage('error', err.message);
      return;
    }
    if (res.status === 'cancelled') return;
    const renamed = res.name.endsWith('.tps.txt');
    ui.showMessage(
      'note',
      `Exported ${what} to ${res.name}.` +
        (notes.length ? ' ' + notes.join(' ') : '') +
        (renamed ? ' This preview can only save it with an extra .txt ending; remove it if you like. geomorph’s readland.tps reads the file either way.' : '')
    );
  }

  // ---- Combining hand-ins (instructors) ------------------------------------

  async function combine(files) {
    const r = combineEntries(await readEntries(files));
    const list = (items, title) =>
      items.length ? `<p><b>${title}</b></p><ul>${items.map((x) => `<li>${esc(x.reason)}</li>`).join('')}</ul>` : '';
    if (!r.states.length) {
      ui.dialog({ title: 'Combine hand-ins', html: `<p>Nothing could be combined.</p>${list(r.refused, 'Not combined')}`, actions: [{ label: 'Close' }] });
      return;
    }
    const exampleShared = r.shared.length ? r.ids[r.states.findIndex((st) => st.specimen.id === r.shared[0].id)] : '';
    const html = `
      <p><b>${plural(r.states.length, 'specimen')}</b> from ${plural(r.operators.length, 'student')}, using the template “${esc(r.template.name || r.template.id)}”.</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Student</th><th class="num">Specimens</th><th class="num">Finished</th></tr></thead>
        <tbody>${r.operators.map((o) => `<tr><td>${esc(o.operator)}</td><td class="num">${o.specimens}</td><td class="num ${o.complete === o.specimens ? 'ok' : 'bad'}">${o.complete}</td></tr>`).join('')}</tbody>
      </table></div>
      ${r.shared.length ? `<p class="hint">Done by more than one student: ${r.shared.map((x) => `${esc(x.id)} (${x.operators})`).join(', ')}. Their IDs get the student’s name added, e.g. <span class="mono">${esc(exampleShared)}</span>, so you can use them for between-student error.</p>` : ''}
      ${list(r.refused, 'Not combined')}${list(r.skipped, 'Skipped (already included)')}`;
    const base = `${safeName(r.template.id) || 'combined'}_${r.states.length}_specimens`;
    ui.dialog({
      title: 'Combine hand-ins',
      html,
      actions: [
        { label: 'Save TPS file', primary: true, keepOpen: true, run: () => { const out = toTps(r.states, { ids: r.ids, missing: missingValue(), includeAdhoc: $('tps-adhoc').checked }); writeExport(`${base}.tps`, out.text, TPS_TYPES, plural(r.states.length, 'specimen'), out.notes); } },
        { label: 'Save CSV file', keepOpen: true, run: () => writeExport(`${base}.csv`, toCsv(r.states, { ids: r.ids }), CSV_TYPES, plural(r.states.length, 'specimen'), []) },
        { label: 'Close' },
      ],
    });
  }

  renderStatus();
  return { openLandmarkFiles, renderStatus, save, operator, unsaved, docFor };
}

export { stateOf };
