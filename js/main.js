// Wires the page together: viewer, picking, markers, the specimen set and
// the five panel tabs (Landmarks, Template, Planes, Specimen, File).

import { Viewer } from './viewer.js';
import { Picker } from './picking.js';
import { Markers } from './markers.js';
import { attachInteraction } from './interaction.js';
import { Session, ADHOC, EXAMPLE_TEMPLATE } from './session.js';
import { LandmarkPanel } from './landmark-panel.js';
import { TemplateEditor } from './template-editor.js';
import { setupSpecimens } from './specimens.js';
import { setupStrip } from './specimen-strip.js';
import { setupSpecimenPanel } from './specimen-panel.js';
import { setupFiles } from './files-panel.js';
import { PlaneView } from './plane-view.js';
import { setupPlanesPanel } from './planes-panel.js';

const $ = (id) => document.getElementById(id);

const session = new Session(EXAMPLE_TEMPLATE);
const app = {
  session,
  state: { mesh: null }, // the loaded mesh on screen
  ui: { showMessage, showPrompt, clearMessage, setBusy, dialog },
  nextFrame,
  openMeshPicker: () => $('file-input').click(),
  renderAll: () => renderAll(),
  renderStrip: () => strip?.render(),
  renderStageHint: () => renderStageHint(),
};

// ---- 3D view -------------------------------------------------------------

let webgl = true;
try {
  app.viewer = new Viewer($('stage'));
  app.picker = new Picker(app.viewer);
  app.markers = new Markers(app.viewer, app.picker, session);
  app.planeView = new PlaneView(app.viewer);
  attachInteraction({ viewer: app.viewer, picker: app.picker, markers: app.markers, session, intercept: (hit) => planes?.intercept(hit) });
} catch (err) {
  console.error(err);
  webgl = false;
  showMessage('error', 'This browser could not start 3D graphics (WebGL). Try a recent version of Chrome, Edge, Firefox or Safari.');
}
const { viewer, picker, markers } = app;

function applyTheme() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim();
  if (viewer && color) viewer.setBackground(color);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---- Set, panels ---------------------------------------------------------

const specimens = webgl ? setupSpecimens(app) : null;
app.specimens = specimens;
const landmarkPanel = new LandmarkPanel($('tab-landmarks'), session);
const templateEditor = new TemplateEditor($('template-editor'), session);
const strip = specimens ? setupStrip($('strip'), { session, specimens, openMeshPicker: app.openMeshPicker }) : null;
const specimenPanel = specimens ? setupSpecimenPanel(app) : null;
const files = specimens ? setupFiles(app) : null;
const planes = webgl ? setupPlanesPanel(app, $('planes-panel')) : null;
app.planes = planes;

session.addEventListener('change', (e) => {
  const kind = e.detail.kind;
  // Another specimen became current (switching, undo, removing one): show it.
  if (specimens && !specimens.batch && session.current !== specimens.shown) {
    specimens.show(session.current);
    return; // show() renders everything when the mesh is on screen
  }
  markers?.sync();
  landmarkPanel.render(kind);
  if (kind === 'move') planes?.update3D();
  else planes?.render();
  if (kind !== 'move') {
    templateEditor.requestRender();
    strip?.render();
    specimenPanel?.render();
  }
  renderStageHint();
  renderUndo();
});

function renderAll() {
  markers?.sync();
  landmarkPanel.render();
  templateEditor.render();
  strip?.render();
  specimenPanel?.render();
  planes?.render();
  files?.renderStatus();
  renderStageHint();
  renderUndo();
}

function renderUndo() {
  $('undo-btn').disabled = !session.canUndo;
  $('redo-btn').disabled = !session.canRedo;
}

// The line at the top of the 3D view telling you what a click will do.
function renderStageHint() {
  const el = $('stage-hint');
  const rec = session.current;
  const id = session.activeId;
  if (!rec.specimen.mesh) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const planeHint = planes?.stageHint();
  if (planeHint && app.state.mesh) {
    el.innerHTML = planeHint;
  } else if (!app.state.mesh) {
    el.innerHTML = `<span class="verb">Open ${escapeHtml(rec.specimen.mesh.file)}</span> to see ${escapeHtml(rec.specimen.id)}`;
  } else if (id === ADHOC) {
    el.innerHTML = '<span class="verb">Click to add</span> an ad hoc point';
  } else if (!id) {
    el.innerHTML = session.template.landmarks.length
      ? '<span class="verb">All landmarks done</span>'
      : '<span class="verb">No landmarks</span> in the template';
  } else {
    const st = session.stateOf(id);
    const verb = st === 'todo' || st === 'missing' ? 'Click to place' : 'Drag to move';
    el.innerHTML = `<span class="verb">${verb}</span> <span class="code">${escapeHtml(id)}</span> ${escapeHtml(session.labelOf(id))}`;
  }
}

// Tabs
const tabs = [...document.querySelectorAll('[role="tab"]')];
tabs.forEach((tab) => tab.addEventListener('click', () => selectTab(tab)));
document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(next);
  next.focus();
});
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
}

// Landmark tab controls
$('undo-btn').addEventListener('click', () => session.undo());
$('redo-btn').addEventListener('click', () => session.redo());
$('adhoc-btn').addEventListener('click', () => session.setActive(ADHOC));
$('labels-toggle').addEventListener('change', (e) => markers?.setShowLabels(e.target.checked));
$('marker-size').addEventListener('input', (e) => markers?.setSizeFactor(Number(e.target.value)));

// ---- Opening files -------------------------------------------------------

const isMesh = (f) => /\.(stl|ply)$/i.test(f.name);
const isData = (f) => /\.(json|zip)$/i.test(f.name);

$('file-input').addEventListener('change', (e) => {
  const list = [...e.target.files];
  e.target.value = '';
  if (list.length) specimens?.openMeshFiles(list);
});
$('sample-btn').addEventListener('click', () => {
  if (files?.unsaved().length) {
    showPrompt({
      kind: 'note',
      text: 'The example replaces the specimens open now, and some have unsaved landmarks.',
      actions: [{ label: 'Open the example anyway', run: () => specimens.openSample() }, { label: 'Cancel', run: () => {} }],
    });
  } else {
    specimens?.openSample();
  }
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop').hidden = true;
});
// Drop meshes, landmark files and hand-in zips, in any mix: landmark files
// are read first, so the meshes find the specimens waiting for them.
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (!specimens) return;
  const dropped = [...(e.dataTransfer?.files || [])];
  const data = dropped.filter(isData);
  const meshes = dropped.filter(isMesh);
  const other = dropped.length - data.length - meshes.length;
  if (data.length) await files.openLandmarkFiles(data);
  if (meshes.length) await specimens.openMeshFiles(meshes);
  if (other) showMessage('note', `${other === 1 ? 'One file was' : `${other} files were`} ignored: only STL and PLY meshes, .lmk.json files and hand-in zips can be opened.`);
});

// ---- Display and views -----------------------------------------------------

$('smooth').addEventListener('change', async (e) => {
  if (!app.state.mesh) return;
  setBusy('Updating shading…');
  await nextFrame();
  viewer.setSmooth(e.target.checked);
  setBusy(null);
});
$('wireframe').addEventListener('change', (e) => viewer?.setWireframe(e.target.checked));
$('colors').addEventListener('change', (e) => viewer?.setVertexColors(e.target.checked));

document.querySelectorAll('[data-view]').forEach((btn) => btn.addEventListener('click', () => viewer?.viewFrom(btn.dataset.view)));
$('fit-btn').addEventListener('click', () => viewer?.fit());

$('copy-hash').addEventListener('click', async () => {
  const hash = session.current.specimen.mesh?.sha256;
  if (!hash) return;
  try {
    await navigator.clipboard.writeText(hash);
    flash($('copy-hash'), 'Copied');
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('hash'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    flash($('copy-hash'), 'Selected');
  }
});

// ---- Keyboard ------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const inField = e.target.closest('input, select, textarea');
  if ($('dialog').open) return;

  if (mod && !e.altKey && e.key.toLowerCase() === 'z' && !inField) {
    e.preventDefault();
    if (e.shiftKey) session.redo();
    else session.undo();
    return;
  }
  if (mod && !e.altKey && e.key.toLowerCase() === 'y' && !inField) {
    e.preventDefault();
    session.redo();
    return;
  }
  if (inField || mod || e.altKey) return;

  const id = session.activeId;
  switch (e.key) {
    case 'f': case 'F': viewer?.fit(); break;
    case 'h': case 'H': viewer?.viewFrom('home'); break;
    case 'm': case 'M': session.markMissing(id); break;
    case 'e': case 'E': session.toggleEstimated(id); break;
    case 'Delete': case 'Backspace': if (id && id !== ADHOC) session.clear(id); break;
    case 'n': case 'N': session.step(1); break;
    case 'p': case 'P': session.step(-1); break;
    case ']': if (session.records.length > 1) session.switchTo(session.neighbour(1).uid); break;
    case '[': if (session.records.length > 1) session.switchTo(session.neighbour(-1).uid); break;
    default: return;
  }
});

// ---- Messages, dialog, busy ----------------------------------------------

function showMessage(kind, text) {
  showPrompt({ kind, text, actions: [] });
}

// A message with buttons. Choosing one closes the message, then runs it.
function showPrompt({ kind, text, actions }) {
  const el = $('message');
  el.className = `message ${kind}`;
  el.replaceChildren();
  const p = document.createElement('p');
  p.textContent = text;
  el.appendChild(p);
  const row = document.createElement('div');
  row.className = 'message-actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small${a.primary ? ' primary' : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', () => {
      clearMessage();
      a.run();
    });
    row.appendChild(b);
  }
  if (!actions.length) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn small quiet-close';
    close.textContent = 'Dismiss';
    close.addEventListener('click', clearMessage);
    row.appendChild(close);
  }
  el.appendChild(row);
  el.hidden = false;
}

function clearMessage() {
  $('message').hidden = true;
}

// A modal dialog. `html` must already be escaped. Actions close the dialog
// unless `keepOpen` is set.
function dialog({ title, html, actions }) {
  const d = $('dialog');
  $('dialog-title').textContent = title;
  $('dialog-content').innerHTML = html;
  const row = $('dialog-actions');
  row.replaceChildren();
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn${a.primary ? ' primary' : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', () => {
      if (!a.keepOpen) d.close();
      a.run?.();
    });
    row.appendChild(b);
  }
  if (!d.open) d.showModal();
}

function setBusy(text) {
  $('busy').hidden = !text;
  $('busy-text').textContent = text || '';
}

function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// For the browser tests: the set as the app sees it.
window.__lmk = app;

// Start with the example mesh and template so the tool is never empty.
renderAll();
specimens?.openSample();
