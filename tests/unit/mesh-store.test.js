import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshStore, MAX_LOADED } from '../../js/mesh-store.js';

const mesh = (sha) => {
  const g = { disposed: false, bvhDisposed: false, dispose() { this.disposed = true; }, disposeBoundsTree() { this.bvhDisposed = true; } };
  return { sha256: sha, geometry: g };
};

test('at most 3 meshes are kept, as decided for large surfaces', () => {
  assert.equal(MAX_LOADED, 3);
});

test('the least recently used mesh is unloaded and disposed', () => {
  const s = new MeshStore(3);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(mesh);
  s.put(a);
  s.put(b);
  s.put(c);
  s.get('a'); // a used again: b is now the oldest
  const evicted = s.put(d);
  assert.deepEqual(evicted, ['b']);
  assert.deepEqual([...s.entries.keys()].sort(), ['a', 'c', 'd']);
  assert.equal(b.geometry.disposed, true);
  assert.equal(b.geometry.bvhDisposed, true);
  assert.equal(a.geometry.disposed, false);
});

test('a mesh named in keep is never unloaded', () => {
  const s = new MeshStore(2);
  s.put(mesh('a'));
  s.put(mesh('b'));
  const evicted = s.put(mesh('c'), ['a']);
  assert.deepEqual(evicted, ['b']);
  assert.ok(s.has('a'));
});

test('display copies are kept with the mesh and disposed with it', () => {
  const s = new MeshStore(1);
  const a = mesh('a');
  s.put(a);
  const copy = { disposed: false, dispose() { this.disposed = true; } };
  s.get('a').displayCache.smooth = copy;
  s.put(mesh('b'));
  assert.equal(copy.disposed, true);
});

test('putting the same mesh again keeps its display copies', () => {
  const s = new MeshStore(3);
  const a = mesh('a');
  s.put(a);
  s.get('a').displayCache.smooth = { dispose() {} };
  s.put(a);
  assert.ok(s.get('a').displayCache.smooth);
});

test('remove and clear dispose', () => {
  const s = new MeshStore(3);
  const a = mesh('a');
  const b = mesh('b');
  s.put(a);
  s.put(b);
  s.remove('a');
  assert.equal(a.geometry.disposed, true);
  s.clear();
  assert.equal(b.geometry.disposed, true);
  assert.equal(s.size, 0);
});
