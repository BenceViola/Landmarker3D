// Builds a small example mesh so the viewer has something to show before a
// file is opened. It is written out as a real binary STL and then read back
// through the normal loader, so it behaves exactly like an opened file.
// It sits away from the origin on purpose: the coordinates shown in the
// panel should match the file, not a re-centred copy.

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

export function makeSampleStl() {
  const g = new THREE.IcosahedronGeometry(1, 24);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const offset = new THREE.Vector3(12.5, -40.2, 103.7);

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const bump =
      1 +
      0.09 * Math.sin(5 * v.x + 1.3) * Math.cos(4 * v.y) +
      0.05 * Math.sin(9 * v.z + 3 * v.x) +
      0.025 * Math.cos(14 * v.y - 2 * v.z);
    v.multiplyScalar(bump);
    pos.setXYZ(i, v.x * 34 + offset.x, v.y * 22 + offset.y, v.z * 18 + offset.z);
  }
  g.computeVertexNormals();

  const view = new STLExporter().parse(new THREE.Mesh(g), { binary: true });
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
