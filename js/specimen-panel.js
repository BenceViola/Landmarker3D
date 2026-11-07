// The Specimen tab: the current specimen's ID, notes and units, its
// replicates, its mesh details, and removing it from the set.

import { replicateOf } from './session.js';
import { nextReplicate, shuffledOrder, repeatability } from './set-model.js';

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

  // ---- Replicates ----------------------------------------------------------

  let shuffle = false; // random order is an option, off by default (as in 2D)

  $('rep-section').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'rep-new') landmarkAgain();
    if (b.dataset.act === 'rep-go') session.switchTo(Number(b.dataset.uid));
    if (b.dataset.act === 'rep-summary') openRepeatability();
  });
  $('rep-section').addEventListener('change', (e) => {
    if (e.target.id === 'rep-shuffle') shuffle = e.target.checked;
  });

  // A new replicate: the same specimen and mesh, landmarked again from
  // scratch. Only the current replicate's points are shown, so the earlier
  // ones can't guide the new placement.
  function landmarkAgain() {
    const src = session.current;
    if (!src.specimen.mesh || !app.state.mesh) {
      ui.showMessage('error', 'Open this specimen’s mesh first.');
      return;
    }
    const fam = family(src);
    const n = nextReplicate(fam, src);
    const rec = session.addRecord(
      {
        specimen: { id: src.specimen.id, replicate: n, mesh: structuredClone(src.specimen.mesh) },
        file: src.file,
        thumb: src.thumb,
        order: shuffle ? shuffledOrder(session.template) : null,
      },
      { after: fam.at(-1) }
    );
    session.switchTo(rec.uid);
    ui.showMessage(
      'note',
      `Replicate ${n} of ${src.specimen.id}: place the landmarks again${shuffle ? ', in random order' : ''}. ` +
        'Your earlier points are hidden while you work on this replicate.'
    );
  }

  function renderReplicates(rec) {
    const fam = family(rec);
    const any = session.records.some((r) => !r.isSample && family(r).length > 1);
    const canAgain = !!(rec.specimen.mesh && app.state.mesh);
    $('rep-section').innerHTML = `
      <h2 id="rep-h">Replicates</h2>
      <p class="hint">Landmark a specimen again to check how reliably you place landmarks. A replicate uses the same mesh; your earlier points stay hidden while you place the new ones.</p>
      ${fam.length > 1 ? `<div class="rep-list">${fam.map((r) => {
        const p = session.progressOf(r);
        return `<button type="button" class="btn small${r === rec ? ' on-rep' : ''}" data-act="rep-go" data-uid="${r.uid}" aria-pressed="${r === rec}">r${replicateOf(r)} <span class="mono ${p.done === p.total ? 'ok' : 'bad'}">${p.done}/${p.total}</span></button>`;
      }).join('')}</div>` : ''}
      <label class="toggle">Place landmarks in random order
        <input type="checkbox" id="rep-shuffle"${shuffle ? ' checked' : ''}><span class="switch"></span>
      </label>
      <div class="open-row">
        <button type="button" class="btn small" data-act="rep-new"${canAgain ? '' : ' disabled title="Open the mesh first"'}>Landmark ${esc(rec.specimen.id)} again</button>
        <button type="button" class="btn small" data-act="rep-summary"${any ? '' : ' disabled title="Landmark a specimen twice first"'}>Repeatability…</button>
      </div>`;
  }

  function openRepeatability() {
    const states = session.records
      .filter((r) => !r.isSample && r.specimen.mesh)
      .map((r) => ({ specimen: r.specimen, template: session.template, points: r.points }));
    const r = repeatability(states);
    const u = r.units;
    const fmt = (v) => (v == null ? '–' : v < 1 ? v.toFixed(3) : v.toFixed(2));
    const rows = r.rows.filter((x) => x.pairs).sort((a, b) => b.mean - a.mean);
    const none = r.rows.filter((x) => !x.pairs);
    const html = !r.specimens.length
      ? '<p>No specimen has been landmarked more than once yet. Use “Landmark again” in the Specimen tab, then come back here.</p>'
      : `<p>How far apart your replicates landed, for ${r.specimens.length === 1 ? '1 specimen' : `${r.specimens.length} specimens`} landmarked more than once (${r.specimens.map((x) => `${esc(x.id)} ×${x.replicates}`).join(', ')}). Largest differences first. Replicates share the mesh, so these are straight distances, with no alignment.</p>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Landmark</th><th class="num">Specimens</th><th class="num">Average (${esc(u)})</th><th class="num">Largest (${esc(u)})</th></tr></thead>
          <tbody>${rows.map((x) => `<tr${x.flag ? ' class="flag"' : ''}><td><span class="mono">${esc(x.id)}</span> ${esc(x.name)}${x.flag ? ' <span class="chip">check</span>' : ''}</td><td class="num">${x.specimens}</td><td class="num">${fmt(x.mean)}</td><td class="num">${fmt(x.max)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${rows.some((x) => x.flag) ? `<p class="hint"><span class="chip">check</span> marks landmarks whose average is more than twice the typical value (${fmt(r.median)} ${esc(u)}). Re-read their descriptions in the Template tab.</p>` : ''}
        ${none.length ? `<p class="hint">Not placed on two replicates yet: ${none.map((x) => esc(x.id)).join(', ')}.</p>` : ''}
        <p class="hint">For a full measurement-error analysis (for example Procrustes ANOVA in geomorph), use Export CSV in the File tab: it has separate specimen_id and replicate columns.</p>`;
    ui.dialog({ title: 'Repeatability', html, actions: [{ label: 'Close', primary: true }] });
  }

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
    renderReplicates(rec);
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
      const name = `${rec.specimen.id}${family(rec).length > 1 ? ` r${replicateOf(rec)}` : ''}`;
      el.innerHTML = `<button type="button" class="btn quiet" data-act="remove">Remove ${esc(name)} from the set…</button>`;
    }
  }

  return { render, family };
}
