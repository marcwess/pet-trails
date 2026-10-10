import { CONFIG, PALETTE, RARITY_ORDER, RARITY_RGB, SPECIES, SPECIES_LABEL, angleDelta, mapBlob, type MultiPolygon } from '@pet-trails/shared';
import {
  BufferAttribute,
  BufferGeometry as BufGeo,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  OctahedronGeometry,
  PlaneGeometry,
  PerspectiveCamera,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type BufferGeometry,
  type Texture,
} from 'three';
import { gfx } from './gfx.js';
import { SLAB_H, buildLand } from './landmesh.js';
import type { Perf } from './perf.js';
import type { Territory } from './territory.js';

const WORLD = CONFIG.worldScale;
/**
 * Kenney pets face +Z, and placePet turns them by π/2 − heading.
 * Heading ≈ 0.6 showed the back. π past that is a 3/4 front.
 */
const HOME_FACE = Math.PI + 0.55;
/** Pale playable ground. Inside the blob this is the clear color, so it costs no fragments. */
const FLOOR_COLOR = 0xe7edf3;
/** Dark surround. Drawn only as the ring outside the blob. */
const OUTSIDE_COLOR = 0x62707e;
const RECOLOR_GLSL = `
vec3 petHsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float h = 0.0;
  float s = 0.0;
  if (mx != mn) {
    float d = mx - mn;
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float petHue(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 petRgb(vec3 hsl) {
  float h = hsl.x;
  float s = clamp(hsl.y, 0.0, 1.0);
  float l = clamp(hsl.z, 0.0, 1.0);
  if (s <= 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(petHue(p, q, h + 1.0 / 3.0), petHue(p, q, h), petHue(p, q, h - 1.0 / 3.0));
}
vec3 petToSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(0.454545)); }
vec3 petToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 petRecolor(vec3 linear, float id) {
  int v = int(id + 0.5);
  // Only the four milestone swaps. Anything else, including a missing
  // attribute, stays the Kenney colormap.
  if (v < 1 || v > 4) return linear;
  vec3 rgb = petToSrgb(linear);
  vec3 hsl = petHsl(rgb);
  // Shadow used to force hue 0.75 and crush saturation in linear space,
  // which turned a pink pig into a flat gray. Keep the animal's hue.
  if (v == 1) { hsl.y = min(1.0, hsl.y * 0.9); hsl.z = clamp(hsl.z * 0.62, 0.16, 0.58); }
  else if (v == 2) { hsl.x = mix(hsl.x, 0.12, 0.84); hsl.y = min(1.0, hsl.y + 0.2); hsl.z = min(0.78, hsl.z * 1.08); }
  else if (v == 3) { hsl.x = mix(hsl.x, 0.55, 0.8); hsl.y = min(1.0, hsl.y * 0.85 + 0.12); }
  else { hsl.x = fract(hsl.x + 0.45); hsl.y = 1.0; hsl.z = clamp(hsl.z * 1.15, 0.42, 0.72); }
  return petToLinear(petRgb(hsl));
}
`;

function enableRecolor(mat: MeshBasicMaterial | MeshLambertMaterial): void {
  mat.customProgramCacheKey = () => 'pet-recolor';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float recolor;\nvarying float vRecolor;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRecolor = recolor;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vRecolor;\n${RECOLOR_GLSL}`)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb = petRecolor(diffuseColor.rgb, vRecolor);',
      );
  };
}

/**
 * Critically damped follow, in closed form so a long frame cannot overshoot.
 * Omega 18 settles in about a fifth of a second.
 */
function dampTo(pos: number, vel: number, target: number, dt: number): [number, number] {
  const w = 18;
  const t = Math.max(0, dt);
  const x = pos - target;
  const e = Math.exp(-w * t);
  const b = vel + w * x;
  const next = (x + b * t) * e;
  return [target + next, (b - w * (x + b * t)) * e];
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 0.5) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

function iconTexture(draw: (ctx: CanvasRenderingContext2D, s: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, 64);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
const PAL_CSS = PALETTE.map((c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
const RARITY_TINT = RARITY_ORDER.map((name) => RARITY_RGB[name]);
const PET_CAP = 64;
const PICK_CAP = 72;
const PART_CAP = 140;
const SHADOW_CAP = 180;
const PATH_N = 420;
const RIBBON_SEGS = 1400;

export interface DrawPet {
  id: number;
  x: number;
  z: number;
  h: number;
  pet: number;
  alive: boolean;
  train: Uint8Array;
  trainShown: number;
  trainExtra: number;
  self: boolean;
  outside: boolean;
  hop: number;
  blink: boolean;
  name: string;
  /** 0 common … 4 legendary. */
  rarity: number;
  dash: boolean;
  shield: boolean;
  slow: boolean;
  /** 0 original, then shadow, golden, frost, neon. */
  recolor: number;
  /** 0 none, then sparkle, hearts, rainbow, paw prints. */
  trail: number;
}

export interface DrawPickup {
  x: number;
  z: number;
  kind: number;
}

export interface ScreenLabel {
  sx: number;
  sy: number;
  text: string;
  on: boolean;
  name: boolean;
  color: string;
}

class PathBuf {
  readonly xs = new Float32Array(PATH_N);
  readonly zs = new Float32Array(PATH_N);
  readonly hs = new Float32Array(PATH_N);
  head = 0;
  n = 0;
  lx = 0;
  lz = 0;
  primed = false;

  clear(): void {
    this.n = 0;
    this.head = 0;
    this.primed = false;
  }

  push(x: number, z: number, h: number, minStep2 = 0.35): void {
    if (this.primed) {
      const dx = x - this.lx;
      const dz = z - this.lz;
      if (dx * dx + dz * dz < minStep2) return;
    }
    this.primed = true;
    this.lx = x;
    this.lz = z;
    this.xs[this.head] = x;
    this.zs[this.head] = z;
    this.hs[this.head] = h;
    this.head = (this.head + 1) % PATH_N;
    if (this.n < PATH_N) this.n++;
  }

  sample(dist: number, out: { x: number; z: number; h: number }): boolean {
    if (this.n < 2) return false;
    let remaining = dist;
    let prev = (this.head - 1 + PATH_N) % PATH_N;
    for (let k = 1; k < this.n; k++) {
      const j = (this.head - 1 - k + PATH_N * 4) % PATH_N;
      const dx = this.xs[prev]! - this.xs[j]!;
      const dz = this.zs[prev]! - this.zs[j]!;
      const seg = Math.hypot(dx, dz);
      if (seg >= remaining && seg > 1e-4) {
        const t = remaining / seg;
        out.x = this.xs[prev]! + (this.xs[j]! - this.xs[prev]!) * t;
        out.z = this.zs[prev]! + (this.zs[j]! - this.zs[prev]!) * t;
        out.h = this.hs[j]!;
        return true;
      }
      remaining -= seg;
      prev = j;
    }
    return false;
  }
}

const RIBBON_VERT = `
  attribute float side;
  attribute vec3 color;
  varying float vSide;
  varying vec3 vColor;
  void main() {
    vSide = side;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAG = `
  varying float vSide;
  varying vec3 vColor;
  void main() {
    float e = abs(vSide);
    float rim = smoothstep(0.55, 0.95, e);
    vec3 col = mix(vColor, vColor * 0.78, rim);
    float alpha = 0.72 * (1.0 - smoothstep(0.8, 1.0, e));
    gl_FragColor = vec4(col, alpha);
    #include <premultiplied_alpha_fragment>
    #include <colorspace_fragment>
  }
`;

const RIBBON_COUNT = 17;

class RibbonBatch {
  readonly mesh: Mesh;
  readonly ribbons: Ribbon[] = [];
  readonly pos: Float32Array;
  readonly side: Float32Array;
  readonly col: Float32Array;
  private readonly index: Uint32Array;
  private readonly posAttr: BufferAttribute;
  private readonly sideAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly idxAttr: BufferAttribute;
  private readonly geo: BufGeo;

  constructor() {
    const verts = RIBBON_COUNT * RIBBON_SEGS * 2;
    this.pos = new Float32Array(verts * 3);
    this.side = new Float32Array(verts);
    this.col = new Float32Array(verts * 3);
    this.index = new Uint32Array(RIBBON_COUNT * (RIBBON_SEGS - 1) * 6);
    this.geo = new BufGeo();
    this.posAttr = new BufferAttribute(this.pos, 3);
    this.sideAttr = new BufferAttribute(this.side, 1);
    this.colAttr = new BufferAttribute(this.col, 3);
    this.idxAttr = new BufferAttribute(this.index, 1);
    this.posAttr.setUsage(DynamicDrawUsage);
    this.sideAttr.setUsage(DynamicDrawUsage);
    this.colAttr.setUsage(DynamicDrawUsage);
    this.idxAttr.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('side', this.sideAttr);
    this.geo.setAttribute('color', this.colAttr);
    this.geo.setIndex(this.idxAttr);
    this.geo.setDrawRange(0, 0);
    const mat = new ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    for (let i = 0; i < RIBBON_COUNT; i++) this.ribbons.push(new Ribbon(i, this));
  }

  /** One draw for every live trail. Empty slots contribute no indices. */
  flush(): void {
    let n = 0;
    let any = false;
    for (let s = 0; s < this.ribbons.length; s++) {
      const count = this.ribbons[s]!.count;
      if (count < 2) continue;
      any = true;
      const base = s * RIBBON_SEGS * 2;
      for (let i = 0; i < count - 1; i++) {
        const v = base + i * 2;
        this.index[n++] = v;
        this.index[n++] = v + 1;
        this.index[n++] = v + 2;
        this.index[n++] = v + 1;
        this.index[n++] = v + 3;
        this.index[n++] = v + 2;
      }
    }
    this.idxAttr.clearUpdateRanges();
    this.idxAttr.addUpdateRange(0, Math.max(1, n));
    this.idxAttr.needsUpdate = any;
    this.posAttr.clearUpdateRanges();
    this.sideAttr.clearUpdateRanges();
    this.colAttr.clearUpdateRanges();
    if (any) {
      for (let s = 0; s < this.ribbons.length; s++) {
        const count = this.ribbons[s]!.count;
        if (count < 2) continue;
        const v = s * RIBBON_SEGS * 2;
        this.posAttr.addUpdateRange(v * 3, count * 2 * 3);
        this.sideAttr.addUpdateRange(v, count * 2);
        this.colAttr.addUpdateRange(v * 3, count * 2 * 3);
      }
      this.posAttr.needsUpdate = true;
      this.sideAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
    this.geo.setDrawRange(0, n);
    this.mesh.visible = any && gfx.over;
  }
}

class Ribbon {
  count = 0;
  private cr = 1;
  private cg = 1;
  private cb = 1;
  private readonly sx = new Float32Array(PATH_N + 2);
  private readonly sz = new Float32Array(PATH_N + 2);
  private readonly keep = new Uint8Array(PATH_N + 2);

  constructor(
    private readonly slot: number,
    private readonly batch: RibbonBatch,
  ) {}

  setColor(r: number, g: number, b: number): void {
    this.cr = r;
    this.cg = g;
    this.cb = b;
  }

  clear(): void {
    this.count = 0;
  }

  /**
   * Continuous triangle-strip ribbon. Points are cell coordinates, oldest first
   * in the ring buffer. The live head is appended so the strip meets the pet,
   * and the start is extended back onto the land it left.
   */
  draw(path: PathBuf, headX: number, headZ: number): void {
    let n = 0;
    for (let k = path.n - 1; k >= 0 && n < PATH_N; k--) {
      const i = (path.head - 1 - k + PATH_N * 8) % PATH_N;
      const x = path.xs[i]!;
      const z = path.zs[i]!;
      if (n > 0) {
        const dx = x - this.sx[n - 1]!;
        const dz = z - this.sz[n - 1]!;
        if (dx * dx + dz * dz < 0.04) continue;
        if (n >= 2) {
          const pdx = this.sx[n - 1]! - this.sx[n - 2]!;
          const pdz = this.sz[n - 1]! - this.sz[n - 2]!;
          const denom = Math.hypot(dx, dz) * Math.hypot(pdx, pdz);
          if (denom > 1e-4 && (dx * pdx + dz * pdz) / denom < -0.25) {
            this.sx[n - 1] = x;
            this.sz[n - 1] = z;
            continue;
          }
        }
      }
      this.sx[n] = x;
      this.sz[n] = z;
      n++;
    }
    if (n === 0) {
      this.sx[0] = headX;
      this.sz[0] = headZ;
      n = 1;
    } else {
      const dx = headX - this.sx[n - 1]!;
      const dz = headZ - this.sz[n - 1]!;
      if (dx * dx + dz * dz > 0.0004) {
        this.sx[n] = headX;
        this.sz[n] = headZ;
        n++;
      } else {
        this.sx[n - 1] = headX;
        this.sz[n - 1] = headZ;
      }
    }
    n = decimateRibbon(this.sx, this.sz, this.keep, n, 0.32);
    if (n < 2) {
      this.clear();
      return;
    }
    const fdx = this.sx[1]! - this.sx[0]!;
    const fdz = this.sz[1]! - this.sz[0]!;
    const flen = Math.hypot(fdx, fdz);
    if (flen > 1e-4) {
      const back = 1.15;
      this.sx[0] = this.sx[0]! - (fdx / flen) * back;
      this.sz[0] = this.sz[0]! - (fdz / flen) * back;
    }

    const half = 0.42;
    let count = 0;
    const base = this.slot * RIBBON_SEGS * 2;
    const pos = this.batch.pos;
    const side = this.batch.side;
    const col = this.batch.col;
    const emit = (cx: number, cz: number, nx: number, nz: number) => {
      if (count >= RIBBON_SEGS) return;
      const v = base + count * 2;
      const o = v * 3;
      const c = v * 3;
      const y = SLAB_H + 0.05;
      pos[o] = cx + nx * half;
      pos[o + 1] = y;
      pos[o + 2] = cz + nz * half;
      pos[o + 3] = cx - nx * half;
      pos[o + 4] = y;
      pos[o + 5] = cz - nz * half;
      side[v] = 1;
      side[v + 1] = -1;
      col[c] = this.cr;
      col[c + 1] = this.cg;
      col[c + 2] = this.cb;
      col[c + 3] = this.cr;
      col[c + 4] = this.cg;
      col[c + 5] = this.cb;
      count++;
    };

    for (let i = 0; i < n && count < RIBBON_SEGS - 8; i++) {
      const inn = this.dir(i, n, false);
      const out = this.dir(i, n, true);
      const wx = this.sx[i]! * WORLD;
      const wz = this.sz[i]! * WORLD;
      if (!inn && out) {
        emit(wx, wz, -out.z, out.x);
        continue;
      }
      if (inn && !out) {
        emit(wx, wz, -inn.z, inn.x);
        continue;
      }
      if (!inn || !out) continue;
      const n0x = -inn.z;
      const n0z = inn.x;
      const n1x = -out.z;
      const n1z = out.x;
      const dot = n0x * n1x + n0z * n1z;
      const mx = n0x + n1x;
      const mz = n0z + n1z;
      const ml = Math.hypot(mx, mz);
      const denom = ml > 1e-5 ? (mx / ml) * n0x + (mz / ml) * n0z : 0;
      if (ml < 1e-4 || denom < 0.55 || dot < 0.2) {
        let a0 = Math.atan2(n0z, n0x);
        let a1 = Math.atan2(n1z, n1x);
        let da = a1 - a0;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        const steps = Math.min(5, Math.max(1, Math.ceil(Math.abs(da) / 0.55)));
        for (let s = 0; s <= steps; s++) {
          const a = a0 + (da * s) / steps;
          emit(wx, wz, Math.cos(a), Math.sin(a));
        }
      } else {
        const scale = Math.min(2.15, 1 / denom);
        emit(wx, wz, (mx / ml) * scale, (mz / ml) * scale);
      }
    }

    this.count = count;
  }

  /** One short strip so the ribbon program compiles before the first claim. */
  prime(): void {
    const path = new PathBuf();
    path.push(4, 4, 0);
    path.push(8, 4, 0);
    path.push(8, 8, 0);
    this.draw(path, 8, 9);
  }

  private dir(i: number, n: number, forward: boolean): { x: number; z: number } | null {
    if (forward) {
      for (let j = i + 1; j < n; j++) {
        const dx = this.sx[j]! - this.sx[i]!;
        const dz = this.sz[j]! - this.sz[i]!;
        const len = Math.hypot(dx, dz);
        if (len > 0.05) return { x: dx / len, z: dz / len };
      }
    } else {
      for (let j = i - 1; j >= 0; j--) {
        const dx = this.sx[i]! - this.sx[j]!;
        const dz = this.sz[i]! - this.sz[j]!;
        const len = Math.hypot(dx, dz);
        if (len > 0.05) return { x: dx / len, z: dz / len };
      }
    }
    return null;
  }
}

interface OwnerPart {
  topPos: Float32Array;
  topCol: Float32Array;
  topIdx: Uint32Array;
  wallPos: Float32Array;
  wallCol: Float32Array;
  wallIdx: Uint32Array;
}

export class Renderer {
  readonly renderer: WebGLRenderer;
  readonly territory: Territory;
  readonly labels: ScreenLabel[] = [];
  selfSX = 0;
  selfSY = 0;
  selfScreen = false;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly pets: InstancedMesh[] = [];
  private readonly paths: PathBuf[] = [];
  private readonly trails: PathBuf[] = [];
  private readonly ribbonBatch: RibbonBatch;
  private holdX = 0;
  private holdZ = 0;
  private lookX = 0;
  private lookZ = 0;
  private readonly fenceMeshes: Mesh[] = [];
  private arenaBox = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
  landPct = 0;
  private readonly landParts: Array<OwnerPart | null> = [];
  private readonly topGeo: BufGeo;
  private readonly wallGeo: BufGeo;
  private topPos: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private topCol: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private topIdx: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  private wallPos: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private wallCol: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private wallIdx: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  private readonly riseY = new Float32Array(17);
  private readonly coins: InstancedMesh;
  private readonly fxCoins: InstancedMesh;
  private readonly orbs: InstancedMesh;
  private readonly loot: InstancedMesh;
  private readonly parts: InstancedMesh;
  private readonly shadows: InstancedMesh;
  private readonly bases: InstancedMesh;
  private readonly ring: Mesh;
  private readonly pulse: Mesh;
  private readonly nudge: Mesh;
  /** Pulsing ring and arrow while the pet is parked at spawn. */
  parkHint = false;
  private readonly platform: Mesh;
  private readonly stage: Group;
  private readonly podium: Mesh;
  private readonly ground: Mesh;
  private readonly gridLines: LineSegments;
  private readonly land: Group;
  private readonly flashRing: Mesh;
  private readonly claimRing: Mesh;
  private readonly frames: InstancedMesh;
  private readonly glows: InstancedMesh;
  private readonly shields: InstancedMesh;
  private readonly slows: InstancedMesh;
  private readonly paintRing: Mesh;
  private readonly frostRing: Mesh;
  private paintLife = 0;
  private paintX = 0;
  private paintZ = 0;
  private paintR = 1;
  private frostLife = 0;
  private frostX = 0;
  private frostZ = 0;
  private frostR = 1;
  private readonly sparkles: InstancedMesh;
  private readonly hearts: InstancedMesh;
  private readonly rainbows: InstancedMesh;
  private readonly paws: InstancedMesh;
  heroRecolor = 0;
  /** Home, pet detail, or the box reveal. Each frames the pet differently. */
  stageKind: 'home' | 'detail' | 'reveal' = 'home';
  /** 1 right after a tap on the podium pet, then it decays. */
  wiggle = 0;
  portraitURLs: string[] = [];
  /** In-game lighting, one labeled cell per species. */
  sheet: HTMLCanvasElement | null = null;
  /** Unlit menu portraits, one labeled cell per species. */
  sheetMenu: HTMLCanvasElement | null = null;
  /** Dominant Kenney colormap swatch per species, sampled from the atlas. */
  referenceRGB: Array<[number, number, number]> = [];
  private hemi!: HemisphereLight;
  private keyLight!: DirectionalLight;
  private petMaterial!: MeshLambertMaterial | MeshBasicMaterial;
  private menuMaterial!: MeshBasicMaterial;
  private winLife = 0;
  private readonly winDisc: Mesh;
  private readonly decor: Group;
  private readonly visH = new Float32Array(80);

  /** Camera sample for movement metrics. Scene-space, the same clock as the frame. */
  frameCam(): { x: number; y: number; z: number; lookX: number; lookZ: number } {
    return { x: this.camX, y: this.camY, z: this.camZ, lookX: this.lookX, lookZ: this.lookZ };
  }
  private readonly popLife = new Float32Array(24);
  private killFlash = 0;
  private killX = 0;
  private killZ = 0;
  private arcId = -1;
  private arcLife = 0;
  private arcSx = 0;
  private arcSz = 0;
  private arcTx = 0;
  private arcTz = 0;
  private readonly fxLife = new Float32Array(24);
  private readonly fxX = new Float32Array(24);
  private readonly fxY = new Float32Array(24);
  private readonly fxZ = new Float32Array(24);
  private readonly fxVx = new Float32Array(24);
  private readonly fxVy = new Float32Array(24);
  private readonly fxVz = new Float32Array(24);
  private measurePending = false;
  private measureR = 0;
  private measureG = 0;
  private measureB = 0;
  landMeasure: {
    pixels: number;
    boxW: number;
    boxH: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null = null;
  private readonly mat = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly quat2 = new Quaternion();
  private readonly scl = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly rollAxis = new Vector3(0, 0, 1);
  private readonly proj = new Vector3();
  private readonly sample = { x: 0, z: 0, h: 0 };
  private readonly life = new Float32Array(PART_CAP);
  private readonly px = new Float32Array(PART_CAP);
  private readonly py = new Float32Array(PART_CAP);
  private readonly pz = new Float32Array(PART_CAP);
  private readonly vx = new Float32Array(PART_CAP);
  private readonly vy = new Float32Array(PART_CAP);
  private readonly vz = new Float32Array(PART_CAP);
  private readonly pr = new Float32Array(PART_CAP);
  private readonly pg = new Float32Array(PART_CAP);
  private readonly pb = new Float32Array(PART_CAP);
  private partCount = 0;
  private time = 0;
  private camX = 0;
  private camY = 28;
  private camZ = 18;
  private camVx = 0;
  private camVz = 0;
  private lookVx = 0;
  private lookVz = 0;
  private camInit = false;
  private mirror: Group | null = null;
  private readonly bank = new Float32Array(80);
  private readonly prevHead = new Float32Array(80);
  private readonly sweeps: Array<{ mesh: Mesh; life: number; max: number }> = [];
  private lastW = 0;
  private lastH = 0;
  shake = 0;
  punch = 0;
  private readonly perf: Perf;

  constructor(
    territory: Territory,
    geos: BufferGeometry[],
    material: MeshLambertMaterial,
    perf: Perf,
    coin: { geometry: BufferGeometry; map: Texture | null } | null,
  ) {
    this.territory = territory;
    this.perf = perf;
    const dpr = Math.min(Math.max(0.5, gfx.dpr), 2);
    this.renderer = new WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      preserveDrawingBuffer: new URLSearchParams(location.search).has('cap'),
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = gfx.shadow;
    this.renderer.setClearColor(OUTSIDE_COLOR, 1);
    const veil = document.getElementById('vignette');
    if (veil) veil.hidden = !gfx.vignette;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    document.body.prepend(this.renderer.domElement);
    perf.hook(this.renderer);
    perf.territoryH = 0;

    this.camera = new PerspectiveCamera(40, 1, 0.1, 500);
    // Pets stay Lambert. Land is unlit vertex color, so it does not need a fill light.
    this.hemi = new HemisphereLight(0xfff8f2, 0xd5e0ec, 1.15);
    this.scene.add(this.hemi);
    this.keyLight = new DirectionalLight(0xfffaf4, 0.85);
    this.keyLight.position.set(26, 42, 18);
    this.keyLight.castShadow = gfx.shadow;
    this.scene.add(this.keyLight);

    const gw = territory.gridW * WORLD;
    const gh = territory.gridH * WORLD;
    this.ground = new Mesh(new BufGeo(), outsideMaterial());
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);
    this.gridLines = this.makeGrid(gw, gh);
    this.gridLines.visible = false;
    this.scene.add(this.gridLines);
    this.land = new Group();
    const flat = new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false });
    this.topGeo = new BufGeo();
    this.wallGeo = new BufGeo();
    const top = new Mesh(this.topGeo, flat);
    const wall = new Mesh(
      this.wallGeo,
      new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false, side: DoubleSide }),
    );
    top.frustumCulled = false;
    wall.frustumCulled = false;
    top.renderOrder = 2;
    wall.renderOrder = 1;
    this.land.add(wall, top);
    this.scene.add(this.land);
    this.riseY.fill(1);
    for (let id = 0; id <= 16; id++) this.landParts.push(null);
    this.setBoundary(mapBlob(1, territory.gridW, territory.gridH));

    const foot = new Mesh(new CylinderGeometry(0.98, 1.08, 0.16, 40), new MeshLambertMaterial({ color: 0xffe4c4 }));
    foot.position.y = 0.08;
    const platformGeo = new CylinderGeometry(0.58, 0.74, 0.28, 40);
    this.platform = new Mesh(platformGeo, new MeshLambertMaterial({ color: 0xfff6e4 }));
    this.platform.position.y = 0.3;
    const podiumRing = new Mesh(
      new TorusGeometry(0.64, 0.045, 10, 48),
      new MeshBasicMaterial({ color: 0xffd23f, toneMapped: false }),
    );
    podiumRing.rotation.x = Math.PI / 2;
    podiumRing.position.y = 0.45;
    this.podium = podiumRing;
    const podiumShadow = new Mesh(
      new CircleGeometry(1.25, 32),
      new MeshBasicMaterial({ color: 0x6e88aa, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }),
    );
    podiumShadow.rotation.x = -Math.PI / 2;
    podiumShadow.position.y = 0.012;
    const stageFloor = new Mesh(
      new CircleGeometry(7.2, 48),
      new MeshBasicMaterial({ color: 0xc5ebff, toneMapped: false }),
    );
    stageFloor.rotation.x = -Math.PI / 2;
    stageFloor.position.set(0, -0.04, 0.8);
    // A tall sky so the clear color never shows as a stray band under the pet.
    const backdrop = new Mesh(
      new PlaneGeometry(16, 20),
      new MeshBasicMaterial({ map: titleBackdrop(), toneMapped: false, depthWrite: false }),
    );
    backdrop.position.set(0, 1.5, -5.1);
    this.stage = new Group();
    this.stage.add(backdrop, stageFloor, podiumShadow, foot, this.platform, this.podium);
    this.scene.add(this.stage);
    this.decor = new Group();
    const decorMat = [0xff8ec8, 0xffd23f, 0x7ec8ff, 0xc9b6ff, 0xffb703, 0x3dde7a, 0xfff1c9];
    // Stay inside the portrait frustum. |x| past ~1.3 is clipped at this depth.
    const spots: Array<[number, number, number, number]> = [
      [-1.02, 2.55, -3.7, 0.26],
      [1.02, 2.25, -3.55, 0.22],
      [-0.72, 3.35, -4.15, 0.2],
      [0.82, 3.45, -4.2, 0.18],
      [0.05, 3.85, -4.35, 0.16],
      [-0.35, 1.7, -3.35, 0.14],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [x, y, z, rad] = spots[i]!;
      const blob = new Mesh(
        new SphereGeometry(rad, 16, 12),
        new MeshBasicMaterial({ color: decorMat[i % decorMat.length]!, toneMapped: false }),
      );
      blob.position.set(x, y, z);
      blob.userData.spin = 0.35 + (i % 4) * 0.12;
      blob.userData.base = y;
      blob.userData.ox = x;
      blob.userData.amp = 0.12 + (i % 3) * 0.04;
      this.decor.add(blob);
    }
    this.scene.add(this.decor);
    this.winDisc = new Mesh(
      new CircleGeometry(1, 48),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, toneMapped: false, depthWrite: false }),
    );
    this.winDisc.rotation.x = -Math.PI / 2;
    this.winDisc.visible = false;
    this.winDisc.renderOrder = 3;
    this.winDisc.frustumCulled = false;
    this.scene.add(this.winDisc);

    const petMat = gfx.basic
      ? new MeshBasicMaterial({ map: material.map, side: FrontSide, toneMapped: false })
      : material;
    this.petMaterial = petMat;
    this.menuMaterial = new MeshBasicMaterial({ map: material.map, side: FrontSide, toneMapped: false });
    enableRecolor(petMat);
    for (let i = 0; i < geos.length; i++) {
      const rec = new InstancedBufferAttribute(new Float32Array(PET_CAP), 1);
      rec.setUsage(DynamicDrawUsage);
      geos[i]!.setAttribute('recolor', rec);
      const mesh = new InstancedMesh(geos[i]!, petMat, PET_CAP);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      this.scene.add(mesh);
      this.pets.push(mesh);
    }
    this.ribbonBatch = new RibbonBatch();
    this.scene.add(this.ribbonBatch.mesh);
    for (let i = 0; i < 17; i++) {
      this.paths.push(new PathBuf());
      this.trails.push(new PathBuf());
    }

    const coinGeo = coin?.geometry ?? flatCoin();
    const coinMat = new MeshBasicMaterial({
      map: coin?.map ?? undefined,
      color: coin?.map ? 0xffffff : 0xffc400,
      toneMapped: false,
    });
    this.coins = makeInstances(coinGeo, coinMat, PICK_CAP);
    this.fxCoins = makeInstances(coinGeo, coinMat, 24);
    this.scene.add(this.fxCoins);
    this.orbs = makeInstances(new OctahedronGeometry(0.28, 0), 0x2ec8ff, PICK_CAP);
    this.loot = makeInstances(new SphereGeometry(0.22, 14, 10), 0xff4fa3, PICK_CAP);
    this.scene.add(this.coins, this.orbs, this.loot);

    const shadowGeo = new CircleGeometry(0.46, 14);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadows = new InstancedMesh(
      shadowGeo,
      new MeshBasicMaterial({ color: 0x5c6a7a, transparent: true, opacity: 0.3, depthWrite: false }),
      SHADOW_CAP,
    );
    this.shadows.frustumCulled = false;
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.count = 0;
    this.scene.add(this.shadows);

    const baseGeo = new RingGeometry(0.24, 0.4, 22);
    baseGeo.rotateX(-Math.PI / 2);
    this.bases = new InstancedMesh(
      baseGeo,
      new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: DoubleSide }),
      SHADOW_CAP,
    );
    this.bases.instanceColor = new InstancedBufferAttribute(new Float32Array(SHADOW_CAP * 3), 3);
    this.bases.frustumCulled = false;
    this.bases.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bases.count = 0;
    this.bases.renderOrder = 3;
    this.scene.add(this.bases);

    this.parts = new InstancedMesh(new SphereGeometry(0.11, 8, 6), new MeshBasicMaterial({ color: 0xffffff }), PART_CAP);
    this.parts.instanceColor = new InstancedBufferAttribute(new Float32Array(PART_CAP * 3), 3);
    this.parts.frustumCulled = false;
    this.parts.renderOrder = 5;
    this.parts.instanceMatrix.setUsage(DynamicDrawUsage);
    this.parts.count = 0;
    this.scene.add(this.parts);

    const ringGeo = new RingGeometry(0.62, 0.82, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new Mesh(
      ringGeo,
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ring.visible = false;
    this.scene.add(this.ring);
    const pulseGeo = new RingGeometry(0.78, 1.05, 32);
    pulseGeo.rotateX(-Math.PI / 2);
    this.pulse = new Mesh(
      pulseGeo,
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.pulse.visible = false;
    this.scene.add(this.pulse);
    const arrow = new Shape();
    arrow.moveTo(0.48, 0);
    arrow.lineTo(-0.22, 0.2);
    arrow.lineTo(-0.06, 0);
    arrow.lineTo(-0.22, -0.2);
    arrow.closePath();
    const nudgeGeo = new ShapeGeometry(arrow);
    nudgeGeo.rotateX(-Math.PI / 2);
    this.nudge = new Mesh(
      nudgeGeo,
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide }),
    );
    this.nudge.visible = false;
    this.scene.add(this.nudge);

    const flashGeo = new RingGeometry(0.7, 0.95, 36);
    flashGeo.rotateX(-Math.PI / 2);
    const flashMat = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    this.flashRing = new Mesh(flashGeo, flashMat);
    this.flashRing.visible = false;
    this.flashRing.renderOrder = 3;
    this.scene.add(this.flashRing);

    const claimGeo = new RingGeometry(0.86, 1.02, 48);
    claimGeo.rotateX(-Math.PI / 2);
    this.claimRing = new Mesh(
      claimGeo,
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.claimRing.visible = false;
    this.claimRing.renderOrder = 2;
    this.scene.add(this.claimRing);

    const frameGeo = new RingGeometry(0.46, 0.62, 28);
    frameGeo.rotateX(-Math.PI / 2);
    this.frames = new InstancedMesh(
      frameGeo,
      new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }),
      48,
    );
    this.frames.instanceColor = new InstancedBufferAttribute(new Float32Array(48 * 3), 3);
    this.frames.frustumCulled = false;
    this.frames.renderOrder = 3;
    this.frames.count = 0;
    this.scene.add(this.frames);

    const glowGeo = new RingGeometry(0.7, 1.05, 32);
    glowGeo.rotateX(-Math.PI / 2);
    this.glows = new InstancedMesh(
      glowGeo,
      new MeshBasicMaterial({ color: 0xffb43a, toneMapped: false, transparent: true, opacity: 0.72, depthWrite: false, side: DoubleSide }),
      16,
    );
    this.glows.frustumCulled = false;
    this.glows.renderOrder = 3;
    this.glows.count = 0;
    this.scene.add(this.glows);

    this.shields = new InstancedMesh(
      new SphereGeometry(0.62, 12, 8),
      new MeshBasicMaterial({ color: 0xd7f6ff, transparent: true, opacity: 0.38, depthWrite: false, toneMapped: false }),
      48,
    );
    this.shields.frustumCulled = false;
    this.shields.renderOrder = 4;
    this.shields.count = 0;
    this.scene.add(this.shields);

    this.slows = new InstancedMesh(
      new SphereGeometry(0.7, 12, 8),
      new MeshBasicMaterial({ color: 0x6ec6ff, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false }),
      16,
    );
    this.slows.frustumCulled = false;
    this.slows.renderOrder = 4;
    this.slows.count = 0;
    this.scene.add(this.slows);

    const boomGeo = new RingGeometry(0.7, 0.95, 40);
    boomGeo.rotateX(-Math.PI / 2);
    this.paintRing = new Mesh(
      boomGeo,
      new MeshBasicMaterial({ color: 0xff4d8d, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: DoubleSide }),
    );
    this.paintRing.visible = false;
    this.paintRing.renderOrder = 3;
    this.scene.add(this.paintRing);
    this.frostRing = new Mesh(
      boomGeo.clone(),
      new MeshBasicMaterial({ color: 0x7ec8ff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: DoubleSide }),
    );
    this.frostRing.visible = false;
    this.frostRing.renderOrder = 3;
    this.scene.add(this.frostRing);

    const decal = new PlaneGeometry(0.42, 0.42);
    decal.rotateX(-Math.PI / 2);
    const star = iconTexture((ctx, s) => {
      ctx.translate(s / 2, s / 2);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = i % 2 === 0 ? s * 0.42 : s * 0.16;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    });
    const heart = iconTexture((ctx, s) => {
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5, s * 0.84);
        ctx.bezierCurveTo(s * 0.02, s * 0.48, s * 0.08, s * 0.1, s * 0.5, s * 0.3);
        ctx.bezierCurveTo(s * 0.92, s * 0.1, s * 0.98, s * 0.48, s * 0.5, s * 0.84);
        ctx.closePath();
      };
      path();
      ctx.lineJoin = 'round';
      ctx.lineWidth = s * 0.14;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      path();
      ctx.fillStyle = '#e11d48';
      ctx.fill();
    });
    const dot = iconTexture((ctx, s) => {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2);
      ctx.fill();
    });
    const paw = iconTexture((ctx, s) => {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.62, s * 0.22, s * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const [x, y] of [[0.32, 0.34], [0.5, 0.24], [0.68, 0.34]] as const) {
        ctx.beginPath();
        ctx.arc(s * x, s * y, s * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    const makeDecal = (map: CanvasTexture, cap: number) => {
      const mesh = new InstancedMesh(
        decal,
        new MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, color: 0xffffff }),
        cap,
      );
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    };
    this.sparkles = makeDecal(star, 80);
    this.hearts = makeDecal(heart, 80);
    this.rainbows = makeDecal(dot, 80);
    this.paws = makeDecal(paw, 80);

    for (let i = 0; i < 40; i++) this.labels.push({ sx: 0, sy: 0, text: '', on: false, name: false, color: '#fff' });
    // Mirror X so the south-looking camera is north-up with east on the right.
    // Three's right-handed lookAt would otherwise put east on the left.
    const mirror = new Group();
    this.mirror = mirror;
    mirror.scale.x = -1;
    for (const child of [...this.scene.children]) {
      if (child.type === 'HemisphereLight' || child.type === 'DirectionalLight') continue;
      this.scene.remove(child);
      mirror.add(child);
    }
    this.scene.add(mirror);
    this.applySize();
    window.addEventListener('resize', () => this.applySize());
    if (perf.enabled) (window as unknown as { __r?: Renderer }).__r = this;
  }

  warmup(): void {
    for (let i = 0; i < this.pets.length; i++) {
      const pet = this.pets[i]!;
      this.place(pet, 0, (i % 6) * 0.2, 1, (i % 5) * 0.2, 0, 0, 1);
      pet.count = 1;
      pet.instanceMatrix.needsUpdate = true;
    }
    this.place(this.coins, 0, 2, 0.4, 2, 0, 0, 1);
    this.coins.count = 1;
    this.coins.instanceMatrix.needsUpdate = true;
    this.place(this.orbs, 0, 3, 0.6, 2, 0, 0, 1);
    this.orbs.count = 1;
    this.orbs.instanceMatrix.needsUpdate = true;
    this.place(this.loot, 0, 4, 0.5, 2, 0, 0, 1);
    this.loot.count = 1;
    this.loot.instanceMatrix.needsUpdate = true;
    this.place(this.shadows, 0, 2, 0.03, 2, 0, 0, 1);
    this.shadows.count = 1;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.place(this.parts, 0, 1, 1, 1, 0, 0, 1);
    this.parts.count = 1;
    this.parts.instanceMatrix.needsUpdate = true;
    this.ring.visible = true;
    this.platform.visible = true;
    this.ground.visible = true;
    const warmPos = new Float32Array([0, SLAB_H, 0, 3, SLAB_H, 0, 0, SLAB_H, 3]);
    const warmCol = new Float32Array([1, 0, 0.4, 1, 0, 0.4, 1, 0, 0.4]);
    const warmIdx = new Uint32Array([0, 1, 2]);
    this.topGeo.setAttribute('position', new BufferAttribute(warmPos, 3));
    this.topGeo.setAttribute('color', new BufferAttribute(warmCol, 3));
    this.topGeo.setIndex(new BufferAttribute(warmIdx, 1));
    const warmWall = new Float32Array([0, 0, 0, 3, 0, 0, 0, SLAB_H, 0]);
    this.wallGeo.setAttribute('position', new BufferAttribute(warmWall, 3));
    this.wallGeo.setAttribute('color', new BufferAttribute(warmCol, 3));
    this.wallGeo.setIndex(new BufferAttribute(warmIdx, 1));
    this.ribbonBatch.ribbons[0]?.prime();
    this.ribbonBatch.flush();
    this.camera.position.set(10, 8, 16);
    this.camera.lookAt(2, 0.6, 2);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    for (const ribbon of this.ribbonBatch.ribbons) ribbon.clear();
    this.ribbonBatch.flush();
    this.topGeo.setDrawRange(0, 0);
    this.wallGeo.setDrawRange(0, 0);
    for (const pet of this.pets) pet.count = 0;
    this.coins.count = 0;
    this.orbs.count = 0;
    this.loot.count = 0;
    this.shadows.count = 0;
    this.parts.count = 0;
    this.ring.visible = false;
  }

  burst(x: number, z: number, playerId: number, withShake = true, toX?: number, toZ?: number): void {
    const c = PALETTE[(Math.max(1, playerId) - 1) % PALETTE.length]!;
    const wx = x * WORLD;
    const wz = z * WORLD;
    for (let k = 0; k < 64; k++) {
      if (this.partCount >= PART_CAP) break;
      const i = this.partCount++;
      const ang = (k / 64) * Math.PI * 2 + (k % 5) * 0.11;
      const sp = 3.1 + (k % 6) * 0.55;
      const spread = 0.35 + (k % 8) * 0.16;
      this.px[i] = wx + Math.cos(ang) * spread;
      this.py[i] = 0.45 + (k % 7) * 0.18;
      this.pz[i] = wz + Math.sin(ang) * spread;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = 3.2 + (k % 5) * 0.5;
      this.vz[i] = Math.sin(ang) * sp;
      this.life[i] = 0.95;
      this.pr[i] = c[0] / 255;
      this.pg[i] = c[1] / 255;
      this.pb[i] = c[2] / 255;
    }
    if (playerId > 0 && playerId < this.popLife.length) this.popLife[playerId] = 0.72;
    if (toX !== undefined && toZ !== undefined) {
      this.arcId = playerId;
      this.arcLife = 0.72;
      this.arcSx = x;
      this.arcSz = z;
      this.arcTx = toX;
      this.arcTz = toZ;
    }
    this.killFlash = 0.35;
    this.killX = wx;
    this.killZ = wz;
    const mat = this.flashRing.material as MeshBasicMaterial;
    mat.color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255);
    mat.opacity = 0.95;
    this.flashRing.position.set(wx, 0.08, wz);
    this.flashRing.scale.set(0.6, 1, 0.6);
    this.flashRing.visible = true;
    if (withShake) this.shake = Math.min(1.2, this.shake + 0.85);
  }

  /** Ask the next frame to measure how many pixels match this owner color. */
  queueColorMeasure(r: number, g: number, b: number): void {
    this.measureR = r;
    this.measureG = g;
    this.measureB = b;
    this.measurePending = true;
  }

  private makeGrid(gw: number, gh: number): LineSegments {
    const n = 72;
    const positions = new Float32Array((n + 1) * 4 * 3);
    let o = 0;
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * gw;
      const z = (i / n) * gh;
      positions[o++] = x;
      positions[o++] = 0.01;
      positions[o++] = 0;
      positions[o++] = x;
      positions[o++] = 0.01;
      positions[o++] = gh;
      positions[o++] = 0;
      positions[o++] = 0.01;
      positions[o++] = z;
      positions[o++] = gw;
      positions[o++] = 0.01;
      positions[o++] = z;
    }
    const geo = new BufGeo();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    const lines = new LineSegments(geo, new LineBasicMaterial({ color: 0xd5dee8 }));
    lines.frustumCulled = false;
    return lines;
  }

  /** Rebuild the shared land buffers for owners whose polygons changed. */
  private syncLand(): void {
    const ids = this.territory.consumeDirty();
    if (ids.length === 0) return;
    for (const id of ids) this.rebuildSlot(id);
    this.packLand();
  }

  private rebuildSlot(id: number): void {
    if (id < 0 || id >= this.landParts.length) return;
    const rgb = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
    const built = buildLand(this.territory.polygon(id), WORLD, [rgb[0], rgb[1], rgb[2]]);
    if (!built || built.wall.idx.length < 3) {
      this.landParts[id] = null;
      return;
    }
    this.landParts[id] = {
      topPos: built.top.pos,
      topCol: built.top.col,
      topIdx: built.top.idx,
      wallPos: built.wall.pos,
      wallCol: built.wall.col,
      wallIdx: built.wall.idx,
    };
  }

  private readonly topV0 = new Int32Array(17);
  private readonly wallV0 = new Int32Array(17);

  /** Copy every owner's cached slab into the two shared meshes. */
  private packLand(): void {
    let tv = 0;
    let ti = 0;
    let wv = 0;
    let wi = 0;
    for (const part of this.landParts) {
      if (!part) continue;
      tv += part.topPos.length / 3;
      ti += part.topIdx.length;
      wv += part.wallPos.length / 3;
      wi += part.wallIdx.length;
    }
    this.topPos = growF(this.topPos, tv * 3);
    this.topCol = growF(this.topCol, tv * 3);
    this.topIdx = growU(this.topIdx, ti);
    this.wallPos = growF(this.wallPos, wv * 3);
    this.wallCol = growF(this.wallCol, wv * 3);
    this.wallIdx = growU(this.wallIdx, wi);
    this.topV0.fill(-1);
    this.wallV0.fill(-1);
    let vT = 0;
    let iT = 0;
    let vW = 0;
    let iW = 0;
    for (let id = 0; id < this.landParts.length; id++) {
      const part = this.landParts[id];
      if (!part) continue;
      const s = this.riseY[id] ?? 1;
      this.topV0[id] = vT;
      this.wallV0[id] = vW;
      for (let k = 0; k < part.topPos.length; k += 3) {
        const o = vT * 3;
        this.topPos[o] = part.topPos[k]!;
        this.topPos[o + 1] = part.topPos[k + 1]! * s;
        this.topPos[o + 2] = part.topPos[k + 2]!;
        this.topCol[o] = part.topCol[k]!;
        this.topCol[o + 1] = part.topCol[k + 1]!;
        this.topCol[o + 2] = part.topCol[k + 2]!;
        vT++;
      }
      for (let k = 0; k < part.topIdx.length; k++) this.topIdx[iT++] = this.topV0[id]! + part.topIdx[k]!;
      for (let k = 0; k < part.wallPos.length; k += 3) {
        const o = vW * 3;
        this.wallPos[o] = part.wallPos[k]!;
        this.wallPos[o + 1] = part.wallPos[k + 1]! * s;
        this.wallPos[o + 2] = part.wallPos[k + 2]!;
        this.wallCol[o] = part.wallCol[k]!;
        this.wallCol[o + 1] = part.wallCol[k + 1]!;
        this.wallCol[o + 2] = part.wallCol[k + 2]!;
        vW++;
      }
      for (let k = 0; k < part.wallIdx.length; k++) this.wallIdx[iW++] = this.wallV0[id]! + part.wallIdx[k]!;
    }
    uploadChunk(this.topGeo, this.topPos, this.topCol, this.topIdx, vT, iT);
    uploadChunk(this.wallGeo, this.wallPos, this.wallCol, this.wallIdx, vW, iW);
    const topMesh = this.land.children[1] as Mesh;
    const wallMesh = this.land.children[0] as Mesh;
    topMesh.visible = iT >= 3;
    wallMesh.visible = iW >= 3;
  }

  private applyRise(id: number, s: number): void {
    const part = this.landParts[id];
    const vT = this.topV0[id] ?? -1;
    const vW = this.wallV0[id] ?? -1;
    if (!part || vT < 0) return;
    const nT = part.topPos.length / 3;
    for (let i = 0; i < nT; i++) this.topPos[(vT + i) * 3 + 1] = part.topPos[i * 3 + 1]! * s;
    const nW = part.wallPos.length / 3;
    for (let i = 0; i < nW; i++) this.wallPos[(vW + i) * 3 + 1] = part.wallPos[i * 3 + 1]! * s;
    const topAttr = this.topGeo.getAttribute('position') as BufferAttribute;
    const wallAttr = this.wallGeo.getAttribute('position') as BufferAttribute;
    topAttr.clearUpdateRanges();
    topAttr.addUpdateRange(vT * 3, nT * 3);
    topAttr.needsUpdate = true;
    wallAttr.clearUpdateRanges();
    wallAttr.addUpdateRange(vW * 3, nW * 3);
    wallAttr.needsUpdate = true;
  }

  /** World-space XZ bounds of each owner's polygon. */
  landBoxes(): Array<{ x0: number; z0: number; x1: number; z1: number; w: number; d: number }> {
    const out: Array<{ x0: number; z0: number; x1: number; z1: number; w: number; d: number }> = [];
    for (let id = 1; id < this.landParts.length; id++) {
      const box = this.territory.ownerBounds(id);
      if (!box) continue;
      const x0 = box.x0 * WORLD;
      const z0 = box.y0 * WORLD;
      const x1 = (box.x1 + 1) * WORLD;
      const z1 = (box.y1 + 1) * WORLD;
      out.push({ x0, z0, x1, z1, w: x1 - x0, d: z1 - z0 });
    }
    return out;
  }

  /** Curved arena: the pale floor is the clear color. A dark ring covers everything outside the blob. */
  setBoundary(ring: Array<[number, number]>): void {
    const world = openWorld(ring);
    if (world.length < 8) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of world) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    this.arenaBox = { minX, maxX, minZ, maxZ };
    this.ground.geometry.dispose();
    this.ground.geometry = outsideRing(world);
    for (const mesh of this.fenceMeshes) {
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (!Array.isArray(mat)) mat.dispose();
      mesh.removeFromParent();
    }
    this.fenceMeshes.length = 0;
    const wall = new Mesh(
      blobWall(world),
      new MeshBasicMaterial({ color: 0xf7f4ee, side: DoubleSide, toneMapped: false }),
    );
    wall.frustumCulled = false;
    wall.renderOrder = 3;
    // Same parent as the floor. After the X mirror, that is the world group;
    // scene.add would leave a second rim that only lines up on x = 0.
    (this.ground.parent ?? this.scene).add(wall);
    this.fenceMeshes.push(wall);
  }

  punchClaim(): void {
    this.punch = 1;
    this.shake = Math.min(1, this.shake + 0.28);
  }

  /** Pooled gold coins popping out of a fresh claim. No per-call allocation. */
  coinBurst(x: number, z: number): void {
    const wx = x * WORLD;
    const wz = z * WORLD;
    let spawned = 0;
    for (let i = 0; i < this.fxLife.length && spawned < 8; i++) {
      if (this.fxLife[i]! > 0) continue;
      const ang = spawned * 0.8 + 0.4;
      this.fxLife[i] = 0.75;
      this.fxX[i] = wx;
      this.fxY[i] = SLAB_H + 0.35;
      this.fxZ[i] = wz;
      this.fxVx[i] = Math.cos(ang) * (2.4 + spawned * 0.12);
      this.fxVy[i] = 3.6 + (spawned % 3) * 0.45;
      this.fxVz[i] = Math.sin(ang) * (2.4 + spawned * 0.12);
      spawned++;
    }
  }

  clearPaths(): void {
    for (const p of this.paths) p.clear();
    for (const p of this.trails) p.clear();
    for (const r of this.ribbonBatch.ribbons) r.clear();
  }

  clearPath(id: number): void {
    this.paths[id]?.clear();
    this.trails[id]?.clear();
    this.ribbonBatch.ribbons[id]?.clear();
  }

  /** Drop every ribbon that now sits on `ownerId`'s land, including the claimer. */
  dropCoveredTrails(ownerId: number): void {
    for (let id = 1; id < this.trails.length; id++) {
      const trail = this.trails[id];
      if (!trail || trail.n < 1) {
        if (id === ownerId) this.ribbonBatch.ribbons[id]?.clear();
        continue;
      }
      let hit = id === ownerId;
      const samples = Math.min(trail.n, 32);
      for (let k = 0; k < samples && !hit; k++) {
        const i = (trail.head - 1 - k + PATH_N * 8) % PATH_N;
        if (this.territory.contains(ownerId, trail.xs[i]!, trail.zs[i]!)) hit = true;
      }
      if (!hit) continue;
      trail.clear();
      this.paths[id]?.clear();
      this.ribbonBatch.ribbons[id]?.clear();
    }
  }

  /** The live head is already on this pet's land, so the ribbon is a leftover. */
  private headOnOwnLand(id: number, path: PathBuf): boolean {
    if (path.n < 1) return false;
    const i = (path.head - 1 + PATH_N * 8) % PATH_N;
    return this.territory.contains(id, path.xs[i]!, path.zs[i]!);
  }

  /** True when a stored trail sample now sits on someone else's land. */
  private trailStolen(id: number, path: PathBuf): boolean {
    const n = Math.min(path.n, 80);
    for (let k = 0; k < n; k++) {
      const i = (path.head - 1 - k + PATH_N * 8) % PATH_N;
      if (this.territory.coveredByOther(id, path.xs[i]!, path.zs[i]!)) return true;
    }
    return false;
  }

  private readonly trailX = new Float32Array(PATH_N);
  private readonly trailY = new Float32Array(PATH_N);

  /** Oldest-to-newest trail samples in cell coordinates. */
  exportTrail(id: number): { x: Float32Array; y: Float32Array; n: number } {
    const path = this.trails[id];
    if (!path || path.n < 1) return { x: this.trailX, y: this.trailY, n: 0 };
    let n = 0;
    for (let k = path.n - 1; k >= 0; k--) {
      const i = (path.head - 1 - k + PATH_N * 8) % PATH_N;
      this.trailX[n] = path.xs[i]!;
      this.trailY[n] = path.zs[i]!;
      n++;
    }
    return { x: this.trailX, y: this.trailY, n };
  }

  update(
    dt: number,
    phase: 'title' | 'play' | 'dead',
    hero: number,
    pets: DrawPet[],
    petCount: number,
    pickups: DrawPickup[],
    pickupCount: number,
    snapCam: boolean,
  ): void {
    this.time += dt;
    this.renderer.setClearColor(phase === 'title' ? 0x9ed8ff : FLOOR_COLOR, 1);
    this.territory.update(dt);
    this.syncLand();
    this.riseSlabs();
    this.syncClaimRing();
    this.perf.beginFrame();

    if (phase === 'dead') {
      // The out beat holds the camera, but the land wipe keeps playing, so the
      // eliminated player watches their color drain into the victor's.
      this.stepWin(dt);
    this.stepSweeps(dt);
      this.stepParticles(dt);
      this.stepCoins(dt);
      this.stepPops(dt);
      this.ribbonBatch.flush();
      this.present();
      this.finishMeasure();
      this.perf.endFrame(performance.now(), this.renderer.info.render.calls, petCount);
      return;
    }

    for (const mesh of this.pets) mesh.count = 0;
    let shadowN = 0;
    let labelN = 0;
    for (const label of this.labels) label.on = false;

    if (phase === 'title') {
      this.ground.visible = false;
      this.gridLines.visible = false;
      this.land.visible = false;
      this.claimRing.visible = false;
      this.flashRing.visible = false;
      this.stage.visible = true;
      this.decor.visible = true;
      this.stepDecor(dt);
      if (this.winLife > 0) this.winDisc.visible = false;
      this.bases.count = 0;
      this.fxCoins.count = 0;
      for (let i = 0; i < this.fxLife.length; i++) this.fxLife[i] = 0;
      for (const wall of this.fenceMeshes) wall.visible = false;
      for (const ribbon of this.ribbonBatch.ribbons) ribbon.clear();
      this.ring.visible = false;
      this.pulse.visible = false;
      this.nudge.visible = false;
      this.frames.count = 0;
      this.glows.count = 0;
      this.shields.count = 0;
      this.slows.count = 0;
      this.paintRing.visible = false;
      this.frostRing.visible = false;
      this.sparkles.count = 0;
      this.hearts.count = 0;
      this.rainbows.count = 0;
      this.paws.count = 0;
      this.podium.rotation.z = this.time * 0.35;
      const mesh = this.pets[hero];
      const wig = this.wiggle;
      this.wiggle = Math.max(0, this.wiggle - dt * 1.6);
      const hop = wig > 0 ? Math.sin(Math.min(1, wig) * Math.PI) * 0.42 : 0;
      const bounce = Math.abs(Math.sin(this.time * 3.2));
      const squash = 1 + (1 - bounce) * 0.06 + (wig > 0 ? Math.sin(wig * 12) * 0.07 : 0);
      // About 55% of a portrait width. The pet sits on the pedestal, face toward the camera.
      const portrait = this.camera.aspect < 0.95;
      let lookX = portrait ? 0 : 1.15;
      let lookY = portrait ? 0.48 : 0.62;
      let camY = portrait ? 1.28 : 1.15;
      let camZ = portrait ? 6.55 : 6.7;
      let body = portrait ? 1.05 : 0.72;
      if (this.stageKind === 'detail') {
        lookX = 0;
        lookY = 0.62;
        camY = 1.22;
        camZ = 4.35;
        body = 0.78;
      } else if (this.stageKind === 'reveal') {
        lookX = 0;
        lookY = 0.7;
        camY = 1.28;
        camZ = 5.1;
        body = 0.72;
      }
      const yaw = HOME_FACE + Math.sin(this.time * 0.7) * 0.1;
      if (mesh) {
        this.placePet(mesh, 0, 0, 0.22 + bounce * bounce * 0.2 + hop, 0, yaw + wig * 0.5, wig * 0.28, body, squash, this.heroRecolor);
        mesh.count = 1;
        mesh.instanceMatrix.needsUpdate = true;
      }
      this.place(this.shadows, 0, 0, 0.46, 0, 0, 0, 0.55);
      this.shadows.count = 1;
      this.shadows.instanceMatrix.needsUpdate = true;
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(lookX, camY, camZ);
      this.camera.lookAt(lookX, lookY, 0);
      this.coins.count = 0;
      this.orbs.count = 0;
      this.loot.count = 0;
      this.selfScreen = false;
    } else {
      this.ground.visible = true;
      this.land.visible = true;
      this.gridLines.visible = false;
      this.stage.visible = false;
      this.decor.visible = false;
      for (const wall of this.fenceMeshes) wall.visible = true;
      let selfX = this.holdX;
      let selfZ = this.holdZ;
      let selfAlive = false;
      for (let i = 0; i < petCount; i++) {
        const pet = pets[i]!;
        const ribbon = this.ribbonBatch.ribbons[pet.id];
        if (!pet.alive) {
          this.paths[pet.id]?.clear();
          ribbon?.clear();
          const pop = this.popLife[pet.id] ?? 0;
          if (pop > 0) {
            let px = pet.x;
            let pz = pet.z;
            let py = 0.2;
            if (pet.id === this.arcId && this.arcLife > 0) {
              const u = 1 - this.arcLife / 0.72;
              const e = u * u * (3 - 2 * u);
              px = this.arcSx + (this.arcTx - this.arcSx) * e;
              pz = this.arcSz + (this.arcTz - this.arcSz) * e;
              py = Math.sin(Math.min(1, u) * Math.PI) * 1.45;
            }
            const mesh = this.pets[pet.pet];
            if (mesh && mesh.count < PET_CAP) {
              this.placePet(mesh, mesh.count, px * WORLD, py, pz * WORLD, pet.h, 0, 1.05, 1);
              mesh.count++;
            }
          }
          continue;
        }
        const wx = pet.x * WORLD;
        const wz = pet.z * WORLD;
        const feet = gfx.cpu ? this.surfaceAt(pet.id, pet.x, pet.z) : 0;
        const turn = angleDelta(this.prevHead[pet.id] ?? pet.h, pet.h);
        this.prevHead[pet.id] = pet.h;
        const omega = dt > 1e-4 ? turn / dt : 0;
        const bankTarget = Math.max(-0.2, Math.min(0.2, -omega * 0.045));
        const bankBlend = 1 - Math.exp(-10 * dt);
        this.bank[pet.id] = (this.bank[pet.id] ?? 0) + (bankTarget - (this.bank[pet.id] ?? 0)) * bankBlend;
        const bob = 0;
        const squash = 1;
        const roll = this.bank[pet.id] ?? 0;
        const mesh = this.pets[pet.pet];
        const shimmer = pet.blink ? 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(this.time * Math.PI * 16)) : 1;
        const body = (pet.self ? 1.08 : 1) * shimmer;
        if (mesh && mesh.count < PET_CAP) {
          this.placePet(mesh, mesh.count, wx, feet + bob, wz, this.smoothHead(pet.id, pet.h, dt), roll, body, squash, pet.recolor);
          mesh.count++;
        }
        if (shadowN < SHADOW_CAP) {
          this.place(this.shadows, shadowN++, wx, feet + 0.03, wz, 0, 0, pet.self ? 1.05 : 0.92);
          this.placeBase(shadowN - 1, wx, feet + 0.05, wz, pet.id, pet.self ? 1.05 : 1);
        }
        const path = this.paths[pet.id];
        path?.push(pet.x, pet.z, pet.h);
        const trail = this.trails[pet.id];
        const covered =
          gfx.cpu && !!trail && (this.trailStolen(pet.id, trail) || this.headOnOwnLand(pet.id, trail));
        if (gfx.cpu && pet.outside && trail && !covered) {
          trail.push(pet.x, pet.z, pet.h, 0.12);
          if (ribbon && trail.n >= 1) {
            const col = PALETTE[(Math.max(1, pet.id) - 1) % PALETTE.length]!;
            ribbon.setColor(
              (col[0] + (255 - col[0]) * 0.55) / 255,
              (col[1] + (255 - col[1]) * 0.55) / 255,
              (col[2] + (255 - col[2]) * 0.55) / 255,
            );
            ribbon.draw(trail, pet.x, pet.z);
          }
        } else {
          trail?.clear();
          ribbon?.clear();
        }
        const shown = pet.trainShown;
        for (let t = 0; t < shown; t++) {
          const species = pet.train[shown - 1 - t] ?? 0;
          const follower = this.pets[species];
          if (!follower || follower.count >= PET_CAP || !path) continue;
          if (!path.sample(8.2 * (t + 1), this.sample)) continue;
          const newest = t === 0;
          const hop = newest ? pet.hop : 0;
          const hopT = hop > 0 ? 1 - hop / 0.72 : 1;
          const hopSquash = hop > 0 ? 1 + Math.sin(hopT * Math.PI) * 0.45 : 1;
          const lift = hop > 0 ? Math.sin(hopT * Math.PI) * 1.35 : 0;
          const fw = Math.sin(this.time * 8 + t * 1.7);
          const fb = Math.max(0, fw) * 0.08;
          const fFeet = gfx.cpu ? this.surfaceAt(pet.id, this.sample.x, this.sample.z) : 0;
          this.placePet(
            follower,
            follower.count,
            this.sample.x * WORLD,
            fFeet + fb + lift,
            this.sample.z * WORLD,
            this.sample.h,
            0,
            0.94,
            hop > 0 ? hopSquash : fw > 0 ? 1.06 : 0.92,
          );
          follower.count++;
          if (shadowN < SHADOW_CAP) {
            this.place(this.shadows, shadowN++, this.sample.x * WORLD, fFeet + 0.03, this.sample.z * WORLD, 0, 0, 0.78);
            this.placeBase(shadowN - 1, this.sample.x * WORLD, fFeet + 0.05, this.sample.z * WORLD, pet.id, 0.86);
          }
          if (t === shown - 1 && pet.trainExtra > 0 && labelN < this.labels.length) {
            const label = this.labels[labelN++]!;
            const p = this.project(this.sample.x, fFeet + 1.45, this.sample.z);
            label.on = p.ok;
            label.name = false;
            label.sx = p.x;
            label.sy = p.y;
            label.text = `+${pet.trainExtra}`;
            label.color = '#243044';
          }
        }
        if (!pet.self && pet.name && labelN < this.labels.length) {
          const label = this.labels[labelN++]!;
          const p = this.project(pet.x, feet + 1.85, pet.z);
          label.on = p.ok;
          label.name = true;
          label.sx = p.x;
          label.sy = p.y;
          label.text = pet.name;
          label.color = PAL_CSS[(Math.max(1, pet.id) - 1) % PAL_CSS.length]!;
        }
        if (pet.self) {
          selfX = pet.x;
          selfZ = pet.z;
          selfAlive = true;
          this.holdX = pet.x;
          this.holdZ = pet.z;
          this.ring.visible = true;
          this.ring.position.set(wx, 0.04, wz);
          const col = PALETTE[(Math.max(1, pet.id) - 1) % PALETTE.length]!;
          const ringMat = this.ring.material as MeshBasicMaterial;
          ringMat.color.setRGB(col[0] / 255, col[1] / 255, col[2] / 255);
          if (this.parkHint) {
            const beat = 0.5 + 0.5 * Math.sin(this.time * 5.4);
            const ringScale = 0.76 + beat * 0.46;
            this.ring.scale.set(ringScale, 1, ringScale);
            ringMat.opacity = 0.38 + beat * 0.55;
            this.pulse.visible = true;
            const wave = (this.time * 0.9) % 1;
            const ps = 0.82 + wave * 1.2;
            this.pulse.position.set(wx, 0.05, wz);
            this.pulse.scale.set(ps, 1, ps);
            const pulseMat = this.pulse.material as MeshBasicMaterial;
            pulseMat.color.copy(ringMat.color);
            pulseMat.opacity = (1 - wave) * 0.55;
            this.nudge.visible = true;
            const h = pet.h;
            const dist = 1.12 + beat * 0.18;
            this.nudge.position.set(wx + Math.cos(h) * dist, 0.08, wz + Math.sin(h) * dist);
            this.nudge.rotation.y = -h;
            this.nudge.scale.setScalar(0.92 + beat * 0.22);
            const nudgeMat = this.nudge.material as MeshBasicMaterial;
            nudgeMat.color.copy(ringMat.color);
          } else {
            const ringScale = pet.blink ? 0.9 + 0.18 * (0.5 + 0.5 * Math.sin(this.time * Math.PI * 16)) : 1;
            this.ring.scale.set(ringScale, 1, ringScale);
            ringMat.opacity = 0.9;
            this.pulse.visible = false;
            this.nudge.visible = false;
          }
          const screen = this.project(pet.x, 0.7, pet.z);
          this.selfScreen = screen.ok;
          this.selfSX = screen.x;
          this.selfSY = screen.y;
        }
      }
      for (const mesh of this.pets) {
        mesh.visible = mesh.count > 0;
        if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
      }
      this.shadows.count = shadowN;
      this.bases.count = shadowN;
      if (shadowN > 0) {
        this.shadows.instanceMatrix.needsUpdate = true;
        this.bases.instanceMatrix.needsUpdate = true;
        if (this.bases.instanceColor) this.bases.instanceColor.needsUpdate = true;
      }
      if (!selfAlive) {
        this.ring.visible = false;
        this.pulse.visible = false;
        this.nudge.visible = false;
        this.selfScreen = false;
      }

      this.punch *= Math.exp(-dt * 4);
      this.shake *= Math.exp(-dt * 6);
      const zoom = 1 + Math.min(0.22, this.landPct * 2.2);
      const span = 14 * zoom;
      // Frame the short side. Portrait keeps the old width; landscape and
      // desktop show that same span on the short side and more on the long side.
      const short = Math.min(this.camera.aspect, 1);
      const dist = span / (2 * Math.tan((20 * Math.PI) / 180) * short);
      const elev = (64 * Math.PI) / 180;
      const back = Math.cos(elev) * dist;
      const height = Math.sin(elev) * dist - this.punch * 1.3;
      const px = selfX * WORLD;
      const pz = selfZ * WORLD;
      // North-up, locked to the rendered pet. Heading no longer swings the target,
      // so a turn does not shove the pet around the screen.
      const lx = px;
      const lz = pz;
      const clamped = this.clampLook(lx, lz, Math.max(1, height), back);
      const lookSceneX = -clamped.x;
      const tx = lookSceneX;
      const tz = clamped.z - back;
      if (!this.camInit || snapCam) {
        this.camX = tx;
        this.camY = height;
        this.camZ = tz;
        this.lookX = lookSceneX;
        this.lookZ = clamped.z;
        this.camVx = this.camVz = this.lookVx = this.lookVz = 0;
        this.camInit = true;
      } else {
        [this.camX, this.camVx] = dampTo(this.camX, this.camVx, tx, dt);
        [this.camZ, this.camVz] = dampTo(this.camZ, this.camVz, tz, dt);
        this.camY += (height - this.camY) * (1 - Math.exp(-dt * 8));
        [this.lookX, this.lookVx] = dampTo(this.lookX, this.lookVx, lookSceneX, dt);
        [this.lookZ, this.lookVz] = dampTo(this.lookZ, this.lookVz, clamped.z, dt);
      }
      const jx = (Math.random() - 0.5) * this.shake * 0.35;
      const jz = (Math.random() - 0.5) * this.shake * 0.35;
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(this.camX + jx, this.camY, this.camZ + jz);
      this.camera.lookAt(this.lookX, 0.42, this.lookZ);

      this.layoutPickups(this.coins, pickups, pickupCount, 0);
      this.layoutPickups(this.orbs, pickups, pickupCount, 1);
      this.layoutPickups(this.loot, pickups, pickupCount, 2);
      this.syncAbility(pets, petCount, dt);
      this.layCosmetics(pets, petCount);
    }

    this.stepWin(dt);
    this.stepSweeps(dt);
    this.stepParticles(dt);
    this.stepCoins(dt);
    this.stepPops(dt);
    this.ribbonBatch.flush();
    this.present();
    this.finishMeasure();
    this.perf.endFrame(performance.now(), this.renderer.info.render.calls, phase === 'play' ? petCount : SPECIES.length);
  }

  private syncClaimRing(): void {
    const pulse = this.territory.claimPulse;
    if (pulse <= 0.02) {
      this.claimRing.visible = false;
      return;
    }
    const t = 1 - pulse;
    const ease = 1 - (1 - t) * (1 - t);
    const x0 = this.territory.claimX0;
    const y0 = this.territory.claimY0;
    const x1 = this.territory.claimX1;
    const y1 = this.territory.claimY1;
    const cx = ((x0 + x1 + 1) / 2) * WORLD;
    const cz = ((y0 + y1 + 1) / 2) * WORLD;
    const rad = Math.max(1.4, Math.hypot((x1 - x0 + 1) * WORLD, (y1 - y0 + 1) * WORLD) * 0.55);
    const s = rad * (0.82 + 0.34 * ease);
    this.claimRing.position.set(cx, 0.07, cz);
    this.claimRing.scale.set(s, 1, s);
    const mat = this.claimRing.material as MeshBasicMaterial;
    mat.opacity = Math.max(0, 0.85 * (1 - ease));
    this.claimRing.visible = true;
  }

  private stepPops(dt: number): void {
    for (let i = 0; i < this.popLife.length; i++) {
      if (this.popLife[i]! > 0) this.popLife[i] = Math.max(0, this.popLife[i]! - dt);
    }
    if (this.arcLife > 0) this.arcLife = Math.max(0, this.arcLife - dt);
    if (this.killFlash > 0) {
      this.killFlash = Math.max(0, this.killFlash - dt);
      const u = 1 - this.killFlash / 0.3;
      const s = 0.7 + u * 3.4;
      this.flashRing.position.set(this.killX, 0.08, this.killZ);
      this.flashRing.scale.set(s, 1, s);
      (this.flashRing.material as MeshBasicMaterial).opacity = Math.max(0, 0.95 * (1 - u));
      this.flashRing.visible = this.killFlash > 0.01;
    }
  }

  private finishMeasure(): void {
    if (!this.measurePending) return;
    this.measurePending = false;
    this.landMeasure = this.readColorBox(this.measureR, this.measureG, this.measureB);
  }

  private readColorBox(r: number, g: number, b: number): {
    pixels: number;
    boxW: number;
    boxH: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let pixels = 0;
    const tol = 78;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const p = (y * w + x) * 4;
        if (Math.abs(buf[p]! - r) > tol || Math.abs(buf[p + 1]! - g) > tol || Math.abs(buf[p + 2]! - b) > tol) continue;
        pixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return {
      pixels: pixels * 4,
      boxW: maxX < 0 ? 0 : maxX - minX + 2,
      boxH: maxY < 0 ? 0 : maxY - minY + 2,
      minX,
      minY: maxY < 0 ? 0 : h - 1 - maxY,
      maxX,
      maxY: maxY < 0 ? 0 : h - 1 - minY,
    };
  }

  project(x: number, y: number, z: number): { x: number; y: number; ok: boolean } {
    this.proj.set(-x * WORLD, y, z * WORLD).project(this.camera);
    const w = this.renderer.domElement.clientWidth || window.innerWidth;
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    return {
      x: (this.proj.x * 0.5 + 0.5) * w,
      y: (-this.proj.y * 0.5 + 0.5) * h,
      ok: this.proj.z < 1,
    };
  }

  private layoutPickups(mesh: InstancedMesh, pickups: DrawPickup[], count: number, kind: number): void {
    let n = 0;
    const spin = this.time * (kind === 1 ? 2.4 : 1.6);
    for (let i = 0; i < count; i++) {
      const p = pickups[i]!;
      if (p.kind !== kind || n >= PICK_CAP) continue;
      const bob = kind === 0 ? 0.28 : 0.45 + Math.sin(this.time * 4 + p.x) * 0.06;
      this.place(mesh, n, p.x * WORLD, bob, p.z * WORLD, spin + i, 0, 1);
      n++;
    }
    mesh.count = n;
    if (n > 0) mesh.instanceMatrix.needsUpdate = true;
  }

  private stepParticles(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.partCount; i++) {
      const life = this.life[i]! - dt;
      if (life <= 0) continue;
      const nx = this.px[i]! + this.vx[i]! * dt;
      const ny = this.py[i]! + this.vy[i]! * dt;
      const nz = this.pz[i]! + this.vz[i]! * dt;
      const nvx = this.vx[i]!;
      const nvy = this.vy[i]! - 6 * dt;
      const nvz = this.vz[i]!;
      const nr = this.pr[i]!;
      const ng = this.pg[i]!;
      const nb = this.pb[i]!;
      this.life[w] = life;
      this.px[w] = nx;
      this.py[w] = ny;
      this.pz[w] = nz;
      this.vx[w] = nvx;
      this.vy[w] = nvy;
      this.vz[w] = nvz;
      this.pr[w] = nr;
      this.pg[w] = ng;
      this.pb[w] = nb;
      this.place(this.parts, w, nx, ny, nz, life * 9 + i, life * 5, 0.75 + life * 0.4);
      this.parts.instanceColor?.setXYZ(w, nr, ng, nb);
      w++;
    }
    this.partCount = w;
    this.parts.count = w;
    if (w > 0) {
      this.parts.instanceMatrix.needsUpdate = true;
      if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
    }
  }

  private riseSlabs(): void {
    const id = this.territory.claimId;
    const pulse = this.territory.claimPulse;
    let s = 1;
    if (id > 0 && pulse > 0.02) {
      const t = 1 - pulse;
      const ease = 1 - (1 - t) * (1 - t);
      s = 0.08 + 0.92 * ease;
    }
    for (let i = 1; i < this.riseY.length; i++) {
      const want = i === id ? s : 1;
      if (this.riseY[i] === want) continue;
      this.riseY[i] = want;
      this.applyRise(i, want);
    }
  }

  /**
   * Keep the pet in frame, but don't let the grey outside fill the picture.
   * The far edge of the ground is allowed to sit about 35% in from the screen.
   */
  private clampLook(x: number, z: number, height: number, back: number): { x: number; z: number } {
    const half = (20 * Math.PI) / 180;
    const elev = Math.atan2(height, Math.max(0.2, back));
    const dTop = height / Math.tan(Math.max(0.12, elev - half));
    const dBot = height / Math.tan(elev + half);
    const span = Math.max(1, dTop - dBot);
    const box = this.arenaBox;
    const maxZ = box.maxZ - dTop + back + 0.35 * span;
    const minZ = box.minZ + back - dBot - 0.35 * span;
    let cz = z;
    if (minZ < maxZ) cz = Math.min(maxZ, Math.max(minZ, z));
    const hFov = Math.atan(Math.tan(half) * Math.max(0.2, this.camera.aspect));
    const slant = height / Math.sin(Math.max(0.2, elev - half));
    const inset = slant * Math.tan(hFov) * 0.3;
    let cx = x;
    if (inset * 2 < box.maxX - box.minX) cx = Math.min(box.maxX - inset, Math.max(box.minX + inset, x));
    return { x: cx, z: cz };
  }

  private surfaceAt(id: number, x: number, z: number): number {
    if (this.territory.contains(id, x, z) || this.territory.coveredByOther(id, x, z)) return SLAB_H;
    return 0;
  }

  private placeBase(index: number, x: number, y: number, z: number, id: number, scale: number): void {
    this.place(this.bases, index, x, y, z, 0, 0, scale);
    const c = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
    this.bases.instanceColor?.setXYZ(index, c[0] / 255, c[1] / 255, c[2] / 255);
  }

  /** Victim color wipes away from the bite, revealing the land the victor just took. */
  sweepLand(mp: MultiPolygon, r: number, g: number, b: number, x: number, z: number): void {
    const parts = buildLand(mp, WORLD, [r, g, b]);
    if (!parts || !this.mirror) return;
    const geo = new BufGeo();
    geo.setAttribute('position', new BufferAttribute(parts.top.pos, 3));
    geo.setIndex(new BufferAttribute(parts.top.idx, 1));
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uCenter: { value: new Vector2(x * WORLD, z * WORLD) },
        uRad: { value: 0.15 },
        uColor: { value: new Vector3(r / 255, g / 255, b / 255) },
      },
      vertexShader: `
        varying vec3 vP;
        void main() {
          vP = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec2 uCenter;
        uniform float uRad;
        uniform vec3 uColor;
        varying vec3 vP;
        void main() {
          if (distance(vP.xz, uCenter) < uRad) discard;
          gl_FragColor = vec4(uColor, 0.94);
        }
      `,
    });
    const mesh = new Mesh(geo, mat);
    mesh.position.y = 0.08;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    this.mirror.add(mesh);
    this.sweeps.push({ mesh, life: 0.7, max: 0.7 });
  }

  confetti(x: number, z: number): void {
    const colors: Array<[number, number, number]> = [
      [1, 0.35, 0.55],
      [1, 0.85, 0.2],
      [0.35, 0.75, 1],
      [0.55, 0.95, 0.4],
      [0.72, 0.45, 1],
    ];
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i]!;
      this.splash(x + (i - 2) * 2.2, z + ((i % 2) - 0.5) * 3, 14, c[0], c[1], c[2]);
    }
  }

  private stepSweeps(dt: number): void {
    for (let i = this.sweeps.length - 1; i >= 0; i--) {
      const s = this.sweeps[i]!;
      s.life -= dt;
      const u = 1 - Math.max(0, s.life) / s.max;
      const mat = s.mesh.material as ShaderMaterial;
      const rad = mat.uniforms.uRad;
      if (rad) rad.value = u * u * 70;
      if (s.life <= 0) {
        s.mesh.removeFromParent();
        s.mesh.geometry.dispose();
        mat.dispose();
        this.sweeps.splice(i, 1);
      }
    }
  }

  private stepCoins(dt: number): void {
    let n = 0;
    const floorY = SLAB_H + 0.22;
    for (let i = 0; i < this.fxLife.length; i++) {
      const life = this.fxLife[i]! - dt;
      if (life <= 0) {
        this.fxLife[i] = 0;
        continue;
      }
      this.fxLife[i] = life;
      this.fxX[i] = this.fxX[i]! + this.fxVx[i]! * dt;
      this.fxZ[i] = this.fxZ[i]! + this.fxVz[i]! * dt;
      this.fxY[i] = this.fxY[i]! + this.fxVy[i]! * dt;
      this.fxVy[i] = this.fxVy[i]! - 10 * dt;
      if (this.fxY[i]! < floorY) {
        this.fxY[i] = floorY;
        this.fxVy[i] = Math.abs(this.fxVy[i]!) * 0.35;
      }
      this.place(this.fxCoins, n, this.fxX[i]!, this.fxY[i]!, this.fxZ[i]!, this.time * 9 + i, 0, 0.9);
      n++;
    }
    this.fxCoins.count = n;
    if (n > 0) this.fxCoins.instanceMatrix.needsUpdate = true;
  }

  /** One-shot bursts. Ongoing dash, shield, and frost tint follow the snapshots. */
  abilityFx(kind: string, x: number, z: number, r: number, fx: number, fy: number): void {
    if (kind === 'paint') {
      this.paintLife = 0.62;
      this.paintX = x * WORLD;
      this.paintZ = z * WORLD;
      this.paintR = Math.max(0.5, r * WORLD);
      this.splash(x, z, 26, 1, 0.35, 0.62);
    } else if (kind === 'frost') {
      this.frostLife = 0.66;
      this.frostX = x * WORLD;
      this.frostZ = z * WORLD;
      this.frostR = Math.max(0.5, r * WORLD);
      this.splash(x, z, 22, 0.45, 0.78, 1);
    } else if (kind === 'recall') {
      this.splash(fx, fy, 16, 0.96, 0.96, 1);
      this.splash(x, z, 16, 0.96, 0.96, 1);
    } else if (kind === 'dash') {
      this.splash(x, z, 12, 1, 0.82, 0.28);
    } else if (kind === 'shield') {
      this.splash(x, z, 10, 0.72, 0.92, 1);
    }
  }

  private splash(x: number, z: number, n: number, r: number, g: number, b: number): void {
    const wx = x * WORLD;
    const wz = z * WORLD;
    for (let k = 0; k < n; k++) {
      if (this.partCount >= PART_CAP) break;
      const i = this.partCount++;
      const ang = (k / n) * Math.PI * 2;
      const sp = 1.4 + (k % 5) * 0.45;
      this.px[i] = wx;
      this.py[i] = 0.35 + (k % 4) * 0.12;
      this.pz[i] = wz;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = 1.6 + (k % 3) * 0.4;
      this.vz[i] = Math.sin(ang) * sp;
      this.life[i] = 0.55;
      this.pr[i] = r;
      this.pg[i] = g;
      this.pb[i] = b;
    }
  }

  private syncAbility(pets: DrawPet[], petCount: number, dt: number): void {
    let frames = 0;
    let glows = 0;
    let shields = 0;
    let slows = 0;
    for (let i = 0; i < petCount; i++) {
      const pet = pets[i]!;
      if (!pet.alive) continue;
      const wx = pet.x * WORLD;
      const wz = pet.z * WORLD;
      if (frames < 48) {
        this.place(this.frames, frames, wx, 0.07, wz, 0, 0, pet.self ? 1.22 : 1.08);
        const tint = RARITY_TINT[pet.rarity] ?? RARITY_TINT[0]!;
        this.frames.instanceColor?.setXYZ(frames, tint[0] / 255, tint[1] / 255, tint[2] / 255);
        frames++;
      }
      if (pet.rarity >= 4 && glows < 16) {
        const pulse = 1.28 + Math.sin(this.time * 3.2 + pet.id) * 0.1;
        this.place(this.glows, glows++, wx, 0.09, wz, this.time * 0.6, 0, pulse);
      }
      if (pet.slow && slows < 16) this.place(this.slows, slows++, wx, 0.5, wz, 0, 0, 1.28);
      if (pet.shield) {
        if (shields < 48) this.place(this.shields, shields++, wx, 0.58, wz, 0, 0, 1.12);
        const trail = this.trails[pet.id];
        if (trail) {
          for (let k = 3; k < trail.n && shields < 48; k += 5) {
            const idx = (trail.head - 1 - k + PATH_N * 8) % PATH_N;
            this.place(this.shields, shields++, trail.xs[idx]! * WORLD, 0.42, trail.zs[idx]! * WORLD, 0, 0, 0.7);
          }
        }
      }
      if (pet.dash && this.partCount < PART_CAP - 1) {
        const back = pet.h + Math.PI;
        this.splash(pet.x + Math.cos(back) * 1.2, pet.z + Math.sin(back) * 1.2, 2, 1, 0.86, 0.35);
      }
    }
    this.frames.count = frames;
    this.glows.count = glows;
    this.shields.count = shields;
    this.slows.count = slows;
    if (frames > 0) this.frames.instanceColor!.needsUpdate = true;
    this.frames.instanceMatrix.needsUpdate = frames > 0;
    this.glows.instanceMatrix.needsUpdate = glows > 0;
    this.shields.instanceMatrix.needsUpdate = shields > 0;
    this.slows.instanceMatrix.needsUpdate = slows > 0;
    this.paintLife = this.stepRing(this.paintRing, this.paintLife, 0.62, this.paintX, this.paintZ, this.paintR, dt);
    this.frostLife = this.stepRing(this.frostRing, this.frostLife, 0.66, this.frostX, this.frostZ, this.frostR, dt);
  }

  private stepRing(mesh: Mesh, life: number, max: number, x: number, z: number, radius: number, dt: number): number {
    if (life <= 0) {
      mesh.visible = false;
      return 0;
    }
    const next = life - dt;
    const u = 1 - Math.max(0, next) / max;
    const mat = mesh.material as MeshBasicMaterial;
    mat.opacity = 0.9 * (1 - u);
    mesh.visible = true;
    mesh.position.set(x, 0.06 + u * 0.7, z);
    const s = (radius / 0.82) * (0.2 + 0.8 * u);
    mesh.scale.set(s, 1, s);
    return Math.max(0, next);
  }

  private layCosmetics(pets: DrawPet[], petCount: number): void {
    const meshes = [null, this.sparkles, this.hearts, this.rainbows, this.paws];
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < petCount; i++) {
      const pet = pets[i]!;
      if (!pet.alive || pet.trail <= 0) continue;
      const mesh = meshes[pet.trail];
      if (!mesh) continue;
      const trail = this.trails[pet.id];
      if (!trail || trail.n < 2) continue;
      for (let k = 2; k < trail.n && counts[pet.trail]! < 80; k += 4) {
        const idx = (trail.head - 1 - k + PATH_N * 8) % PATH_N;
        const n = counts[pet.trail]!;
        const spin = pet.trail === 1 ? this.time * 2 + n : n * 0.4;
        const scale = pet.trail === 4 ? 0.7 : pet.trail === 2 ? 2.2 : 0.85;
        this.place(mesh, n, trail.xs[idx]! * WORLD, 0.22, trail.zs[idx]! * WORLD, spin, 0, scale);
        if (pet.trail === 3) {
          const hue = (this.time * 0.2 + n * 0.08) % 1;
          const rgb = hsl(hue, 0.9, 0.55);
          mesh.instanceColor?.setXYZ(n, rgb[0], rgb[1], rgb[2]);
        } else if (pet.trail === 2) {
          mesh.instanceColor?.setXYZ(n, 1, 1, 1);
        } else if (pet.trail === 1) {
          mesh.instanceColor?.setXYZ(n, 1, 0.92, 0.45);
        } else {
          mesh.instanceColor?.setXYZ(n, 0.95, 0.62, 0.42);
        }
        counts[pet.trail] = n + 1;
      }
    }
    for (let t = 1; t <= 4; t++) {
      const mesh = meshes[t]!;
      mesh.count = counts[t]!;
      mesh.instanceMatrix.needsUpdate = counts[t]! > 0;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = counts[t]! > 0;
    }
  }

  poke(): void {
    this.wiggle = 1;
  }

  /** Spreading disc of the victor's color. The real flood lands when it finishes. */
  winWave(x: number, z: number, r: number, g: number, b: number): void {
    this.winLife = 1.35;
    this.winDisc.visible = true;
    this.winDisc.position.set(x * WORLD, 0.12, z * WORLD);
    const mat = this.winDisc.material as MeshBasicMaterial;
    mat.color.setRGB(r / 255, g / 255, b / 255);
    mat.opacity = 0.94;
    this.winDisc.scale.set(0.3, 1, 0.3);
  }

  private stepWin(dt: number): void {
    if (this.winLife <= 0) return;
    this.winLife = Math.max(0, this.winLife - dt);
    const u = 1 - this.winLife / 1.35;
    const e = u * u * (3 - 2 * u);
    const s = 0.35 + e * 72;
    this.winDisc.scale.set(s, 1, s);
    const mat = this.winDisc.material as MeshBasicMaterial;
    mat.opacity = this.winLife < 0.25 ? Math.max(0, this.winLife / 0.25) * 0.94 : 0.94;
    this.winDisc.visible = this.winLife > 0;
  }

  private stepDecor(dt: number): void {
    const kids = this.decor.children;
    for (let i = 0; i < kids.length; i++) {
      const blob = kids[i]!;
      const spin = typeof blob.userData.spin === 'number' ? blob.userData.spin : 0.4;
      const base = typeof blob.userData.base === 'number' ? blob.userData.base : 0.4;
      const amp = typeof blob.userData.amp === 'number' ? blob.userData.amp : 0.12;
      const origin = typeof blob.userData.ox === 'number' ? blob.userData.ox : blob.position.x;
      blob.position.x = origin + Math.sin(this.time * spin * 0.45 + i) * amp;
      blob.position.y = base + Math.sin(this.time * spin + i) * 0.16;
      blob.rotation.y += dt * spin;
    }
  }

  private smoothHead(id: number, target: number, dt: number): number {
    const prev = this.visH[id] ?? target;
    const d = angleDelta(prev, target);
    if (Math.abs(d) > 1.5) {
      this.visH[id] = target;
      return target;
    }
    const next = prev + d * (1 - Math.exp(-18 * dt));
    this.visH[id] = next;
    return next;
  }

  /**
   * One close, labeled still per species. Menus use the unlit colormap.
   * In-game uses the same Lambert pets the match draws, with no recolor.
   */
  buildSheet(): void {
    const refs = this.kenneySwatches();
    this.referenceRGB = refs;
    const menu = this.captureSpecies(true);
    const game = this.captureSpecies(false);
    this.sheetMenu = composeContact('Menus', menu, refs);
    this.sheet = composeContact('In game', game, refs);
    this.portraitURLs = menu.map((tile) => tile.toDataURL('image/png'));
  }

  private kenneySwatches(): Array<[number, number, number]> {
    const map = this.petMaterial.map;
    const image = map?.image as CanvasImageSource | undefined;
    const blank: Array<[number, number, number]> = SPECIES.map(() => [180, 180, 180]);
    if (!image) return blank;
    const src = document.createElement('canvas');
    const iw = (image as HTMLImageElement).width || (image as ImageBitmap).width || 512;
    const ih = (image as HTMLImageElement).height || (image as ImageBitmap).height || 512;
    src.width = iw;
    src.height = ih;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    if (!sctx) return blank;
    sctx.drawImage(image, 0, 0, iw, ih);
    const pixels = sctx.getImageData(0, 0, iw, ih).data;
    return this.pets.map((mesh) => {
      const uv = mesh.geometry.getAttribute('uv');
      if (!uv || uv.count === 0) return [180, 180, 180] as [number, number, number];
      const bins = new Map<number, number>();
      const cols = 16;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        const cx = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
        const cy = Math.min(cols - 1, Math.max(0, Math.floor((1 - v) * cols)));
        const key = cy * cols + cx;
        bins.set(key, (bins.get(key) ?? 0) + 1);
      }
      let best = 0;
      let bestN = -1;
      let fallback = 0;
      let fallbackN = -1;
      for (const [key, n] of bins) {
        const cx = key % cols;
        const cy = (key / cols) | 0;
        const px = Math.min(iw - 1, Math.floor(((cx + 0.5) / cols) * iw));
        const py = Math.min(ih - 1, Math.floor(((cy + 0.5) / cols) * ih));
        const i = (py * iw + px) * 4;
        const r = pixels[i] ?? 0;
        const g = pixels[i + 1] ?? 0;
        const b = pixels[i + 2] ?? 0;
        // Outline cells are near-black. The reference color is the body swatch.
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luma > 36 && n > bestN) {
          best = key;
          bestN = n;
        }
        if (n > fallbackN) {
          fallback = key;
          fallbackN = n;
        }
      }
      const chosen = bestN >= 0 ? best : fallback;
      const cx = chosen % cols;
      const cy = (chosen / cols) | 0;
      const px = Math.min(iw - 1, Math.floor(((cx + 0.5) / cols) * iw));
      const py = Math.min(ih - 1, Math.floor(((cy + 0.5) / cols) * ih));
      const i = (py * iw + px) * 4;
      return [pixels[i] ?? 180, pixels[i + 1] ?? 180, pixels[i + 2] ?? 180];
    });
  }

  /** Close-up of every species. `menu` draws the raw atlas; otherwise Lambert, recolor 0. */
  private captureSpecies(menu: boolean): HTMLCanvasElement[] {
    const prevX = this.camera.position.x;
    const prevY = this.camera.position.y;
    const prevZ = this.camera.position.z;
    const prevAspect = this.camera.aspect;
    const hemiI = this.hemi.intensity;
    const keyI = this.keyLight.intensity;
    const keyX = this.keyLight.position.x;
    const keyY = this.keyLight.position.y;
    const keyZ = this.keyLight.position.z;
    this.ground.visible = false;
    this.land.visible = false;
    this.stage.visible = false;
    this.decor.visible = false;
    this.winDisc.visible = false;
    this.gridLines.visible = false;
    for (const wall of this.fenceMeshes) wall.visible = false;
    this.shadows.count = 0;
    this.coins.count = 0;
    this.orbs.count = 0;
    this.loot.count = 0;
    const mat = menu ? this.menuMaterial : this.petMaterial;
    if (!menu) {
      this.hemi.intensity = 1.55;
      this.keyLight.intensity = 1.35;
      this.keyLight.position.set(2.5, 5.5, 7);
    }
    for (const mesh of this.pets) mesh.material = mat;
    const size = 180;
    const rt = new WebGLRenderTarget(size, size);
    this.camera.position.set(0.72, 0.78, 2.55);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0.52, 0);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(0xf4fbff, 1);
    const tiles: HTMLCanvasElement[] = [];
    for (let i = 0; i < this.pets.length; i++) {
      for (const mesh of this.pets) mesh.count = 0;
      const mesh = this.pets[i]!;
      this.placePet(mesh, 0, 0, 0, 0, HOME_FACE, 0, 1.08, 1, 0);
      mesh.count = 1;
      mesh.instanceMatrix.needsUpdate = true;
      this.renderer.setRenderTarget(rt);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      const buf = new Uint8Array(size * size * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      const tile = document.createElement('canvas');
      tile.width = size;
      tile.height = size;
      const tctx = tile.getContext('2d');
      if (!tctx) continue;
      const img = tctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        const src = (size - 1 - y) * size * 4;
        img.data.set(buf.subarray(src, src + size * 4), y * size * 4);
      }
      tctx.putImageData(img, 0, 0);
      tiles.push(tile);
    }
    this.renderer.setRenderTarget(null);
    rt.dispose();
    for (const mesh of this.pets) {
      mesh.material = this.petMaterial;
      mesh.count = 0;
    }
    this.hemi.intensity = hemiI;
    this.keyLight.intensity = keyI;
    this.keyLight.position.set(keyX, keyY, keyZ);
    this.camera.position.set(prevX, prevY, prevZ);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(0, 0.6, 0);
    return tiles;
  }

  private placePet(
    mesh: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    heading: number,
    rollAmt: number,
    scale: number,
    squash: number,
    recolor = 0,
  ): void {
    const rec = mesh.geometry.getAttribute('recolor') as InstancedBufferAttribute | undefined;
    if (rec) {
      rec.setX(index, recolor);
      rec.needsUpdate = true;
    }
    this.pos.set(x, y + 0.24, z);
    this.quat.setFromAxisAngle(this.up, Math.PI / 2 - heading);
    if (rollAmt !== 0) {
      this.quat2.setFromAxisAngle(this.rollAxis, rollAmt);
      this.quat.multiply(this.quat2);
    }
    const sy = scale * squash;
    const sx = scale / Math.max(0.4, Math.sqrt(squash));
    this.scl.set(sx, sy, sx);
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  private place(
    mesh: InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    rot: number,
    rollAmt: number,
    scale: number,
  ): void {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(this.up, rot);
    if (rollAmt !== 0) {
      this.quat2.setFromAxisAngle(this.rollAxis, rollAmt);
      this.quat.multiply(this.quat2);
    }
    this.scl.set(scale, scale, scale);
    this.mat.compose(this.pos, this.quat, this.scl);
    mesh.setMatrixAt(index, this.mat);
  }

  private present(): void {
    if (!gfx.over) {
      this.ribbonBatch.mesh.visible = false;
      this.shadows.visible = false;
      this.bases.visible = false;
      this.ring.visible = false;
      this.pulse.visible = false;
      this.nudge.visible = false;
      this.flashRing.visible = false;
      this.claimRing.visible = false;
      this.paintRing.visible = false;
      this.frostRing.visible = false;
      this.frames.visible = false;
      this.glows.visible = false;
      this.shields.visible = false;
      this.slows.visible = false;
      this.parts.visible = false;
      this.sparkles.visible = false;
      this.hearts.visible = false;
      this.rainbows.visible = false;
      this.paws.visible = false;
      this.fxCoins.visible = false;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private applySize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }
}

function flatCoin(): BufferGeometry {
  const geo = new CylinderGeometry(0.28, 0.28, 0.07, 16);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function openWorld(ring: Array<[number, number]>): Array<[number, number]> {
  const n =
    ring.length > 1 &&
    Math.hypot(ring[0]![0] - ring[ring.length - 1]![0], ring[0]![1] - ring[ring.length - 1]![1]) < 1e-4
      ? ring.length - 1
      : ring.length;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push([ring[i]![0] * WORLD, ring[i]![1] * WORLD]);
  return out;
}

/** Star-shaped hole is the blob. Triangles face +Y so FrontSide survives the X-mirror flip. */
function outsideRing(world: Array<[number, number]>): BufGeo {
  const n = world.length;
  let cx = 0;
  let cz = 0;
  for (const p of world) {
    cx += p[0];
    cz += p[1];
  }
  cx /= n;
  cz /= n;
  // Far enough that the tilted camera still lands on this ring past the fence.
  const reach = 120;
  const y = -0.03;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const x = world[i]![0];
    const z = world[i]![1];
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    const dx = x - cx;
    const dz = z - cz;
    const len = Math.hypot(dx, dz) || 1;
    const o = (n + i) * 3;
    pos[o] = cx + (dx / len) * reach;
    pos[o + 1] = y;
    pos[o + 2] = cz + (dz / len) * reach;
  }
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const innerA = i;
    const innerB = j;
    const outerA = n + i;
    const outerB = n + j;
    // Blob ring is counter-clockwise. Both halves of the quad face +Y;
    // swapping one of them culls every other triangle and leaves pale spokes.
    const t = i * 6;
    idx[t] = innerA;
    idx[t + 1] = innerB;
    idx[t + 2] = outerB;
    idx[t + 3] = innerA;
    idx[t + 4] = outerB;
    idx[t + 5] = outerA;
  }
  const geo = new BufGeo();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setIndex(new BufferAttribute(idx, 1));
  return geo;
}

function outsideMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: OUTSIDE_COLOR,
    side: FrontSide,
    toneMapped: false,
    depthWrite: true,
  });
}

function blobWall(world: Array<[number, number]>): BufGeo {
  const n = world.length;
  const thick = 0.7;
  const height = 0.52;
  const outer: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const prev = world[(i - 1 + n) % n]!;
    const cur = world[i]!;
    const next = world[(i + 1) % n]!;
    const e0x = cur[0] - prev[0];
    const e0z = cur[1] - prev[1];
    const e1x = next[0] - cur[0];
    const e1z = next[1] - cur[1];
    const l0 = Math.hypot(e0x, e0z) || 1;
    const l1 = Math.hypot(e1x, e1z) || 1;
    let nx = e0z / l0 + e1z / l1;
    let nz = -e0x / l0 - e1x / l1;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    outer.push([cur[0] + nx * thick, cur[1] + nz * thick]);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, z: number) => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = world[i]!;
    const b = world[j]!;
    const c = outer[i]!;
    const d = outer[j]!;
    const a0 = v(a[0], height, a[1]);
    const b0 = v(b[0], height, b[1]);
    const c0 = v(c[0], height, c[1]);
    const d0 = v(d[0], height, d[1]);
    idx.push(a0, b0, d0, a0, d0, c0);
    const c1 = v(c[0], 0, c[1]);
    const d1 = v(d[0], 0, d[1]);
    const c2 = v(c[0], height, c[1]);
    const d2 = v(d[0], height, d[1]);
    idx.push(c1, d2, d1, c1, c2, d2);
    const a1 = v(a[0], 0, a[1]);
    const b1 = v(b[0], 0, b[1]);
    const a2 = v(a[0], height, a[1]);
    const b2 = v(b[0], height, b[1]);
    idx.push(a1, b1, b2, a1, b2, a2);
  }
  const geo = new BufGeo();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  return geo;
}

/** Drop fence-scrape jitter. The live head and the land end stay put. */
function decimateRibbon(sx: Float32Array, sz: Float32Array, keep: Uint8Array, n: number, eps: number): number {
  if (n < 4) return n;
  keep.fill(0, 0, n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  const eps2 = eps * eps;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = sx[a]!;
    const az = sz[a]!;
    const bx = sx[b]!;
    const bz = sz[b]!;
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    let best = -1;
    let bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const px = sx[i]!;
      const pz = sz[i]!;
      let d = 0;
      if (len2 < 1e-8) d = (px - ax) * (px - ax) + (pz - az) * (pz - az);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / len2));
        const cx = ax + vx * t;
        const cz = az + vz * t;
        d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD > eps2) {
      keep[best] = 1;
      stack.push(a, best, best, b);
    }
  }
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    sx[w] = sx[i]!;
    sz[w] = sz[i]!;
    w++;
  }
  return w;
}

function titleBackdrop(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const g = canvas.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, '#8fd4ff');
  sky.addColorStop(0.55, '#ffd0ef');
  sky.addColorStop(1, '#ffe3bf');
  g.fillStyle = sky;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = 'rgba(255,255,255,0.45)';
  for (let y = 24; y < 512; y += 28) {
    for (let x = (y / 28) % 2 === 0 ? 12 : 26; x < 512; x += 28) {
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Soft color only in the corners. The middle stays clear so it cannot cover the pet.
  const blobs: Array<[number, number, string, number]> = [
    [70, 80, '#ffffff', 56],
    [450, 70, '#ffe56b', 48],
    [48, 450, '#ff8ec8', 52],
    [470, 440, '#7ec8ff', 46],
  ];
  for (const [x, y, color, rad] of blobs) {
    const paint = g.createRadialGradient(x, y, 4, x, y, rad);
    paint.addColorStop(0, color);
    paint.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = paint;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function composeContact(
  title: string,
  tiles: HTMLCanvasElement[],
  refs: Array<[number, number, number]>,
): HTMLCanvasElement {
  const cols = 4;
  const rows = Math.ceil(Math.max(1, tiles.length) / cols);
  const cellW = 220;
  const cellH = 248;
  const head = 52;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = head + rows * cellH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#f4fbff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1c2430';
  ctx.font = '700 28px Fredoka, sans-serif';
  ctx.fillText(title, 18, 34);
  tiles.forEach((tile, i) => {
    const col = i % cols;
    const row = (i / cols) | 0;
    const x = col * cellW + 10;
    const y = head + row * cellH + 8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x, y, 200, 232, 22);
    ctx.fill();
    ctx.drawImage(tile, x + 10, y + 8, 180, 180);
    const species = SPECIES[i];
    const name = species ? SPECIES_LABEL[species] : 'Pet';
    ctx.fillStyle = '#1c2430';
    ctx.font = '700 20px Fredoka, sans-serif';
    ctx.fillText(name, x + 14, y + 206);
    const ref = refs[i] ?? [180, 180, 180];
    ctx.fillStyle = `rgb(${ref[0]},${ref[1]},${ref[2]})`;
    ctx.beginPath();
    ctx.roundRect(x + 14, y + 214, 18, 14, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(28,36,48,0.25)';
    ctx.stroke();
    const hex = ref.map((n) => n.toString(16).padStart(2, '0')).join('');
    ctx.fillStyle = '#4c5968';
    ctx.font = '600 13px Fredoka, sans-serif';
    ctx.fillText(`#${hex}`, x + 38, y + 226);
  });
  return canvas;
}

function growF(buf: Float32Array<ArrayBufferLike>, need: number): Float32Array<ArrayBufferLike> {
  if (buf.length >= need) return buf;
  return new Float32Array(Math.max(need, buf.length ? Math.ceil(buf.length * 1.5) : 96));
}

function growU(buf: Uint32Array<ArrayBufferLike>, need: number): Uint32Array<ArrayBufferLike> {
  if (buf.length >= need) return buf;
  return new Uint32Array(Math.max(need, buf.length ? Math.ceil(buf.length * 1.5) : 96));
}

function uploadChunk(
  geo: BufGeo,
  pos: Float32Array<ArrayBufferLike>,
  col: Float32Array<ArrayBufferLike>,
  idx: Uint32Array<ArrayBufferLike>,
  verts: number,
  indices: number,
): void {
  if (verts < 3 || indices < 3) {
    geo.setDrawRange(0, 0);
    return;
  }
  const posAttr = new BufferAttribute(pos.subarray(0, verts * 3), 3);
  const colAttr = new BufferAttribute(col.subarray(0, verts * 3), 3);
  posAttr.setUsage(DynamicDrawUsage);
  colAttr.setUsage(DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  geo.setIndex(new BufferAttribute(idx.subarray(0, indices), 1));
  geo.setDrawRange(0, indices);
  geo.computeBoundingSphere();
}

function makeInstances(geo: BufferGeometry, colorOrMat: number | MeshBasicMaterial, cap: number): InstancedMesh {
  const mat = typeof colorOrMat === 'number' ? new MeshBasicMaterial({ color: colorOrMat }) : colorOrMat;
  const mesh = new InstancedMesh(geo, mat, cap);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  return mesh;
}
