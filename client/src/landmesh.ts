import type { MultiPolygon, Pair, Ring } from '@pet-trails/shared';
import { ShapeUtils, Vector2 } from 'three';

/**
 * Slab thickness in world units (~1.2 cells). A 0.3-cell lip is only a few
 * pixels under the play camera, so the wall is tall enough to read as a
 * paper.io slab while the flat top stays the exact owner color.
 */
export const SLAB_H = 0.36;

export interface LandBuffers {
  fillPos: Float32Array;
  fillIdx: Uint16Array;
  rimPos: Float32Array;
  rimIdx: Uint16Array;
  shadowPos: Float32Array;
  shadowIdx: Uint16Array;
}

/** Triangulate an owner's polygons, extrude the sides, and lay a contact shadow. */
export function buildLand(mp: MultiPolygon, world: number): LandBuffers | null {
  if (mp.length === 0) return null;
  const fillP: number[] = [];
  const fillI: number[] = [];
  const rimP: number[] = [];
  const rimI: number[] = [];
  const shadowP: number[] = [];
  const shadowI: number[] = [];
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
    let sx = 0;
    let sy = 0;
    let sn = 0;
    for (const ring of all) {
      for (const p of ring) {
        fillP.push(p[0] * world, SLAB_H, p[1] * world);
        sx += p[0];
        sy += p[1];
        sn++;
      }
    }
    for (const face of faces) {
      fillI.push(base + face[0]!, base + face[1]!, base + face[2]!);
    }
    const cx = sn > 0 ? sx / sn : contour[0]![0];
    const cy = sn > 0 ? sy / sn : contour[0]![1];
    const sBase = shadowP.length / 3;
    for (const ring of all) {
      for (const p of ring) {
        const ox = p[0] + (p[0] - cx) * 0.035 + 0.14;
        const oy = p[1] + (p[1] - cy) * 0.035 + 0.1;
        shadowP.push(ox * world, 0.012, oy * world);
      }
    }
    for (const face of faces) {
      shadowI.push(sBase + face[0]!, sBase + face[1]!, sBase + face[2]!);
    }
    pushWalls(contour, world, rimP, rimI);
    for (const hole of holeRings) pushWalls(hole, world, rimP, rimI);
  }
  if (fillI.length < 3) return null;
  const fillPos = Float32Array.from(fillP);
  const fillIdx = Uint16Array.from(fillI);
  faceUp(fillPos, fillIdx);
  const shadowPos = Float32Array.from(shadowP);
  const shadowIdx = Uint16Array.from(shadowI);
  if (shadowIdx.length >= 3) faceUp(shadowPos, shadowIdx);
  return {
    fillPos,
    fillIdx,
    rimPos: Float32Array.from(rimP),
    rimIdx: Uint16Array.from(rimI),
    shadowPos,
    shadowIdx,
  };
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
    const cross = (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    if (cross < 0) {
      const tmp = idx[i + 1]!;
      idx[i + 1] = idx[i + 2]!;
      idx[i + 2] = tmp;
    }
  }
}

/** Vertical quads with unique vertices so each face keeps its own normal. */
function pushWalls(ring: Pair[], world: number, pos: number[], idx: number[]): void {
  const n = ring.length;
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i]![0] * world;
    const z0 = ring[i]![1] * world;
    const x1 = ring[j]![0] * world;
    const z1 = ring[j]![1] * world;
    const base = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z1, x0, SLAB_H, z0, x1, SLAB_H, z1);
    idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
  }
}
