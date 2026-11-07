// Wires the page together: viewer, picking, markers, the landmark session
// and the three panel tabs (Landmarks, Template, Mesh).

import { Viewer } from './viewer.js';
import { Picker } from './picking.js';
import { Markers } from './markers.js';
import { attachInteraction } from './interaction.js';
import { Session, ADHOC, EXAMPLE_TEMPLATE } from './session.js';
import { LandmarkPanel } from './landmark-panel.js';
import { TemplateEditor } from './template-editor.js';
import { loadMeshFile, loadMeshBuffer, MeshLoadError } from './mesh-loader.js';
import { makeSampleStl } from './sample.js';
import { setupFiles } from './files-panel.js';

const $ = (id) => document.getElementById(id);

const state = { mesh: null, units: 'mm', isSample: false };
const session = new Session(EXAMPLE_TEMPLATE);
let viewer = null;
let picker = null;
let markers = null;

// ---- 3D view -------------------------------------------------------------

try {
  viewer = new Viewer($('stage'));
  picker = new Picker(viewer);
  markers = new Markers(viewer, picker, session);
  attachInteraction({ viewer, picker, markers, session });
} catch (err) {
  console.error(err);
  showMessage(
    'error',
    'This browser could not start 3D graphics (WebGL). Try a recent version of Chrome, Edge, Firefox or Safari.'
  );
}

function applyTheme() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim();
  if (viewer && color) viewer.setBackground(color);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

// ---- Panels --------------------------------------------------------------

const landmarkPanel = new LandmarkPanel($('tab-landmarks'), session);
const templateEditor = new TemplateEditor($('template-editor'), session);

const files = setupFiles({
  session,
  state,
  picker,
  ui: { showMessage, showPrompt, clearMessage },
  openMeshPicker: () => $('file-input').click(),
  setUnits(units) {
    state.units = units;
    $('units').value = units;
    renderInfo();
  },
  renderAll: () => renderAll(),
});

session.addEventListener('change', (e) => {
  const kind = e.detail.kind;
  markers?.sync();
  landmarkPanel.render(kind);
  if (kind !== 'move') templateEditor.requestRender();
  renderStageHint();
  $('undo-btn').disabled = !session.canUndo;
  $('redo-btn').disabled = !session.canRedo;
});

function renderAll() {
  markers?.sync();
  landmarkPanel.render();
  templateEditor.render();
  renderStageHint();
  $('undo-btn').disabled = !session.canUndo;
  $('redo-btn').disabled = !session.canRedo;
}

// The line at the top of the 3D view telling you what a click will do.
function renderStageHint() {
  const el = $('stage-hint');
  const id = session.activeId;
  if (!state.mesh) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (id === ADHOC) {
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

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) openFile(file);
  e.target.value = '';
});
$('sample-btn').addEventListener('click', () => files.guardUnsaved(openSample, 'Opening the example mesh'));

let dragDepth = 0;
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
// Drop a mesh, a landmark file, or a mesh and its landmark file together.
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const dropped = [...(e.dataTransfer?.files || [])];
  if (!dropped.length) return;
  const isLmk = (f) => /\.json$/i.test(f.name);
  const meshFile = dropped.find((f) => !isLmk(f));
  const lmkFile = dropped.find(isLmk);
  if (meshFile && lmkFile) {
    // The landmark file waits for the mesh and is applied when it has loaded.
    files.guardUnsaved(async () => {
      if (await files.queueLandmarkFile(lmkFile)) await loadMesh(meshFile);
    }, 'Opening the dropped files');
  } else if (lmkFile) {
    files.openLandmarkFile(lmkFile);
  } else {
    openFile(meshFile);
  }
  if (dropped.length > (meshFile && lmkFile ? 2 : 1)) {
    showMessage('note', 'Drop one mesh (and optionally its landmark file) at a time; the other files were ignored.');
  }
});

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

function openFile(file) {
  if (!viewer) return;
  files.guardUnsaved(() => loadMesh(file), `Opening “${file.name}”`);
}

async function loadMesh(file) {
  if (!viewer) return;
  clearMessage();
  setBusy(`Reading ${file.name}…`);
  try {
    await nextFrame();
    const mesh = await loadMeshFile(file);
    await show(mesh, false);
  } catch (err) {
    reportError(err, file.name);
  } finally {
    setBusy(null);
  }
}

async function openSample() {
  if (!viewer) return;
  clearMessage();
  try {
    const mesh = await loadMeshBuffer(makeSampleStl(), 'sample-pebble.stl');
    await show(mesh, true);
  } catch (err) {
    reportError(err, 'the sample');
  } finally {
    setBusy(null);
  }
}

function reportError(err, name) {
  if (!(err instanceof MeshLoadError)) console.error(err); // expected refusals are only shown
  if (err instanceof MeshLoadError) {
    showMessage('error', err.message);
  } else {
    showMessage('error', `Couldn’t read “${name}”. It may be damaged, or not a valid STL or PLY file.`);
  }
}

async function show(mesh, isSample) {
  setBusy(`Preparing ${int(mesh.faceCount)} triangles for picking…`);
  await nextFrame();

  state.mesh = mesh;
  state.isSample = isSample;
  $('colors').checked = mesh.hasColors;
  viewer.setGeometry(mesh.geometry, {
    smooth: $('smooth').checked,
    wireframe: $('wireframe').checked,
    vertexColors: mesh.hasColors,
  });
  picker.setGeometry(mesh.geometry);
  markers.setMeshSize(viewer.diagonal);

  // Landmarks belong to one specimen, so a new mesh starts a fresh set
  // (unsaved work was already guarded before the mesh was opened).
  session.resetPoints();
  renderInfo();
  renderAll();
  files.onMeshShown();
}

// ---- Display and views -----------------------------------------------------

$('smooth').addEventListener('change', async (e) => {
  if (!state.mesh) return;
  setBusy('Updating shading…');
  await nextFrame();
  viewer.setSmooth(e.target.checked);
  setBusy(null);
});
$('wireframe').addEventListener('change', (e) => viewer?.setWireframe(e.target.checked));
$('colors').addEventListener('change', (e) => viewer?.setVertexColors(e.target.checked));

document.querySelectorAll('[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => viewer?.viewFrom(btn.dataset.view))
);
$('fit-btn').addEventListener('click', () => viewer?.fit());

// ---- Keyboard ------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const inField = e.target.closest('input, select, textarea');

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
    case 'n': case 'N': case ']': session.step(1); break;
    case 'p': case 'P': case '[': session.step(-1); break;
    default: return;
  }
});

// ---- Mesh tab --------------------------------------------------------------

$('units').addEventListener('change', (e) => {
  state.units = e.target.value;
  renderInfo();
  files.markDirty();
});

$('copy-hash').addEventListener('click', async () => {
  const hash = state.mesh?.sha256;
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

function renderInfo() {
  const m = state.mesh;
  if (!m) return;
  const box = m.geometry.boundingBox;
  const size = box.max.clone().sub(box.min);
  const centre = box.min.clone().add(box.max).multiplyScalar(0.5);
  const u = unitLabel(state.units);

  for (const id of ['file-name', 'stage-file']) $(id).textContent = m.name;
  $('sample-tag').hidden = !state.isSample;
  $('format').textContent = m.format;
  $('faces').textContent = int(m.faceCount);
  $('vertices').textContent = int(m.vertexCount);
  $('extent').textContent = `${num(size.x)} × ${num(size.y)} × ${num(size.z)}${u}`;
  $('centre').textContent = `${num(centre.x)}, ${num(centre.y)}, ${num(centre.z)}`;
  $('size').textContent = bytes(m.sizeBytes);
  $('hash').textContent = m.sha256 || 'not available in this browser';
  $('copy-hash').hidden = !m.sha256;
  $('colors-row').hidden = !m.hasColors;
}

function unitLabel(units) {
  return { mm: ' mm', cm: ' cm', m: ' m', um: ' µm', unknown: '' }[units] ?? '';
}

// ---- Helpers -------------------------------------------------------------

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

const int = (n) => n.toLocaleString('en-US');
const num = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// Start with the example mesh and template so the tool is never empty.
renderAll();
openSample();
