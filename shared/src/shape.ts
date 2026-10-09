import { mulberry32 } from './rng.js';

/** Closed ring. The first point is repeated at the end. */
export type Loop = Array<[number, number]>;

export interface FenceHit {
  /** Closest point on the boundary. */
  x: number;
  y: number;
  /** Outward unit normal. */
  nx: number;
  ny: number;
  /** Unit tangent, walking the ring counter-clockwise. */
  tx: number;
  ty: number;
  /** Positive inside the loop, negative outside. */
  dist: number;
  inside: boolean;
}

function openLen(ring: Loop): number {
  const n = ring.length;
  if (n > 1) {
    const a = ring[0]!;
    const b = ring[n - 1]!;
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return n - 1;
  }
  return n;
}

export function ringArea(ring: Loop): number {
  const n = openLen(ring);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a * 0.5);
}

/** Smooth circle. `size` is the old spawn square's side; the disk is a bit smaller so a first loop matters. */
export function spawnRadius(size: number): number {
  const area = Math.max(1, size * size) * 0.72;
  return Math.sqrt(area / Math.PI);
}

export function circleRing(cx: number, cy: number, r: number, segments = 48): Loop {
  const n = Math.max(16, segments);
  const ring: Loop = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

/**
 * Organic map outline for a room seed. Radius is a smooth function of angle,
 * so the ring stays a simple closed curve with no corners.
 */
export function mapBlob(seed: number, w: number, h: number): Loop {
  const rng = mulberry32((seed ^ 0xa5a5a5a5) >>> 0);
  const controls = 8;
  const span = Math.min(w, h);
  const wide = span >= 80;
  const raw: number[] = [];
  const lo = wide ? 0.62 : 0.9;
  const hi = 1;
  for (let i = 0; i < controls; i++) raw.push(lo + rng() * (hi - lo));
  // One neighbor blend keeps a lobe from pinching, without flattening the silhouette.
  const smooth: number[] = [];
  for (let i = 0; i < controls; i++) {
    const prev = raw[(i - 1 + controls) % controls]!;
    const next = raw[(i + 1) % controls]!;
    smooth.push(raw[i]! * 0.62 + prev * 0.19 + next * 0.19);
  }
  const margin = Math.max(0.8, span * (wide ? 0.04 : 0.05));
  const base = span / 2 - margin;
  const cx = w / 2;
  const cy = h / 2;
  const samples = 16;
  const total = controls * samples;
  const ring: Loop = [];
  for (let i = 0; i < total; i++) {
    const f = i / samples;
    const i0 = Math.floor(f) % controls;
    const i1 = (i0 + 1) % controls;
    const t = f - Math.floor(f);
    const s = (1 - Math.cos(t * Math.PI)) * 0.5;
    const wobble = smooth[i0]! * (1 - s) + smooth[i1]! * s;
    const a = (i / total) * Math.PI * 2;
    const r = Math.max(1, base * wobble);
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

function pointInLoop(ring: Loop, x: number, y: number): boolean {
  const n = openLen(ring);
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    if (yi === yj) continue;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest boundary point, outward normal, and signed distance. */
export function fenceQuery(ring: Loop, x: number, y: number): FenceHit {
  const n = openLen(ring);
  let best = Infinity;
  let bx = x;
  let by = y;
  let tx = 1;
  let ty = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) continue;
    let t = ((x - p[0]) * dx + (y - p[1]) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = p[0] + dx * t;
    const py = p[1] + dy * t;
    const ddx = x - px;
    const ddy = y - py;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 < best) {
      best = d2;
      bx = px;
      by = py;
      const len = Math.sqrt(len2);
      tx = dx / len;
      ty = dy / len;
    }
  }
  const inside = pointInLoop(ring, x, y);
  const dist = Math.sqrt(best) * (inside ? 1 : -1);
  return { x: bx, y: by, nx: ty, ny: -tx, tx, ty, dist, inside };
}

/**
 * Keep a body inside the loop. A step through the fence is pulled back and
 * the outward part of the heading is dropped so the pet slides along the curve.
 */
export function containBody(
  body: { x: number; y: number; heading: number; desiredX: number; desiredY: number },
  ring: Loop,
  margin = 0.35,
): boolean {
  let hit = fenceQuery(ring, body.x, body.y);
  if (hit.dist >= margin) return false;
  body.x = hit.x - hit.nx * margin;
  body.y = hit.y - hit.ny * margin;
  hit = fenceQuery(ring, body.x, body.y);
  if (hit.dist < margin * 0.5) {
    body.x = hit.x - hit.nx * margin;
    body.y = hit.y - hit.ny * margin;
  }
  let vx = Math.cos(body.heading);
  let vy = Math.sin(body.heading);
  const out = vx * hit.nx + vy * hit.ny;
  if (out > 0) {
    vx -= hit.nx * out;
    vy -= hit.ny * out;
  }
  if (vx * vx + vy * vy < 1e-6) {
    const side = body.desiredX * hit.tx + body.desiredY * hit.ty >= 0 ? 1 : -1;
    vx = hit.tx * side;
    vy = hit.ty * side;
  }
  // A hair inward, so the next step stays on the curve instead of popping outside and snapping back.
  vx -= hit.nx * 0.14;
  vy -= hit.ny * 0.14;
  body.heading = Math.atan2(vy, vx);
  return true;
}
