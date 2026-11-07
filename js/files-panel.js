// The File tab and everything around saving and opening:
//   - specimen ID, operator and notes that go into the landmark file
//   - Save / Save as / Open for .lmk.json files
//   - matching an opened file to the mesh by its SHA-256, and offering to
//     snap the points onto a different mesh when they don't match
//   - TPS export for this specimen, and combining several files into one TPS
//   - warning before unsaved landmarks are replaced

import { buildLandmarkFile, parseLandmarkFile, meshMatches, LandmarkFileError } from './landmark-file.js';
import { tpsBlock, combineTps, adhocIdsOf } from './tps.js';
import { saveText, prepareSaving, canSaveInPlace } from './file-io.js';

const $ = (id) => document.getElementById(id);
const OPERATOR_KEY = 'landmarker.operator';
const UNITS = new Set(['mm', 'cm', 'm', 'um', 'unknown']);
const JSON_TYPES = [{ description: 'Landmark file', accept: { 'application/json': ['.json'] } }];
const TPS_TYPES = [{ description: 'TPS file', accept: { 'text/plain': ['.tps'] } }];

const stem = (name) => name.replace(/\.(stl|ply|lmk\.json|json)$/i, '');
const safeName = (s) => (s || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'specimen';
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function setupFiles(app) {
  const { session, state, ui } = app;
  const f = {
    baseDoc: null, // the file as last opened or saved; unknown fields are kept from it
    pending: null, // a landmark file waiting for its mesh
    dirty: false,
    handle: null, // where Save writes again (browsers with a Save dialog)
    created: null,
    savedName: null,
    savedAt: null,
    action: null, // 'opened' | 'saved'
  };

  prepareSaving();

  // ---- Specimen fields -----------------------------------------------------

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
    markDirty();
  });
  $('spec-id').addEventListener('change', markDirty);
  $('spec-notes').addEventListener('change', markDirty);

  session.addEventListener('change', (e) => {
    if (!['active', 'load', 'reset'].includes(e.detail.kind)) markDirty();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!f.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---- Buttons -------------------------------------------------------------

  $('save-btn').addEventListener('click', () => save());
  $('save-file').addEventListener('click', () => save());
  $('save-as').addEventListener('click', () => save({ as: true }));
  $('save-as').hidden = !canSaveInPlace; // elsewhere every save asks anyway
  $('open-lmk-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openLandmarkFile(file);
  });
  $('export-tps').addEventListener('click', exportTps);
  $('combine-input').addEventListener('change', async (e) => {
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

  // ---- State and status ----------------------------------------------------

  function markDirty() {
    if (!state.mesh) return;
    f.dirty = true;
    renderStatus();
  }

  function renderStatus() {
    const el = $('save-status');
    const time = f.savedAt ? f.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let text;
    if (!state.mesh) text = 'Open a mesh to start.';
    else if (f.dirty) text = f.savedName ? `Unsaved changes since ${f.action} ${f.savedName}` : 'Not saved yet';
    else if (f.savedName) text = `${f.action === 'saved' ? 'Saved' : 'Opened'} ${f.savedName}${time && f.action === 'saved' ? ` at ${time}` : ''}`;
    else text = 'No changes yet';
    el.textContent = text;
    el.classList.toggle('is-dirty', f.dirty);
    $('save-btn').classList.toggle('has-changes', f.dirty);
    $('save-btn').title = f.dirty ? 'Save landmarks (unsaved changes) · Ctrl/⌘ S' : 'Save landmarks · Ctrl/⌘ S';
  }

  function specimenId() {
    const v = $('spec-id').value.trim();
    if (v) return v;
    const id = state.mesh ? stem(state.mesh.name) : 'specimen';
    $('spec-id').value = id;
    return id;
  }

  // Ask before something replaces unsaved work.
  function guardUnsaved(proceed, what) {
    if (!f.dirty) return proceed();
    ui.showPrompt({
      kind: 'note',
      text: `You have unsaved landmarks. ${what} will replace them.`,
      actions: [
        { label: 'Save first', primary: true, run: async () => { if (await save()) proceed(); } },
        { label: 'Discard and continue', run: () => { f.dirty = false; renderStatus(); proceed(); } },
        { label: 'Cancel', run: () => {} },
      ],
    });
  }

  // Called after a new mesh is on screen (the session has been reset).
  function onMeshShown() {
    f.baseDoc = null;
    f.handle = null;
    f.created = null;
    f.savedName = null;
    f.savedAt = null;
    f.dirty = false;
    $('spec-id').value = state.isSample ? 'sample' : stem(state.mesh.name);
    $('spec-notes').value = '';
    if (f.pending) {
      const parsed = f.pending;
      f.pending = null;
      if (meshMatches(parsed.doc.specimen.mesh, state.mesh)) apply(parsed, { resnap: false });
      else promptMismatch(parsed);
    }
    renderStatus();
  }

  // ---- Opening -------------------------------------------------------------

  async function readLandmarkFile(file) {
    try {
      return parseLandmarkFile(await file.text(), file.name);
    } catch (err) {
      if (!(err instanceof LandmarkFileError)) console.error(err); // expected refusals are only shown
      ui.showMessage('error', err instanceof LandmarkFileError ? err.message : `Couldn’t read “${file.name}”.`);
      return null;
    }
  }

  async function openLandmarkFile(file) {
    const parsed = await readLandmarkFile(file);
    if (parsed) guardUnsaved(() => route(parsed), `Opening “${file.name}”`);
  }

  // A landmark file dropped together with its mesh: hold it until the mesh loads.
  async function queueLandmarkFile(file) {
    const parsed = await readLandmarkFile(file);
    if (parsed) f.pending = parsed;
    return !!parsed;
  }

  function route(parsed) {
    const want = parsed.doc.specimen.mesh;
    if (!state.mesh || state.isSample) {
      f.pending = parsed;
      ui.showPrompt({
        kind: 'note',
        text: `Landmarks for ${parsed.doc.specimen.id} are ready. Open their mesh, ${want.file}, to see them.`,
        actions: [{ label: `Open ${want.file}…`, primary: true, run: app.openMeshPicker }],
      });
      return;
    }
    if (meshMatches(want, state.mesh)) apply(parsed, { resnap: false });
    else promptMismatch(parsed);
  }

  function promptMismatch(parsed) {
    const want = parsed.doc.specimen.mesh;
    const sameName = want.file === state.mesh.name;
    ui.showPrompt({
      kind: 'note',
      text: sameName
        ? `“${parsed.name}” was made on a different version of ${want.file}: the file contents don’t match. The landmarks may not sit on this surface.`
        : `“${parsed.name}” was made on ${want.file}, but the open mesh is ${state.mesh.name}. The landmarks may not sit on this surface.`,
      actions: [
        { label: `Open ${want.file}…`, primary: true, run: () => { f.pending = parsed; app.openMeshPicker(); } },
        { label: 'Use this mesh and snap points to it', run: () => apply(parsed, { resnap: true }) },
        { label: 'Cancel', run: () => {} },
      ],
    });
  }

  function apply(parsed, { resnap }) {
    session.load(parsed.template, parsed.points);

    let snapped = 0;
    let maxDist = 0;
    if (resnap) {
      for (const p of session.points) {
        if (!p.position) continue;
        const s = app.picker.snap(p.position);
        if (!s) continue;
        session.replacePoint(p.id, s.fields);
        snapped++;
        maxDist = Math.max(maxDist, s.distance);
      }
    }

    const doc = parsed.doc;
    f.baseDoc = doc;
    f.created = doc.provenance?.created || null;
    f.handle = null;
    f.savedName = parsed.name;
    f.savedAt = null;
    f.action = 'opened';
    f.dirty = resnap;
    $('spec-id').value = doc.specimen.id ?? '';
    $('spec-notes').value = doc.specimen.notes ?? '';
    if (doc.provenance?.operator) $('operator').value = doc.provenance.operator;
    const units = doc.specimen.mesh.units;
    if (UNITS.has(units)) app.setUnits(units);

    app.renderAll();
    renderStatus();

    const notes = [...parsed.warnings];
    if (resnap) {
      notes.unshift(
        `${plural(snapped, 'point')} moved onto this mesh; the largest move was ${maxDist.toFixed(3)} ${units && units !== 'unknown' ? units.replace('um', 'µm') : 'units'}. Save to keep the snapped positions.`
      );
    }
    if (notes.length) ui.showMessage('note', `Opened ${parsed.name}. ${notes.join(' ')}`);
    else ui.clearMessage();
  }

  // ---- Saving --------------------------------------------------------------

  async function save({ as = false } = {}) {
    if (!state.mesh) {
      ui.showMessage('error', 'Open a mesh before saving landmarks.');
      return false;
    }
    const id = specimenId();
    f.created ||= stamp();
    const { text, doc } = buildLandmarkFile({
      session,
      mesh: state.mesh,
      units: state.units,
      specimenId: id,
      notes: $('spec-notes').value.trim(),
      operator: $('operator').value.trim(),
      base: f.baseDoc,
      created: f.created,
    });
    let res;
    try {
      res = await saveText({ filename: `${safeName(id)}.lmk.json`, text, handle: as ? null : f.handle, types: JSON_TYPES });
    } catch (err) {
      ui.showMessage('error', err.message);
      return false;
    }
    if (res.status === 'cancelled') return false;
    f.handle = res.handle || null;
    f.baseDoc = doc;
    f.dirty = false;
    f.savedName = res.name;
    f.savedAt = new Date();
    f.action = 'saved';
    renderStatus();
    return true;
  }

  // ---- TPS -----------------------------------------------------------------

  function missingValue() {
    return $('tps-missing').value.trim() || '-999';
  }

  function exportTps() {
    if (!state.mesh) {
      ui.showMessage('error', 'Open a mesh and place landmarks before exporting.');
      return;
    }
    const todo = session.counts().todo;
    const missing = missingValue();
    const go = async () => {
      const id = specimenId();
      const adhocIds = $('tps-adhoc').checked ? adhocIdsOf(session.points) : [];
      const { text, rows } = tpsBlock({ id, template: session.template, points: session.points, adhocIds, missing });
      await saveTps(`${safeName(id)}`, text, `${plural(rows, 'landmark')} for ${id}`);
    };
    if (todo) {
      ui.showPrompt({
        kind: 'note',
        text: `${plural(todo, 'landmark is', 'landmarks are')} still to do. ${todo === 1 ? 'It' : 'They'} will be written as missing (${missing} ${missing} ${missing}).`,
        actions: [
          { label: 'Export anyway', primary: true, run: go },
          { label: 'Cancel', run: () => {} },
        ],
      });
    } else {
      go();
    }
  }

  async function combine(files) {
    const parsed = [];
    const errors = [];
    for (const file of files) {
      try {
        parsed.push(parseLandmarkFile(await file.text(), file.name));
      } catch (err) {
        errors.push(err instanceof LandmarkFileError ? err.message : `Couldn’t read “${file.name}”.`);
      }
    }
    if (errors.length) {
      ui.showMessage('error', `Nothing was combined. ${errors.join(' ')}`);
      return;
    }
    let out;
    try {
      out = combineTps(parsed, { includeAdhoc: $('tps-adhoc').checked, missing: missingValue() });
    } catch (err) {
      ui.showMessage('error', err.message);
      return;
    }
    // Saving waits for a click: the browser's Save dialog needs a fresh one.
    const base = `${safeName(parsed[0].template.id)}_${out.count}_specimens`;
    ui.showPrompt({
      kind: 'note',
      text: `Combined ${plural(out.count, 'specimen')} into one TPS file. ${out.notes.join(' ')}`,
      actions: [
        { label: 'Save TPS file', primary: true, run: () => saveTps(base, out.text, plural(out.count, 'specimen')) },
        { label: 'Cancel', run: () => {} },
      ],
    });
  }

  async function saveTps(base, text, what) {
    let res;
    try {
      res = await saveText({ filename: `${base}.tps`, frameFilename: `${base}.tps.txt`, text, types: TPS_TYPES });
    } catch (err) {
      ui.showMessage('error', err.message);
      return;
    }
    if (res.status === 'cancelled') return;
    const renamed = res.name.endsWith('.tps.txt');
    ui.showMessage(
      'note',
      `Exported ${what} to ${res.name}.` +
        (renamed ? ' This preview can only save it with an extra .txt ending; remove it if you like. geomorph’s readland.tps reads the file either way.' : '')
    );
  }

  renderStatus();
  return { onMeshShown, openLandmarkFile, queueLandmarkFile, guardUnsaved, markDirty, renderStatus };
}
