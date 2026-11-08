// Drawing planes in the 3D view: a see-through square for each plane (its
// two sides tinted differently, so you can tell which side is which) and a
// thick line on the surface where the plane cuts the mesh.
//
// The cut is recomputed only when the plane or the mesh changes, so it can
// follow a landmark while it is dragged.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { planeCut } from './planes.js';

const Z = new THREE.Vector3(0, 0, 1);

export class PlaneView {
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.renderOrder = 3;
    viewer.scene.add(this.group);
    this.items = new Map(); // key -> { front, back, line, lineMat, cutKey, segments }
    this.square = new THREE.PlaneGeometry(1, 1);
    this.pickGroup = new THREE.Group();
    viewer.scene.add(this.pickGroup);
    this.pickGeo = new THREE.SphereGeometry(1, 16, 12);
    this._size = new THREE.Vector2();
    viewer.addFrameHook(() => {
      viewer.renderer.getSize(this._size);
      for (const it of this.items.values()) it.lineMat.resolution.copy(this._size);
    });
  }

  /**
   * Show these planes: [{ key, plane: { point, normal }, color, surface,
   * cut, emphasis }]. `geometry` is the mesh's source geometry (or null).
   */
  update(list, geometry) {
    const keep = new Set();
    const box = this.viewer.box;
    for (const p of list) {
      if (!p.plane || !box) continue;
      keep.add(p.key);
      const it = this.items.get(p.key) || this._create(p.key);
      const color = new THREE.Color(p.color);
      it.front.material.color.copy(color);
      it.back.material.color.copy(color).lerp(new THREE.Color('#ffffff'), 0.45);
      const opacity = p.emphasis ? 0.22 : 0.12;
      it.front.material.opacity = it.back.material.opacity = opacity;

      // The square: centred on the point of the plane nearest the mesh's centre, as wide as the mesh.
      const n = new THREE.Vector3(...p.plane.normal);
      const centre = box.getCenter(new THREE.Vector3());
      const d = n.dot(centre.clone().sub(new THREE.Vector3(...p.plane.point)));
      const at = centre.addScaledVector(n, -d);
      const size = box.min.distanceTo(box.max) * 1.05;
      for (const m of [it.front, it.back]) {
        m.position.copy(at);
        m.quaternion.setFromUnitVectors(Z, n);
        m.scale.set(size, size, 1);
        m.visible = !!p.surface;
      }

      // The cut through the mesh.
      it.lineMat.color.copy(color);
      it.lineMat.linewidth = p.emphasis ? 4 : 2.5;
      const cutKey = geometry && p.cut ? `${geometry.uuid}|${p.plane.point.join()}|${p.plane.normal.join()}` : null;
      if (cutKey !== it.cutKey) {
        it.cutKey = cutKey;
        it.segments = cutKey
          ? planeCut(geometry.attributes.position.array, geometry.index ? geometry.index.array : null, p.plane)
          : new Float32Array(0);
        if (it.segments.length) {
          it.line.geometry.dispose();
          it.line.geometry = new LineSegmentsGeometry().setPositions(it.segments);
        }
      }
      it.line.visible = !!(p.cut && it.segments.length);
    }
    for (const [key, it] of this.items) {
      if (keep.has(key)) continue;
      this.group.remove(it.front, it.back, it.line);
      it.line.geometry.dispose();
      it.lineMat.dispose();
      it.front.material.dispose();
      it.back.material.dispose();
      this.items.delete(key);
    }
  }

  // Number of cut segments drawn for a plane (for the panel and the tests).
  segmentsOf(key) {
    const it = this.items.get(key);
    return it && it.line.visible ? it.segments.length / 6 : 0;
  }

  // Points clicked so far for a new plane.
  setPickPoints(points, radius, color = '#ffb300') {
    this.pickGroup.clear();
    for (const p of points) {
      const m = new THREE.Mesh(this.pickGeo, new THREE.MeshBasicMaterial({ color }));
      m.position.fromArray(p);
      m.scale.setScalar(radius);
      this.pickGroup.add(m);
    }
  }

  _create(key) {
    const mat = (side) =>
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, side, depthWrite: false });
    const front = new THREE.Mesh(this.square, mat(THREE.FrontSide));
    const back = new THREE.Mesh(this.square, mat(THREE.BackSide));
    front.renderOrder = back.renderOrder = 3;
    const lineMat = new LineMaterial({ linewidth: 2.5, worldUnits: false });
    const line = new LineSegments2(new LineSegmentsGeometry(), lineMat);
    line.renderOrder = 4;
    line.visible = false;
    this.group.add(front, back, line);
    const it = { front, back, line, lineMat, cutKey: null, segments: new Float32Array(0) };
    this.items.set(key, it);
    return it;
  }
}
