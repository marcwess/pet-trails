import type { MultiPolygon, Pair, Ring } from '@pet-trails/shared';
import { ShapeUtils, Vector2 } from 'three';

const RIM = 0.32;

export interface LandBuffers {
  fillPos: Float32Array;
  fillIdx: Uint16Array;
  rimPos: Float32Array;
  rimIdx: Uint16Array;
}

/** Triangulate an owner's polygons and an inset rim band. Empty land returns null. */
export function buildLand(mp: MultiPolygon, world: number): LandBuffers | null {
  if (mp.length === 0) return null;
  const fillP: number[] = [];
  const fillI: number[] = [];
  const rimP: number[] = [];
  const rimI: number[] = [];
  for (const poly of mp) {
    if (poly.length === 0) continue;
    const contour = openRing(poly[0]!);
    if (contour.length < 3) continue;
    const holes: Vector2[][] = [];
    const holeRings: Pair[][] = [];
    for (let h = 1; h < poly.length; h++) {
      const ring = openRing(poly[h]!);
      if (ring.length < 3) continue;
      holes.push(ring.map((p) => new Vector2(p[0], p[1])));
      holeRings.push(ring);
    }
    const shape = contour.map((p) => new Vector2(p[0], p[1]));
    const faces = ShapeUtils.triangulateShape(shape, holes);
    const base = fillP.length / 3;
    const all = [contour, ...holeRings];
    for (const ring of all) {
      for (const p of ring) {
        fillP.push(p[0] * world, 0.07, p[1] * world);
      }
    }
    for (const face of faces) {
      fillI.push(base + face[0]!, base + face[1]!, base + face[2]!);
    }
    pushRim(contour, mp, world, rimP, rimI);
    for (const hole of holeRings) pushRim(hole, mp, world, rimP, rimI);
  }
  if (fillI.length < 3) return null;
  const fillPos = Float32Array.from(fillP);
  const fillIdx = Uint16Array.from(fillI);
  faceUp(fillPos, fillIdx);
  const rimPos = Float32Array.from(rimP);
  const rimIdx = Uint16Array.from(rimI);
  if (rimIdx.length >= 3) faceUp(rimPos, rimIdx);
  return { fillPos, fillIdx, rimPos, rimIdx };
}

function openRing(ring: Ring): Pair[] {
  const n = ring.length > 1 && near(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) out.push([ring[i]![0], ring[i]![1]]);
  return out;
}

function near(a: Pair, b: Pair): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

function faceUp(pos: Float32Array, idx: Uint16Array): void {
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    // Positive Y is (bz-az)*(cx-ax) - (bx-ax)*(cz-az). The camera looks down onto +Y.
    const cross = (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    if (cross < 0) {
      const tmp = idx[i + 1]!;
      idx[i + 1] = idx[i + 2]!;
      idx[i + 2] = tmp;
    }
  }
}

function pointIn(mp: MultiPolygon, x: number, y: number): boolean {
  for (const poly of mp) {
    if (poly.length === 0) continue;
    if (!ray(poly[0]!, x, y)) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) {
      if (ray(poly[h]!, x, y)) {
        hole = true;
        break;
      }
    }
    if (!hole) return true;
  }
  return false;
}

function ray(ring: Ring, x: number, y: number): boolean {
  const n = ring.length > 1 && near(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
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

function pushRim(ring: Pair[], mp: MultiPolygon, world: number, pos: number[], idx: number[]): void {
  const inner = inset(ring, mp);
  if (!inner) return;
  const n = ring.length;
  const base = pos.length / 3;
  for (let i = 0; i < n; i++) {
    pos.push(ring[i]![0] * world, 0.09, ring[i]![1] * world);
  }
  for (let i = 0; i < n; i++) {
    pos.push(inner[i]![0] * world, 0.09, inner[i]![1] * world);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(base + i, base + n + i, base + j, base + j, base + n + i, base + n + j);
  }
}

function inset(ring: Pair[], mp: MultiPolygon): Pair[] | null {
  const n = ring.length;
  if (n < 3) return null;
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % n]!;
    let ax = cur[0] - prev[0];
    let ay = cur[1] - prev[1];
    let bx = next[0] - cur[0];
    let by = next[1] - cur[1];
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;
    let nx = -ay - by;
    let ny = ax + bx;
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-5) {
      nx = -ay;
      ny = ax;
    } else {
      nx /= nl;
      ny /= nl;
    }
    const denom = nx * -ay + ny * ax;
    let miter = Math.abs(denom) > 0.35 ? RIM / denom : RIM;
    if (miter > RIM * 2.4) miter = RIM * 2.4;
    if (miter < -RIM * 2.4) miter = -RIM * 2.4;
    let ox = cur[0] + nx * miter;
    let oy = cur[1] + ny * miter;
    if (!pointIn(mp, ox, oy)) {
      ox = cur[0] - nx * Math.abs(miter);
      oy = cur[1] - ny * Math.abs(miter);
      if (!pointIn(mp, ox, oy)) {
        ox = cur[0] + nx * RIM * 0.5;
        oy = cur[1] + ny * RIM * 0.5;
      }
    }
    out.push([ox, oy]);
  }
  return out;
}
