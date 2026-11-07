# Landmarker3D

A lightweight tool for placing 3D landmarks on surface meshes, in the browser. Open an STL or PLY file, place the landmarks of a template by clicking on the surface, and save them as a Landmark JSON file or export them as TPS for geomorph and other morphometrics software.

**Open the app: https://benceviola.github.io/Landmarker3D/**

Nothing to install. Meshes are read on your own computer and never uploaded.

## What it does

- Opens binary and ASCII **STL** and **PLY** triangle meshes, including large ones (a few million triangles).
- **Specimen sets**: open several meshes at once. A strip under the 3D view shows each specimen with a picture and how many landmarks are done; `[` and `]` switch. Up to three meshes are kept in memory; the others are read again from their files when you switch to them.
- **Templates** define which landmarks to place and in which order, with placement instructions and left/right pairs. Edit them in the Template tab.
- **Placing**: click the mesh to place the current landmark; the app moves on to the next one. Drag a marker to move it. Mark landmarks as *missing* or *estimated*, add notes, and add ad hoc points that are not in the template. Undo and redo cover everything.
- **Landmark files** (`.lmk.json`): one file per specimen with the template, every point and the mesh's SHA-256, so a file is never applied to the wrong mesh by accident. The format is documented in [`docs/landmark-json-spec.md`](docs/landmark-json-spec.md).
- **Replicates**: landmark a specimen again (optionally in random order) to check how reliably landmarks are placed. Earlier points stay hidden, and a repeatability summary shows how far apart replicates landed, in mm.
- **Hand-in**: one zip with a landmark file for every specimen plus TPS and CSV, named after the student. Opening the zip again resumes the set.
- **TPS and CSV export** of the whole set, and **Combine hand-ins** for instructors: several students' zips into one TPS and CSV. Specimens done by more than one student get the student's name in their ID; replicates get `_r1`, `_r2`.

Coordinates are always in the mesh file's own coordinate system: the app never moves, centres or scales the mesh.

## Keyboard

| Key | Action |
|---|---|
| click | place the current landmark |
| drag a marker | move it over the surface |
| drag / right-drag / scroll | rotate / pan / zoom |
| N, P | next / previous landmark |
| [, ] | previous / next specimen |
| M, E, Delete | missing, estimated, clear |
| Ctrl/⌘ Z, Ctrl/⌘ Shift Z | undo, redo |
| Ctrl/⌘ S | save the landmark file |
| F, H | fit the view, default view |

## Browsers

Works in current Chrome, Edge, Firefox and Safari. In Chrome and Edge, Save writes back to the same file; Firefox and Safari download a new copy each time.

## Development

Plain JavaScript modules with no build step. three.js and three-mesh-bvh load from a CDN at pinned versions (see the import map in `index.html`).

```sh
npm install
npm test                         # unit tests
npx playwright install chromium  # once
npm run test:e2e                 # browser tests
```

To try changes locally, serve the folder with any static server, e.g. `npx serve .`, and open the address it prints. Opening `index.html` straight from disk does not work, because browsers block module scripts from `file://` addresses.

More detail on the code and the decisions behind it: [`CLAUDE.md`](CLAUDE.md). Tests: [`tests/README.md`](tests/README.md).
