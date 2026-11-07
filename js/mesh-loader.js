// Reads STL and PLY files into three.js geometry, with the facts the
// landmark file records about the mesh: raw vertex and face counts and a
// SHA-256 of the file. Files are read locally and never uploaded.
//
// v0.1 accepts triangle meshes only. PLYLoader silently splits quads and
// polygons into triangles, which would shift the face numbering that
// landmark anchors rely on, so such files are refused instead.

import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

export class MeshLoadError extends Error {}

export async function loadMeshFile(file) {
  const buffer = await file.arrayBuffer();
  return loadMeshBuffer(buffer, file.name);
}

export async function loadMeshBuffer(buffer, name) {
  const ext = name.toLowerCase().split('.').pop();
  let parsed;
  if (ext === 'stl') parsed = parseStl(buffer, name);
  else if (ext === 'ply') parsed = parsePly(buffer, name);
  else {
    throw new MeshLoadError(
      `“${name}” is not an STL or PLY file. Choose a file ending in .stl or .ply.`
    );
  }
  const sha256 = await hashBuffer(buffer);
  return { name, sizeBytes: buffer.byteLength, sha256, ...parsed };
}

function parseStl(buffer, name) {
  const binary = isBinaryStl(buffer);
  let geometry;
  try {
    // STLLoader reads the binary header at byte 80, so very short files throw.
    geometry = new STLLoader().parse(buffer);
  } catch {
    throw new MeshLoadError(`“${name}” isn’t a readable STL file. It may be empty or damaged.`);
  }
  const faceCount = geometry.attributes.position.count / 3;
  if (!faceCount) {
    throw new MeshLoadError(`“${name}” contains no triangles.`);
  }
  return {
    geometry,
    format: binary ? 'STL, binary' : 'STL, ASCII',
    faceCount,
    // Raw count as stored in the file: STL has no shared vertices.
    vertexCount: faceCount * 3,
    hasColors: false,
  };
}

function isBinaryStl(buffer) {
  if (buffer.byteLength < 84) return false;
  const n = new DataView(buffer).getUint32(80, true);
  return 84 + n * 50 === buffer.byteLength;
}

function parsePly(buffer, name) {
  const header = readPlyHeader(buffer);
  if (!header) {
    throw new MeshLoadError(`“${name}” is not a readable PLY file: its header is missing or damaged.`);
  }
  if (!header.faceCount) {
    throw new MeshLoadError(
      `“${name}” is a point cloud: it has ${fmt(header.vertexCount)} points but no faces. ` +
        'Landmarks are placed on a surface, so export it as a triangle mesh and load it again.'
    );
  }

  const geometry = new PLYLoader().parse(buffer);
  const triangles = geometry.index
    ? geometry.index.count / 3
    : geometry.attributes.position.count / 3;

  if (triangles > header.faceCount) {
    throw new MeshLoadError(
      `“${name}” has faces with more than three corners (quads or polygons). ` +
        'This version only opens triangle meshes, so that landmark positions can be tied to ' +
        'the file’s own faces. Triangulate the mesh first (MeshLab and Blender both can) and load it again.'
    );
  }
  if (triangles < header.faceCount) {
    throw new MeshLoadError(
      `“${name}” lists ${fmt(header.faceCount)} faces, but only ${fmt(triangles)} could be read. ` +
        'The file may be damaged or contain faces with fewer than three corners.'
    );
  }

  return {
    geometry,
    format: `PLY, ${header.format.replaceAll('_', ' ')}`,
    faceCount: header.faceCount,
    vertexCount: header.vertexCount,
    hasColors: !!geometry.attributes.color,
  };
}

function readPlyHeader(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
  const text = new TextDecoder('latin1').decode(bytes);
  if (!text.startsWith('ply')) return null;
  const end = text.indexOf('end_header');
  if (end < 0) return null;

  const header = { format: 'unknown', vertexCount: 0, faceCount: 0 };
  for (const raw of text.slice(0, end).split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] === 'format') header.format = parts[1];
    if (parts[0] === 'element' && parts[1] === 'vertex') header.vertexCount = Number(parts[2]);
    if (parts[0] === 'element' && parts[1] === 'face') header.faceCount = Number(parts[2]);
  }
  return header;
}

async function hashBuffer(buffer) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fmt(n) {
  return n.toLocaleString('en-US');
}
