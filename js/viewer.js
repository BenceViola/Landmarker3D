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
    });
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

  // Show a new mesh. `source` is kept untouched for later picking and anchors.
  setGeometry(source, options = {}) {
    this._clear();
    this.source = source;
    this.displayCache = {};
    Object.assign(this.options, options);

    source.computeBoundingBox();
    this.box = source.boundingBox.clone();

    this._buildMesh();
    this.viewFrom('home');
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

  _clear() {
    if (this.mesh) this.scene.remove(this.mesh);
    if (this.wire) this.scene.remove(this.wire);
    for (const g of Object.values(this.displayCache)) g.dispose();
    if (this.source) this.source.dispose();
    this.mesh = this.wire = this.source = this.box = null;
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
