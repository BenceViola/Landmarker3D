// Scene, camera, lighting and controls for the mesh viewer.
// Rule from the spec: the source geometry is never moved, centred or scaled.
// The camera is framed on the mesh's bounding box instead, so every picked
// coordinate stays in the mesh file's own coordinate space.

import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

const BONE = 0xe4ddcf;

// Named views along the mesh's own axes. `dir` points from the mesh to the camera.
const VIEWS = {
  '+x': { dir: [1, 0, 0], up: [0, 0, 1] },
  '-x': { dir: [-1, 0, 0], up: [0, 0, 1] },
  '+y': { dir: [0, 1, 0], up: [0, 0, 1] },
  '-y': { dir: [0, -1, 0], up: [0, 0, 1] },
  '+z': { dir: [0, 0, 1], up: [0, 1, 0] },
  '-z': { dir: [0, 0, -1], up: [0, 1, 0] },
  home: { dir: [0.45, 0.35, 1], up: [0, 1, 0] },
};

export class Viewer {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    // HTML labels (landmark names) drawn over the canvas.
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);
    this.frameHooks = [];

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    this.scene.add(this.camera);

    // Soft fill from all around plus a key light that follows the camera,
    // so the side you are looking at is always lit.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6f6a62, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(0.6, 0.8, 0);
    key.target.position.set(0, 0, -1);
    this.camera.add(key, key.target);

    this.material = new THREE.MeshStandardMaterial({
      color: BONE,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
      // Pushed back a hair in depth, so lines drawn on the surface (plane cuts) aren't hidden in it.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.renderer.localClippingEnabled = true;
    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x1d2433,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 3.2;
    this.controls.zoomSpeed = 1.4;
    this.controls.panSpeed = 0.9;
    this.controls.staticMoving = true;

    this.source = null; // geometry exactly as parsed from the file
    this.displayCache = {}; // display copies, keyed by shading mode
    this.mesh = null;
    this.wire = null;
    this.box = null;
    this.options = { smooth: true, wireframe: false, vertexColors: false };

    this._resize = this._resize.bind(this);
    new ResizeObserver(this._resize).observe(container);
    this._resize();

    const loop = () => {
      this.controls.update();
      for (const hook of this.frameHooks) hook();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  addFrameHook(fn) {
    this.frameHooks.push(fn);
  }

  // Length of the mesh's bounding-box diagonal, used to size markers.
  get diagonal() {
    return this.box ? this.box.min.distanceTo(this.box.max) : 1;
  }

  setBackground(color) {
    this.scene.background = new THREE.Color(color);
  }

  // Show a mesh. `source` is kept untouched for later picking and anchors.
  // `displayCache` holds its display copies (smooth, flat); it belongs to the
  // caller, which keeps it with the mesh, so switching back is instant.
  // Nothing is disposed here: the caller decides when a mesh is unloaded.
  setGeometry(source, { displayCache = {}, view = null, ...options } = {}) {
    this.clear();
    this.source = source;
    this.displayCache = displayCache;
    Object.assign(this.options, options);

    if (!source.boundingBox) source.computeBoundingBox();
    this.box = source.boundingBox.clone();

    this._buildMesh();
    if (view) this.setView(view);
    else this.viewFrom('home');
  }

  // Show nothing (a specimen whose mesh isn't open).
  clear() {
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.wire) this.scene.remove(this.wire);
    this.mesh = this.wire = this.source = this.box = null;
    this.displayCache = {};
  }

  // Hide the part of the mesh on one side of a plane (cut-away view), or
  // show all of it again with null. `keep` is a THREE.Plane: what has a
  // negative distance to it is hidden.
  setClip(keep) {
    const planes = keep ? [keep] : [];
    this.material.clippingPlanes = planes;
    this.wireMaterial.clippingPlanes = planes;
    this.material.needsUpdate = this.wireMaterial.needsUpdate = true;
  }

  // The camera position, to come back to when switching back to a specimen.
  getView() {
    if (!this.box) return null;
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      up: this.camera.up.toArray(),
    };
  }

  setView(v) {
    this.camera.up.fromArray(v.up);
    this.camera.position.fromArray(v.position);
    this.controls.target.fromArray(v.target);
    const dist = this.camera.position.distanceTo(this.controls.target) || 1;
    const size = this.diagonal;
    this.camera.near = Math.max(Math.min(dist, size) / 1000, 1e-6);
    this.camera.far = (dist + size) * 100;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  // A small picture of the mesh from the default view, as a data URL, for the
  // specimen strip. `hide` are scene objects (markers) left out of it.
  capture(width = 128, height = 96, hide = []) {
    if (!this.box) return null;
    const saved = this.getView();
    this.viewFrom('home');
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const clip = this.material.clippingPlanes;
    this.material.clippingPlanes = [];
    this.renderer.render(this.scene, this.camera);
    this.material.clippingPlanes = clip;
    const src = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // Crop the middle of the view to the thumbnail's shape, a little
    // tighter than the full view so the mesh fills the picture.
    const scale = Math.min(src.width / width, src.height / height) * 0.8;
    const sw = width * scale;
    const sh = height * scale;
    ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, width, height);
    hide.forEach((o, i) => (o.visible = was[i]));
    this.setView(saved);
    this.renderer.render(this.scene, this.camera);
    try {
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      return null;
    }
  }

  setSmooth(smooth) {
    if (this.options.smooth === smooth) return;
    this.options.smooth = smooth;
    if (this.source) this._buildMesh();
  }

  setWireframe(on) {
    this.options.wireframe = on;
    if (this.wire) this.wire.visible = on;
  }

  setVertexColors(on) {
    this.options.vertexColors = on;
    this.material.vertexColors = on;
    this.material.color.set(on ? 0xffffff : BONE);
    this.material.needsUpdate = true;
  }

  // Frame the whole mesh, looking along one of the mesh's axes.
  viewFrom(name) {
    const view = VIEWS[name] || VIEWS.home;
    this._frame(new THREE.Vector3(...view.dir).normalize(), new THREE.Vector3(...view.up));
  }

  // Frame the whole mesh from the current viewing direction.
  fit() {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this._frame(dir, this.camera.up.clone());
  }

  _frame(dir, up) {
    if (!this.box) return;
    const sphere = this.box.getBoundingSphere(new THREE.Sphere());
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fov = Math.min(vFov, hFov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * 1.08;

    this.controls.target.copy(sphere.center);
    this.camera.up.copy(up);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 1e-6);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(sphere.center);
    this.controls.update();
  }

  // Build (or reuse) the display copy for the current shading mode.
  // Vertex merging happens only here, never on the source geometry.
  // mergeVertices keeps triangle order, so triangle i is still file face i.
  _displayGeometry() {
    const mode = this.options.smooth ? 'smooth' : 'flat';
    if (this.displayCache[mode]) return this.displayCache[mode];

    let g;
    if (mode === 'smooth') {
      if (this.source.index) {
        g = this.source.clone();
        if (!g.attributes.normal) g.computeVertexNormals();
      } else {
        g = this.source.clone();
        g.deleteAttribute('normal');
        g = mergeVertices(g);
        g.computeVertexNormals();
      }
    } else {
      g = this.source.index ? this.source.toNonIndexed() : this.source.clone();
      g.deleteAttribute('normal');
      g.computeVertexNormals(); // non-indexed, so these are face normals
    }
    this.displayCache[mode] = g;
    return g;
  }

  _buildMesh() {
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.wire) this.scene.remove(this.wire);
    const g = this._displayGeometry();
    this.mesh = new THREE.Mesh(g, this.material);
    this.wire = new THREE.Mesh(g, this.wireMaterial);
    this.wire.visible = this.options.wireframe;
    this.wire.renderOrder = 1;
    this.scene.add(this.mesh, this.wire);
    this.setVertexColors(this.options.vertexColors && !!g.attributes.color);
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
  }
}
