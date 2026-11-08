// The Landmarks tab: progress, the active landmark (or curve) with its
// placement instructions and actions, and the list of all landmarks and
// curves with their state.

import { ADHOC } from './session.js';
import { nPointsOf } from './curves.js';

const STATE_WORDS = { todo: 'To do', partial: 'Started', placed: 'Placed', estimated: 'Estimated', missing: 'Missing' };
const fmtLen = (v) => (v >= 100 ? v.toFixed(1) : v.toFixed(2));
const unitWord = (u) => (u && u !== 'unknown' ? u.replace('um', 'µm') : 'units');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const coord = (p) => p.position.map((n) => n.toFixed(2)).join(', ');

export class LandmarkPanel {
  // `curveError(id)` says why a curve has no semilandmarks yet (curve-view.js).
  constructor(root, session, { curveError = () => null } = {}) {
    this.session = session;
    this.curveError = curveError;
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
      if (btn.dataset.act === 'undo-click') session.removeLastControlPoint(id);
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

    if (s.isCurve(id)) {
      this._renderCurve(id);
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

  _renderCurve(id) {
    const s = this.session;
    const def = s.curveDef(id);
    const c = s.curve(id);
    const state = s.stateOf(id);
    const clicks = c?.control_points?.length || 0;
    const n = nPointsOf(def);
    const got = c?.points?.length || 0;
    const units = unitWord(s.current.specimen.mesh?.units);
    const ends = def.closed
      ? 'A closed loop: click around it, the end joins the start.'
      : `It ${def.start ? `starts on ${def.start}` : 'has a free start'} and ${def.end ? `ends on ${def.end}` : 'a free end'}.`;
    const err = this.curveError(id);
    const problem =
      state !== 'missing' && (err?.code === 'start' || err?.code === 'end')
        ? `Place ${err.id} first: the curve ${err.code === 'start' ? 'starts' : 'ends'} there.`
        : null;
    const eyebrow = state === 'todo' ? 'Next to place · curve' : 'Selected curve';
    const hint = {
      todo: `Click points along it, in order. ${n} semilandmarks are then spread evenly along it.`,
      partial: `Keep clicking along it${def.closed ? ' (a loop needs at least three points)' : ''}.`,
      placed: 'Click to add points at the end, or drag a diamond to move one.',
      estimated: 'Click to add points at the end, or drag a diamond to move one.',
      missing: 'Marked missing. Click the mesh if you can trace it after all.',
    }[state];
    this.activeEl.innerHTML = `
      <div class="active-card is-${state === 'partial' ? 'todo' : state}">
        <span class="eyebrow">${eyebrow}</span>
        <div class="active-title">
          <span class="code">${esc(id)}</span>
          <span class="active-name">${esc(def.name)}</span>
        </div>
        ${def.description ? `<p class="active-desc">${esc(def.description)}</p>` : ''}
        <div class="active-state">
          <span class="dot is-${state === 'partial' ? 'todo' : state}" aria-hidden="true"></span>
          <span>${STATE_WORDS[state]}</span>
          <span class="coords" id="curve-summary">${clicks} click${clicks === 1 ? '' : 's'} · ${got} of ${n} points${got && c.length ? ` · ${fmtLen(c.length)} ${esc(units)} long` : ''}</span>
        </div>
        <p class="active-hint">${esc(ends)} ${hint}</p>
        ${problem ? `<p class="active-problem" role="status">${esc(problem)}</p>` : ''}
        <div class="active-actions">
          ${clicks ? `<button type="button" class="btn small" data-act="undo-click" title="Shortcut: Backspace">Remove last point</button>` : ''}
          ${state !== 'missing' ? `<button type="button" class="btn small" data-act="missing" title="Shortcut: M">Missing</button>` : ''}
          ${got ? `<button type="button" class="btn small${state === 'estimated' ? ' on' : ''}" data-act="estimated" aria-pressed="${state === 'estimated'}" title="Shortcut: E">Estimated</button>` : ''}
          ${c ? `<button type="button" class="btn small" data-act="clear" title="Shortcut: Delete">Clear curve</button>` : ''}
        </div>
        ${c ? `<label class="note"><span class="visually-hidden">Note</span>
                 <input id="lm-note" type="text" placeholder="Note, e.g. worn, traced on the other side" value="${esc(c.note || '')}"></label>` : ''}
      </div>`;
  }

  _renderList() {
    const s = this.session;
    const rows = s.rows();
    const html = [];
    let adhocHeader = false;
    let curveHeader = false;
    for (const r of rows) {
      if (r.kind === 'adhoc' && !adhocHeader) {
        html.push(`<li class="list-divider">Ad hoc points</li>`);
        adhocHeader = true;
      }
      if (r.kind === 'curve' && !curveHeader) {
        html.push(`<li class="list-divider">Curves</li>`);
        curveHeader = true;
      }
      const state = s.stateOf(r.id);
      const active = r.id === s.activeId;
      html.push(`
        <li><button type="button" class="lm-row${active ? ' is-active' : ''}" data-id="${esc(r.id)}" aria-current="${active}">
          <span class="dot is-${state === 'partial' ? 'todo' : state}" aria-hidden="true"></span>
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
