// 3D landmark markers: a sphere per placed point plus an HTML label.
// Labels hide when the surface is between the camera and the point, so you
// don't read the label of a landmark on the far side of the skull.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Same colours as the status dots in the panel.
const COLORS = { placed: 0x2f63e0, estimated: 0xd98a00, active: 0xe0337a };

export class Markers {
  constructor(viewer, picker, session) {
    this.viewer = viewer;
    this.picker = picker;
    this.session = session;

    this.group = new THREE.Group();
    viewer.scene.add(this.group);
    this.geometry = new THREE.SphereGeometry(1, 24, 16);
    this.materials = {};
    for (const [key, color] of Object.entries(COLORS)) {
      this.materials[key] = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.4,
        metalness: 0,
        emissive: color,
        emissiveIntensity: 0.22,
      });
    }

    this.items = new Map(); // id -> { mesh, label, text, active }
    this.baseRadius = 1;
    this.sizeFactor = 1;
    this.showLabels = true;
    this._camState = new THREE.Matrix4();
    this._labelsDirty = true;
    this._camPos = new THREE.Vector3();

    viewer.addFrameHook(() => this._updateLabels());
  }

  // Marker size follows the mesh, so it looks the same on a tooth or a femur.
  setMeshSize(diagonal) {
    this.baseRadius = diagonal * 0.0045;
    this._applyScale();
  }

  setSizeFactor(f) {
    this.sizeFactor = f;
    this._applyScale();
  }

  setShowLabels(on) {
    this.showLabels = on;
    this._labelsDirty = true;
  }

  // Bring markers in line with the session's points.
  sync() {
    const s = this.session;
    const seen = new Set();
    for (const p of s.points) {
      if (!p.position) continue;
      seen.add(p.id);
      let item = this.items.get(p.id);
      if (!item) item = this._create(p.id);

      const active = p.id === s.activeId;
      item.active = active;
      item.mesh.material = active
        ? this.materials.active
        : p.status === 'estimated'
          ? this.materials.estimated
          : this.materials.placed;
      item.mesh.position.fromArray(p.position);
      item.el.className = `lm-label is-${p.status}${active ? ' is-active' : ''}`;
      item.text.textContent = active ? `${p.id} · ${s.labelOf(p.id)}` : p.id;
    }
    for (const [id, item] of this.items) {
      if (seen.has(id)) continue;
      item.mesh.remove(item.label); // fires 'removed', which takes the label out of the DOM
      this.group.remove(item.mesh);
      this.items.delete(id);
    }
    this._applyScale();
    this._labelsDirty = true;
  }

  // Id of the marker under the cursor, ignoring markers hidden behind the surface.
  hitTest(clientX, clientY) {
    if (!this.items.size) return null;
    const ray = this.picker.rayAt(clientX, clientY);
    let best = null;
    for (const [id, item] of this.items) {
      const r = item.mesh.scale.x;
      const c = item.mesh.position;
      if (ray.distanceToPoint(c) > r * 1.6) continue; // a little larger than drawn, easier to grab
      const t = ray.origin.distanceTo(c);
      if (!best || t < best.t) best = { id, t, r };
    }
    if (!best) return null;
    const surface = this.picker.surfaceDistance(ray);
    if (surface !== null && surface < best.t - best.r * 1.5) return null;
    return best.id;
  }

  _create(id) {
    const mesh = new THREE.Mesh(this.geometry, this.materials.placed);
    mesh.renderOrder = 2;
    const el = document.createElement('div');
    const text = document.createElement('span');
    el.appendChild(text);
    const label = new CSS2DObject(el);
    label.center.set(0, 1); // bottom-left corner of the label sits on the point
    mesh.add(label);
    this.group.add(mesh);
    const item = { mesh, label, el, text, active: false };
    this.items.set(id, item);
    return item;
  }

  _applyScale() {
    for (const item of this.items.values()) {
      item.mesh.scale.setScalar(this.baseRadius * this.sizeFactor * (item.active ? 1.4 : 1));
    }
    this._labelsDirty = true;
  }

  _updateLabels() {
    const cam = this.viewer.camera;
    if (!this._labelsDirty && cam.matrixWorld.equals(this._camState)) return;
    this._camState.copy(cam.matrixWorld);
    this._labelsDirty = false;
    cam.getWorldPosition(this._camPos);
    for (const item of this.items.values()) {
      const wanted = this.showLabels || item.active;
      item.label.visible =
        wanted && !this.picker.isHidden(item.mesh.position, this._camPos, item.mesh.scale.x * 1.5);
    }
  }
}
