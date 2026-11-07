// Meshes in memory. A set can hold any number of specimens, but at most
// MAX_LOADED meshes are kept loaded at once, because one surface with a
// million triangles already takes a few hundred megabytes once it is ready
// for display and picking. When another mesh is needed, the one used least
// recently is unloaded; its landmarks stay in the set, and its mesh is read
// again from the file when the student switches back to it.
//
// Meshes are keyed by their SHA-256, so replicates of a specimen (same mesh
// file) share one loaded copy.

export const MAX_LOADED = 3;

export class MeshStore {
  constructor(max = MAX_LOADED) {
    this.max = max;
    this.entries = new Map(); // sha256 -> { mesh, displayCache, used }
    this.clock = 0;
  }

  has(sha) {
    return this.entries.has(sha);
  }

  get(sha) {
    const e = this.entries.get(sha);
    if (e) e.used = ++this.clock;
    return e || null;
  }

  get size() {
    return this.entries.size;
  }

  // Keep a loaded mesh. `keep` are hashes that must not be unloaded now
  // (the specimen on screen). Returns the hashes that were unloaded.
  put(mesh, keep = []) {
    const old = this.entries.get(mesh.sha256);
    if (old && old.mesh !== mesh) dispose(old);
    this.entries.set(mesh.sha256, { mesh, displayCache: old?.displayCache ?? {}, used: ++this.clock });
    return this.trim([mesh.sha256, ...keep]);
  }

  // Unload least recently used meshes until at most `max` are left.
  trim(keep = []) {
    const evicted = [];
    const protect = new Set(keep);
    while (this.entries.size > this.max) {
      let oldest = null;
      for (const [sha, e] of this.entries) {
        if (protect.has(sha)) continue;
        if (!oldest || e.used < oldest[1].used) oldest = [sha, e];
      }
      if (!oldest) break;
      dispose(oldest[1]);
      this.entries.delete(oldest[0]);
      evicted.push(oldest[0]);
    }
    return evicted;
  }

  remove(sha) {
    const e = this.entries.get(sha);
    if (!e) return;
    dispose(e);
    this.entries.delete(sha);
  }

  clear() {
    for (const e of this.entries.values()) dispose(e);
    this.entries.clear();
  }
}

function dispose(entry) {
  const g = entry.mesh.geometry;
  g.disposeBoundsTree?.();
  g.dispose?.();
  for (const d of Object.values(entry.displayCache)) d.dispose?.();
}
