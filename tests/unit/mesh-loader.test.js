import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { loadMeshBuffer, MeshLoadError } from '../../js/mesh-loader.js';
import { makeSampleStl } from '../../js/sample.js';
import { asciiStlSquare, binaryStl, asciiPly, binaryPly, SQUARE_VERTS, enc } from '../fixtures.js';

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex');

describe('STL', () => {
  test('ASCII STL: raw counts, format and hash', async () => {
    const buf = asciiStlSquare();
    const m = await loadMeshBuffer(buf, 'square.STL');
    assert.equal(m.format, 'STL, ASCII');
    assert.equal(m.faceCount, 2);
    assert.equal(m.vertexCount, 6, 'raw count: 3 per triangle');
    assert.equal(m.sha256, sha(buf));
    assert.equal(m.sizeBytes, buf.byteLength);
    assert.equal(m.hasColors, false);
  });

  test('binary STL keeps triangle order and coordinates exactly', async () => {
    const g = new THREE.TorusKnotGeometry(10, 3, 40, 8).toNonIndexed();
    g.translate(100, -50, 25); // away from the origin, nothing should re-centre it
    const m = await loadMeshBuffer(binaryStl(g), 'knot.stl');
    assert.equal(m.format, 'STL, binary');
    assert.equal(m.faceCount, g.attributes.position.count / 3);
    const a = g.attributes.position.array;
    const b = m.geometry.attributes.position.array;
    assert.equal(b.length, a.length);
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4, `coordinate ${i}`);
  });

  test('the generated sample mesh loads like a real file', async () => {
    const m = await loadMeshBuffer(makeSampleStl(), 'sample-pebble.stl');
    assert.equal(m.format, 'STL, binary');
    assert.ok(m.faceCount > 10000);
    m.geometry.computeBoundingBox();
    const c = m.geometry.boundingBox.getCenter(new THREE.Vector3());
    assert.ok(Math.abs(c.x - 12.5) < 5 && Math.abs(c.z - 103.7) < 5, 'sample sits away from the origin');
  });

  test('an STL with no triangles is refused with an explanation', async () => {
    // Short file: three.js would throw a RangeError reading the binary header.
    await assert.rejects(loadMeshBuffer(enc('solid empty\nendsolid empty\n'), 'empty.stl'), MeshLoadError);
    await assert.rejects(loadMeshBuffer(new ArrayBuffer(0), 'zero.stl'), MeshLoadError);
    // Long enough for a header, but no facets.
    const padded = enc('solid empty\n' + ' '.repeat(120) + '\nendsolid empty\n');
    await assert.rejects(loadMeshBuffer(padded, 'padded.stl'), /no triangles|readable/);
  });

  test('a binary STL that says it has 0 triangles is refused', async () => {
    const buf = new ArrayBuffer(84); // header + count of 0
    await assert.rejects(loadMeshBuffer(buf, 'zero-tris.stl'), MeshLoadError);
  });
});

describe('PLY', () => {
  test('ASCII triangle PLY: raw vertex count from the header', async () => {
    const m = await loadMeshBuffer(asciiPly(SQUARE_VERTS, [[0, 1, 2], [0, 2, 3]]), 'square.ply');
    assert.equal(m.format, 'PLY, ascii');
    assert.equal(m.faceCount, 2);
    assert.equal(m.vertexCount, 4);
    assert.ok(m.geometry.index, 'PLY keeps shared vertices');
    assert.deepEqual(Array.from(m.geometry.index.array), [0, 1, 2, 0, 2, 3], 'face order kept');
  });

  test('binary little-endian PLY', async () => {
    const m = await loadMeshBuffer(binaryPly(SQUARE_VERTS, [[0, 1, 2], [0, 2, 3]]), 'square.ply');
    assert.equal(m.format, 'PLY, binary little endian');
    assert.equal(m.faceCount, 2);
    assert.deepEqual(Array.from(m.geometry.index.array), [0, 1, 2, 0, 2, 3]);
  });

  test('vertex colours are detected', async () => {
    const m = await loadMeshBuffer(asciiPly(SQUARE_VERTS, [[0, 1, 2]], { colors: true }), 'c.ply');
    assert.equal(m.hasColors, true);
  });

  test('quads are refused, not silently triangulated', async () => {
    await assert.rejects(
      loadMeshBuffer(asciiPly(SQUARE_VERTS, [[0, 1, 2, 3]]), 'quad.ply'),
      (err) => err instanceof MeshLoadError && /more than three corners/.test(err.message)
    );
  });

  test('a mix of triangles and one quad is refused', async () => {
    const verts = [...SQUARE_VERTS, [2, 0, 0]];
    await assert.rejects(loadMeshBuffer(asciiPly(verts, [[0, 1, 2], [1, 4, 2, 3]]), 'mix.ply'), /more than three corners/);
  });

  test('point clouds are refused', async () => {
    await assert.rejects(loadMeshBuffer(asciiPly(SQUARE_VERTS, []), 'cloud.ply'), /point cloud/);
  });

  test('a damaged header is refused', async () => {
    await assert.rejects(loadMeshBuffer(enc('ply\nformat ascii 1.0\n'), 'broken.ply'), /header/);
    await assert.rejects(loadMeshBuffer(enc('not a ply'), 'fake.ply'), /header/);
  });
});

test('other file types are refused with the reason', async () => {
  await assert.rejects(loadMeshBuffer(enc('x'), 'skull.obj'), (err) => err instanceof MeshLoadError && /not an STL or PLY/.test(err.message));
});
