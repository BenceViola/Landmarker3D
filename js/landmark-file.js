// Reading and writing Landmark JSON files (.lmk.json), format v0.2.
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

// Row order for exports: template.export_order if given, then any template
// landmarks it leaves out, in template order.
export function exportOrder(template) {
  const ids = template.landmarks.map((d) => d.id);
  const known = new Set(ids);
  const order = Array.isArray(template.export_order)
    ? template.export_order.filter((id) => known.has(id))
    : [];
  const listed = new Set(order);
  return [...order, ...ids.filter((id) => !listed.has(id))];
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

// Build the file text. `base` is the parsed file that was opened (or last saved).
export function buildLandmarkFile({ session, mesh, units, specimenId, notes, operator, base, created }) {
  const b = base ? clone(base) : {};

  const specimen = { ...(b.specimen || {}) };
  delete specimen.image;
  specimen.id = specimenId;
  if (notes) specimen.notes = notes;
  else delete specimen.notes;
  specimen.mesh = {
    file: mesh.name,
    sha256: mesh.sha256,
    units,
    vertex_count: mesh.vertexCount,
    face_count: mesh.faceCount,
  };
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
  const doc = {
    format: FORMAT.name,
    version: FORMAT.version,
    specimen: {
      id: specimen.id,
      ...(specimen.notes ? { notes: specimen.notes } : {}),
      mesh: specimen.mesh,
      ...specimen,
    },
    template: clone(session.template),
    landmarks: orderedPoints(session.template, session.points).map(cleanPoint),
  };
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
  const [ourMajor, ourMinor] = FORMAT.version.split('.').map(Number);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== ourMajor) {
    throw new LandmarkFileError(
      `“${name}” uses format version ${doc.version}, which this app (format ${FORMAT.version}) can’t read safely. Open it with a matching version of the app.`
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
  if (skipped) warnings.push(`${skipped} landmark entr${skipped === 1 ? 'y was' : 'ies were'} unreadable and left out.`);
  if (unlinked) warnings.push(`${unlinked} point${unlinked === 1 ? '' : 's'} referred to landmarks not in the template and became ad hoc points.`);

  return { doc, template: clone(t), points, warnings, name };
}

// Do this file and this mesh belong together?
export function meshMatches(fileMesh, mesh) {
  if (!fileMesh || !mesh) return false;
  if (fileMesh.sha256 && mesh.sha256) return fileMesh.sha256.toLowerCase() === mesh.sha256.toLowerCase();
  return fileMesh.file === mesh.name && fileMesh.face_count === mesh.faceCount;
}
