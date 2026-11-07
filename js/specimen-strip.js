// The strip of specimens under the 3D view: a picture of each mesh, its ID,
// and how many landmarks are done (red until all are, then green).
// Click to switch; [ and ] switch from the keyboard.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function setupStrip(el, { session, specimens, openMeshPicker }) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'add') openMeshPicker();
    else if (b.dataset.uid) session.switchTo(Number(b.dataset.uid));
  });

  let lastCurrent = null;
  function render() {
    const recs = session.records;
    const hasRep = (r) => recs.some((x) => x !== r && x.specimen.id === r.specimen.id && specimens.shaOf(x) === specimens.shaOf(r));
    el.innerHTML =
      recs
        .map((r) => {
          const { done, total } = session.progressOf(r);
          const state = specimens.meshState(r);
          const pic = r.thumb
            ? `<img class="pic" src="${r.thumb}" alt="">`
            : `<span class="pic">${state === 'missing' && r.specimen.mesh ? `Open ${esc(r.specimen.mesh.file)}` : 'No mesh'}</span>`;
          const rep = hasRep(r) ? ` <span class="rep">r${specimens.replicateOf(r)}</span>` : '';
          const current = r === session.current;
          const label = `${r.specimen.id}${hasRep(r) ? ` replicate ${specimens.replicateOf(r)}` : ''}: ${done} of ${total} landmarks done${state === 'missing' ? ', mesh not open' : ''}`;
          return `<button type="button" class="thumb" data-uid="${r.uid}" aria-current="${current}" aria-label="${esc(label)}" title="${esc(label)}">
            ${pic}
            <span class="count${total && done === total ? ' done' : ''}" aria-hidden="true">${done}/${total}</span>
            <span class="cap">${esc(r.specimen.id)}${rep}</span>
          </button>`;
        })
        .join('') +
      `<button type="button" class="thumb add" data-act="add" title="Open more meshes">+ Add meshes</button>`;
    if (session.current !== lastCurrent) {
      lastCurrent = session.current;
      el.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  return { render };
}
