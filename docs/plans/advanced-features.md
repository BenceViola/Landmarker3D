# Advanced features: plan for the `advanced` branch

Started 2026-11-08. This branch is for features that need experimenting before students see them. `main` stays what students use on GitHub Pages; nothing here is published there until it is merged.

## How the branch works

- **Created from** `main` at `146b3a8` (specimen sets, replicates, Pages deployment).
- **Tests** run on GitHub for every push to this branch, as on `main`. Pages only publishes `main`.
- **Trying it out:** a separate claude.ai artifact, "Landmarker (experimental)", published from this branch, and the Pages workflow publishes this branch at `…/Landmarker3D/next/` (decided 2026-11-08), so it can be tried with real meshes in any browser without touching the student link.
- **Keeping up:** merge `main` into `advanced` after every change on `main`, so the two don't drift apart.
- **Merging back:** a feature goes to `main` once it is tested, the master spec covers anything it saves, and the 2D app has an answer for it where both apps should behave the same.
- **Format changes:** the master spec (the project's Claude Doc) is changed first, then copied to `docs/landmark-json-spec.md` in both repositories.

## 1. Planes

**Goal:** define a plane from three (or more) points, see it against the mesh, see exactly where it cuts the surface, and check how far landmarks lie from it, e.g. that midline landmarks really sit on the midsagittal plane.

### Defining a plane

- **From landmarks** (main use): "Midsagittal plane = LM01, LM03, LM06". It is defined once in the template, so it is the same on every specimen and updates when a landmark is moved.
- **From clicked points** (exploring): three clicks on the surface give a plane for this specimen only.
- **Three points** give the plane exactly. **More than three** give a best-fit (least-squares) plane, with the fit shown as the RMS distance of the points from it. For example, fit the plane through all midline landmarks and see which one is off.
- The plane is always computed from its points and never stored as numbers on its own, in keeping with the spec's rule that coordinates are the truth.

### Showing it

- **The plane itself:** a translucent square, sized to the mesh's bounding box, with its two sides tinted differently so it's clear which side is which.
- **Where it cuts the mesh:** a bright line drawn on the surface along the cut (the intersection contour). It is computed triangle by triangle: wherever a triangle's corners lie on both sides, a line segment is drawn. For a 2-million-triangle mesh this takes some tens of milliseconds, so it can update while a defining landmark is dragged (throttled).
- **Optional cut-away view:** hide everything on one side of the plane to look at the profile directly.
- **Distances:** a table of each landmark's signed distance from the plane in mm. Midline landmarks beyond a tolerance are flagged. For bilateral pairs, the difference between left and right distances gives a quick asymmetry check.

### Format (to decide)

Planes are not in the spec yet. The proposal for the master spec (v0.4, an optional addition, so a minor version):

- `template.planes`: `[{ "id": "PL01", "name": "Midsagittal", "landmarks": ["LM01", "LM03", "LM06"], "description": "…" }]`
- Planes from clicked points: for now a checking tool that is never saved (decided 2026-11-08). If they should be saved later, as a specimen-level `planes` list with `control_points` (like curves).

### Tests

Plane through three points and the best fit of noisy points (unit). The contour of a sphere cut through its centre is a circle of the sphere's radius (unit). Signed distances (unit). In the browser: define a plane from three landmarks, check the contour is drawn, and check the table values follow when a landmark is dragged.

## 2. Curves with equidistant semilandmarks

**Goal:** place a curve by clicking control points on the surface. The app spaces a set number of semilandmarks evenly along it and exports them with the landmarks, plus the file geomorph needs to slide them.

### Already settled

The master spec already defines curves (template definition and specimen entry) and their export order. Implementing them in 3D needs no format change.

### What carries over from the 2D app (landmarker2D `src/core.js`, `src/app.js`, `src/template-editor.js`)

- Template editor rows for curves: name, number of semilandmarks, optional start and end landmarks, closed loop.
- Placing by clicking control points. Backspace removes the last one; control points can be dragged; a curve can be cleared or marked missing.
- Resampling at equal arc length, with anchored ends excluded from `n_points` (the 2D `resample`), and the same rules for closed loops.
- Export order (landmarks, then curve points in curve order, then ad hoc points), CSV `type = curve` with `curve` and `index` columns, curves in "next to do", and repeatability per curve.

### What is new in 3D: following the surface

Between two control points the path must stay on the mesh. The spec allows two kinds of path:

- **`euclidean` (first):** straight segments between control points, sampled densely and pulled onto the nearest surface point (the BVH's closest-point search, already used for snapping). It's simple and fast, and fine when control points are reasonably close. Across a deep groove it can cut a corner; more control points fix that.
- **`geodesic` (second):** the shortest path across the surface. The plan:
  - a shortest-path search (Dijkstra) over the mesh's edges, limited to the region around the two points;
  - then a few rounds of shortening the path and pulling it back onto the surface, to remove the zigzag of following edges.
  - The search needs to know which triangles share vertices. STL files repeat each vertex, so this uses a welded copy (as for smooth shading), never the file's own geometry. Anchors still come from the source geometry, so face numbers stay those of the file.
- **Semilandmarks:** the dense path is resampled at equal arc length (in 3D), and each point is snapped to the surface for its `anchor` and `normal`.

### Showing and editing

The curve is drawn as a line on the surface, lifted slightly so it isn't hidden in the triangles, with dots for the semilandmarks and small handles for the control points. Dragging a handle recomputes the curve live.

### Sliding semilandmarks for geomorph

geomorph needs a "curves" table saying which point slides between which neighbours (before, slide, after), with row numbers matching the TPS file. The app can write it from the template:

- one row per semilandmark;
- anchored ends point to their landmarks' rows;
- closed loops wrap round.

It would be exported next to the TPS (and put in the hand-in zip). The 2D app doesn't have this yet; it should get the same file at the same time.

### Tests

- Port the 2D resampling tests.
- Every semilandmark lies on the surface (distance to the mesh ≈ 0).
- On a sphere, a geodesic between two points is within about 1–2 % of the great-circle distance; a euclidean path is never shorter than the straight chord.
- The sliders table for open, anchored and closed curves.
- In the browser: add a curve in the template, click control points, see n semilandmarks, and check that TPS rows = landmarks + curve points.

## Suggested order

1. **Curves with euclidean paths.** The format is already settled and 2D shows the way, so it's the quickest useful step.
2. **Planes**, once the format question is decided.
3. **Geodesic paths** for curves.
4. **The geomorph sliders file**, in both apps.

## Later (not on this branch yet)

- A gallery comparing one landmark across specimens (3D version, designed around the three-mesh limit).
- Templates as separate `.template.json` files.
- A JSON Schema for the format.

## Status

- 2026-11-08: planes done on this branch (spec v0.4 `template.planes`, Planes tab, planes from 3 clicks, cut line, cut-away, distance tables for midline landmarks and left/right pairs). Next: test with real meshes, then curves. Idea from testing planes: a curve could start from where a plane cuts the mesh.
