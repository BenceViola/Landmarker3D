// The Specimen tab: the current specimen's ID, notes and units, its mesh
// details, and removing it from the set.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const int = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '–');
const num = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitLabel = (u) => ({ mm: ' mm', cm: ' cm', m: ' m', um: ' µm', unknown: '' })[u] ?? '';
function bytes(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function setupSpecimenPanel(app) {
  const { session, specimens, ui } = app;
  let removing = false;

  // Replicates share the specimen's ID and mesh, so edits to those apply to all of them.
  const family = (rec) =>
    session.records.filter((r) => r === rec || (r.specimen.id === rec.specimen.id && specimens.shaOf(r) && specimens.shaOf(r) === specimens.shaOf(rec)));

  $('spec-id').addEventListener('change', (e) => {
    const rec = session.current;
    const id = e.target.value.trim() || rec.specimen.id;
    e.target.value = id;
    if (id === rec.specimen.id) return;
    const clash = session.records.find((r) => r.specimen.id === id && !family(rec).includes(r));
    if (clash) {
      ui.showMessage('error', `Another specimen in the set is already called ${id}. Choose a different ID.`);
      e.target.value = rec.specimen.id;
      return;
    }
    for (const r of family(rec)) {
      r.specimen.id = id;
      r.dirty = true;
    }
    app.renderAll();
  });

  $('spec-notes').addEventListener('change', (e) => {
    const rec = session.current;
    const notes = e.target.value.trim();
    if ((rec.specimen.notes || '') === notes) return;
    if (notes) rec.specimen.notes = notes;
    else delete rec.specimen.notes;
    rec.dirty = true;
    app.renderAll();
  });

  $('units').addEventListener('change', (e) => {
    const rec = session.current;
    if (!rec.specimen.mesh) return;
    for (const r of family(rec)) {
      r.specimen.mesh.units = e.target.value;
      r.dirty = true;
    }
    app.renderAll();
  });

  $('remove-spec').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') removing = true;
    if (act === 'remove-no') removing = false;
    if (act === 'remove-yes') {
      removing = false;
      const rec = session.current;
      specimens.release(rec);
      session.removeRecord(rec.uid);
    }
    render();
  });

  function render() {
    const rec = session.current;
    const recs = session.records;
    const mesh = app.state.mesh; // the loaded mesh on screen, if any
    const m = rec.specimen.mesh;

    $('spec-pos').textContent = recs.length > 1 ? `· ${recs.indexOf(rec) + 1} of ${recs.length}` : '';
    if (document.activeElement !== $('spec-id')) $('spec-id').value = rec.specimen.id || '';
    if (document.activeElement !== $('spec-notes')) $('spec-notes').value = rec.specimen.notes || '';
    $('spec-id').disabled = $('spec-notes').disabled = !m;

    $('file-name').textContent = m?.file || 'No mesh loaded';
    $('stage-file').textContent = m?.file || '';
    $('sample-tag').hidden = !rec.isSample;
    const waiting = m && !mesh;
    $('mesh-waiting').hidden = !waiting;
    if (waiting) $('mesh-waiting').textContent = `Not open. Open ${m.file} to see this specimen and place landmarks.`;
    $('units').value = m?.units || 'mm';
    $('units').disabled = !m;

    if (mesh) {
      const box = mesh.geometry.boundingBox;
      const size = box.max.clone().sub(box.min);
      const centre = box.min.clone().add(box.max).multiplyScalar(0.5);
      $('format').textContent = mesh.format;
      $('extent').textContent = `${num(size.x)} × ${num(size.y)} × ${num(size.z)}${unitLabel(m.units)}`;
      $('centre').textContent = `${num(centre.x)}, ${num(centre.y)}, ${num(centre.z)}`;
      $('size').textContent = bytes(mesh.sizeBytes);
      $('colors-row').hidden = !mesh.hasColors;
    } else {
      for (const id of ['format', 'extent', 'centre', 'size']) $(id).textContent = '–';
      $('colors-row').hidden = true;
    }
    $('faces').textContent = int(m?.face_count);
    $('vertices').textContent = int(m?.vertex_count);
    $('hash').textContent = m?.sha256 || '–';
    $('copy-hash').hidden = !m?.sha256;

    const el = $('remove-spec');
    const real = recs.filter((r) => !r.isSample);
    if (real.length < 2) {
      el.innerHTML = '';
      removing = false;
    } else if (removing) {
      el.innerHTML = `<div class="tpl-confirm" style="margin:0">
          <p class="confirm-text">Remove ${esc(rec.specimen.id)} from the set?${rec.dirty && rec.points.length ? ' Its landmarks are not saved and will be lost.' : ''}</p>
          <div class="confirm-actions">
            <button type="button" class="btn danger small" data-act="remove-yes">Remove</button>
            <button type="button" class="btn small" data-act="remove-no">Cancel</button>
          </div></div>`;
    } else {
      el.innerHTML = `<button type="button" class="btn quiet" data-act="remove">Remove ${esc(rec.specimen.id)} from the set…</button>`;
    }
  }

  return { render, family };
}
