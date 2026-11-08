// The specimen set on screen: opening meshes into the set, showing the
// current specimen, and keeping at most three meshes in memory.
//
// A specimen (session record) knows its mesh by SHA-256. The mesh itself is
// either loaded (in the MeshStore), or can be read again from the File the
// student opened, or isn't available yet (a specimen opened from a landmark
// file or hand-in, waiting for its mesh).

import { newRecord, replicateOf, recordHasData } from './session.js';
import { MeshStore } from './mesh-store.js';
import { loadMeshFile, loadMeshBuffer, MeshLoadError } from './mesh-loader.js';
import { makeSampleStl } from './sample.js';

const stem = (name) => name.replace(/\.(stl|ply)$/i, '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function meshInfo(mesh, units = 'mm') {
  return { file: mesh.name, sha256: mesh.sha256, units, vertex_count: mesh.vertexCount, face_count: mesh.faceCount };
}

export function setupSpecimens(app) {
  const { session, viewer, picker, markers, ui } = app;
  const store = new MeshStore();
  let shown = null; // the record whose mesh (or empty view) is on screen
  let token = 0;
  let batch = false; // opening files: the viewer is busy with thumbnails

  const shaOf = (rec) => rec?.specimen.mesh?.sha256 || null;
  const hiddenInThumbnails = () => [markers.group, app.curveView?.group, app.planeView?.group, app.planeView?.pickGroup].filter(Boolean);
  const sampleOnly = () => session.records.every((r) => r.isSample || (!r.specimen.mesh && !recordHasData(r)));

  // Is this specimen's mesh in memory, or can it be read again?
  const meshState = (rec) => {
    const sha = shaOf(rec);
    if (sha && store.has(sha)) return 'loaded';
    if (rec.file) return 'file';
    return 'missing';
  };

  const displayOptions = () => ({
    smooth: document.getElementById('smooth').checked,
    wireframe: document.getElementById('wireframe').checked,
  });

  // Put a loaded mesh on screen (without picking, which needs its BVH).
  function display(entry, view = null) {
    viewer.setGeometry(entry.mesh.geometry, {
      displayCache: entry.displayCache,
      view,
      ...displayOptions(),
      vertexColors: entry.mesh.hasColors && document.getElementById('colors').checked,
    });
  }

  // Show the current specimen: from memory, by reading its file again, or
  // an empty view when its mesh isn't open.
  async function show(rec = session.current) {
    const my = ++token;
    if (shown && shown !== rec && viewer.box) shown.view = viewer.getView();
    const sha = shaOf(rec);
    let entry = sha ? store.get(sha) : null;

    if (!entry && rec.file) {
      ui.setBusy(`Reading ${rec.file.name}…`);
      await app.nextFrame();
      try {
        const mesh = await loadMeshFile(rec.file);
        if (mesh.sha256 !== sha) {
          mesh.geometry.dispose();
          forgetFile(rec);
          ui.showMessage('error', `${rec.file?.name || 'The mesh file'} has changed since it was opened. Open it again to see ${rec.specimen.id}.`);
        } else {
          store.put(mesh, [shaOf(session.current)]);
          entry = store.get(sha);
        }
      } catch (err) {
        if (!(err instanceof MeshLoadError)) console.error(err);
        const name = rec.file?.name;
        forgetFile(rec);
        ui.showMessage('error', `Couldn’t read ${name} again. It may have been moved or deleted; open it again to see ${rec.specimen.id}.`);
      }
      if (my !== token) return ui.setBusy(null);
    }

    if (entry) {
      if (!entry.mesh.geometry.boundsTree) {
        ui.setBusy(`Preparing ${entry.mesh.faceCount.toLocaleString('en-US')} triangles for picking…`);
        await app.nextFrame();
        if (my !== token) return;
      }
      display(entry, rec.view);
      picker.setGeometry(entry.mesh.geometry);
      markers.setMeshSize(viewer.diagonal);
      app.curveView?.setMeshSize(viewer.diagonal);
      app.state.mesh = entry.mesh;
    } else {
      viewer.clear();
      picker.clear();
      app.state.mesh = null;
    }
    shown = rec;
    ui.setBusy(null);
    app.renderAll();
  }

  // Replicates share the mesh file, so forgetting it affects all of them.
  function forgetFile(rec) {
    const sha = shaOf(rec);
    for (const r of session.records) if (r === rec || (sha && shaOf(r) === sha)) r.file = null;
  }

  // A specimen ID not used by another specimen (replicates share theirs).
  function uniqueId(id, sha) {
    const taken = (x) => session.records.some((r) => !r.isSample && r.specimen.id === x && shaOf(r) !== sha);
    if (!taken(id)) return id;
    for (let k = 2; ; k++) if (!taken(`${id}_${k}`)) return `${id}_${k}`;
  }

  // Add a specimen; the example makes way for real specimens.
  function addSpecimen(fields, opts) {
    if (sampleOnly()) {
      for (const r of session.records) if (shaOf(r)) store.remove(shaOf(r));
      const rec = newRecord(fields);
      session.replaceRecords([rec]);
      return rec;
    }
    return session.addRecord(fields, opts);
  }

  /**
   * Open meshes. Each becomes a specimen, or gives a waiting specimen (from
   * a landmark file) its mesh: matched by SHA-256, or by file name when the
   * contents differ, in which case the points are moved onto the new mesh.
   */
  async function openMeshFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    ui.clearMessage();
    batch = true;
    const added = [];
    const notes = [];
    let already = 0;
    let firstSha = null;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      ui.setBusy(`Reading ${f.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}…`);
      await app.nextFrame();
      let mesh;
      try {
        mesh = await loadMeshFile(f);
      } catch (err) {
        if (!(err instanceof MeshLoadError)) console.error(err);
        notes.push(err instanceof MeshLoadError ? err.message : `Couldn’t read “${f.name}”. It may be damaged, or not a valid STL or PLY file.`);
        continue;
      }
      const sha = mesh.sha256;
      let targets = session.records.filter((r) => !r.isSample && shaOf(r) === sha);
      if (targets.some((r) => r.file || store.has(sha))) {
        already++;
        mesh.geometry.dispose();
        continue;
      }
      let snapped = null;
      if (!targets.length) {
        const byName = session.records.filter((r) => !r.isSample && !r.file && !store.has(shaOf(r)) && r.specimen.mesh?.file === f.name);
        if (byName.length) {
          targets = byName;
          snapped = byName;
        }
      }
      if (targets.length) {
        for (const t of targets) {
          t.file = f;
          if (snapped) {
            t.specimen.mesh = { ...meshInfo(mesh, t.specimen.mesh.units), ...extraMeshFields(t.specimen.mesh) };
            t.dirty = true;
          }
        }
      } else {
        const id = uniqueId(stem(f.name), sha);
        targets = [addSpecimen({ specimen: { id, mesh: meshInfo(mesh) }, file: f })];
      }
      firstSha ??= sha;
      store.put(mesh, [firstSha]);
      const entry = store.get(sha);

      // A picture for the strip, taken from the default view.
      display(entry);
      const thumb = viewer.capture(128, 96, hiddenInThumbnails());
      for (const t of targets) t.thumb = thumb;

      if (snapped) {
        picker.setGeometry(mesh.geometry);
        const { count, max } = snapPoints(snapped);
        const u = snapped[0].specimen.mesh.units;
        notes.push(
          `${f.name} isn’t the same file ${snapped[0].specimen.id} was landmarked on (its contents differ). ` +
          `${plural(count, 'point')} moved onto it; the largest move was ${max.toFixed(3)} ${u && u !== 'unknown' ? u.replace('um', 'µm') : 'units'}. Check them before saving.`
        );
      }
      added.push(targets[0]);
    }

    ui.setBusy(null);
    shown = null; // the viewer was used for thumbnails
    batch = false;
    if (added.length) {
      if (!session.switchTo(added[0].uid)) await show(session.current);
    } else {
      await show(session.current);
    }

    let msg = '';
    const waiting = session.records.filter((r) => meshState(r) === 'missing' && r.specimen.mesh);
    if (files.length > 1 && added.length) msg = `Opened ${plural(added.length, 'mesh', 'meshes')}.`;
    if (already) msg += ` ${plural(already, 'mesh was', 'meshes were')} already open.`;
    if (waiting.length && added.length) msg += ` Still waiting for ${waiting.length === 1 ? waiting[0].specimen.mesh.file : plural(waiting.length, 'mesh', 'meshes')}.`;
    if (notes.length) msg += ' ' + notes.join(' ');
    if (msg.trim()) ui.showMessage(notes.length ? 'note' : 'note', msg.trim());
  }

  // Move every point of these specimens onto the mesh now in the picker.
  function snapPoints(records) {
    let count = 0;
    let max = 0;
    for (const r of records) {
      for (const p of r.points) {
        if (!p.position) continue;
        const s = picker.snap(p.position);
        if (!s) continue;
        Object.assign(p, s.fields);
        count++;
        max = Math.max(max, s.distance);
      }
      // Curve control points too; the semilandmarks are recomputed from them.
      for (const c of r.curves || []) {
        for (const cp of c.control_points || []) {
          const s = picker.snap(cp.position);
          if (!s) continue;
          cp.position = s.fields.position;
          if (s.fields.anchor) cp.anchor = s.fields.anchor;
          max = Math.max(max, s.distance);
        }
      }
    }
    return { count, max };
  }

  async function openSample() {
    ui.clearMessage();
    batch = true;
    try {
      const mesh = await loadMeshBuffer(makeSampleStl(), 'sample-pebble.stl');
      store.clear();
      const rec = newRecord({ isSample: true, specimen: { id: 'sample', mesh: meshInfo(mesh) } });
      store.put(mesh);
      session.replaceRecords([rec]);
      shown = null;
      display(store.get(mesh.sha256));
      rec.thumb = viewer.capture(128, 96, hiddenInThumbnails());
      batch = false;
      await show(rec);
    } catch (err) {
      console.error(err);
      ui.showMessage('error', 'Couldn’t create the example mesh.');
    } finally {
      batch = false;
    }
  }

  // Unload a specimen's mesh if no other specimen uses it.
  function release(rec) {
    const sha = shaOf(rec);
    if (sha && !session.records.some((r) => r !== rec && shaOf(r) === sha)) store.remove(sha);
  }

  return {
    store,
    show,
    openMeshFiles,
    openSample,
    addSpecimen,
    uniqueId,
    sampleOnly,
    meshState,
    release,
    snapPoints,
    shaOf,
    get shown() {
      return shown;
    },
    get batch() {
      return batch;
    },
    replicateOf,
  };
}

// Mesh fields other than the ones this app writes (kept on save).
function extraMeshFields(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (!['file', 'sha256', 'units', 'vertex_count', 'face_count'].includes(k)) out[k] = v;
  }
  return out;
}
