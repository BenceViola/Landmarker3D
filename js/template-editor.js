// The Template tab: the landmarking protocol. Name the template, add
// landmarks (one at a time or a pasted list), rename them, write placement
// instructions, set bilateral pairs and change the order they are placed
// and exported in. Curves (semilandmarks spaced along a traced line) are
// listed after the landmarks, with their number of points and end landmarks.
//
// Edits are applied when a field is left (change event), so each one is a
// single undo step. A landmark's ID is locked once it has data, as the spec
// requires ("never changed once data exists").

import { esc } from './landmark-panel.js';
import { nPointsOf, MAX_CURVE_POINTS, pathOf } from './curves.js';

export class TemplateEditor {
  constructor(root, session) {
    this.root = root;
    this.session = session;
    this.errors = new Map(); // landmark id -> message
    this.open = new Set(); // ids whose details are expanded
    this.confirming = null; // id awaiting delete confirmation, or '*new*'

    root.addEventListener('change', (e) => this._onChange(e));
    root.addEventListener('click', (e) => this._onClick(e));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'tpl-new-name') {
        e.preventDefault();
        this._addOne();
      }
      if (e.key === 'Enter' && e.target.id === 'tpl-new-curve') {
        e.preventDefault();
        this._addCurve();
      }
    });
    root.addEventListener('toggle', (e) => {
      const id = e.target.dataset?.openKey || e.target.closest?.('[data-row]')?.dataset.row;
      if (!id || !e.target.matches('details')) return;
      if (e.target.open) this.open.add(id);
      else this.open.delete(id);
    }, true);
  }

  // Rendering waits a frame, so a Tab out of a field moves focus before the
  // inputs are rebuilt, and several changes in a row render once.
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    const s = this.session;
    const t = s.template;

    // Re-rendering replaces the inputs; put focus and caret back where they were.
    const focusId = document.activeElement && this.root.contains(document.activeElement)
      ? document.activeElement.id
      : null;
    const caret = focusId ? document.activeElement.selectionStart : null;
    const pending = this.root.querySelector('#tpl-new-name')?.value || '';
    const pendingCurve = this.root.querySelector('#tpl-new-curve')?.value || '';
    const bulk = this.root.querySelector('#tpl-bulk')?.value || '';
    const bulkOpen = this.root.querySelector('#tpl-bulk-box')?.open || false;

    const ids = t.landmarks.map((d) => d.id);
    const rows = t.landmarks.map((d, i) => this._row(d, i, ids)).join('');

    this.root.innerHTML = `
      <div class="tpl-meta">
        <label class="field-stack">Template name
          <input id="tpl-f-name" type="text" value="${esc(t.name)}" data-field="name">
        </label>
        <div class="tpl-meta-row">
          <label class="field-stack">Template ID
            <input id="tpl-f-id" type="text" class="mono" value="${esc(t.id)}" data-field="id">
          </label>
          <label class="field-stack">Version
            <input id="tpl-f-version" type="text" class="mono" value="${esc(t.version)}" data-field="version">
          </label>
        </div>
        <p class="hint tpl-dims"><span class="mono">dimensions: ${esc(t.dimensions ?? 3)}</span> · 3D landmarks on meshes. Templates for 2D images can’t be used here.</p>
      </div>

      <p class="hint">${t.landmarks.length
        ? `${t.landmarks.length} landmark${t.landmarks.length === 1 ? '' : 's'}, placed and exported in this order.`
        : 'No landmarks yet. Add the first one below.'}</p>

      <ol class="tpl-list">${rows}</ol>

      <div class="tpl-add">
        <label class="visually-hidden" for="tpl-new-name">New landmark name</label>
        <input id="tpl-new-name" type="text" placeholder="New landmark, e.g. Nasion" value="${esc(pending)}">
        <button type="button" class="btn" data-act="add">Add</button>
      </div>

      <details id="tpl-bulk-box" class="tpl-bulk"${bulkOpen ? ' open' : ''}>
        <summary>Add several at once</summary>
        <label class="visually-hidden" for="tpl-bulk">Landmark names, one per line</label>
        <textarea id="tpl-bulk" rows="5" placeholder="One name per line&#10;Nasion&#10;Bregma&#10;Lambda">${esc(bulk)}</textarea>
        <button type="button" class="btn" data-act="add-bulk">Add all</button>
      </details>

      <h2 class="tpl-h" id="tpl-curves-h">Curves</h2>
      <p class="hint">${s.curveDefs.length
        ? 'Traced along the surface; each gives a fixed number of semilandmarks, evenly spaced. Exported after the landmarks.'
        : 'A curve is traced by clicking along a ridge, suture or outline. It gives a fixed number of evenly spaced semilandmarks, optionally between two landmarks.'}</p>
      ${s.curveDefs.length ? `<ol class="tpl-list" aria-labelledby="tpl-curves-h">${s.curveDefs.map((c, i) => this._curveRow(c, i, ids)).join('')}</ol>` : ''}
      <div class="tpl-add">
        <label class="visually-hidden" for="tpl-new-curve">New curve name</label>
        <input id="tpl-new-curve" type="text" placeholder="New curve, e.g. Supraorbital margin" value="${esc(pendingCurve)}">
        <button type="button" class="btn" data-act="add-curve">Add curve</button>
      </div>

      <div class="tpl-danger">
        ${this.confirming === '*new*'
          ? `<p class="confirm-text">Start an empty template? This removes all ${t.landmarks.length} landmarks${s.curveDefs.length ? ` and ${s.curveDefs.length} curves` : ''} and every placed point. You can undo it.</p>
             <div class="confirm-actions">
               <button type="button" class="btn danger" data-act="new-yes">Start empty template</button>
               <button type="button" class="btn" data-act="cancel">Cancel</button>
             </div>`
          : `<button type="button" class="btn quiet" data-act="new">Start a new empty template…</button>`}
      </div>`;

    if (focusId) {
      const el = this.root.querySelector(`#${CSS.escape(focusId)}`);
      if (el) {
        el.focus();
        if (caret !== null && typeof el.setSelectionRange === 'function') {
          try { el.setSelectionRange(caret, caret); } catch { /* not a text field */ }
        }
      }
    }
  }

  _row(d, i, ids) {
    const s = this.session;
    const hasData = !!s.point(d.id);
    const key = encodeURIComponent(d.id);
    const err = this.errors.get(d.id);
    const pairOptions = ids
      .filter((id) => id !== d.id)
      .map((id) => `<option value="${esc(id)}"${d.bilateral_pair === id ? ' selected' : ''}>${esc(id)} · ${esc(s.def(id).name)}</option>`)
      .join('');

    const confirm = this.confirming === d.id
      ? `<div class="tpl-confirm">
           <p class="confirm-text">Delete ${esc(d.id)} ${esc(d.name)}${hasData ? ' and its placed point' : ''}?</p>
           <div class="confirm-actions">
             <button type="button" class="btn danger small" data-act="del-yes">Delete</button>
             <button type="button" class="btn small" data-act="cancel">Cancel</button>
           </div>
         </div>`
      : '';

    return `
      <li class="tpl-item${s.activeId === d.id ? ' is-active' : ''}" data-row="${esc(d.id)}">
        <div class="tpl-line">
          <span class="ord">${i + 1}</span>
          <label class="visually-hidden" for="tpl-id-${key}">ID of ${esc(d.name)}</label>
          <input id="tpl-id-${key}" class="tpl-id mono" type="text" value="${esc(d.id)}" data-edit="id"
            ${hasData ? 'readonly title="Locked: this landmark already has data"' : ''}>
          <label class="visually-hidden" for="tpl-name-${key}">Name of ${esc(d.id)}</label>
          <input id="tpl-name-${key}" class="tpl-name" type="text" value="${esc(d.name)}" data-edit="name">
          <div class="tpl-btns">
            <button type="button" class="icon-btn" data-act="up" aria-label="Move ${esc(d.id)} up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-act="down" aria-label="Move ${esc(d.id)} down"${i === ids.length - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-act="del" aria-label="Delete ${esc(d.id)}">×</button>
          </div>
        </div>
        ${err ? `<p class="tpl-err" role="alert">${esc(err)}</p>` : ''}
        ${confirm}
        <details class="tpl-more"${this.open.has(d.id) ? ' open' : ''}>
          <summary>${d.description ? esc(d.description) : 'Add placement instructions'}${d.bilateral_pair ? ` · pair ${esc(d.bilateral_pair)}` : ''}</summary>
          <label class="field-stack">Where to place it
            <textarea id="tpl-desc-${key}" rows="2" data-edit="description" placeholder="Shown to students while placing">${esc(d.description || '')}</textarea>
          </label>
          <label class="field-stack">Bilateral pair
            <select id="tpl-pair-${key}" data-edit="pair">
              <option value="">None</option>${pairOptions}
            </select>
          </label>
        </details>
      </li>`;
  }

  _curveRow(c, i, lmIds) {
    const s = this.session;
    const hasData = s.hasData(c.id);
    const key = encodeURIComponent(c.id);
    const err = this.errors.get(c.id);
    const n = nPointsOf(c);
    const options = (sel) =>
      `<option value="">Free (no landmark)</option>` +
      lmIds.map((id) => `<option value="${esc(id)}"${sel === id ? ' selected' : ''}>${esc(id)} · ${esc(s.def(id).name)}</option>`).join('');
    const geodesic = pathOf(c) === 'geodesic';
    const summary = `${n} points · ${c.closed ? 'closed loop' : `${c.start || 'free'} → ${c.end || 'free'}`} · ${geodesic ? 'along the surface' : 'straight lines'}${c.description ? ` · ${esc(c.description)}` : ''}`;
    const confirm = this.confirming === `curve:${c.id}`
      ? `<div class="tpl-confirm">
           <p class="confirm-text">Delete the curve ${esc(c.id)} ${esc(c.name)}${hasData ? ' and what was traced for it on every specimen' : ''}?</p>
           <div class="confirm-actions">
             <button type="button" class="btn danger small" data-act="cdel-yes">Delete</button>
             <button type="button" class="btn small" data-act="cancel">Cancel</button>
           </div>
         </div>`
      : '';
    const openKey = `curve:${c.id}`;
    return `
      <li class="tpl-item${s.activeId === c.id ? ' is-active' : ''}" data-crow="${esc(c.id)}">
        <div class="tpl-line">
          <span class="ord" aria-hidden="true">~</span>
          <label class="visually-hidden" for="tpl-cid-${key}">ID of ${esc(c.name)}</label>
          <input id="tpl-cid-${key}" class="tpl-id mono" type="text" value="${esc(c.id)}" data-cedit="id"
            ${hasData ? 'readonly title="Locked: this curve already has data"' : ''}>
          <label class="visually-hidden" for="tpl-cname-${key}">Name of ${esc(c.id)}</label>
          <input id="tpl-cname-${key}" class="tpl-name" type="text" value="${esc(c.name)}" data-cedit="name">
          <div class="tpl-btns">
            <button type="button" class="icon-btn" data-act="cup" aria-label="Move ${esc(c.id)} up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-act="cdown" aria-label="Move ${esc(c.id)} down"${i === s.curveDefs.length - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-act="cdel" aria-label="Delete ${esc(c.id)}">×</button>
          </div>
        </div>
        ${err ? `<p class="tpl-err" role="alert">${esc(err)}</p>` : ''}
        ${confirm}
        <details class="tpl-more" data-open-key="${esc(openKey)}"${this.open.has(openKey) ? ' open' : ''}>
          <summary>${summary}</summary>
          <label class="field-stack">Semilandmarks
            <input id="tpl-cn-${key}" type="number" min="1" max="${MAX_CURVE_POINTS}" step="1" value="${n}" data-cedit="n_points">
            <span class="hint">${c.closed ? 'Spread evenly around the loop.' : 'Not counting the end landmarks, which are exported once, as landmarks.'}</span>
          </label>
          <label class="field-stack">Path between the clicks
            <select id="tpl-cpath-${key}" data-cedit="path">
              <option value="geodesic"${geodesic ? ' selected' : ''}>Along the surface (shortest route)</option>
              <option value="euclidean"${geodesic ? '' : ' selected'}>Straight lines, pressed onto the surface</option>
            </select>
            <span class="hint">${geodesic
              ? 'Follows the surface between your clicks, even across grooves and thin bone.'
              : 'Quicker, but across thin bone or a deep groove it can jump to the other side. Click more points there.'}</span>
          </label>
          <label class="toggle">Closed loop (e.g. an orbit rim)
            <input type="checkbox" id="tpl-cclosed-${key}" data-cedit="closed"${c.closed ? ' checked' : ''}><span class="switch"></span>
          </label>
          ${c.closed ? '' : `
          <label class="field-stack">Starts on
            <select id="tpl-cstart-${key}" data-cedit="start">${options(c.start)}</select>
          </label>
          <label class="field-stack">Ends on
            <select id="tpl-cend-${key}" data-cedit="end">${options(c.end)}</select>
          </label>`}
          <label class="field-stack">How to trace it
            <textarea id="tpl-cdesc-${key}" rows="2" data-cedit="description" placeholder="Shown to students while tracing">${esc(c.description || '')}</textarea>
          </label>
        </details>
      </li>`;
  }

  _onChange(e) {
    const s = this.session;
    const cedit = e.target.dataset.cedit;
    if (cedit) {
      const id = e.target.closest('[data-crow]')?.dataset.crow;
      if (!id) return;
      const value = cedit === 'closed' ? e.target.checked : e.target.value;
      const error = s.updateCurveDef(id, { [cedit]: value });
      if (error) {
        this.errors.set(id, error);
        this.requestRender();
      } else {
        this.errors.delete(id);
        if (cedit === 'id') {
          const nid = e.target.value.trim();
          if (this.open.delete(`curve:${id}`)) this.open.add(`curve:${nid}`);
        }
      }
      return;
    }
    const field = e.target.dataset.field;
    if (field) {
      s.setTemplateField(field, e.target.value);
      return;
    }
    const edit = e.target.dataset.edit;
    const id = e.target.closest('[data-row]')?.dataset.row;
    if (!edit || !id) return;
    if (edit === 'pair') {
      s.setPair(id, e.target.value || null);
      return;
    }
    const error = s.updateDef(id, { [edit]: e.target.value });
    if (error) {
      this.errors.set(id, error);
      this.requestRender();
    } else {
      this.errors.delete(id);
      this.errors.delete(e.target.value.trim()); // in case the id itself changed
      if (edit === 'id' && this.open.delete(id)) this.open.add(e.target.value.trim());
    }
  }

  _onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const s = this.session;
    const id = btn.closest('[data-row]')?.dataset.row;
    const cid = btn.closest('[data-crow]')?.dataset.crow;
    switch (btn.dataset.act) {
      case 'cup': s.moveCurveDef(cid, -1); break;
      case 'cdown': s.moveCurveDef(cid, 1); break;
      case 'cdel': this.confirming = `curve:${cid}`; this.requestRender(); break;
      case 'cdel-yes': this.confirming = null; this.errors.delete(cid); s.removeCurveDef(cid); break;
      case 'add-curve': this._addCurve(); break;
      case 'up': s.moveDef(id, -1); break;
      case 'down': s.moveDef(id, 1); break;
      case 'del': this.confirming = id; this.requestRender(); break;
      case 'del-yes': this.confirming = null; this.errors.delete(id); s.removeDef(id); break;
      case 'new': this.confirming = '*new*'; this.requestRender(); break;
      case 'new-yes': this.confirming = null; this.errors.clear(); s.newTemplate(); break;
      case 'cancel': this.confirming = null; this.requestRender(); break;
      case 'add': this._addOne(); break;
      case 'add-bulk': {
        const box = this.root.querySelector('#tpl-bulk');
        const names = box.value.split(/\r?\n/);
        box.value = '';
        s.addDefs(names);
        break;
      }
    }
  }

  _addCurve() {
    const input = this.root.querySelector('#tpl-new-curve');
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    input.value = '';
    const id = this.session.addCurveDef(name);
    if (id) this.open.add(`curve:${id}`); // show its settings right away
    this.render();
    this.root.querySelector('#tpl-new-curve')?.focus();
  }

  _addOne() {
    const input = this.root.querySelector('#tpl-new-name');
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    input.value = '';
    this.session.addDefs([name]);
    this.root.querySelector('#tpl-new-name')?.focus();
  }
}
