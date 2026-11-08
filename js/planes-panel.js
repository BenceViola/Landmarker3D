// The Planes tab: reference planes, shown against the mesh, and how far
// landmarks lie from them.
//
//   - Planes from landmarks are part of the template (spec v0.4), so they
//     are the same on every specimen and follow their landmarks.
//   - A plane from three clicked points is for exploring this specimen only;
//     it is never saved.
//   - The selected plane can cut away one side of the mesh, and has a table
//     of distances: midline landmarks (no left/right pair) should be close
//     to 0; left/right pairs should be at mirror distances.

import * as THREE from 'three';
import { fitPlane, planeOnSpecimen, signedDistance } from './planes.js';

export const PLANE_COLORS = ['#0f9d8a', '#7c4dff', '#e8590c', '#1c7ed6', '#c2255c', '#5c940d'];
const FREE_COLOR = '#f59f00';
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unitLabel = (u) => ({ mm: 'mm', cm: 'cm', m: 'm', um: 'µm' })[u] || 'units';
const fmt = (v) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1));

export function setupPlanesPanel(app, root) {
  const { session, ui, viewer, picker, planeView } = app;
  const st = {
    selected: null,
    hidden: new Set(),
    surface: true,
    cut: true,
    cutAway: 'none', // 'none' | 'front' (hide the side the plane faces) | 'back'
    tolerance: 1,
    editing: null, // null | 'new' | plane id
    draft: null, // { name, description, landmarks: [] }
    error: null,
    picking: null, // { points: [] } while clicking a plane's points
    confirmDelete: null,
  };
  let freeCount = 0;

  // ---- The planes on this specimen -------------------------------------

  function entries() {
    const rec = session.current;
    const out = (session.template.planes || []).map((def, i) => ({
      key: def.id,
      kind: 'template',
      def,
      color: PLANE_COLORS[i % PLANE_COLORS.length],
      ...planeOnSpecimen(def, session.points),
    }));
    for (const fp of rec.freePlanes || []) {
      out.push({ key: fp.id, kind: 'free', def: fp, color: FREE_COLOR, used: fp.points.map((p, i) => ({ id: `click ${i + 1}`, position: p })), lacking: [], ...fitPlane(fp.points) });
    }
    return out;
  }

  function selectedEntry(list = entries()) {
    return list.find((e) => e.key === st.selected) || null;
  }

  // ---- 3D ----------------------------------------------------------------

  let raf = 0;
  function update3D() {
    raf = 0;
    const list = entries();
    const geometry = app.state.mesh?.geometry || null;
    planeView.update(
      list
        .filter((e) => e.plane && !st.hidden.has(e.key))
        .map((e) => ({ key: e.key, plane: e.plane, color: e.color, surface: st.surface, cut: st.cut, emphasis: e.key === st.selected })),
      geometry
    );
    const sel = selectedEntry(list);
    if (sel?.plane && st.cutAway !== 'none' && geometry) {
      const n = new THREE.Vector3(...sel.plane.normal);
      const p = new THREE.Vector3(...sel.plane.point);
      // three.js hides what has a negative distance to the clipping plane.
      const keep = st.cutAway === 'front' ? new THREE.Plane(n.clone().negate(), n.dot(p)) : new THREE.Plane(n, -n.dot(p));
      viewer.setClip(keep);
      picker.keep = (q) => keep.distanceToPoint(q) >= 0;
    } else {
      viewer.setClip(null);
      picker.keep = null;
    }
    const r = viewer.diagonal * 0.005;
    planeView.setPickPoints(st.picking ? st.picking.points : [], r);
  }
  function schedule3D() {
    if (!raf) raf = requestAnimationFrame(update3D);
  }

  // ---- Clicking the points of a plane ------------------------------------

  // Called by interaction.js for every click on the 3D view.
  function intercept(hit) {
    if (!st.picking) return false;
    if (hit) {
      st.picking.points.push(hit.position);
      if (st.picking.points.length === 3) {
        const pts = st.picking.points;
        st.picking = null;
        const fit = fitPlane(pts);
        if (fit.error) {
          ui.showMessage('error', 'Those three points lie on one line, so they don’t make a plane. Try points further apart.');
        } else {
          const rec = session.current;
          const id = `C${++freeCount}`;
          (rec.freePlanes ||= []).push({ id, name: `Clicked plane ${freeCount}`, points: pts });
          st.selected = id;
        }
      }
      render();
      app.renderStageHint();
    }
    return true; // while picking, clicks never place landmarks
  }

  function startPicking() {
    if (!app.state.mesh) {
      ui.showMessage('error', 'Open this specimen’s mesh first.');
      return;
    }
    st.picking = { points: [] };
    st.editing = null;
    render();
    app.renderStageHint();
  }

  function cancelPicking() {
    if (!st.picking) return;
    st.picking = null;
    render();
    app.renderStageHint();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.picking) cancelPicking();
  });

  // The line at the top of the 3D view, while picking.
  function stageHint() {
    if (!st.picking) return null;
    const left = 3 - st.picking.points.length;
    return `<span class="verb">Click ${left} more point${left === 1 ? '' : 's'}</span> on the surface for a plane · Esc to cancel`;
  }

  // ---- Events --------------------------------------------------------------

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const key = b.dataset.key;
    switch (b.dataset.act) {
      case 'select':
        st.selected = st.selected === key ? null : key;
        break;
      case 'new':
        st.editing = 'new';
        st.draft = { name: (session.template.planes || []).length ? '' : 'Midsagittal', description: '', landmarks: midlineGuess() };
        st.error = null;
        break;
      case 'edit': {
        const def = session.plane(key);
        st.editing = key;
        st.draft = { name: def.name, description: def.description || '', landmarks: [...def.landmarks] };
        st.error = null;
        break;
      }
      case 'cancel-edit':
        st.editing = null;
        st.error = null;
        break;
      case 'save-edit':
        return saveEdit();
      case 'delete':
        st.confirmDelete = key;
        break;
      case 'delete-no':
        st.confirmDelete = null;
        break;
      case 'delete-yes':
        st.confirmDelete = null;
        st.editing = null;
        session.removePlane(key);
        if (st.selected === key) st.selected = null;
        return; // the session change renders
      case 'pick':
        return startPicking();
      case 'pick-cancel':
        return cancelPicking();
      case 'remove-free': {
        const rec = session.current;
        rec.freePlanes = (rec.freePlanes || []).filter((p) => p.id !== key);
        if (st.selected === key) st.selected = null;
        break;
      }
      case 'lm-up':
      case 'lm-down': {
        const L = st.draft.landmarks;
        const i = L.indexOf(b.dataset.id);
        const j = i + (b.dataset.act === 'lm-up' ? -1 : 1);
        if (i >= 0 && j >= 0 && j < L.length) [L[i], L[j]] = [L[j], L[i]];
        break;
      }
      default:
        return;
    }
    render();
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.act === 'show') {
      if (t.checked) st.hidden.delete(t.dataset.key);
      else st.hidden.add(t.dataset.key);
    } else if (t.id === 'pl-surface') st.surface = t.checked;
    else if (t.id === 'pl-cut') st.cut = t.checked;
    else if (t.id === 'pl-cutaway') st.cutAway = t.value;
    else if (t.id === 'pl-tol') {
      const v = Number(t.value);
      st.tolerance = v > 0 ? v : st.tolerance;
    } else if (t.dataset.act === 'lm-pick') {
      const id = t.dataset.id;
      const L = st.draft.landmarks;
      if (t.checked && !L.includes(id)) L.push(id);
      if (!t.checked) st.draft.landmarks = L.filter((x) => x !== id);
    } else if (t.id === 'pl-name') st.draft.name = t.value;
    else if (t.id === 'pl-desc') st.draft.description = t.value;
    else return;
    render();
  });

  function saveEdit() {
    const d = st.draft;
    if (st.editing === 'new') {
      const r = session.addPlane(d);
      if (r.error) {
        st.error = r.error;
        return render();
      }
      st.selected = r.id;
    } else {
      const err = session.updatePlane(st.editing, d);
      if (err) {
        st.error = err;
        return render();
      }
    }
    st.editing = null;
    st.error = null;
    render();
  }

  // A first guess for a midsagittal plane: landmarks without a left/right pair.
  function midlineGuess() {
    return session.template.landmarks.filter((d) => !d.bilateral_pair).map((d) => d.id).slice(0, 8);
  }

  // ---- Rendering -------------------------------------------------------------

  function statusOf(e) {
    if (e.error === 'too_few') {
      const ids = e.lacking.slice(0, 4).join(', ') + (e.lacking.length > 4 ? '…' : '');
      return { text: e.kind === 'template' && e.def.landmarks.length < 3 ? 'Needs at least three landmarks' : `Place ${ids} first`, bad: true };
    }
    if (e.error === 'collinear') return { text: 'Its points lie on one line', bad: true };
    const u = unitLabel(session.current.specimen.mesh?.units);
    if (e.exact) return { text: `Through ${e.kind === 'free' ? '3 clicked points' : '3 landmarks'}` };
    return { text: `Best fit through ${e.used.length}: RMS ${fmt(e.rms)} ${u}` };
  }

  function render() {
    const list = entries();
    if (st.selected && !list.some((e) => e.key === st.selected)) st.selected = null;
    const rec = session.current;
    const u = unitLabel(rec.specimen.mesh?.units);

    const rows = list
      .map((e) => {
        const s = statusOf(e);
        const sel = e.key === st.selected;
        const what = e.kind === 'template' ? esc(e.def.landmarks.join(' · ')) : 'clicked, not saved';
        const tools =
          e.kind === 'template'
            ? `<button type="button" class="icon-btn" data-act="edit" data-key="${esc(e.key)}" aria-label="Edit ${esc(e.def.name)}">✎</button>`
            : `<button type="button" class="icon-btn" data-act="remove-free" data-key="${esc(e.key)}" aria-label="Remove ${esc(e.def.name)}">×</button>`;
        return `<li class="plane-row${sel ? ' is-selected' : ''}">
          <button type="button" class="plane-main" data-act="select" data-key="${esc(e.key)}" aria-pressed="${sel}">
            <span class="swatch" style="background:${e.color}"></span>
            <span class="plane-text">
              <span class="plane-name">${esc(e.def.name)} <span class="mono muted">${e.kind === 'template' ? esc(e.key) : ''}</span></span>
              <span class="plane-sub">${what}</span>
              <span class="plane-sub ${s.bad ? 'bad' : ''}">${esc(s.text)}</span>
            </span>
          </button>
          <label class="plane-show" title="Show in the 3D view"><input type="checkbox" data-act="show" data-key="${esc(e.key)}"${st.hidden.has(e.key) ? '' : ' checked'}> Show</label>
          ${tools}
        </li>`;
      })
      .join('');

    const html = [];
    html.push(`<section aria-labelledby="pl-h">
      <h2 id="pl-h">Planes</h2>
      <p class="hint">A plane through landmarks is saved in the template, so it is the same on every specimen and moves when its landmarks move. Three landmarks give the plane through them; more give the best fit.</p>
      ${list.length ? `<ul class="plane-list">${rows}</ul>` : '<p class="hint">No planes yet.</p>'}
      ${st.picking
        ? `<div class="pick-box"><span>Click ${3 - st.picking.points.length} more point${3 - st.picking.points.length === 1 ? '' : 's'} on the surface.</span> <button type="button" class="btn small" data-act="pick-cancel">Cancel</button></div>`
        : `<div class="open-row">
            <button type="button" class="btn small" data-act="new"${session.template.landmarks.length >= 3 ? '' : ' disabled title="The template needs at least three landmarks"'}>+ Plane from landmarks</button>
            <button type="button" class="btn small" data-act="pick"${app.state.mesh ? '' : ' disabled title="Open the mesh first"'}>+ Plane from 3 clicks</button>
          </div>`}
    </section>`);

    if (st.editing) html.push(editorHtml());

    html.push(`<section aria-labelledby="pl-disp-h">
      <h2 id="pl-disp-h">Display</h2>
      <label class="toggle">Show plane surfaces <input type="checkbox" id="pl-surface"${st.surface ? ' checked' : ''}><span class="switch"></span></label>
      <label class="toggle">Show where planes cut the mesh <input type="checkbox" id="pl-cut"${st.cut ? ' checked' : ''}><span class="switch"></span></label>
      <label class="field-stack">Cut away (selected plane)
        <select id="pl-cutaway"${selectedEntry(list)?.plane ? '' : ' disabled'}>
          <option value="none"${st.cutAway === 'none' ? ' selected' : ''}>Show the whole mesh</option>
          <option value="front"${st.cutAway === 'front' ? ' selected' : ''}>Hide the side the plane faces (dark tint)</option>
          <option value="back"${st.cutAway === 'back' ? ' selected' : ''}>Hide the other side (light tint)</option>
        </select>
      </label>
    </section>`);

    html.push(distancesHtml(selectedEntry(list), u));
    // Re-rendering replaces the controls; keep the keyboard focus where it was.
    const f = document.activeElement;
    const sel = f && root.contains(f) ? focusSelector(f) : null;
    root.innerHTML = html.join('');
    if (sel) root.querySelector(sel)?.focus();
    schedule3D();
  }

  function editorHtml() {
    const d = st.draft;
    const isNew = st.editing === 'new';
    const lms = session.template.landmarks;
    const order = d.landmarks;
    return `<section class="plane-editor" aria-labelledby="pl-ed-h">
      <h2 id="pl-ed-h">${isNew ? 'New plane' : `Edit ${esc(st.editing)}`}</h2>
      <label class="field-stack">Name <input type="text" id="pl-name" value="${esc(d.name)}" placeholder="e.g. Midsagittal"></label>
      <div class="field-stack">Landmarks (at least three)
        <div class="lm-pick">${lms
          .map((l) => `<label class="lm-pick-item"><input type="checkbox" data-act="lm-pick" data-id="${esc(l.id)}"${order.includes(l.id) ? ' checked' : ''}> <span class="mono">${esc(l.id)}</span> ${esc(l.name)}</label>`)
          .join('')}</div>
      </div>
      ${order.length ? `<div class="field-stack">Order <span class="hint">The first three decide which side the plane faces.</span>
        <ol class="lm-order">${order
          .map((id, i) => `<li><span class="mono">${esc(id)}</span> ${esc(session.def(id)?.name || '')}
            <button type="button" class="icon-btn" data-act="lm-up" data-id="${esc(id)}" aria-label="Move ${esc(id)} up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-act="lm-down" data-id="${esc(id)}" aria-label="Move ${esc(id)} down"${i === order.length - 1 ? ' disabled' : ''}>↓</button></li>`)
          .join('')}</ol></div>` : ''}
      <label class="field-stack">Description <input type="text" id="pl-desc" value="${esc(d.description)}" placeholder="Optional"></label>
      ${st.error ? `<p class="tpl-err" style="margin:0" role="alert">${esc(st.error)}</p>` : ''}
      ${st.confirmDelete === st.editing
        ? `<div class="tpl-confirm" style="margin:0"><p class="confirm-text">Delete this plane from the template?</p>
            <div class="confirm-actions"><button type="button" class="btn danger small" data-act="delete-yes" data-key="${esc(st.editing)}">Delete</button>
            <button type="button" class="btn small" data-act="delete-no">Cancel</button></div></div>`
        : ''}
      <div class="open-row">
        <button type="button" class="btn primary small" data-act="save-edit">${isNew ? 'Add plane' : 'Save plane'}</button>
        <button type="button" class="btn small" data-act="cancel-edit">Cancel</button>
        ${isNew ? '' : `<button type="button" class="btn quiet" data-act="delete" data-key="${esc(st.editing)}">Delete plane…</button>`}
      </div>
    </section>`;
  }

  function distancesHtml(sel, u) {
    if (!sel) return `<section aria-labelledby="pl-dist-h"><h2 id="pl-dist-h">Distances</h2><p class="hint">Select a plane to see how far landmarks lie from it on this specimen.</p></section>`;
    if (!sel.plane) return `<section aria-labelledby="pl-dist-h"><h2 id="pl-dist-h">Distances to ${esc(sel.def.name)}</h2><p class="hint">${esc(statusOf(sel).text)}.</p></section>`;
    const pts = new Map(session.points.filter((p) => p.template_id !== null && p.status !== 'missing' && p.position).map((p) => [p.template_id, p]));
    const defining = new Set(sel.kind === 'template' ? sel.def.landmarks : []);
    const tol = st.tolerance;
    const dist = (id) => (pts.has(id) ? signedDistance(sel.plane, pts.get(id).position) : null);

    const midline = session.template.landmarks.filter((d) => !d.bilateral_pair && pts.has(d.id));
    const pairs = [];
    const seen = new Set();
    for (const d of session.template.landmarks) {
      if (!d.bilateral_pair || seen.has(d.id)) continue;
      seen.add(d.id).add(d.bilateral_pair);
      const o = session.def(d.bilateral_pair);
      if (o && (pts.has(d.id) || pts.has(o.id))) pairs.push([d, o]);
    }
    const fitLine = sel.exact
      ? 'The plane passes exactly through its three points.'
      : `Best fit: RMS ${fmt(sel.rms)} ${u}, largest ${fmt(sel.max)} ${u} (${esc(sel.used[sel.maxIndex].id)}).`;

    const midRows = midline
      .map((d) => {
        const v = dist(d.id);
        const off = Math.abs(v) > tol;
        return `<tr${off ? ' class="flag"' : ''}><td><span class="mono">${esc(d.id)}</span> ${esc(d.name)}${defining.has(d.id) ? ' <span class="chip def">plane</span>' : ''}</td>
          <td class="num">${fmt(v)}</td><td>${off ? '<span class="chip">off</span>' : ''}</td></tr>`;
      })
      .join('');
    const pairRows = pairs
      .map(([a, b]) => {
        const da = dist(a.id);
        const db = dist(b.id);
        if (da === null || db === null) return `<tr><td><span class="mono nowrap">${esc(a.id)} · ${esc(b.id)}</span></td><td class="num">${da === null ? '–' : fmt(da)}</td><td class="num">${db === null ? '–' : fmt(db)}</td><td class="num">–</td><td></td></tr>`;
        const diff = Math.abs(da + db); // mirror images have opposite signs
        const sameSide = da * db > 0;
        const off = diff > tol;
        return `<tr${off || sameSide ? ' class="flag"' : ''}><td><span class="mono nowrap">${esc(a.id)} · ${esc(b.id)}</span> ${esc(a.name.replace(/\s+[LR]$/, ''))}</td>
          <td class="num">${fmt(da)}</td><td class="num">${fmt(db)}</td><td class="num">${fmt(diff)}</td>
          <td>${sameSide ? '<span class="chip">same side</span>' : off ? '<span class="chip">uneven</span>' : ''}</td></tr>`;
      })
      .join('');

    return `<section aria-labelledby="pl-dist-h">
      <h2 id="pl-dist-h">Distances to ${esc(sel.def.name)}</h2>
      <p class="hint">${fitLine} Signed distances in ${u}: positive on the side the plane faces (dark tint).</p>
      <div class="field"><label class="field-label" for="pl-tol">Flag beyond<small>${u}</small></label>
        <input type="number" id="pl-tol" class="mono tps-missing" min="0" step="0.1" value="${tol}"></div>
      ${midline.length ? `<div class="table-wrap"><table class="data-table" id="pl-mid">
        <thead><tr><th>Midline landmark</th><th class="num">Distance</th><th></th></tr></thead><tbody>${midRows}</tbody></table></div>` : '<p class="hint">No midline landmarks (without a left/right pair) are placed yet.</p>'}
      ${pairs.length ? `<div class="table-wrap"><table class="data-table" id="pl-pairs">
        <thead><tr><th>Left/right pair</th><th class="num">First</th><th class="num">Second</th><th class="num">Mirror diff.</th><th></th></tr></thead><tbody>${pairRows}</tbody></table></div>
        <p class="hint">For a symmetric pair the two distances are equal and opposite, so their sum (the mirror difference) is close to 0.</p>` : ''}
    </section>`;
  }

  function focusSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = ['act', 'key', 'id'].filter((k) => el.dataset[k]).map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`);
    return parts.length ? parts.join('') : null;
  }

  // Switching specimen ends any picking.
  session.addEventListener('change', (e) => {
    if (e.detail.kind === 'switch' && st.picking) st.picking = null;
  });

  return { render, intercept, stageHint, update3D: schedule3D, state: st };
}
