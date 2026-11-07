// The Template tab: the landmarking protocol. Name the template, add
// landmarks (one at a time or a pasted list), rename them, write placement
// instructions, set bilateral pairs and change the order they are placed
// and exported in.
//
// Edits are applied when a field is left (change event), so each one is a
// single undo step. A landmark's ID is locked once it has data, as the spec
// requires ("never changed once data exists").

import { esc } from './landmark-panel.js';

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
    });
    root.addEventListener('toggle', (e) => {
      const id = e.target.closest?.('[data-row]')?.dataset.row;
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

      <div class="tpl-danger">
        ${this.confirming === '*new*'
          ? `<p class="confirm-text">Start an empty template? This removes all ${t.landmarks.length} landmarks and every placed point. You can undo it.</p>
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

  _onChange(e) {
    const s = this.session;
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
    switch (btn.dataset.act) {
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
