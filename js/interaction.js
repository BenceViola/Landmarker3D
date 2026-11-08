// Mouse and touch handling on the 3D view.
//
//   click on the surface   place the active landmark there, then move on
//   click on a marker      select that landmark
//   drag a marker          slide it over the surface
//   (a curve's clicked points, the small diamonds, work like markers)
//   drag anywhere else     rotate / pan / zoom (TrackballControls)
//
// A press only counts as a click if the pointer barely moved, so rotating
// the view never drops a landmark by accident.

import { parseCpKey } from './session.js';

const CLICK_SLOP = 5; // px
const CLICK_TIME = 600; // ms

// `intercept(hit)` may take a click on the 3D view for another tool (e.g.
// clicking the points of a plane); return true to stop it placing a landmark.
export function attachInteraction({ viewer, picker, markers, curves = null, session, intercept = null }) {
  const markerAt = (x, y) => markers.hitTest(x, y) || curves?.hitTest(x, y) || null;
  // A curve point's key ("C01#2") selects its curve.
  const select = (key) => {
    const id = parseCpKey(key)?.id ?? key;
    if (session.activeId !== id) session.setActive(id);
  };
  const canvas = viewer.renderer.domElement;
  const stage = viewer.container;
  let press = null;
  let hoverQueued = null;

  // Capture phase: runs before TrackballControls sees the event, so a press
  // on a marker can switch the camera controls off for the drag.
  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target !== canvas) return;
      if (!e.isPrimary) {
        press = null; // second finger: a pinch, not a click
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const markerId = markerAt(e.clientX, e.clientY);
      press = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        time: performance.now(),
        markerId,
        moved: false,
        dragging: false,
      };
      if (markerId) {
        viewer.controls.enabled = false;
        canvas.setPointerCapture(e.pointerId);
      }
    },
    { capture: true }
  );

  window.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.pointerId) {
      const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (dist > CLICK_SLOP) press.moved = true;
      if (press.markerId) {
        if (!press.dragging && dist > 3) {
          press.dragging = true;
          session.beginMove();
          select(press.markerId);
          canvas.style.cursor = 'grabbing';
        }
        if (press.dragging) {
          const hit = picker.pickAt(e.clientX, e.clientY);
          if (hit) session.moveTo(press.markerId, hit);
        }
      }
      return;
    }
    if (e.target === canvas && e.buttons === 0) queueHover(e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', (e) => finish(e, false));
  window.addEventListener('pointercancel', (e) => finish(e, true));

  function finish(e, cancelled) {
    if (!press || e.pointerId !== press.pointerId) return;
    const p = press;
    press = null;

    if (p.markerId) {
      viewer.controls.enabled = true;
      canvas.style.cursor = '';
      if (p.dragging) session.endMove();
      else if (!cancelled) select(p.markerId);
      return;
    }
    if (cancelled || p.moved || performance.now() - p.time > CLICK_TIME) return;
    const hit = picker.pickAt(e.clientX, e.clientY);
    if (intercept?.(hit)) return;
    if (!session.activeId) return;
    if (hit) session.place(session.activeId, hit);
  }

  // Cursor feedback, at most once per frame.
  function queueHover(x, y) {
    const first = !hoverQueued;
    hoverQueued = { x, y };
    if (!first) return;
    requestAnimationFrame(() => {
      const { x: hx, y: hy } = hoverQueued;
      hoverQueued = null;
      if (press) return;
      if (markerAt(hx, hy)) canvas.style.cursor = 'grab';
      else if (session.activeId && picker.pickAt(hx, hy)) canvas.style.cursor = 'crosshair';
      else canvas.style.cursor = '';
    });
  }
}
