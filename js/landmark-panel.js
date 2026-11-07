// The Landmarks tab: progress, the active landmark with its placement
// instructions and actions, and the list of all landmarks with their state.

import { ADHOC } from './session.js';

const STATE_WORDS = { todo: 'To do', placed: 'Placed', estimated: 'Estimated', missing: 'Missing' };

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const coord = (p) => p.position.map((n) => n.toFixed(2)).join(', ');

export class LandmarkPanel {
  constructor(root, session) {
    this.session = session;
    this.progressEl = root.querySelector('#lm-progress');
    this.activeEl = root.querySelector('#lm-active');
    this.listEl = root.querySelector('#lm-list');

    this.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (row) session.setActive(row.dataset.id);
    });

    this.activeEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = session.activeId;
      if (btn.dataset.act === 'missing') session.markMissing(id);
      if (btn.dataset.act === 'estimated') session.toggleEstimated(id);
      if (btn.dataset.act === 'clear') session.clear(id);
      if (btn.dataset.act === 'cancel-adhoc') session.setActive(session.nextTodo(null));
    });
    this.activeEl.addEventListener('change', (e) => {
      if (e.target.id === 'lm-note') session.setNote(session.activeId, e.target.value);
    });
  }

  render(kind) {
    this._renderProgress();
    this._renderActive();
    if (kind !== 'move') this._renderList(); // the list doesn't change while a marker is dragged
  }

  _renderProgress() {
    const c = this.session.counts();
    const done = c.placed + c.estimated + c.missing;
    const pct = c.total ? (done / c.total) * 100 : 0;
    const parts = [];
    if (c.estimated) parts.push(`${c.estimated} estimated`);
    if (c.missing) parts.push(`${c.missing} missing`);
    if (c.adhoc) parts.push(`${c.adhoc} ad hoc`);
    this.progressEl.innerHTML = `
      <div class="progress-line">
        <span><strong>${done}</strong> of ${c.total} done</span>
        <span class="muted">${esc(parts.join(' · '))}</span>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${done}">
        <span style="width:${pct.toFixed(1)}%"></span>
      </div>`;
  }

  _renderActive() {
    const s = this.session;
    const id = s.activeId;

    if (id === ADHOC) {
      this.activeEl.innerHTML = `
        <div class="active-card">
          <span class="eyebrow">Ad hoc point</span>
          <p class="active-hint">Click the mesh to add a point that isn’t in the template. It is exported after the template landmarks.</p>
          <div class="active-actions"><button type="button" class="btn small" data-act="cancel-adhoc">Cancel</button></div>
        </div>`;
      return;
    }

    if (!id) {
      const c = s.counts();
      this.activeEl.innerHTML = c.total
        ? `<div class="active-card is-done"><span class="eyebrow">All done</span>
             <p class="active-hint">Every landmark in the template is placed or marked missing. Select one in the list to change it.</p></div>`
        : `<div class="active-card is-done"><span class="eyebrow">No landmarks yet</span>
             <p class="active-hint">This template is empty. Add landmarks in the Template tab, or add an ad hoc point.</p></div>`;
      return;
    }

    const def = s.def(id);
    const p = s.point(id);
    const state = p?.status || 'todo';
    const eyebrow = state === 'todo' ? 'Next to place' : 'Selected';
    const hint = {
      todo: 'Click the mesh to place it.',
      placed: 'Drag the marker to move it, or click the mesh to place it again.',
      estimated: 'Drag the marker to move it, or click the mesh to place it again.',
      missing: 'Marked missing. Click the mesh if you can place it after all.',
    }[state];
    const pair = def?.bilateral_pair ? `<span class="pair">Pair: ${esc(def.bilateral_pair)}</span>` : '';

    this.activeEl.innerHTML = `
      <div class="active-card is-${state}">
        <span class="eyebrow">${eyebrow}</span>
        <div class="active-title">
          <span class="code">${esc(id)}</span>
          <span class="active-name">${esc(s.labelOf(id))}</span>
        </div>
        ${def?.description ? `<p class="active-desc">${esc(def.description)}</p>` : ''}
        <div class="active-state">
          <span class="dot is-${state}" aria-hidden="true"></span>
          <span>${STATE_WORDS[state]}</span>
          ${p?.position ? `<span class="coords">${coord(p)}</span>` : ''}
          ${pair}
        </div>
        <p class="active-hint">${hint}</p>
        <div class="active-actions">
          ${state !== 'missing' && def ? `<button type="button" class="btn small" data-act="missing" title="Shortcut: M">Missing</button>` : ''}
          ${p?.position ? `<button type="button" class="btn small${state === 'estimated' ? ' on' : ''}" data-act="estimated" aria-pressed="${state === 'estimated'}" title="Shortcut: E">Estimated</button>` : ''}
          ${p ? `<button type="button" class="btn small" data-act="clear" title="Shortcut: Delete">${def ? 'Clear' : 'Delete'}</button>` : ''}
        </div>
        ${p ? `<label class="note"><span class="visually-hidden">Note</span>
                 <input id="lm-note" type="text" placeholder="Note, e.g. broken, estimated from other side" value="${esc(p.note || '')}"></label>` : ''}
      </div>`;
  }

  _renderList() {
    const s = this.session;
    const rows = s.rows();
    const html = [];
    let adhocHeader = false;
    for (const r of rows) {
      if (!r.def && !adhocHeader) {
        html.push(`<li class="list-divider">Ad hoc points</li>`);
        adhocHeader = true;
      }
      const state = r.point?.status || 'todo';
      const active = r.id === s.activeId;
      html.push(`
        <li><button type="button" class="lm-row${active ? ' is-active' : ''}" data-id="${esc(r.id)}" aria-current="${active}">
          <span class="dot is-${state}" aria-hidden="true"></span>
          <span class="code">${esc(r.id)}</span>
          <span class="lm-name">${esc(s.labelOf(r.id))}</span>
          <span class="lm-state is-${state}">${STATE_WORDS[state]}</span>
        </button></li>`);
    }
    this.listEl.innerHTML = html.join('');
    // Keep the active row in view, but only when the selection changes.
    if (s.activeId !== this._scrolledTo) {
      this._scrolledTo = s.activeId;
      this.listEl.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    }
  }
}
