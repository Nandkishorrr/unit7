// The minimap's maths: the whole layout shrunk into a small box, where the screen is inside it, and where the
// camera goes when you click or drag in it. Pure, so test/map-overview.test.ts checks it under Node.
export interface Box { x: number; y: number; w: number; h: number }
export interface Cam { x: number; y: number; k: number } // screen = world * k + (x, y)
export interface Size { w: number; h: number }

// the scale that fits the world in the box, and the box it really takes
export function miniFit(world: Box, max: Size): { s: number; w: number; h: number } {
  const s = Math.min(max.w / Math.max(1, world.w), max.h / Math.max(1, world.h));
  return { s, w: Math.round(world.w * s), h: Math.round(world.h * s) };
}

// the screen, as a rectangle in minimap pixels
export function viewRect(cam: Cam, vp: Size, world: Box, s: number): Box {
  return { x: (-cam.x / cam.k - world.x) * s, y: (-cam.y / cam.k - world.y) * s, w: (vp.w / cam.k) * s, h: (vp.h / cam.k) * s };
}

// a click at (px, py) in the minimap: the screen centres there, zoom unchanged
export function camAt(px: number, py: number, cam: Cam, vp: Size, world: Box, s: number): Cam {
  const wx = px / s + world.x, wy = py / s + world.y;
  return { k: cam.k, x: vp.w / 2 - wx * cam.k, y: vp.h / 2 - wy * cam.k };
}

// dragging the screen's rectangle by (dx, dy) minimap pixels: the world moves the other way, scaled up
export function camDrag(from: Cam, dx: number, dy: number, s: number): Cam {
  return { k: from.k, x: from.x - (dx / s) * from.k, y: from.y - (dy / s) * from.k };
}

// is a minimap point inside the screen's rectangle (so a press there drags it rather than jumping)
export const inside = (r: Box, px: number, py: number) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
