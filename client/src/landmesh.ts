import type { MultiPolygon, Pair, Ring } from '@pet-trails/shared';
import { ShapeUtils, Vector2 } from 'three';

/**
 * Slab thickness in world units. Tall enough that the lip reads as a paper.io
 * block under the play camera, while the flat top stays the exact owner color.
 */
export const SLAB_H = 0.62;

/** Darker shade of the owner hue, baked into the wall so it never depends on lights. */
const WALL_SHADE = 0.58;

export interface LandChunk {
  pos: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
}

export interface LandParts {
  top: LandChunk;
  wall: LandChunk;
}

/**
 * Triangulate every polygon of one owner. Tops carry the exact palette color
 * (linear, so the sRGB framebuffer round-trips). Walls are the same hue baked
 * darker, wound so the outside faces the camera on both outer rings and holes.
 */
export function buildLand(mp: MultiPolygon, world: number, rgb: readonly [number, number, number]): LandParts | null {
  if (mp.length === 0) return null;
  const topP: number[] = [];
  const topC: number[] = [];
  const topI: number[] = [];
  const wallP: number[] = [];
  const wallC: number[] = [];
  const wallI: number[] = [];
  const topCol = srgbByteToLinear(rgb[0], rgb[1], rgb[2]);
  const wallCol = srgbByteToLinear(rgb[0] * WALL_SHADE, rgb[1] * WALL_SHADE, rgb[2] * WALL_SHADE);
  for (const poly of mp) {
    if (poly.length === 0) continue;
    const contour = ensureWinding(openRing(poly[0]!), true);
    if (contour.length < 3) continue;
    const holes: Vector2[][] = [];
    const holeRings: Pair[][] = [];
    for (let h = 1; h < poly.length; h++) {
      const ring = ensureWinding(openRing(poly[h]!), false);
      if (ring.length < 3) continue;
      holes.push(ring.map((p) => new Vector2(p[0], p[1])));
      holeRings.push(ring);
    }
    const shape = contour.map((p) => new Vector2(p[0], p[1]));
    const faces = ShapeUtils.triangulateShape(shape, holes);
    const base = topP.length / 3;
    const all = [contour, ...holeRings];
    for (const ring of all) {
      for (const p of ring) {
        topP.push(p[0] * world, SLAB_H, p[1] * world);
        topC.push(topCol[0], topCol[1], topCol[2]);
      }
    }
    for (const face of faces) topI.push(base + face[0]!, base + face[1]!, base + face[2]!);
    pushWalls(contour, world, wallP, wallC, wallI, wallCol);
    for (const hole of holeRings) pushWalls(hole, world, wallP, wallC, wallI, wallCol);
  }
  if (topI.length < 3) return null;
  const topPos = Float32Array.from(topP);
  const topIdx = Uint32Array.from(topI);
  faceUp(topPos, topIdx);
  return {
    top: { pos: topPos, col: Float32Array.from(topC), idx: topIdx },
    wall: {
      pos: Float32Array.from(wallP),
      col: Float32Array.from(wallC),
      idx: Uint32Array.from(wallI),
    },
  };
}

function srgbChannelToLinear(s: number): number {
  const c = Math.min(1, Math.max(0, s / 255));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function srgbByteToLinear(r: number, g: number, b: number): [number, number, number] {
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
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

/** Positive area is counter-clockwise in cell space, which is counter-clockwise in XZ. */
function ringArea(ring: Pair[]): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function ensureWinding(ring: Pair[], ccw: boolean): Pair[] {
  if (ring.length < 3) return ring;
  const positive = ringArea(ring) > 0;
  if (positive === ccw) return ring;
  const out = ring.slice().reverse();
  return out;
}

function faceUp(pos: Float32Array, idx: Uint32Array): void {
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    const cross =
      (pos[b + 2]! - pos[a + 2]!) * (pos[c]! - pos[a]!) - (pos[b]! - pos[a]!) * (pos[c + 2]! - pos[a + 2]!);
    if (cross < 0) {
      const tmp = idx[i + 1]!;
      idx[i + 1] = idx[i + 2]!;
      idx[i + 2] = tmp;
    }
  }
}

/**
 * One quad per edge. Outer rings are CCW and holes are CW, so the right-hand
 * side of each edge is outside the solid and these triangles face that way.
 * The X mirror flips front-face together with the normal, so the outside stays
 * visible without lighting.
 */
function pushWalls(
  ring: Pair[],
  world: number,
  pos: number[],
  col: number[],
  idx: number[],
  rgb: [number, number, number],
): void {
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
    col.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
  }
}
