// Small meshes and landmark data built in code, so tests need no binary files.

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

export const enc = (s) => new TextEncoder().encode(s).buffer;

// A unit square in the z = 0 plane made of two triangles, as ASCII STL.
export function asciiStlSquare() {
  return enc(`solid square
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 1 1 0
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 1 0
  vertex 0 1 0
 endloop
endfacet
endsolid square
`);
}

// Binary STL of any three.js geometry.
export function binaryStl(geometry) {
  const view = new STLExporter().parse(new THREE.Mesh(geometry), { binary: true });
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

// ASCII PLY with the given vertices and faces (each face a list of indices).
export function asciiPly(vertices, faces, { colors = false } = {}) {
  const lines = [
    'ply',
    'format ascii 1.0',
    `element vertex ${vertices.length}`,
    'property float x',
    'property float y',
    'property float z',
    ...(colors ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
    ...vertices.map((v) => (colors ? [...v, 200, 100, 50] : v).join(' ')),
    ...faces.map((f) => [f.length, ...f].join(' ')),
  ];
  return enc(lines.join('\n') + '\n');
}

export const SQUARE_VERTS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];

// Binary little-endian PLY with triangles only.
export function binaryPly(vertices, faces) {
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${vertices.length}\nproperty float x\nproperty float y\nproperty float z\n` +
    `element face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const size = head.length + vertices.length * 12 + faces.length * 13;
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).set(head, 0);
  const dv = new DataView(buf);
  let o = head.length;
  for (const v of vertices) for (const c of v) { dv.setFloat32(o, c, true); o += 4; }
  for (const f of faces) {
    dv.setUint8(o, 3); o += 1;
    for (const i of f) { dv.setInt32(o, i, true); o += 4; }
  }
  return buf;
}

// A placed-landmark hit as the picker returns it.
export const hit = (x, y = 0, z = 0, face = 0) => ({
  position: [x, y, z],
  anchor: { face, bary: [0.2, 0.3, 0.5] },
  normal: [0, 0, 1],
});

export const MESH = {
  name: 'SKULL_014.ply',
  sha256: 'ab'.repeat(32),
  vertexCount: 248113,
  faceCount: 496222,
};

export const SMALL_TEMPLATE = {
  id: 'tiny',
  name: 'Tiny set',
  version: '1.0',
  dimensions: 3,
  landmarks: [
    { id: 'LM01', name: 'Nasion' },
    { id: 'LM02', name: 'Zygion L', bilateral_pair: 'LM03' },
    { id: 'LM03', name: 'Zygion R', bilateral_pair: 'LM02' },
  ],
};
