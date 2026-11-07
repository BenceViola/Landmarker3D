# Landmarker3D: notes for development

Browser app for placing 3D landmarks on STL/PLY meshes, for teaching and research in morphometrics. Students open it from GitHub Pages; nothing is installed and no data leaves their computer. The owner is a morphometrician, not a web developer: explain changes in plain terms.

## Ground rules (do not break these)

- **The source geometry is never moved, centred, scaled or re-indexed.** The camera is framed on the mesh's bounding box instead. Every stored coordinate is in the mesh file's own space.
- **Face order is the file's order.** `anchor.face` is the triangle index in the file. The BVH is built with `indirect: true` so it never reorders triangles. Vertex merging for smooth shading happens only on a separate display copy (`viewer.js`). `tests/unit/picking.test.js` guards this.
- **Triangle meshes only.** PLY files with quads or polygons are refused, not triangulated (triangulating would shift face numbers). Point clouds are refused.
- **3D only.** The format (v0.2) also defines 2D image data; this app refuses 2D templates and image sources with a clear message.
- **Landmark JSON format v0.2.0**, spec in `docs/landmark-json-spec.md`. Unknown fields in an opened file must survive a save. Missing values are `null` in JSON, never a sentinel number.
- **`vertex_count` / `face_count` are raw file counts** (for STL, vertices = 3 × faces).
- **Plain JavaScript, ES modules, no build step.** Dependencies load from jsDelivr through the import map in `index.html` at pinned versions. `package.json` pins the same versions for the tests; change both together.

## Code map

| File | Role |
|---|---|
| `index.html` | Page, styles (colour tokens, light and dark), import map |
| `js/main.js` | Wiring: viewer, panels, tabs, keyboard, opening meshes, messages |
| `js/viewer.js` | three.js scene, camera framing, shading, CSS2D label layer |
| `js/mesh-loader.js` | STL/PLY reading, raw counts, SHA-256, triangle-only checks |
| `js/picking.js` | BVH raycasting, anchors (face + barycentric), snapping, occlusion |
| `js/markers.js` | Landmark spheres and labels; labels hide behind the surface |
| `js/interaction.js` | Click to place, drag markers, click vs. rotate detection |
| `js/session.js` | Template + points, statuses, undo/redo, template edits, `checkTemplate` |
| `js/landmark-panel.js` | Landmarks tab |
| `js/template-editor.js` | Template tab |
| `js/files-panel.js` | File tab: specimen fields, save/open, mesh matching, TPS export/combine |
| `js/landmark-file.js` | Build and parse `.lmk.json` |
| `js/tps.js` | TPS writer and combiner |
| `js/file-io.js` | Saving: Save dialog (Chrome/Edge), claude.ai download capability, plain download |
| `js/sample.js` | Generated example mesh shown at start |

All changes to landmarks and the template go through `Session`, which fires a `change` event the panels and markers listen to.

## Tests

`npm test` (unit, ~1 s) and `npm run test:e2e` (headless Chromium, ~1 min). Both run in CI on every push. Add a test with every fix or feature; the browser tests catch problems the unit tests can't (one already caught the loading overlay never hiding on a plain host). Test meshes are generated in `tests/fixtures.js`.

## Writing for the UI

Short, plain sentences from the student's side of the screen. Errors say what went wrong and what to do about it. No jargon a biology student wouldn't know.

## Decided

- Hosting on GitHub Pages; plain JS first, Vite/TypeScript only if the code base needs it.
- Template embedded in every landmark file by default; landmark IDs are stable codes (`LM01`) with a separate display name.
- File extension `.lmk.json`, format name `landmark-json`.
- Statuses: `placed`, `estimated`, `missing`; a template landmark with no entry is "to do".
- TPS: `LM3=` blocks, rows in template export order, ad hoc points last, missing as `-999` (configurable).

## Not done yet

- Curves with equidistant semilandmarks (spec section "Curves", v0.2), and the geomorph curve-sliding file.
- CSV export.
- Saving and opening templates as separate `.template.json` files; opening landmark files that reference one (currently refused).
- A JSON Schema file for the format.
- Deferred: Slicer `.mrk.json` export.
