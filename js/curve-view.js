// Curves in the 3D view, and computing them on the mesh on screen.
//
// For the current specimen, each curve is computed from its clicked points
// (curves.js) whenever something it depends on changes: a click, a dragged
// point, a moved end landmark, the template's settings, or the mesh. The
// semilandmarks are stored on the curve entry through the session (they are
// what the file saves); the surface path is kept here only for drawing.
//
// Drawn: the path as a line on the surface, the semilandmarks as small
// dots, and the clicked points as small diamonds that can be dragged.
// Curves of specimens whose mesh isn't on screen are left as they are; they
// are recomputed when the specimen is shown.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { computeCurve, samplingOf } from './curves.js';
import { cpKey } from './session.js';

const COLOR = { line: 0x0e9fc7, active: 0xe0337a, estimated: 0xd98a00, cp: 0xffffff };

export class CurveView {
  constructor(viewer, picker, session) {
    this.viewer = viewer;
    this.picker = picker;
    this.session = session;
    this.group = new THREE.Group();
    viewer.scene.add(this.group);
    this.sphere = new THREE.SphereGeometry(1, 12, 8);
    this.diamond = new THREE.OctahedronGeometry(1);
    this.cache = new Map(); // `${uid}|${curveId}` -> { sig, path, error }
    this.items = new Map(); // curve id -> drawn objects
    this.baseRadius = 1;
    this.sizeFactor = 1;
    this.showLabels = true;
    this._size = new THREE.Vector2();
    this._camState = new THREE.Matrix4();
    this._camPos = new THREE.Vector3();
    this._labelsDirty = true;
    viewer.addFrameHook(() => {
      viewer.renderer.getSize(this._size);
      for (const it of this.items.values()) it.lineMat.resolution.copy(this._size);
      this._updateLabels();
    });
  }

  setMeshSize(diagonal) {
    this.baseRadius = diagonal * 0.0045;
  }
  setSizeFactor(f) {
    this.sizeFactor = f;
    this.draw();
  }
  setShowLabels(on) {
    this.showLabels = on;
    this._labelsDirty = true;
  }

  // ---- Computing ------------------------------------------------------------

  // Recompute the current specimen's curves where needed, then draw them.
  update() {
    this.compute();
    this.draw();
  }

  compute() {
    const s = this.session;
    const rec = s.current;
    const geo = this.picker.mesh?.geometry;
    if (!geo) return;
    const project = (p) => this.picker.snap(p)?.fields || null;
    for (const def of s.curveDefs) {
      const entry = s.curve(def.id);
      if (!entry) continue;
      const pointOf = (id) => s.point(id);
      const ends = [def.start, def.end].map((id) => (id ? pointOf(id) : null)).map((p) => (p && p.status !== 'missing' ? p.position : null));
      const sig = JSON.stringify([geo.uuid, def, entry.status, entry.control_points.map((c) => c.position), ends]);
      const key = `${rec.uid}|${def.id}`;
      const hit = this.cache.get(key);
      if (hit && hit.sig === sig) continue;
      const r = computeCurve(def, entry, pointOf, project);
      this.cache.set(key, { sig, path: r.path, error: r.error });
      s.setCurveResult(rec, def.id, { points: r.points, length: r.length, sampling: samplingOf(def) });
    }
  }

  // Why a curve of the current specimen has no semilandmarks yet, or null.
  errorOf(id) {
    return this.cache.get(`${this.session.current.uid}|${id}`)?.error || null;
  }

  // The surface path of a curve (for tests).
  pathOf(id) {
    return this.cache.get(`${this.session.current.uid}|${id}`)?.path || [];
  }

  // ---- Drawing --------------------------------------------------------------

  draw() {
    const s = this.session;
    const seen = new Set();
    if (this.picker.mesh) {
      for (const def of s.curveDefs) {
        const entry = s.curve(def.id);
        if (!entry || entry.status === 'missing') continue;
        seen.add(def.id);
        const it = this.items.get(def.id) || this._create(def.id);
        const active = s.activeId === def.id;
        const color = active ? COLOR.active : entry.status === 'estimated' ? COLOR.estimated : COLOR.line;
        const r = this.baseRadius * this.sizeFactor;

        const path = this.pathOf(def.id);
        if (path.length >= 2) {
          const seg = new Float32Array((path.length - 1) * 6);
          for (let i = 1; i < path.length; i++) seg.set([...path[i - 1], ...path[i]], (i - 1) * 6);
          it.line.geometry.dispose();
          it.line.geometry = new LineSegmentsGeometry().setPositions(seg);
          it.line.visible = true;
        } else it.line.visible = false;
        it.lineMat.color.setHex(color);
        it.lineMat.linewidth = active ? 3 : 2;

        // Semilandmarks: dots a shade darker than the line, so they stand out on it.
        const dot = new THREE.Color(color).multiplyScalar(0.62).getHex();
        it.dots = this._instances(it.dots, this.sphere, entry.points.map((p) => p.position), r * 0.85, dot, it.root);
        it.cpRadius = r * (active ? 1.4 : 1);
        it.cps = this._instances(it.cps, this.diamond, entry.control_points.map((c) => c.position), it.cpRadius, COLOR.cp, it.root);
        it.cpPositions = entry.control_points.map((c) => c.position);

        // Label at the middle of the path (or the first click while unfinished).
        const at = path.length ? path[Math.floor(path.length / 2)] : entry.control_points[0]?.position;
        it.hasAt = !!at;
        it.label.visible = it.hasAt;
        if (at) it.anchor.position.fromArray(at);
        it.el.className = `lm-label is-curve${active ? ' is-active' : ''}${entry.status === 'estimated' ? ' is-estimated' : ''}`;
        it.text.textContent = active ? `${def.id} · ${def.name}` : def.id;
        it.active = active;
      }
    }
    for (const [id, it] of this.items) {
      if (seen.has(id)) continue;
      it.anchor.remove(it.label);
      this.group.remove(it.root);
      it.line.geometry.dispose();
      it.lineMat.dispose();
      this.items.delete(id);
    }
    this._labelsDirty = true;
  }

  // Key of the clicked point under the cursor ("C01#2"), or null.
  hitTest(clientX, clientY) {
    if (!this.items.size || !this.picker.mesh) return null;
    const ray = this.picker.rayAt(clientX, clientY);
    const c = new THREE.Vector3();
    let best = null;
    for (const [id, it] of this.items) {
      (it.cpPositions || []).forEach((p, i) => {
        c.fromArray(p);
        const r = it.cpRadius;
        if (ray.distanceToPoint(c) > r * 1.8) return;
        const t = ray.origin.distanceTo(c);
        if (!best || t < best.t) best = { key: cpKey(id, i), t, r };
      });
    }
    if (!best) return null;
    const surface = this.picker.surfaceDistance(ray);
    if (surface !== null && surface < best.t - best.r * 1.5) return null;
    return best.key;
  }

  _instances(old, geometry, positions, radius, color, parent) {
    if (old && old.count === positions.length && old.userData.capacity >= positions.length) {
      old.material.color.setHex(color);
    } else {
      if (old) {
        parent.remove(old);
        old.material.dispose();
        old.dispose?.();
      }
      old = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.25 }),
        Math.max(positions.length, 1)
      );
      old.userData.capacity = Math.max(positions.length, 1);
      old.renderOrder = 2;
      parent.add(old);
    }
    old.count = positions.length;
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3(radius, radius, radius);
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    positions.forEach((p, i) => old.setMatrixAt(i, m.compose(v.fromArray(p), q, scale)));
    old.instanceMatrix.needsUpdate = true;
    old.computeBoundingSphere();
    return old;
  }

  _create(id) {
    const root = new THREE.Group();
    const lineMat = new LineMaterial({ linewidth: 2.5, worldUnits: false });
    const line = new LineSegments2(new LineSegmentsGeometry(), lineMat);
    line.renderOrder = 2;
    root.add(line);
    const anchor = new THREE.Object3D();
    root.add(anchor);
    const el = document.createElement('div');
    const text = document.createElement('span');
    el.appendChild(text);
    const label = new CSS2DObject(el);
    label.center.set(0, 1);
    anchor.add(label);
    this.group.add(root);
    const it = { root, line, lineMat, anchor, label, el, text, dots: null, cps: null, cpPositions: [], cpRadius: 0, active: false, hasAt: false };
    this.items.set(id, it);
    return it;
  }

  _updateLabels() {
    const cam = this.viewer.camera;
    if (!this._labelsDirty && cam.matrixWorld.equals(this._camState)) return;
    this._camState.copy(cam.matrixWorld);
    this._labelsDirty = false;
    cam.getWorldPosition(this._camPos);
    for (const it of this.items.values()) {
      const wanted = it.hasAt && (this.showLabels || it.active);
      it.label.visible = wanted && !this.picker.isHidden(it.anchor.position, this._camPos, this.baseRadius * 2);
    }
  }
}
