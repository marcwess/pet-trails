import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Pair, Polygon, Ring } from 'polygon-clipping';

const pc = polygonClipping;
const SCALE = 16;
const MIN_AREA = 0.75;
const SIMPLIFY = 0.1;
const MAX_RING = 240;

export type { MultiPolygon, Pair, Polygon, Ring };

export function cloneMulti(mp: MultiPolygon): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => ring.map((p) => [p[0], p[1]] as Pair)));
}

export function signedArea(ring: Ring): number {
  let a = 0;
  const n = ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

export function multiArea(mp: MultiPolygon): number {
  let a = 0;
  for (const poly of mp) {
    if (poly.length === 0) continue;
    a += Math.abs(signedArea(poly[0]!));
    for (let h = 1; h < poly.length; h++) a -= Math.abs(signedArea(poly[h]!));
  }
  return Math.max(0, a);
}

function samePt(a: Pair, b: Pair): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

function onSeg(x: number, y: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  if (Math.abs(cross) > 1e-7) return false;
  const dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay);
  if (dot < -1e-7) return false;
  const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
  return dot <= len2 + 1e-7;
}

/** Boundary counts as inside when `edgeInside` is set. */
export function ringContains(ring: Ring, x: number, y: number, edgeInside: boolean): boolean {
  const n = ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
  if (n < 3) return false;
  if (edgeInside) {
    for (let i = 0; i < n; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % n]!;
      if (onSeg(x, y, p[0], p[1], q[0], q[1])) return true;
    }
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    if (yi === yj) continue;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function multiContains(mp: MultiPolygon, x: number, y: number): boolean {
  for (const poly of mp) {
    if (poly.length === 0) continue;
    if (!ringContains(poly[0]!, x, y, true)) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (ringContains(poly[h]!, x, y, false)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function closeRing(pts: Pair[]): Ring | null {
  if (pts.length < 3) return null;
  const out: Pair[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && samePt(last, p)) continue;
    out.push([p[0], p[1]]);
  }
  if (out.length >= 2 && samePt(out[0]!, out[out.length - 1]!)) out.pop();
  if (out.length < 3) return null;
  out.push([out[0]![0], out[0]![1]]);
  return out;
}

function dropCollinear(ring: Ring): Ring | null {
  const n = ring.length - 1;
  const kept: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % n]!;
    const ax = cur[0] - prev[0];
    const ay = cur[1] - prev[1];
    const bx = next[0] - cur[0];
    const by = next[1] - cur[1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const sin = Math.abs(ax * by - ay * bx) / (la * lb);
    if (sin < 0.035) continue;
    kept.push([cur[0], cur[1]]);
  }
  return closeRing(kept);
}

/** Remove vertices where the path reverses on itself (boolean spikes). */
function despike(ring: Ring): Ring | null {
  let cur = ring;
  for (let pass = 0; pass < 4; pass++) {
    const n = cur.length - 1;
    if (n < 4) break;
    const kept: Pair[] = [];
    let removed = false;
    for (let i = 0; i < n; i++) {
      const prev = cur[(i - 1 + n) % n]!;
      const p = cur[i]!;
      const next = cur[(i + 1) % n]!;
      const ax = p[0] - prev[0];
      const ay = p[1] - prev[1];
      const bx = next[0] - p[0];
      const by = next[1] - p[1];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la > 1e-6 && lb > 1e-6 && (ax / la) * (bx / lb) + (ay / la) * (by / lb) < -0.62) {
        removed = true;
        continue;
      }
      kept.push([p[0], p[1]]);
    }
    const next = closeRing(kept);
    if (!next) return cur;
    cur = next;
    if (!removed) break;
  }
  return cur;
}

function douglasPeucker(pts: Pair[], eps: number): Pair[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestD = 0;
    const ax = pts[a]![0];
    const ay = pts[a]![1];
    const bx = pts[b]![0];
    const by = pts[b]![1];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i]![0];
      const py = pts[i]![1];
      let d = 0;
      if (len2 < 1e-12) d = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
        const cx = ax + vx * t;
        const cy = ay + vy * t;
        d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD > eps2) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: Pair[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]!);
  return out;
}

function simplifyRing(ring: Ring, eps: number): Ring | null {
  const n = ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
  const open: Pair[] = [];
  for (let i = 0; i < n; i++) open.push([ring[i]![0], ring[i]![1]]);
  const simp = douglasPeucker(open, eps);
  return closeRing(simp);
}

function orient(ring: Ring, ccw: boolean): Ring {
  const positive = signedArea(ring) > 0;
  if (positive === ccw) return ring;
  const n = ring.length - 1;
  const out: Pair[] = [];
  for (let i = n - 1; i >= 0; i--) out.push([ring[i]![0], ring[i]![1]]);
  out.push([out[0]![0], out[0]![1]]);
  return out;
}

function sanitize(mp: MultiPolygon, eps = SIMPLIFY): MultiPolygon {
  const out: MultiPolygon = [];
  for (const poly of mp) {
    const rings: Ring[] = [];
    for (let r = 0; r < poly.length; r++) {
      let ring = closeRing(poly[r]!);
      if (!ring) continue;
      ring = dropCollinear(ring) ?? ring;
      ring = despike(ring) ?? ring;
      let tol = eps;
      ring = simplifyRing(ring, tol) ?? ring;
      while (ring.length - 1 > MAX_RING && tol < 1.2) {
        tol *= 1.6;
        ring = simplifyRing(ring, tol) ?? ring;
      }
      const area = Math.abs(signedArea(ring));
      if (area < MIN_AREA) continue;
      rings.push(orient(ring, r === 0));
    }
    if (rings.length > 0 && Math.abs(signedArea(rings[0]!)) >= MIN_AREA) out.push(rings);
  }
  return out;
}

function safeUnion(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0) return cloneMulti(b);
  if (b.length === 0) return cloneMulti(a);
  try {
    return pc.union(a, b);
  } catch {
    return cloneMulti(a);
  }
}

function safeDiff(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0 || b.length === 0) return cloneMulti(a);
  try {
    return pc.difference(a, b);
  } catch {
    return cloneMulti(a);
  }
}

function safeInter(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0 || b.length === 0) return [];
  try {
    return pc.intersection(a, b);
  } catch {
    return [];
  }
}

function rectPoly(x: number, y: number, w: number, h: number): Polygon {
  return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
}

interface Snap {
  edge: number;
  t: number;
  x: number;
  y: number;
  dist: number;
}

function projectRing(ring: Ring, x: number, y: number): Snap | null {
  const n = ring.length - 1;
  if (n < 3) return null;
  let best: Snap | null = null;
  for (let i = 0; i < n; i++) {
    const ax = ring[i]![0];
    const ay = ring[i]![1];
    const bx = ring[(i + 1) % n]![0];
    const by = ring[(i + 1) % n]![1];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = 0;
    if (len2 > 1e-12) t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
    const px = ax + vx * t;
    const py = ay + vy * t;
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.dist) best = { edge: i, t, x: px, y: py, dist: d };
  }
  return best;
}

function walkArc(ring: Ring, from: Snap, to: Snap, dir: 1 | -1): Pair[] {
  const n = ring.length - 1;
  const pts: Pair[] = [[from.x, from.y]];
  const same = from.edge === to.edge;
  if (dir === 1 && same && to.t >= from.t - 1e-8) {
    pts.push([to.x, to.y]);
    return pts;
  }
  if (dir === -1 && same && to.t <= from.t + 1e-8) {
    pts.push([to.x, to.y]);
    return pts;
  }
  let e = from.edge;
  for (let k = 0; k < n + 1; k++) {
    if (dir === 1) {
      const v = ring[(e + 1) % n]!;
      pts.push([v[0], v[1]]);
      e = (e + 1) % n;
    } else {
      const v = ring[e]!;
      pts.push([v[0], v[1]]);
      e = (e - 1 + n) % n;
    }
    if (e === to.edge) break;
  }
  pts.push([to.x, to.y]);
  return pts;
}

function ringBBox(pts: Pair[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

function farCorner(mp: MultiPolygon, box: { minX: number; minY: number; maxX: number; maxY: number }, mapW: number, mapH: number): boolean {
  const pad = 8;
  const corners: Pair[] = [
    [0.4, 0.4],
    [mapW - 0.4, 0.4],
    [0.4, mapH - 0.4],
    [mapW - 0.4, mapH - 0.4],
  ];
  for (const c of corners) {
    if (!multiContains(mp, c[0], c[1])) continue;
    if (c[0] < box.minX - pad || c[0] > box.maxX + pad || c[1] < box.minY - pad || c[1] > box.maxY + pad) return true;
  }
  return false;
}

export function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 1e-12) t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  const cx = ax + vx * t;
  const cy = ay + vy * t;
  return Math.hypot(px - cx, py - cy);
}

/** True when any polyline vertex in `[start, end)` comes within `radius` of the segment. */
export function polylineNearSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  start: number,
  end: number,
  radius: number,
): boolean {
  for (let i = start; i < end; i++) {
    if (distPointSeg(xs[i]!, ys[i]!, ax, ay, bx, by) <= radius) return true;
  }
  return false;
}

function centroidOf(mp: MultiPolygon): { x: number; y: number } | null {
  let aSum = 0;
  let x = 0;
  let y = 0;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r]!;
      const n = ring.length - 1;
      let a = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        const cross = p[0] * q[1] - q[0] * p[1];
        a += cross;
        cx += (p[0] + q[0]) * cross;
        cy += (p[1] + q[1]) * cross;
      }
      a *= 0.5;
      const sign = r === 0 ? 1 : -1;
      if (Math.abs(a) < 1e-8) continue;
      aSum += sign * a;
      x += sign * cx;
      y += sign * cy;
    }
  }
  if (Math.abs(aSum) < 1e-8) return null;
  return { x: x / (6 * aSum), y: y / (6 * aSum) };
}

function boundsOf(mp: MultiPolygon): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const p of ring) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointInRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/**
 * One owner's territory is a multi-polygon with holes. Gameplay queries use
 * point-in-polygon. A claim unions the trail loop and subtracts it from everyone else.
 */
export class LandBook {
  readonly area: Float64Array;
  private readonly cx: Float64Array;
  private readonly cy: Float64Array;
  private readonly multi: MultiPolygon[];
  private readonly dirty = new Set<number>();
  private added: MultiPolygon = [];
  private pending: MultiPolygon | null = null;
  private pendingId = 0;

  constructor(
    private readonly maxId: number,
    readonly mapW: number,
    readonly mapH: number,
  ) {
    this.area = new Float64Array(maxId + 1);
    this.cx = new Float64Array(maxId + 1);
    this.cy = new Float64Array(maxId + 1);
    this.multi = [];
    for (let i = 0; i <= maxId; i++) this.multi.push([]);
  }

  beginTick(): void {
    this.dirty.clear();
  }

  changedIds(): number[] {
    return [...this.dirty];
  }

  areaOf(id: number): number {
    return this.area[id] ?? 0;
  }

  home(id: number): { x: number; y: number } | null {
    if ((this.area[id] ?? 0) <= 0) return null;
    return { x: this.cx[id]!, y: this.cy[id]! };
  }

  get(id: number): MultiPolygon {
    return this.multi[id] ?? [];
  }

  contains(id: number, x: number, y: number): boolean {
    const mp = this.multi[id];
    if (!mp || mp.length === 0) return false;
    return multiContains(mp, x, y);
  }

  /** Topmost owner, or 0. Overlaps should already have been subtracted. */
  ownerAt(x: number, y: number): number {
    for (let id = 1; id <= this.maxId; id++) {
      if (this.multi[id]!.length > 0 && multiContains(this.multi[id]!, x, y)) return id;
    }
    return 0;
  }

  pointInAdded(x: number, y: number): boolean {
    return this.added.length > 0 && multiContains(this.added, x, y);
  }

  clear(id: number): void {
    if (id < 1 || id > this.maxId) return;
    this.multi[id] = [];
    this.area[id] = 0;
    this.cx[id] = 0;
    this.cy[id] = 0;
    this.dirty.add(id);
  }

  /** Union an axis-aligned rectangle into this owner's land. */
  unionRect(id: number, x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const rect: MultiPolygon = [rectPoly(x, y, w, h)];
    const next = sanitize(this.clip(safeUnion(this.multi[id]!, rect)), 0.02);
    this.multi[id] = next.length > 0 ? next : rect;
    this.recompute(id);
  }

  /**
   * Build the claim loop (trail plus the boundary arc) and remember the region
   * that would be added. Returns false when the trail does not close a region.
   */
  prepareClaim(id: number, xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): boolean {
    this.added = [];
    this.pending = null;
    this.pendingId = 0;
    const loop = this.buildLoop(id, xs, ys, n);
    if (!loop) return false;
    const own = this.multi[id]!;
    let added = own.length === 0 ? loop : sanitize(this.clip(safeDiff(loop, own)));
    if (own.length === 0) added = sanitize(added);
    if (multiArea(added) < 0.5) return false;
    this.pending = loop;
    this.pendingId = id;
    this.added = added;
    return true;
  }

  /** Union the prepared loop and subtract it from every other owner. */
  commitClaim(id: number): number {
    if (this.pendingId !== id || !this.pending) return 0;
    const before = this.area[id] ?? 0;
    const loop = this.pending;
    const next = sanitize(this.clip(safeUnion(this.multi[id]!, loop)));
    this.multi[id] = next.length > 0 ? next : this.multi[id]!;
    this.recompute(id);
    const box = boundsOf(loop);
    for (let o = 1; o <= this.maxId; o++) {
      if (o === id || this.multi[o]!.length === 0) continue;
      if (box && !boxesOverlap(box, boundsOf(this.multi[o]!), 0.5)) continue;
      const prev = this.area[o] ?? 0;
      const diff = sanitize(this.clip(safeDiff(this.multi[o]!, loop)));
      const nextArea = multiArea(diff);
      if (Math.abs(nextArea - prev) < 0.05) continue;
      this.multi[o] = diff;
      this.recompute(o);
    }
    this.pending = null;
    this.pendingId = 0;
    return (this.area[id] ?? 0) - before;
  }

  /** True when the rectangle intersects land owned by anyone except `ignore`. */
  hitsExcept(ignore: number, x: number, y: number, w: number, h: number): boolean {
    const x1 = x + w;
    const y1 = y + h;
    for (let id = 1; id <= this.maxId; id++) {
      if (id === ignore) continue;
      const mp = this.multi[id]!;
      if (mp.length === 0) continue;
      if (multiHitsRect(mp, x, y, x1, y1)) return true;
    }
    return false;
  }

  vertexCount(): number {
    let n = 0;
    for (let id = 1; id <= this.maxId; id++) n += countVerts(this.multi[id]!);
    return n;
  }

  vertsOf(id: number): number {
    return countVerts(this.multi[id] ?? []);
  }

  audit(): boolean {
    for (let id = 1; id <= this.maxId; id++) {
      const area = multiArea(this.multi[id]!);
      if (!Number.isFinite(area) || area < -0.01) return false;
      if (Math.abs(area - (this.area[id] ?? 0)) > 0.05) return false;
    }
    return true;
  }

  encode(ids: number[]): number[] {
    const out: number[] = [];
    for (const id of ids) {
      const mp = this.multi[id] ?? [];
      out.push(id, mp.length);
      for (const poly of mp) {
        out.push(poly.length);
        for (const ring of poly) {
          const closed = ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!);
          const n = closed ? ring.length - 1 : ring.length;
          out.push(n);
          for (let i = 0; i < n; i++) {
            out.push(Math.round(ring[i]![0] * SCALE), Math.round(ring[i]![1] * SCALE));
          }
        }
      }
    }
    return out;
  }

  encodeAll(): number[] {
    const ids: number[] = [];
    for (let id = 1; id <= this.maxId; id++) if (this.multi[id]!.length > 0) ids.push(id);
    return this.encode(ids);
  }

  /** Replace the listed owners with the decoded polygons. */
  applyEncoded(data: ArrayLike<number>): void {
    let i = 0;
    while (i + 1 < data.length) {
      const id = data[i++]!;
      const polyCount = data[i++]!;
      if (id < 1 || id > this.maxId || polyCount < 0 || polyCount > 64) return;
      const mp: MultiPolygon = [];
      for (let p = 0; p < polyCount; p++) {
        if (i >= data.length) return;
        const ringCount = data[i++]!;
        if (ringCount < 1 || ringCount > 32) return;
        const poly: Polygon = [];
        for (let r = 0; r < ringCount; r++) {
          if (i >= data.length) return;
          const n = data[i++]!;
          if (n < 3 || n > 2000 || i + n * 2 > data.length) return;
          const ring: Ring = [];
          for (let k = 0; k < n; k++) {
            ring.push([data[i++]! / SCALE, data[i++]! / SCALE]);
          }
          ring.push([ring[0]![0], ring[0]![1]]);
          poly.push(ring);
        }
        mp.push(poly);
      }
      this.multi[id] = mp;
      this.recompute(id);
    }
  }

  private clip(mp: MultiPolygon): MultiPolygon {
    if (mp.length === 0) return [];
    const map: MultiPolygon = [rectPoly(0, 0, this.mapW, this.mapH)];
    return safeInter(mp, map);
  }

  private recompute(id: number): void {
    const mp = this.multi[id]!;
    this.area[id] = multiArea(mp);
    const c = centroidOf(mp);
    this.cx[id] = c?.x ?? 0;
    this.cy[id] = c?.y ?? 0;
    this.dirty.add(id);
  }

  private buildLoop(id: number, xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): MultiPolygon | null {
    if (n < 3) return null;
    const raw: Pair[] = [];
    for (let i = 0; i < n; i++) {
      const p: Pair = [xs[i]!, ys[i]!];
      const last = raw[raw.length - 1];
      if (last && samePt(last, p)) continue;
      raw.push(p);
    }
    if (raw.length < 3) return null;
    const simplified = douglasPeucker(raw, 0.08);
    const trail = simplified.length >= 3 ? simplified : raw;
    const own = this.multi[id]!;
    const start = nearestSnap(own, trail[0]![0], trail[0]![1], 2);
    const end = nearestSnap(own, trail[trail.length - 1]![0], trail[trail.length - 1]![1], 2);
    const box = ringBBox(trail);
    const candidates: MultiPolygon[] = [];
    if (start && end && start.poly === end.poly) {
      const ring = own[start.poly]![0]!;
      for (const dir of [1, -1] as const) {
        const arc = walkArc(ring, end.snap, start.snap, dir);
        const pts: Pair[] = [[start.snap.x, start.snap.y]];
        for (let i = 1; i < trail.length - 1; i++) pts.push(trail[i]!);
        pts.push([end.snap.x, end.snap.y]);
        for (let i = 1; i < arc.length; i++) pts.push(arc[i]!);
        const closed = closeRing(pts);
        if (!closed) continue;
        const poly = orient(closed, true);
        if (Math.abs(signedArea(poly)) < 0.4) continue;
        candidates.push([[poly]]);
      }
    }
    const straight = closeRing(trail);
    if (straight && Math.abs(signedArea(straight)) >= 0.4) candidates.push([[orient(straight, true)]]);
    let best: MultiPolygon | null = null;
    let bestArea = Infinity;
    for (const cand of candidates) {
      const clipped = this.clip(cand);
      if (clipped.length === 0) continue;
      const added = own.length === 0 ? clipped : safeDiff(clipped, own);
      const area = multiArea(added);
      if (area < 0.5) continue;
      if (farCorner(added, box, this.mapW, this.mapH)) continue;
      if (area < bestArea) {
        bestArea = area;
        best = clipped;
      }
    }
    if (!best) {
      for (const cand of candidates) {
        const clipped = this.clip(cand);
        const added = own.length === 0 ? clipped : safeDiff(clipped, own);
        const area = multiArea(added);
        if (area < 0.5) continue;
        if (area < bestArea) {
          bestArea = area;
          best = clipped;
        }
      }
    }
    return best;
  }
}

function nearestSnap(
  mp: MultiPolygon,
  x: number,
  y: number,
  maxDist: number,
): { poly: number; snap: Snap } | null {
  let best: { poly: number; snap: Snap } | null = null;
  for (let i = 0; i < mp.length; i++) {
    const ring = mp[i]![0];
    if (!ring) continue;
    const snap = projectRing(ring, x, y);
    if (!snap || snap.dist > maxDist) continue;
    if (!best || snap.dist < best.snap.dist) best = { poly: i, snap };
  }
  return best;
}

function boxesOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number } | null,
  pad: number,
): boolean {
  if (!b) return false;
  return a.minX - pad <= b.maxX && a.maxX + pad >= b.minX && a.minY - pad <= b.maxY && a.maxY + pad >= b.minY;
}

function countVerts(mp: MultiPolygon): number {
  let n = 0;
  for (const poly of mp) {
    for (const ring of poly) {
      const closed = ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!);
      n += closed ? ring.length - 1 : ring.length;
    }
  }
  return n;
}

function multiHitsRect(mp: MultiPolygon, x0: number, y0: number, x1: number, y1: number): boolean {
  const corners: Pair[] = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
    [(x0 + x1) / 2, (y0 + y1) / 2],
  ];
  for (const c of corners) if (multiContains(mp, c[0], c[1])) return true;
  const rectEdges: Array<[number, number, number, number]> = [
    [x0, y0, x1, y0],
    [x1, y0, x1, y1],
    [x1, y1, x0, y1],
    [x0, y1, x0, y0],
  ];
  for (const poly of mp) {
    for (const ring of poly) {
      const n = ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        if (pointInRect(a[0], a[1], x0, y0, x1, y1)) return true;
        for (const e of rectEdges) {
          if (segsCross(a[0], a[1], b[0], b[1], e[0], e[1], e[2], e[3])) return true;
        }
      }
    }
  }
  return false;
}
