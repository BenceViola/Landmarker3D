// Reading and writing Landmark JSON files (.lmk.json). Files are written as
// format 0.2.0 (curves included), 0.3.0 for replicates, 0.4.0 with planes;
// files up to 0.4 are read.
//
// Writing starts from the file that was opened, if any, so fields this app
// doesn't know about (curves, surfaces, extensions, extra keys) survive a
// save, as the spec requires ("readers ignore what they don't know").

import { FORMAT, checkTemplate } from './session.js';

export const APP = { name: 'landmarker', version: '0.1.0' };

const STATUSES = new Set(['placed', 'estimated', 'missing']);
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const clone = (o) => JSON.parse(JSON.stringify(o));

export class LandmarkFileError extends Error {}

// Landmark row order for exports: template.export_order if given, then any
// template landmarks it leaves out, in template order.
export function exportOrder(template) {
  return exportItems(template).filter((x) => x.kind === 'landmark').map((x) => x.id);
}

// Landmarks and curves in export order: template.export_order if given, then
// whatever it leaves out (landmarks first, then curves, in template order).
export function exportItems(template) {
  const items = [
    ...template.landmarks.map((d) => ({ kind: 'landmark', id: d.id, def: d })),
    ...(template.curves || []).map((c) => ({ kind: 'curve', id: c.id, def: c })),
  ];
  const byId = new Map(items.map((x) => [x.id, x]));
  const order = Array.isArray(template.export_order) ? [...new Set(template.export_order)].filter((id) => byId.has(id)) : [];
  const listed = new Set(order);
  return [...order.map((id) => byId.get(id)), ...items.filter((x) => !listed.has(x.id))];
}

// Template points in export order, then everything else (ad hoc) by id.
export function orderedPoints(template, points) {
  const order = exportOrder(template);
  const rank = new Map(order.map((id, i) => [id, i]));
  const key = (p) => (p.template_id !== null && rank.has(p.template_id) ? rank.get(p.template_id) : Infinity);
  return [...points].sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

function cleanPoint(p) {
  const out = clone(p);
  if (out.status === 'missing') {
    out.position = null;
    delete out.anchor;
    delete out.normal;
  }
  return out;
}

function cleanCurve(c) {
  const out = {};
  for (const [k, v] of Object.entries(c)) if (!k.startsWith('_')) out[k] = clone(v);
  if (out.status === 'missing') {
    out.control_points = [];
    out.points = [];
    delete out.length;
    delete out.sampling;
  }
  return out;
}

// The higher of two MAJOR.MINOR.PATCH strings; `b` wins if `a` is missing or malformed.
export function newerVersion(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x) return b;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
  return b;
}

// The mesh fields of `specimen.mesh`, from a loaded mesh ({ name, sha256,
// vertexCount, faceCount }) or from stored ones ({ file, sha256, ... }).
function meshFields(mesh, units) {
  return {
    file: mesh.file ?? mesh.name,
    sha256: mesh.sha256,
    units: units ?? mesh.units ?? 'mm',
    vertex_count: mesh.vertex_count ?? mesh.vertexCount,
    face_count: mesh.face_count ?? mesh.faceCount,
  };
}

/**
 * Build the file text. `base` is the parsed file that was opened (or last
 * saved). Template and points come from `template`/`points`, or from a
 * `session` (its current specimen). `replicate` > 1 makes it a replicate
 * file, which needs format 0.3.0 (spec: Replicates).
 */
export function buildLandmarkFile({
  session, template = session?.template, points = session?.points, curves = session?.current?.curves || [],
  mesh, units, specimenId, notes, operator, base, created, replicate = 1,
}) {
  const b = base ? clone(base) : {};

  const specimen = { ...(b.specimen || {}) };
  delete specimen.image;
  specimen.id = specimenId;
  if (notes) specimen.notes = notes;
  else delete specimen.notes;
  if (replicate > 1) specimen.replicate = replicate;
  else delete specimen.replicate;
  specimen.mesh = meshFields(mesh, units);
  // Unknown mesh fields from the opened file go after the known ones.
  for (const [k, v] of Object.entries(b.specimen?.mesh || {})) {
    if (!(k in specimen.mesh)) specimen.mesh[k] = v;
  }

  const provenance = {
    ...(b.provenance || {}),
    software: APP.name,
    software_version: APP.version,
    created: b.provenance?.created || created || stamp(),
    modified: stamp(),
  };
  if (operator) provenance.operator = operator;
  else delete provenance.operator;

  // Spec order first, then any other top-level keys from the opened file.
  // A file re-saved from a newer minor version keeps that version, since its
  // extra fields are kept too.
  let needed = FORMAT.version;
  if (replicate > 1) needed = newerVersion(needed, FORMAT.replicateVersion);
  if (template.planes?.length) needed = newerVersion(needed, FORMAT.planesVersion);
  const version = newerVersion(b.version, needed);
  const doc = {
    format: FORMAT.name,
    version,
    specimen: {
      id: specimen.id,
      ...(specimen.notes ? { notes: specimen.notes } : {}),
      ...(specimen.replicate ? { replicate: specimen.replicate } : {}),
      mesh: specimen.mesh,
      ...specimen,
    },
    template: clone(template),
    landmarks: orderedPoints(template, points).map(cleanPoint),
  };
  // Curves in template order, without the app's private fields (starting with _).
  const rank = new Map((template.curves || []).map((c, i) => [c.id, i]));
  const curveList = [...(curves || [])]
    .sort((x, y) => (rank.get(x.template_id) ?? 1e9) - (rank.get(y.template_id) ?? 1e9))
    .map(cleanCurve);
  // Curves of the opened file that aren't in the template are kept as they were.
  const extra = Array.isArray(b.curves) ? b.curves.filter((c) => !rank.has(c?.template_id ?? c?.id)) : [];
  if (curveList.length || b.curves) doc.curves = [...curveList, ...extra];
  for (const [k, v] of Object.entries(b)) {
    if (!(k in doc) && k !== 'provenance' && k !== 'extensions') doc[k] = v;
  }
  doc.provenance = provenance;
  if (b.extensions) doc.extensions = b.extensions;

  return { text: stringify(doc), doc };
}

// Pretty JSON, but with number arrays ([x, y, z], bary) kept on one line.
function stringify(doc) {
  return (
    JSON.stringify(doc, null, 2).replace(
      /\[\s+(-?[\d.eE+-]+(?:,\s+-?[\d.eE+-]+)*)\s+\]/g,
      (_, inner) => `[${inner.split(/,\s+/).join(', ')}]`
    ) + '\n'
  );
}

// Parse and check a landmark file. Throws LandmarkFileError with a message
// for the user; returns non-fatal problems in `warnings`.
export function parseLandmarkFile(text, name) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LandmarkFileError(`“${name}” isn’t valid JSON, so it can’t be a landmark file.`);
  }
  if (!doc || typeof doc !== 'object' || doc.format !== 'landmark-json') {
    throw new LandmarkFileError(`“${name}” is a JSON file, but not a landmark file (its "format" isn’t "landmark-json").`);
  }

  const warnings = [];
  const m = /^(\d+)\.(\d+)/.exec(String(doc.version || ''));
  if (!m) throw new LandmarkFileError(`“${name}” has no readable format version.`);
  const [ourMajor, ourMinor] = FORMAT.readVersion.split('.').map(Number);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== ourMajor) {
    throw new LandmarkFileError(
      `“${name}” uses format version ${doc.version}, which this app (format ${FORMAT.readVersion}) can’t read safely. Open it with a matching version of the app.`
    );
  }
  if (minor > ourMinor) {
    warnings.push(`It uses a newer format version (${doc.version}); fields this app doesn’t know are kept when you save.`);
  }

  if (doc.specimen?.image) {
    throw new LandmarkFileError(`“${name}” holds 2D landmarks on an image. This app works with 3D meshes only.`);
  }
  if (!doc.specimen?.mesh) {
    throw new LandmarkFileError(`“${name}” doesn’t say which mesh it belongs to (no "specimen.mesh").`);
  }

  const t = doc.template;
  if (!t || !Array.isArray(t.landmarks)) {
    if (t?.ref) {
      throw new LandmarkFileError(
        `“${name}” refers to a separate template file (${t.ref}) instead of including the template. Opening such files isn’t supported yet.`
      );
    }
    throw new LandmarkFileError(`“${name}” has no template.`);
  }
  const templateError = checkTemplate(t);
  if (templateError) throw new LandmarkFileError(templateError);
  const planeNote = cleanPlanes(t);
  if (planeNote) warnings.push(planeNote);
  const curveDefNote = cleanCurveDefs(t);
  if (curveDefNote) warnings.push(curveDefNote);
  const defIds = new Set();
  for (const d of t.landmarks) {
    if (!d || typeof d.id !== 'string' || !d.id || defIds.has(d.id)) {
      throw new LandmarkFileError(`The template in “${name}” has a landmark with a missing or repeated ID.`);
    }
    defIds.add(d.id);
    if (typeof d.name !== 'string' || !d.name) d.name = d.id;
  }

  const points = [];
  const seen = new Set();
  let skipped = 0;
  let unlinked = 0;
  for (const p of Array.isArray(doc.landmarks) ? doc.landmarks : []) {
    if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id) || !STATUSES.has(p.status)) {
      skipped++;
      continue;
    }
    const pt = clone(p);
    if (pt.status === 'missing') {
      pt.position = null;
    } else if (!(Array.isArray(pt.position) && pt.position.length === 3 && pt.position.every(Number.isFinite))) {
      skipped++;
      continue;
    }
    if (pt.template_id === undefined) pt.template_id = defIds.has(pt.id) ? pt.id : null;
    if (pt.template_id !== null && !defIds.has(pt.template_id)) {
      pt.template_id = null; // keep the point as an ad hoc point
      unlinked++;
    }
    seen.add(pt.id);
    points.push(pt);
  }
  const rep = doc.specimen.replicate;
  if (rep !== undefined && !(Number.isInteger(rep) && rep > 0)) {
    warnings.push(`Its replicate number (${JSON.stringify(rep)}) isn’t a whole number of 1 or more, so it is treated as replicate 1.`);
    delete doc.specimen.replicate;
  }
  if (skipped) warnings.push(`${skipped} landmark entr${skipped === 1 ? 'y was' : 'ies were'} unreadable and left out.`);
  if (unlinked) warnings.push(`${unlinked} point${unlinked === 1 ? '' : 's'} referred to landmarks not in the template and became ad hoc points.`);

  const curves = parseCurves(doc.curves, t, warnings);

  return { doc, template: clone(t), points, curves, warnings, name };
}

const isPos = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

// Curve entries of a file: kept when they belong to a template curve.
function parseCurves(list, t, warnings) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    warnings.push('Its "curves" isn’t a list, so its curves were left out.');
    return [];
  }
  const ids = new Set((t.curves || []).map((c) => c.id));
  const out = [];
  let dropped = 0;
  for (const c of list) {
    const tid = c?.template_id ?? c?.id;
    if (!c || typeof c.id !== 'string' || !ids.has(tid) || out.some((x) => x.template_id === tid)) {
      dropped++;
      continue;
    }
    const e = clone(c);
    e.template_id = tid;
    if (!STATUSES.has(e.status)) e.status = 'placed';
    e.control_points = (Array.isArray(e.control_points) ? e.control_points : []).filter((p) => p && isPos(p.position));
    e.points = (Array.isArray(e.points) ? e.points : []).filter((p) => p && isPos(p.position));
    out.push(e);
  }
  if (dropped) warnings.push(`${dropped} curve${dropped === 1 ? ' is' : 's are'} not in the template (or unreadable), so ${dropped === 1 ? 'it isn’t' : 'they aren’t'} shown; ${dropped === 1 ? 'it is' : 'they are'} kept in the file when you save.`);
  return out;
}

// Drop curve definitions that can't be used; fix ends naming unknown landmarks.
function cleanCurveDefs(t) {
  if (!t.curves) return null;
  const lm = new Set(t.landmarks.map((d) => d && d.id));
  const seen = new Set();
  let dropped = 0;
  let ends = 0;
  t.curves = t.curves.filter((c) => {
    if (!c || typeof c.id !== 'string' || !c.id || seen.has(c.id) || lm.has(c.id)) {
      dropped++;
      return false;
    }
    seen.add(c.id);
    if (typeof c.name !== 'string' || !c.name) c.name = c.id;
    for (const k of ['start', 'end']) {
      if (c[k] != null && !lm.has(c[k])) {
        delete c[k];
        ends++;
      }
    }
    return true;
  });
  if (!t.curves.length) delete t.curves;
  const parts = [];
  if (dropped) parts.push(`${dropped} curve definition${dropped === 1 ? ' was' : 's were'} unreadable and left out`);
  if (ends) parts.push(`${ends} curve end${ends === 1 ? '' : 's'} named landmarks not in the template and became free`);
  return parts.length ? parts.join('; ') + '.' : null;
}

// Drop plane definitions that can't be used; keep the rest. Returns a note, or null.
function cleanPlanes(t) {
  if (!t.planes) return null;
  const ids = new Set(t.landmarks.map((d) => d && d.id));
  let dropped = 0;
  let trimmed = 0;
  const seen = new Set();
  t.planes = t.planes.filter((p) => {
    const ok = p && typeof p.id === 'string' && p.id && !seen.has(p.id) && Array.isArray(p.landmarks);
    if (!ok) {
      dropped++;
      return false;
    }
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name) p.name = p.id;
    const kept = [...new Set(p.landmarks.filter((id) => ids.has(id)))];
    if (kept.length !== p.landmarks.length) trimmed++;
    p.landmarks = kept;
    return true;
  });
  if (!t.planes.length) delete t.planes;
  const parts = [];
  if (dropped) parts.push(`${dropped} plane${dropped === 1 ? ' was' : 's were'} unreadable and left out`);
  if (trimmed) parts.push(`${trimmed} plane${trimmed === 1 ? '' : 's'} named landmarks not in the template, which were removed from ${trimmed === 1 ? 'it' : 'them'}`);
  return parts.length ? parts.join('; ') + '.' : null;
}

// Do this file and this mesh belong together?
export function meshMatches(fileMesh, mesh) {
  if (!fileMesh || !mesh) return false;
  if (fileMesh.sha256 && mesh.sha256) return fileMesh.sha256.toLowerCase() === mesh.sha256.toLowerCase();
  return fileMesh.file === mesh.name && fileMesh.face_count === mesh.faceCount;
}
