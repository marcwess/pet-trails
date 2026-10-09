import { CONFIG, PALETTE, SPECIES } from '@pet-trails/shared';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry as BufGeo,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Texture,
} from 'three';
import { SLAB_H, buildLand } from './landmesh.js';
import type { Perf } from './perf.js';
import type { Territory } from './territory.js';

const WORLD = CONFIG.worldScale;
const PAL_CSS = PALETTE.map((c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
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
  varying float vSide;
  void main() {
    vSide = side;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAG = `
  uniform vec3 color;
  varying float vSide;
  void main() {
    float e = abs(vSide);
    float rim = smoothstep(0.55, 0.95, e);
    vec3 col = mix(color, color * 0.78, rim);
    float alpha = 0.72 * (1.0 - smoothstep(0.8, 1.0, e));
    gl_FragColor = vec4(col, alpha);
    #include <premultiplied_alpha_fragment>
    #include <colorspace_fragment>
  }
`;

class Ribbon {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly side: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly sideAttr: BufferAttribute;
  private readonly geo: BufGeo;
  private readonly color: Color;
  private readonly sx = new Float32Array(PATH_N + 2);
  private readonly sz = new Float32Array(PATH_N + 2);

  constructor(color: number) {
    this.pos = new Float32Array(RIBBON_SEGS * 2 * 3);
    this.side = new Float32Array(RIBBON_SEGS * 2);
    this.geo = new BufGeo();
    this.posAttr = new BufferAttribute(this.pos, 3);
    this.sideAttr = new BufferAttribute(this.side, 1);
    this.posAttr.setUsage(DynamicDrawUsage);
    this.sideAttr.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('side', this.sideAttr);
    // Mesh draws triangles. Expand the strip once; drawRange selects the live span.
    const index = new Uint16Array((RIBBON_SEGS - 1) * 6);
    for (let s = 0; s < RIBBON_SEGS - 1; s++) {
      const i = s * 2;
      const o = s * 6;
      index[o] = i;
      index[o + 1] = i + 1;
      index[o + 2] = i + 2;
      index[o + 3] = i + 1;
      index[o + 4] = i + 3;
      index[o + 5] = i + 2;
    }
    this.geo.setIndex(new BufferAttribute(index, 1));
    this.geo.setDrawRange(0, 0);
    this.color = new Color(color);
    const mat = new ShaderMaterial({
      uniforms: { color: { value: this.color } },
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
  }

  setColor(r: number, g: number, b: number): void {
    this.color.setRGB(r, g, b);
  }

  clear(): void {
    this.geo.setDrawRange(0, 0);
    this.mesh.visible = false;
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
    const emit = (cx: number, cz: number, nx: number, nz: number) => {
      if (count >= RIBBON_SEGS) return;
      const o = count * 6;
      const s = count * 2;
      const y = SLAB_H + 0.05;
      this.pos[o] = cx + nx * half;
      this.pos[o + 1] = y;
      this.pos[o + 2] = cz + nz * half;
      this.pos[o + 3] = cx - nx * half;
      this.pos[o + 4] = y;
      this.pos[o + 5] = cz - nz * half;
      this.side[s] = 1;
      this.side[s + 1] = -1;
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

    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, count * 6);
    this.posAttr.needsUpdate = true;
    this.sideAttr.clearUpdateRanges();
    this.sideAttr.addUpdateRange(0, count * 2);
    this.sideAttr.needsUpdate = true;
    this.geo.setDrawRange(0, Math.max(0, (count - 1) * 6));
    this.mesh.visible = count > 1;
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

interface LandSlot {
  fill: Mesh;
  rim: Mesh;
  shadow: Mesh;
  fillGeo: BufGeo;
  rimGeo: BufGeo;
  shadowGeo: BufGeo;
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
  private readonly ribbons: Ribbon[] = [];
  private readonly pitchAxis = new Vector3(1, 0, 0);
  private holdX = 0;
  private holdZ = 0;
  private holdH = 0;
  private lookX = 0;
  private lookZ = 0;
  private readonly fenceMeshes: Mesh[] = [];
  landPct = 0;
  private readonly coins: InstancedMesh;
  private readonly fxCoins: InstancedMesh;
  private readonly orbs: InstancedMesh;
  private readonly loot: InstancedMesh;
  private readonly parts: InstancedMesh;
  private readonly shadows: InstancedMesh;
  private readonly bases: InstancedMesh;
  private readonly ring: Mesh;
  private readonly platform: Mesh;
  private readonly stage: Group;
  private readonly podium: Mesh;
  private readonly ground: Mesh;
  private readonly gridLines: LineSegments;
  private readonly land: Group;
  private readonly landShadow: Group;
  private readonly slots: LandSlot[] = [];
  private readonly flashRing: Mesh;
  private readonly claimRing: Mesh;
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
  private camInit = false;
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    this.renderer.setClearColor(0xb7c3d0, 1);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    document.body.prepend(this.renderer.domElement);
    perf.hook(this.renderer);
    perf.territoryH = 0;

    this.camera = new PerspectiveCamera(40, 1, 0.1, 500);
    this.scene.add(new HemisphereLight(0xfff8ef, 0xc5d0dc, 0.95));
    const dir = new DirectionalLight(0xfffaf4, 1.45);
    dir.position.set(24, 48, 12);
    this.scene.add(dir);

    const gw = territory.gridW * WORLD;
    const gh = territory.gridH * WORLD;
    const groundGeo = new PlaneGeometry(gw, gh);
    groundGeo.rotateX(-Math.PI / 2);
    groundGeo.translate(gw / 2, 0, gh / 2);
    this.ground = new Mesh(groundGeo, new MeshBasicMaterial({ map: groundPattern(), color: 0xffffff }));
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);
    this.gridLines = this.makeGrid(gw, gh);
    this.scene.add(this.gridLines);
    this.land = new Group();
    this.landShadow = new Group();
    const shadowMat = new MeshBasicMaterial({
      color: 0x2c3544,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      toneMapped: false,
    });
    for (let id = 0; id <= 16; id++) {
      const col = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
      const fillGeo = new BufGeo();
      const rimGeo = new BufGeo();
      const shadowGeo = new BufGeo();
      const fill = new Mesh(
        fillGeo,
        new MeshBasicMaterial({
          color: (col[0] << 16) | (col[1] << 8) | col[2],
          toneMapped: false,
        }),
      );
      fill.frustumCulled = false;
      fill.renderOrder = 2;
      fill.visible = false;
      const wall = (Math.round(col[0] * 0.52) << 16) | (Math.round(col[1] * 0.52) << 8) | Math.round(col[2] * 0.52);
      const rim = new Mesh(rimGeo, new MeshBasicMaterial({ color: wall, toneMapped: false }));
      rim.frustumCulled = false;
      rim.renderOrder = 1;
      rim.visible = false;
      const shadow = new Mesh(shadowGeo, shadowMat);
      shadow.frustumCulled = false;
      shadow.renderOrder = 0;
      shadow.visible = false;
      this.land.add(fill, rim);
      this.landShadow.add(shadow);
      this.slots.push({ fill, rim, shadow, fillGeo, rimGeo, shadowGeo });
    }
    this.scene.add(this.land);
    this.scene.add(this.landShadow);
    this.addFence(gw, gh);

    const hero = PALETTE[0]!;
    const heroHex = (hero[0] << 16) | (hero[1] << 8) | hero[2];
    const platformGeo = new CylinderGeometry(1.7, 1.95, 0.42, 36);
    this.platform = new Mesh(platformGeo, new MeshLambertMaterial({ color: heroHex }));
    this.platform.position.y = 0.21;
    const podiumRing = new Mesh(
      new TorusGeometry(1.85, 0.07, 8, 40),
      new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    podiumRing.rotation.x = Math.PI / 2;
    podiumRing.position.y = 0.44;
    this.podium = podiumRing;
    const backdrop = new Mesh(
      new CircleGeometry(16, 48),
      new MeshBasicMaterial({ map: titleBackdrop(), toneMapped: false }),
    );
    backdrop.rotation.x = -Math.PI / 2;
    backdrop.position.y = -0.35;
    this.stage = new Group();
    this.stage.add(backdrop, this.platform, this.podium);
    this.scene.add(this.stage);

    for (let i = 0; i < geos.length; i++) {
      const mesh = new InstancedMesh(geos[i]!, material, PET_CAP);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      this.scene.add(mesh);
      this.pets.push(mesh);
    }
    for (let i = 0; i < 17; i++) {
      this.paths.push(new PathBuf());
      this.trails.push(new PathBuf());
      const ribbon = new Ribbon(0xffffff);
      this.ribbons.push(ribbon);
      this.scene.add(ribbon.mesh);
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
    this.loot = makeInstances(new BoxGeometry(0.34, 0.34, 0.34), 0xff4fa3, PICK_CAP);
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

    this.parts = new InstancedMesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial({ color: 0xffffff }), PART_CAP);
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

    for (let i = 0; i < 40; i++) this.labels.push({ sx: 0, sy: 0, text: '', on: false, name: false, color: '#fff' });
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
    this.camera.position.set(10, 8, 16);
    this.camera.lookAt(2, 0.6, 2);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
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

  /** Rebuild meshes for owners whose polygons changed. Nothing runs when the set is empty. */
  private syncLand(): void {
    const ids = this.territory.consumeDirty();
    for (const id of ids) this.rebuildSlot(id);
  }

  private rebuildSlot(id: number): void {
    const slot = this.slots[id];
    if (!slot) return;
    const built = buildLand(this.territory.polygon(id), WORLD);
    if (!built) {
      slot.fill.visible = false;
      slot.rim.visible = false;
      slot.shadow.visible = false;
      return;
    }
    slot.fillGeo.setAttribute('position', new BufferAttribute(built.fillPos, 3));
    slot.fillGeo.setIndex(new BufferAttribute(built.fillIdx, 1));
    slot.fillGeo.computeBoundingSphere();
    slot.fill.visible = true;
    slot.fill.scale.y = 1;
    if (built.shadowIdx.length >= 3) {
      slot.shadowGeo.setAttribute('position', new BufferAttribute(built.shadowPos, 3));
      slot.shadowGeo.setIndex(new BufferAttribute(built.shadowIdx, 1));
      slot.shadowGeo.computeBoundingSphere();
      slot.shadow.visible = true;
    } else {
      slot.shadow.visible = false;
    }
    if (built.rimIdx.length >= 3) {
      slot.rimGeo.setAttribute('position', new BufferAttribute(built.rimPos, 3));
      slot.rimGeo.setIndex(new BufferAttribute(built.rimIdx, 1));
      slot.rimGeo.computeBoundingSphere();
      slot.rim.visible = true;
      slot.rim.scale.y = 1;
    } else {
      slot.rim.visible = false;
    }
  }

  /** World-space XZ bounds of each owner's polygon. */
  landBoxes(): Array<{ x0: number; z0: number; x1: number; z1: number; w: number; d: number }> {
    const out: Array<{ x0: number; z0: number; x1: number; z1: number; w: number; d: number }> = [];
    for (let id = 1; id < this.slots.length; id++) {
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

  private addFence(gw: number, gh: number): void {
    const outside = new MeshBasicMaterial({ color: 0xb7c3d0 });
    const skirt = (x: number, z: number, w: number, d: number) => {
      const mesh = new Mesh(new PlaneGeometry(w, d), outside);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, -0.02, z);
      this.scene.add(mesh);
      this.fenceMeshes.push(mesh);
    };
    const pad = 80;
    skirt(-pad / 2, gh / 2, pad, gh + pad * 2);
    skirt(gw + pad / 2, gh / 2, pad, gh + pad * 2);
    skirt(gw / 2, -pad / 2, gw, pad);
    skirt(gw / 2, gh + pad / 2, gw, pad);

    const lip = 0.72;
    const height = 0.5;
    const border = new MeshLambertMaterial({ color: 0xf7f4ee });
    const shade = new MeshBasicMaterial({
      color: 0x8d99a8,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const bars: Array<[number, number, number, number]> = [
      [gw / 2, -lip / 2, gw + lip * 2, lip],
      [gw / 2, gh + lip / 2, gw + lip * 2, lip],
      [-lip / 2, gh / 2, lip, gh],
      [gw + lip / 2, gh / 2, lip, gh],
    ];
    for (const [x, z, w, d] of bars) {
      const shadow = new Mesh(new PlaneGeometry(w + 0.35, d + 0.35), shade);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(x + 0.12, 0.01, z + 0.1);
      this.scene.add(shadow);
      this.fenceMeshes.push(shadow);
      const mesh = new Mesh(new BoxGeometry(w, height, d), border);
      mesh.position.set(x, height / 2, z);
      this.scene.add(mesh);
      this.fenceMeshes.push(mesh);
    }
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
    for (const r of this.ribbons) r.clear();
  }

  clearPath(id: number): void {
    this.paths[id]?.clear();
    this.trails[id]?.clear();
    this.ribbons[id]?.clear();
  }

  /** Drop every ribbon that now sits on `ownerId`'s land, including the claimer. */
  dropCoveredTrails(ownerId: number): void {
    for (let id = 1; id < this.trails.length; id++) {
      const trail = this.trails[id];
      if (!trail || trail.n < 1) {
        if (id === ownerId) this.ribbons[id]?.clear();
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
      this.ribbons[id]?.clear();
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
    this.territory.update(dt);
    this.syncLand();
    this.riseSlabs();
    this.syncClaimRing();
    this.perf.beginFrame();

    if (phase === 'dead') {
      this.stepParticles(dt);
      this.stepCoins(dt);
      this.stepPops(dt);
      this.renderer.render(this.scene, this.camera);
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
      this.landShadow.visible = false;
      this.claimRing.visible = false;
      this.flashRing.visible = false;
      this.stage.visible = true;
      this.bases.count = 0;
      this.fxCoins.count = 0;
      for (let i = 0; i < this.fxLife.length; i++) this.fxLife[i] = 0;
      for (const wall of this.fenceMeshes) wall.visible = false;
      for (const ribbon of this.ribbons) ribbon.clear();
      this.ring.visible = false;
      const spin = this.time * 0.7;
      this.podium.rotation.z = spin;
      const mesh = this.pets[hero];
      if (mesh) {
        const wave = Math.sin(this.time * 3);
        this.placePet(mesh, 0, 0, 0.22 + wave * 0.05, 0, spin, 0, 1.38, 1 + wave * 0.05);
        mesh.count = 1;
        mesh.instanceMatrix.needsUpdate = true;
      }
      const ang = this.time * 0.18;
      this.camera.position.set(Math.sin(ang) * 6.4, 3.5, Math.cos(ang) * 6.4);
      this.camera.lookAt(0, 0.85, 0);
      this.coins.count = 0;
      this.orbs.count = 0;
      this.loot.count = 0;
      this.shadows.count = 0;
      this.selfScreen = false;
    } else {
      this.ground.visible = true;
      this.land.visible = true;
      this.landShadow.visible = true;
      this.gridLines.visible = true;
      this.stage.visible = false;
      for (const wall of this.fenceMeshes) wall.visible = true;
      let selfX = this.holdX;
      let selfZ = this.holdZ;
      let selfH = this.holdH;
      let selfAlive = false;
      for (let i = 0; i < petCount; i++) {
        const pet = pets[i]!;
        const ribbon = this.ribbons[pet.id];
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
        const feet = this.surfaceAt(pet.id, pet.x, pet.z);
        const wave = Math.sin(this.time * 8 + pet.id * 1.7);
        const bob = Math.max(0, wave) * 0.1;
        const squash = wave > 0 ? 1.07 : 0.9;
        const roll = wave * 0.06;
        const mesh = this.pets[pet.pet];
        const shimmer = pet.blink ? 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(this.time * Math.PI * 16)) : 1;
        const body = (pet.self ? 1.08 : 1) * shimmer;
        if (mesh && mesh.count < PET_CAP) {
          this.placePet(mesh, mesh.count, wx, feet + bob, wz, pet.h, roll, body, squash);
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
          !!trail && (this.trailStolen(pet.id, trail) || this.headOnOwnLand(pet.id, trail));
        if (pet.outside && trail && !covered) {
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
          const fFeet = this.surfaceAt(pet.id, this.sample.x, this.sample.z);
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
          selfH = pet.h;
          selfAlive = true;
          this.holdX = pet.x;
          this.holdZ = pet.z;
          this.holdH = pet.h;
          this.ring.visible = true;
          this.ring.position.set(wx, 0.04, wz);
          const ringScale = pet.blink ? 0.9 + 0.18 * (0.5 + 0.5 * Math.sin(this.time * Math.PI * 16)) : 1;
          this.ring.scale.set(ringScale, 1, ringScale);
          const col = PALETTE[(Math.max(1, pet.id) - 1) % PALETTE.length]!;
          (this.ring.material as MeshBasicMaterial).color.setRGB(col[0] / 255, col[1] / 255, col[2] / 255);
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
      const fx = Math.cos(selfH);
      const fz = Math.sin(selfH);
      const px = selfX * WORLD;
      const pz = selfZ * WORLD;
      const lx = px + fx * 1.35;
      const lz = pz + fz * 1.35;
      const tx = lx - fx * back;
      const tz = lz - fz * back;
      if (!this.camInit || snapCam) {
        this.camX = tx;
        this.camY = height;
        this.camZ = tz;
        this.lookX = lx;
        this.lookZ = lz;
        this.camInit = true;
      } else {
        const k = 1 - Math.exp(-dt * 4.2);
        this.camX += (tx - this.camX) * k;
        this.camY += (height - this.camY) * k;
        this.camZ += (tz - this.camZ) * k;
        this.lookX += (lx - this.lookX) * k;
        this.lookZ += (lz - this.lookZ) * k;
      }
      const jx = (Math.random() - 0.5) * this.shake * 0.35;
      const jz = (Math.random() - 0.5) * this.shake * 0.35;
      this.camera.position.set(this.camX + jx, this.camY, this.camZ + jz);
      this.camera.lookAt(this.lookX, 0.42, this.lookZ);
      const shx = this.camX - this.lookX;
      const shz = this.camZ - this.lookZ;
      const shl = Math.hypot(shx, shz) || 1;
      const off = 0.07;
      this.landShadow.position.set((shx / shl) * off, -0.02, (shz / shl) * off);

      this.layoutPickups(this.coins, pickups, pickupCount, 0);
      this.layoutPickups(this.orbs, pickups, pickupCount, 1);
      this.layoutPickups(this.loot, pickups, pickupCount, 2);
    }

    this.stepParticles(dt);
    this.stepCoins(dt);
    this.stepPops(dt);
    this.renderer.render(this.scene, this.camera);
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
    this.proj.set(x * WORLD, y, z * WORLD).project(this.camera);
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
    const rising = id > 0 && pulse > 0.02;
    let s = 1;
    if (rising) {
      const t = 1 - pulse;
      const ease = 1 - (1 - t) * (1 - t);
      s = 0.08 + 0.92 * ease;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const y = rising && i === id ? s : 1;
      if (slot.fill.scale.y !== y) slot.fill.scale.y = y;
      if (slot.rim.scale.y !== y) slot.rim.scale.y = y;
    }
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
  ): void {
    this.pos.set(x, y + 0.24, z);
    this.quat.setFromAxisAngle(this.up, Math.PI / 2 - heading);
    this.quat2.setFromAxisAngle(this.pitchAxis, -0.68);
    this.quat.multiply(this.quat2);
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

function groundPattern(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#e7edf3';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(148, 166, 184, 0.55)';
  for (let y = 8; y < 128; y += 16) {
    for (let x = 8; x < 128; x += 16) {
      g.beginPath();
      g.arc(x, y, 1.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(26, 26);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function titleBackdrop(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#e4ebf2';
  g.fillRect(0, 0, 512, 512);
  const blobs: Array<[number, number, string]> = [
    [110, 130, '#ff2d7d'],
    [390, 90, '#ff7a00'],
    [70, 390, '#ffd600'],
    [430, 370, '#1ec83e'],
    [250, 240, '#00bcff'],
    [300, 430, '#8e34ff'],
    [180, 50, '#ff2460'],
    [50, 210, '#ff705c'],
  ];
  for (const [x, y, color] of blobs) {
    const rad = g.createRadialGradient(x, y, 8, x, y, 150);
    rad.addColorStop(0, color);
    rad.addColorStop(1, 'rgba(228,235,242,0)');
    g.fillStyle = rad;
    g.beginPath();
    g.arc(x, y, 150, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function makeInstances(geo: BufferGeometry, colorOrMat: number | MeshBasicMaterial, cap: number): InstancedMesh {
  const mat = typeof colorOrMat === 'number' ? new MeshBasicMaterial({ color: colorOrMat }) : colorOrMat;
  const mesh = new InstancedMesh(geo, mat, cap);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  return mesh;
}
