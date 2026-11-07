# Landmarker3D: notes for development

Browser app for placing 3D landmarks on STL/PLY meshes, for teaching and research in morphometrics. Students open it from GitHub Pages; nothing is installed and no data leaves their computer. The owner is a morphometrician, not a web developer: explain changes in plain terms.

## Ground rules (do not break these)

- **The source geometry is never moved, centred, scaled or re-indexed.** The camera is framed on the mesh's bounding box instead. Every stored coordinate is in the mesh file's own space.
- **Face order is the file's order.** `anchor.face` is the triangle index in the file. The BVH is built with `indirect: true` so it never reorders triangles. Vertex merging for smooth shading happens only on a separate display copy (`viewer.js`). `tests/unit/picking.test.js` guards this.
- **Triangle meshes only.** PLY files with quads or polygons are refused, not triangulated (triangulating would shift face numbers). Point clouds are refused.
- **3D only.** The format (v0.2) also defines 2D image data; this app refuses 2D templates and image sources with a clear message.
- **Landmark JSON format**, spec in `docs/landmark-json-spec.md`. Files are written as 0.2.0, or 0.3.0 for a replicate after the first; re-saving a newer file keeps its version; files up to 0.3 are read. Unknown fields in an opened file must survive a save. Missing values are `null` in JSON, never a sentinel number.
- **Sets, replicates, hand-ins and combining follow the 2D app (landmarker2D)**: same export IDs (`_<operator>` when a specimen has several operators, `_r<n>` when any has replicates), same file names (`<id>_r<n>.lmk.json`), same hand-in contents, same CSV columns (plus `z`). Change them in both apps together.
- **At most three meshes in memory** (`MeshStore`), because some surfaces have a million triangles or more. A specimen's landmarks never depend on its mesh being loaded.
- **`vertex_count` / `face_count` are raw file counts** (for STL, vertices = 3 × faces).
- **Plain JavaScript, ES modules, no build step.** Dependencies load from jsDelivr through the import map in `index.html` at pinned versions. `package.json` pins the same versions for the tests; change both together.

## Code map

| File | Role |
|---|---|
| `index.html` | Page, styles (colour tokens, light and dark), import map |
| `js/main.js` | Wiring: viewer, panels, tabs, keyboard, drag and drop, messages, dialog |
| `js/specimens.js` | The set on screen: opening meshes into specimens, showing one, thumbnails, snapping |
| `js/mesh-store.js` | Loaded meshes (at most three), least recently used unloaded first |
| `js/specimen-strip.js` | Thumbnail strip under the 3D view |
| `js/specimen-panel.js` | Specimen tab: ID, notes, units, replicates, repeatability, removing a specimen |
| `js/viewer.js` | three.js scene, camera framing, shading, CSS2D label layer |
| `js/mesh-loader.js` | STL/PLY reading, raw counts, SHA-256, triangle-only checks |
| `js/picking.js` | BVH raycasting, anchors (face + barycentric), snapping, occlusion |
| `js/markers.js` | Landmark spheres and labels; labels hide behind the surface |
| `js/interaction.js` | Click to place, drag markers, click vs. rotate detection |
| `js/session.js` | The set: shared template, specimen records with their points, statuses, undo/redo over the whole set, template edits, `checkTemplate` |
| `js/set-model.js` | Set rules shared with 2D: export IDs, replicates, file names, template matching, repeatability |
| `js/landmark-panel.js` | Landmarks tab |
| `js/template-editor.js` | Template tab |
| `js/files-panel.js` | File tab: operator, save/open, opening files into the set, hand-in, TPS/CSV export, combining |
| `js/landmark-file.js` | Build and parse `.lmk.json` |
| `js/tps.js` | TPS writer |
| `js/csv.js` | CSV writer (long format) |
| `js/handin.js` | Hand-in zip contents, reading zips, combining hand-ins |
| `js/zip.js` | Small zip writer and reader (same as 2D) |
| `js/file-io.js` | Saving: Save dialog (Chrome/Edge), claude.ai download capability, plain download |
| `js/sample.js` | Generated example mesh shown at start |

All changes to landmarks and the template go through `Session`, which fires a `change` event the panels and markers listen to. `session.points` is always the current specimen's; `session.records` is the set. When the current specimen changes (switching, undo, removing one), `main.js` asks `specimens.show()` to put its mesh on screen. `window.__lmk` exposes the app for the browser tests.

## Tests

`npm test` (unit, ~1 s) and `npm run test:e2e` (headless Chromium, ~1 min). Both run in CI on every push. Add a test with every fix or feature; the browser tests catch problems the unit tests can't (one already caught the loading overlay never hiding on a plain host). Test meshes are generated in `tests/fixtures.js`.

## Deployment

GitHub Pages is published by `.github/workflows/pages.yml` after the Tests workflow passes on `main` (Pages source: "GitHub Actions"). Pushes from Claude sessions don't trigger GitHub's "deploy from a branch" build, which is why this workflow exists. The version in the page header (`v0.2`) shows which version is live.

## Writing for the UI

Short, plain sentences from the student's side of the screen. Errors say what went wrong and what to do about it. No jargon a biology student wouldn't know.

## Decided

- Hosting on GitHub Pages; plain JS first, Vite/TypeScript only if the code base needs it.
- Template embedded in every landmark file by default; landmark IDs are stable codes (`LM01`) with a separate display name.
- File extension `.lmk.json`, format name `landmark-json`.
- Statuses: `placed`, `estimated`, `missing`; a template landmark with no entry is "to do".
- TPS: `LM3=` blocks, rows in template export order, ad hoc points last (only when every specimen has the same ones), missing as `-999` (configurable).
- Specimen sets with a thumbnail strip (counts red until done, then green), `[`/`]` to switch, at most three meshes loaded. No autosave in 3D (decided 2026-11-07).
- Replicates: `specimen.replicate` (v0.3); earlier replicates hidden while placing; template order by default, random order as an option.

## Not done yet

- A gallery comparing one landmark across specimens (the 2D app's Compare view); in 3D it needs its own design because of the three-mesh limit.
- Curves with equidistant semilandmarks (spec section "Curves", v0.2), and the geomorph curve-sliding file.
- Saving and opening templates as separate `.template.json` files; opening landmark files that reference one (currently refused).
- A JSON Schema file for the format.
- Deferred: Slicer `.mrk.json` export.
