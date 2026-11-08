// The landmarking session: a set of specimens sharing one template (what to
// place, in which order). Each specimen record holds its own points (where
// they were placed); `points` always means the current specimen's.
// Field names follow the Landmark JSON spec, so saving is a direct dump.
// Every change goes through this class, which keeps undo/redo snapshots of
// the whole set and fires a 'change' event the panels and markers listen to.

export const ADHOC = '+adhoc'; // active "landmark" meaning: the next click adds an ad hoc point

// Landmark JSON format. v0.2 added 2D image data; this app stays 3D, so its
// templates declare dimensions 3 and 2D templates are refused. v0.3 added the
// optional specimen.replicate: files are written as 0.2.0, or 0.3.0 for a
// replicate after the first, and files up to 0.3 are read.
// v0.4 added optional template.planes: a template with planes is written as 0.4.0.
export const FORMAT = {
  name: 'landmark-json',
  version: '0.2.0',
  replicateVersion: '0.3.0',
  planesVersion: '0.4.0',
  readVersion: '0.4.0',
};
export const DIMENSIONS = 3;

let uidCounter = 0;

/**
 * One specimen in the set. `specimen` mirrors the file's specimen object
 * (id, notes, replicate, mesh: { file, sha256, units, vertex_count,
 * face_count }); the rest is app state that is never saved as such.
 */
export function newRecord(fields = {}) {
  return {
    uid: ++uidCounter,
    specimen: { id: 'specimen' },
    points: [],
    file: null, // the mesh File, kept so the mesh can be read again after it is unloaded
    thumb: null, // small picture of the mesh, as a data URL
    isSample: false,
    order: null, // shuffled landmark ids for a replicate placed in random order
    base: null, // the file as last opened or saved; unknown fields are kept from it
    handle: null, // where Save writes again (browsers with a Save dialog)
    created: null,
    savedName: null,
    savedAt: null,
    action: null, // 'opened' | 'saved'
    dirty: false,
    ...fields,
  };
}

export const replicateOf = (rec) => {
  const n = rec.specimen?.replicate;
  return Number.isInteger(n) && n > 0 ? n : 1;
};

const MAX_UNDO = 200;
const ID_RE = /^[A-Za-z0-9_.-]+$/;

// Returns an error message if this app can't use the template, else null.
// `dimensions` defaults to 3 when absent (spec v0.2).
export function checkTemplate(template) {
  const dims = template?.dimensions ?? 3;
  if (dims === 2) {
    return `“${template.name || template.id || 'This template'}” is a 2D template for landmarking on images. This app places landmarks on 3D meshes, so it needs a template with "dimensions": 3.`;
  }
  if (dims !== 3) return `The template’s "dimensions" is ${JSON.stringify(dims)}; it must be 2 or 3.`;
  if (!Array.isArray(template.landmarks)) return 'The template has no "landmarks" list.';
  if (template.planes !== undefined && !Array.isArray(template.planes)) return 'The template’s "planes" isn’t a list.';
  return null;
}

export const EXAMPLE_TEMPLATE = {
  id: 'cranium-basic',
  name: 'Cranium, basic set (example)',
  version: '1.0',
  dimensions: 3,
  landmarks: [
    { id: 'LM01', name: 'Glabella', description: 'Most anterior midline point on the frontal bone, between the brow ridges.' },
    { id: 'LM02', name: 'Nasion', description: 'Midline point where the frontonasal suture meets the internasal suture.' },
    { id: 'LM03', name: 'Bregma', description: 'Junction of the coronal and sagittal sutures.' },
    { id: 'LM04', name: 'Lambda', description: 'Junction of the sagittal and lambdoid sutures.' },
    { id: 'LM05', name: 'Opisthocranion', description: 'Most posterior midline point of the vault, measured from glabella.' },
    { id: 'LM06', name: 'Basion', description: 'Midline point on the anterior margin of the foramen magnum.' },
    { id: 'LM07', name: 'Opisthion', description: 'Midline point on the posterior margin of the foramen magnum.' },
    { id: 'LM08', name: 'Prosthion', description: 'Most anterior point of the alveolar process between the upper central incisors.' },
    { id: 'LM09', name: 'Porion L', description: 'Uppermost point on the margin of the left external acoustic meatus.', bilateral_pair: 'LM10' },
    { id: 'LM10', name: 'Porion R', description: 'Uppermost point on the margin of the right external acoustic meatus.', bilateral_pair: 'LM09' },
    { id: 'LM11', name: 'Orbitale L', description: 'Lowest point on the inferior margin of the left orbit.', bilateral_pair: 'LM12' },
    { id: 'LM12', name: 'Orbitale R', description: 'Lowest point on the inferior margin of the right orbit.', bilateral_pair: 'LM11' },
    { id: 'LM13', name: 'Zygion L', description: 'Most lateral point on the left zygomatic arch.', bilateral_pair: 'LM14' },
    { id: 'LM14', name: 'Zygion R', description: 'Most lateral point on the right zygomatic arch.', bilateral_pair: 'LM13' },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class Session extends EventTarget {
  constructor(template) {
    super();
    const error = checkTemplate(template);
    if (error) throw new Error(error);
    this.template = clone(template);
    this.template.dimensions = DIMENSIONS;
    this.records = [newRecord()];
    this.current = this.records[0];
    this.undoStack = [];
    this.redoStack = [];
    this._pendingMove = null;
    this.activeId = this.nextTodo(null);
  }

  // The current specimen's points.
  get points() {
    return this.current.points;
  }
  set points(v) {
    this.current.points = v;
  }

  // ---- The set -------------------------------------------------------------

  record(uid) {
    return this.records.find((r) => r.uid === uid) || null;
  }

  // Add a specimen. `after` puts it right behind that record (replicates
  // stay next to their specimen). Adding or removing specimens clears undo.
  addRecord(fields = {}, { after = null } = {}) {
    const rec = newRecord(fields);
    const i = after ? this.records.indexOf(after) : -1;
    if (i >= 0) this.records.splice(i + 1, 0, rec);
    else this.records.push(rec);
    this._clearHistory();
    this._emit('set');
    return rec;
  }

  // Replace the whole set, e.g. when real meshes replace the example.
  replaceRecords(records, template = null) {
    if (template) {
      const error = checkTemplate(template);
      if (error) throw new Error(error);
      this.template = clone(template);
      this.template.dimensions = DIMENSIONS;
    }
    this.records = records.length ? records : [newRecord()];
    this.current = this.records[0];
    this.activeId = this.nextTodo(null);
    this._clearHistory();
    this._emit('set');
  }

  removeRecord(uid) {
    const i = this.records.findIndex((r) => r.uid === uid);
    if (i < 0) return;
    this.records.splice(i, 1);
    if (!this.records.length) this.records.push(newRecord());
    if (this.current.uid === uid) {
      this.current = this.records[Math.min(i, this.records.length - 1)];
      this.activeId = this.nextTodo(null);
    }
    this._clearHistory();
    this._emit('set');
  }

  // Make another specimen current. Not an undo step.
  switchTo(uid) {
    const rec = this.record(uid);
    if (!rec || rec === this.current) return false;
    this.endMove();
    this.current = rec;
    this.activeId = this.nextTodo(null);
    this._emit('switch');
    return true;
  }

  // The specimen `delta` places before or after the current one, wrapping round.
  neighbour(delta) {
    const n = this.records.length;
    const i = this.records.indexOf(this.current);
    return this.records[(i + delta + n) % n];
  }

  // Template landmarks done (placed, estimated or missing) on a specimen.
  progressOf(rec = this.current) {
    const ids = new Set(rec.points.filter((p) => p.template_id !== null).map((p) => p.template_id));
    const total = this.template.landmarks.length;
    const done = this.template.landmarks.filter((d) => ids.has(d.id)).length;
    return { done, total };
  }

  // Does any specimen have a point for this landmark id?
  hasData(id) {
    return this.records.some((r) => r.points.some((p) => p.id === id || p.template_id === id));
  }

  // ---- Reading -----------------------------------------------------------

  def(id) {
    return this.template.landmarks.find((d) => d.id === id) || null;
  }

  point(id) {
    return this.points.find((p) => p.id === id) || null;
  }

  // 'todo' when the template landmark has no entry yet (spec: "not yet done").
  stateOf(id) {
    return this.point(id)?.status || 'todo';
  }

  labelOf(id) {
    if (id === ADHOC) return 'Ad hoc point';
    return this.point(id)?.label || this.def(id)?.name || id;
  }

  // Template landmarks in placement order, then ad hoc points.
  rows() {
    const rows = this.template.landmarks.map((def, i) => ({
      id: def.id,
      def,
      point: this.point(def.id),
      order: i + 1,
    }));
    for (const p of this.points) {
      if (p.template_id === null) rows.push({ id: p.id, def: null, point: p, order: null });
    }
    return rows;
  }

  counts() {
    const c = { total: this.template.landmarks.length, placed: 0, estimated: 0, missing: 0, todo: 0, adhoc: 0 };
    for (const def of this.template.landmarks) c[this.stateOf(def.id)]++;
    c.adhoc = this.points.filter((p) => p.template_id === null).length;
    return c;
  }

  // Next template landmark without an entry, after `afterId`, wrapping round.
  // A replicate placed in random order follows its own shuffled order.
  nextTodo(afterId) {
    const known = new Set(this.template.landmarks.map((d) => d.id));
    const order = this.current.order?.filter((id) => known.has(id));
    const ids = order?.length === known.size ? order : [...known];
    if (!ids.length) return null;
    const start = afterId ? ids.indexOf(afterId) + 1 : 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[(start + k) % ids.length];
      if (!this.point(id)) return id;
    }
    return null;
  }

  // ---- Undo / redo ---------------------------------------------------------

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  // Undo and redo go back to the specimen the change was made on;
  // the event's `switched` says when that changed the current specimen.
  undo() {
    if (!this.canUndo) return;
    const before = this.current;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this._emit('undo', { switched: this.current !== before });
  }

  redo() {
    if (!this.canRedo) return;
    const before = this.current;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this._emit('redo', { switched: this.current !== before });
  }

  // The whole set: a template edit can change every specimen's points.
  _snapshot() {
    return JSON.stringify({
      template: this.template,
      points: this.records.map((r) => [r.uid, r.points]),
      current: this.current.uid,
      activeId: this.activeId,
    });
  }

  _restore(snapshot) {
    const s = JSON.parse(snapshot);
    this.template = s.template;
    for (const [uid, points] of s.points) {
      const rec = this.record(uid);
      if (rec) {
        rec.points = points;
        rec.dirty = true;
      }
    }
    this.current = this.record(s.current) || this.current;
    this.activeId = s.activeId;
  }

  _commit() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  _clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this._pendingMove = null;
  }

  _emit(kind, extra = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...extra } }));
  }

  // ---- Landmarks -----------------------------------------------------------

  setActive(id) {
    if (this.activeId === id) return;
    this.activeId = id;
    this._emit('active');
  }

  // Move the selection up or down the list (template landmarks, then ad hoc).
  step(delta) {
    const ids = this.rows().map((r) => r.id);
    if (!ids.length) return;
    const i = ids.indexOf(this.activeId);
    const next = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : (i + delta + ids.length) % ids.length;
    this.setActive(ids[next]);
  }

  // Place (or re-place) a landmark at a surface hit, then move on to the next to-do.
  place(id, hit) {
    if (!id || !hit) return null;
    this._commit();
    let p;
    if (id === ADHOC) {
      const n = this._nextAdhocNumber();
      p = { id: `AH${String(n).padStart(2, '0')}`, template_id: null, label: `Ad hoc ${n}`, status: 'placed' };
      this.points.push(p);
    } else {
      p = this.point(id);
      if (!p) {
        p = { id, template_id: this.def(id) ? id : null, status: 'placed' };
        this.points.push(p);
      }
    }
    if (p.status === 'missing') p.status = 'placed';
    Object.assign(p, hit, { placed_at: stamp() });
    this.activeId = this.nextTodo(id === ADHOC ? null : id);
    this._emit('place');
    return p.id;
  }

  // Dragging a marker: one undo step for the whole drag.
  beginMove() {
    this._pendingMove = this._snapshot();
  }

  moveTo(id, hit) {
    const p = this.point(id);
    if (!p || !hit) return;
    Object.assign(p, hit, { placed_at: stamp() });
    this._emit('move');
  }

  endMove() {
    if (!this._pendingMove) return;
    this.undoStack.push(this._pendingMove);
    this.redoStack = [];
    this._pendingMove = null;
    this._emit('commit');
  }

  markMissing(id) {
    if (!id || id === ADHOC) return;
    this._commit();
    let p = this.point(id);
    if (!p) {
      p = { id, template_id: this.def(id) ? id : null, status: 'missing' };
      this.points.push(p);
    }
    p.status = 'missing';
    p.position = null;
    delete p.anchor;
    delete p.normal;
    p.placed_at = stamp();
    if (this.activeId === id) this.activeId = this.nextTodo(id);
    this._emit('status');
  }

  // Toggle between placed and estimated (only for points that have a position).
  toggleEstimated(id) {
    const p = this.point(id);
    if (!p || !p.position) return;
    this._commit();
    p.status = p.status === 'estimated' ? 'placed' : 'estimated';
    this._emit('status');
  }

  // Remove a point. Template landmarks go back to "to do"; ad hoc points are deleted.
  clear(id) {
    const i = this.points.findIndex((p) => p.id === id);
    if (i < 0) return;
    this._commit();
    const [p] = this.points.splice(i, 1);
    this.activeId = p.template_id === null ? this.nextTodo(null) : id;
    this._emit('clear');
  }

  setNote(id, note) {
    const p = this.point(id);
    if (!p) return;
    const text = note.trim();
    if ((p.note || '') === text) return;
    this._commit();
    if (text) p.note = text;
    else delete p.note;
    this._emit('note');
  }

  // Replace the template and the current specimen's points with those from
  // an opened landmark file.
  load(template, points) {
    this.template = clone(template);
    this.template.dimensions = DIMENSIONS;
    this.points = clone(points);
    this._clearHistory();
    this.activeId = this.nextTodo(null);
    this._emit('load');
  }

  // Replace stored positions without an undo step (used when re-snapping to a mesh).
  replacePoint(id, fields) {
    const p = this.point(id);
    if (p) Object.assign(p, fields);
  }

  // Clear the current specimen's points and all history; keep the template.
  resetPoints() {
    this.points = [];
    this._clearHistory();
    this.activeId = this.nextTodo(null);
    this._emit('reset');
  }

  _nextAdhocNumber() {
    let n = 0;
    for (const p of this.points) {
      const m = /^AH(\d+)$/.exec(p.id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return n + 1;
  }

  // ---- Template ------------------------------------------------------------

  setTemplateField(field, value) {
    const v = value.trim();
    if ((this.template[field] || '') === v) return;
    this._commit();
    if (v) this.template[field] = v;
    else delete this.template[field];
    this._emit('template');
  }

  addDefs(names) {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (!clean.length) return;
    this._commit();
    let first = null;
    for (const name of clean) {
      const id = this._nextDefId();
      this.template.landmarks.push({ id, name });
      first ??= id;
    }
    if (!this.activeId) this.activeId = first;
    this._emit('template');
  }

  // Returns an error message, or null when the change was applied.
  updateDef(id, patch) {
    const def = this.def(id);
    if (!def) return null;
    let newId = id;
    if ('id' in patch) {
      newId = patch.id.trim();
      if (newId !== id) {
        if (!newId) return 'Every landmark needs an ID.';
        if (!ID_RE.test(newId)) return 'IDs can only use letters, digits, “-”, “_” and “.”.';
        if (this.def(newId) || this.plane(newId) || this.hasData(newId)) return `${newId} is already used.`;
        if (this.hasData(id)) return 'This landmark already has data, so its ID can’t change.';
      }
    }
    const name = 'name' in patch ? patch.name.trim() : def.name;
    if (!name) return 'Every landmark needs a name.';
    const description = 'description' in patch ? patch.description.trim() : def.description || '';
    if (newId === id && name === def.name && description === (def.description || '')) return null;

    this._commit();
    def.name = name;
    if (description) def.description = description;
    else delete def.description;
    if (newId !== id) {
      def.id = newId;
      for (const d of this.template.landmarks) if (d.bilateral_pair === id) d.bilateral_pair = newId;
      for (const pl of this.template.planes || []) pl.landmarks = pl.landmarks.map((x) => (x === id ? newId : x));
      if (this.activeId === id) this.activeId = newId;
    }
    this._emit('template');
    return null;
  }

  removeDef(id) {
    const i = this.template.landmarks.findIndex((d) => d.id === id);
    if (i < 0) return;
    this._commit();
    this.template.landmarks.splice(i, 1);
    for (const r of this.records) {
      const kept = r.points.filter((p) => p.template_id !== id);
      if (kept.length !== r.points.length) r.dirty = true;
      r.points = kept;
    }
    for (const d of this.template.landmarks) if (d.bilateral_pair === id) delete d.bilateral_pair;
    // A plane loses the landmark; with fewer than three it waits until more are chosen.
    for (const pl of this.template.planes || []) pl.landmarks = pl.landmarks.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = this.nextTodo(null);
    this._emit('template');
  }

  moveDef(id, delta) {
    const list = this.template.landmarks;
    const i = list.findIndex((d) => d.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    this._commit();
    [list[i], list[j]] = [list[j], list[i]];
    this._emit('template');
  }

  // Bilateral pairs are kept symmetric: setting A↔B clears any old partners.
  setPair(id, otherId) {
    const def = this.def(id);
    if (!def || otherId === id || (def.bilateral_pair || '') === (otherId || '')) return;
    this._commit();
    const unpair = (d) => {
      if (!d?.bilateral_pair) return;
      const partner = this.def(d.bilateral_pair);
      if (partner && partner.bilateral_pair === d.id) delete partner.bilateral_pair;
      delete d.bilateral_pair;
    };
    unpair(def);
    if (otherId) {
      const other = this.def(otherId);
      unpair(other);
      def.bilateral_pair = otherId;
      other.bilateral_pair = id;
    }
    this._emit('template');
  }

  newTemplate() {
    this._commit();
    this.template = { id: 'untitled', name: 'Untitled template', version: '1.0', dimensions: DIMENSIONS, landmarks: [] };
    for (const r of this.records) {
      if (r.points.length) r.dirty = true;
      r.points = [];
    }
    this.activeId = null;
    this._emit('template');
  }

  // ---- Planes (spec v0.4) ---------------------------------------------------
  // A plane is defined in the template by at least three landmarks; where it
  // lies is computed from their positions on each specimen (planes.js).

  plane(id) {
    return (this.template.planes || []).find((p) => p.id === id) || null;
  }

  // Returns { id } when added, or { error }.
  addPlane({ name, landmarks, description = '' }) {
    const error = this._checkPlane(name, landmarks);
    if (error) return { error };
    this._commit();
    const id = this._nextPlaneId();
    const pl = { id, name: name.trim(), landmarks: [...landmarks] };
    if (description.trim()) pl.description = description.trim();
    (this.template.planes ||= []).push(pl);
    this._emit('template');
    return { id };
  }

  // Returns an error message, or null when the change was applied.
  updatePlane(id, patch) {
    const pl = this.plane(id);
    if (!pl) return null;
    const name = 'name' in patch ? patch.name : pl.name;
    const landmarks = 'landmarks' in patch ? patch.landmarks : pl.landmarks;
    const description = ('description' in patch ? patch.description : pl.description || '').trim();
    const error = this._checkPlane(name, landmarks);
    if (error) return error;
    const same = name.trim() === pl.name && description === (pl.description || '') && landmarks.join() === pl.landmarks.join();
    if (same) return null;
    this._commit();
    pl.name = name.trim();
    pl.landmarks = [...landmarks];
    if (description) pl.description = description;
    else delete pl.description;
    this._emit('template');
    return null;
  }

  removePlane(id) {
    const list = this.template.planes || [];
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return;
    this._commit();
    list.splice(i, 1);
    if (!list.length) delete this.template.planes;
    this._emit('template');
  }

  _checkPlane(name, landmarks) {
    if (!name || !name.trim()) return 'Every plane needs a name.';
    if (!Array.isArray(landmarks) || new Set(landmarks).size !== landmarks.length) return 'Choose each landmark only once.';
    if (landmarks.length < 3) return 'A plane needs at least three landmarks.';
    const unknown = landmarks.find((id) => !this.def(id));
    if (unknown) return `${unknown} is not a landmark in this template.`;
    return null;
  }

  _nextPlaneId() {
    let n = 0;
    for (const p of this.template.planes || []) {
      const m = /^PL(\d+)$/.exec(p.id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    let id;
    do {
      n++;
      id = `PL${String(n).padStart(2, '0')}`;
    } while (this.def(id) || this.plane(id) || this.hasData(id));
    return id;
  }

  _nextDefId() {
    let n = 0;
    for (const d of this.template.landmarks) {
      const m = /^LM(\d+)$/.exec(d.id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    let id;
    do {
      n++;
      id = `LM${String(n).padStart(2, '0')}`;
    } while (this.def(id) || this.plane(id) || this.hasData(id));
    return id;
  }
}
