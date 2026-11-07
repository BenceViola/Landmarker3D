# Tests

Two layers, both on Node's built-in test runner (Node 20 or newer).

```sh
npm install          # three and three-mesh-bvh, the same versions the page loads
npm test             # unit tests, about 1 s
npx playwright install chromium   # once, for the browser tests
npm run test:e2e     # browser tests, about 1 min
npm run test:all     # both
```

**Unit tests** (`tests/unit/`) check the modules that hold the logic:

- `session.test.js`: placing, statuses, undo/redo, template editing, the v0.2 `dimensions` check.
- `mesh-loader.test.js`: STL and PLY reading, raw counts, SHA-256, refusal of quads, point clouds and damaged files.
- `picking.test.js`: the BVH never reorders the file's triangles; face indices match a brute-force search; every anchor reproduces its position.
- `landmark-file.test.js`: the `.lmk.json` format against the spec, unknown fields kept on save, every refusal case.
- `tps.test.js`: TPS output, read back with the rules geomorph's `readland.tps` uses.
- `set-model.test.js`, `csv-zip-handin.test.js`, `mesh-store.test.js`: export IDs, replicates, repeatability, CSV, the zip writer/reader (checked against the system `unzip`), hand-ins, combining, the three-mesh limit.

**Browser tests** (`tests/e2e/`: `app`, `sets`, `replicates`) run the real page in headless Chromium and use it as a student would: clicking on the mesh, dragging markers, keyboard shortcuts, editing the template, saving, reopening, dropping files, exporting TPS. Saves are captured in memory instead of opening a dialog. The page is served exactly as it is on disk, as GitHub Pages serves it, and each test fails if anything is logged to the browser console.

The same tests run on GitHub for every push and pull request (`.github/workflows/test.yml`).

Test meshes and landmark files are generated in code (`tests/fixtures.js`), so the repository needs no binary test data.
