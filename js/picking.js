// Surface picking on the source mesh (the geometry exactly as read from the
// file), accelerated with three-mesh-bvh.
//
// The BVH is built in "indirect" mode: it sorts its own lookup table instead
// of reordering the geometry's triangles, so the face index of a hit is the
// face index in the file. That is what `anchor.face` in the spec requires.

import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const round = (n) => Math.round(n * 1e6) / 1e6; // spec: up to 6 decimal places

export class Picker {
  constructor(viewer) {
    this.viewer = viewer;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.mesh = null;
    this._ndc = new THREE.Vector2();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  // Building the BVH takes a moment on large meshes, so it stays on the
  // geometry and is reused when switching back to that mesh. The mesh store
  // disposes it when the mesh is unloaded.
  setGeometry(geometry) {
    if (!geometry.boundsTree) geometry.computeBoundsTree({ indirect: true });
    // Never rendered; only used for ray tests. DoubleSide so inner walls can be picked.
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.mesh.updateMatrixWorld(true);
  }

  clear() {
    this.mesh = null;
  }

  // The camera ray under a screen position.
  rayAt(clientX, clientY) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this._ndc, this.viewer.camera);
    return this.raycaster.ray.clone();
  }

  // Surface point under the cursor, as the landmark fields the spec stores.
  pickAt(clientX, clientY) {
    if (!this.mesh) return null;
    this.rayAt(clientX, clientY);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    return hit ? this._describe(hit) : null;
  }

  // Distance along `ray` to the first surface hit, or null.
  surfaceDistance(ray) {
    if (!this.mesh) return null;
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    return hit ? hit.distance : null;
  }

  // True when the surface lies between `from` and `point`.
  isHidden(point, from, margin) {
    if (!this.mesh) return false;
    const dir = point.clone().sub(from);
    const dist = dir.length();
    if (dist === 0) return false;
    this.raycaster.ray.set(from, dir.divideScalar(dist));
    this.raycaster.near = 0;
    this.raycaster.far = dist;
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    return !!hit && hit.distance < dist - margin;
  }

  // Nearest surface point to a stored position, as landmark fields, plus how
  // far it moved. Used when a landmark file is applied to a different mesh.
  snap(position) {
    if (!this.mesh) return null;
    const p = new THREE.Vector3().fromArray(position);
    const hit = this.mesh.geometry.boundsTree.closestPointToPoint(p, {});
    if (!hit) return null;
    return {
      fields: this._describe({ point: hit.point, faceIndex: hit.faceIndex }),
      distance: hit.distance,
    };
  }

  _describe(hit) {
    const g = this.mesh.geometry;
    const pos = g.attributes.position;
    const face = hit.faceIndex;
    const idx = g.index;
    const ia = idx ? idx.getX(3 * face) : 3 * face;
    const ib = idx ? idx.getX(3 * face + 1) : 3 * face + 1;
    const ic = idx ? idx.getX(3 * face + 2) : 3 * face + 2;
    const a = this._a.fromBufferAttribute(pos, ia);
    const b = this._b.fromBufferAttribute(pos, ib);
    const c = this._c.fromBufferAttribute(pos, ic);

    const result = { position: hit.point.toArray().map(round) };
    const bary = THREE.Triangle.getBarycoord(hit.point, a, b, c, new THREE.Vector3());
    if (bary) result.anchor = { face, bary: bary.toArray().map(round) };
    const normal = THREE.Triangle.getNormal(a, b, c, new THREE.Vector3());
    if (normal.lengthSq() > 0) result.normal = normal.toArray().map(round);
    return result;
  }
}
