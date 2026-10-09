import { CONFIG, PALETTE, SPECIES } from '@pet-trails/shared';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry as BufGeo,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import type { Perf } from './perf.js';
import type { Territory } from './territory.js';

const WORLD = CONFIG.worldScale;
const PET_CAP = 64;
const PICK_CAP = 72;
const PART_CAP = 140;
const SHADOW_CAP = 180;
const PATH_N = 280;
const RIBBON_SEGS = 160;

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

  push(x: number, z: number, h: number): void {
    if (this.primed) {
      const dx = x - this.lx;
      const dz = z - this.lz;
      if (dx * dx + dz * dz < 0.35) return;
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

class Ribbon {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly geo: BufGeo;

  constructor(color: number) {
    this.pos = new Float32Array(RIBBON_SEGS * 2 * 3);
    this.geo = new BufGeo();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, 0);
    const mat = new MeshBasicMaterial({ color, side: DoubleSide, depthWrite: false });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  setColor(r: number, g: number, b: number): void {
    (this.mesh.material as MeshBasicMaterial).color.setRGB(r, g, b);
  }

  clear(): void {
    this.geo.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  /** Path points are in cell coordinates, oldest to newest is walked from the head. */
  draw(path: PathBuf): void {
    if (path.n < 2) {
      this.clear();
      return;
    }
    const half = 0.32;
    let count = 0;
    let prev = -1;
    const start = path.n - 1;
    for (let k = start; k >= 0 && count < RIBBON_SEGS; k--) {
      const i = (path.head - 1 - k + PATH_N * 8) % PATH_N;
      const x = path.xs[i]! * WORLD;
      const z = path.zs[i]! * WORLD;
      let tx = 1;
      let tz = 0;
      const nxt = k > 0 ? (path.head - 1 - (k - 1) + PATH_N * 8) % PATH_N : i;
      const px = k > 0 ? path.xs[nxt]! * WORLD : x;
      const pz = k > 0 ? path.zs[nxt]! * WORLD : z;
      const dx = px - x;
      const dz = pz - z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-4) {
        tx = -dz / len;
        tz = dx / len;
      } else if (prev >= 0) {
        continue;
      }
      const o = count * 6;
      this.pos[o] = x + tx * half;
      this.pos[o + 1] = 0.07;
      this.pos[o + 2] = z + tz * half;
      this.pos[o + 3] = x - tx * half;
      this.pos[o + 4] = 0.07;
      this.pos[o + 5] = z - tz * half;
      count++;
      prev = i;
    }
    const attr = this.geo.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
    this.geo.setDrawRange(0, count * 2);
    this.mesh.visible = count > 1;
  }
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
  private readonly orbs: InstancedMesh;
  private readonly loot: InstancedMesh;
  private readonly parts: InstancedMesh;
  private readonly shadows: InstancedMesh;
  private readonly ring: Mesh;
  private readonly platform: Mesh;
  private readonly ground: Mesh;
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

  constructor(territory: Territory, geos: BufferGeometry[], material: MeshLambertMaterial, perf: Perf) {
    this.territory = territory;
    this.perf = perf;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setClearColor(0x8fd4ff, 1);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    document.body.prepend(this.renderer.domElement);
    perf.hook(this.renderer);
    perf.territoryH = territory.texH;

    this.camera = new PerspectiveCamera(40, 1, 0.1, 500);
    this.scene.add(new HemisphereLight(0xfff4d8, 0x7dce9a, 1.15));
    const dir = new DirectionalLight(0xffffff, 1.15);
    dir.position.set(30, 50, 20);
    this.scene.add(dir);

    const gw = territory.gridW * WORLD;
    const gh = territory.gridH * WORLD;
    const groundGeo = new PlaneGeometry(gw, gh);
    groundGeo.rotateX(-Math.PI / 2);
    groundGeo.translate(gw / 2, 0, gh / 2);
    const groundMat = new ShaderMaterial({
      uniforms: { mapTex: { value: territory.texture } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D mapTex;
        varying vec2 vUv;
        void main() {
          vec4 t = texture2D(mapTex, vUv);
          float m = smoothstep(0.1, 0.58, t.a);
          float rim = smoothstep(0.78, 0.28, t.a);
          vec3 fill = t.rgb * mix(1.0, 0.68, rim);
          vec3 ground = vec3(0.74, 0.90, 0.79);
          ground *= 0.97 + 0.03 * sin(vUv.x * 26.0 + vUv.y * 18.0);
          float shadow = smoothstep(0.02, 0.28, t.a) * (1.0 - m);
          ground *= mix(1.0, 0.74, shadow);
          gl_FragColor = vec4(mix(ground, fill, m), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    groundMat.toneMapped = false;
    this.ground = new Mesh(groundGeo, groundMat);
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);
    this.addFence(gw, gh);

    const platformGeo = new CircleGeometry(7.2, 40);
    platformGeo.rotateX(-Math.PI / 2);
    this.platform = new Mesh(platformGeo, new MeshLambertMaterial({ color: 0xb6ebc4 }));
    this.platform.position.y = 0.02;
    this.scene.add(this.platform);

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

    this.coins = makeInstances(new CylinderGeometry(0.22, 0.22, 0.08, 10), 0xffc400, PICK_CAP);
    this.orbs = makeInstances(new OctahedronGeometry(0.28, 0), 0x2ec8ff, PICK_CAP);
    this.loot = makeInstances(new BoxGeometry(0.34, 0.34, 0.34), 0xff4fa3, PICK_CAP);
    this.scene.add(this.coins, this.orbs, this.loot);

    const shadowGeo = new CircleGeometry(0.46, 14);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadows = new InstancedMesh(
      shadowGeo,
      new MeshBasicMaterial({ color: 0x143024, transparent: true, opacity: 0.22, depthWrite: false }),
      SHADOW_CAP,
    );
    this.shadows.frustumCulled = false;
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.count = 0;
    this.scene.add(this.shadows);

    this.parts = new InstancedMesh(new BoxGeometry(0.16, 0.16, 0.16), new MeshBasicMaterial({ color: 0xffffff }), PART_CAP);
    this.parts.instanceColor = new InstancedBufferAttribute(new Float32Array(PART_CAP * 3), 3);
    this.parts.frustumCulled = false;
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

    for (let i = 0; i < 16; i++) this.labels.push({ sx: 0, sy: 0, text: '', on: false });
    this.applySize();
    window.addEventListener('resize', () => this.applySize());
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

  burst(x: number, z: number, playerId: number, withShake = true): void {
    const c = PALETTE[(Math.max(1, playerId) - 1) % PALETTE.length]!;
    const wx = x * WORLD;
    const wz = z * WORLD;
    for (let k = 0; k < 28; k++) {
      if (this.partCount >= PART_CAP) break;
      const i = this.partCount++;
      const ang = (k / 28) * Math.PI * 2 + (k % 3) * 0.2;
      const sp = 1.1 + (k % 5) * 0.28;
      this.px[i] = wx;
      this.py[i] = 0.4;
      this.pz[i] = wz;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = 1.8 + (k % 4) * 0.35;
      this.vz[i] = Math.sin(ang) * sp;
      this.life[i] = 0.55;
      this.pr[i] = c[0] / 255;
      this.pg[i] = c[1] / 255;
      this.pb[i] = c[2] / 255;
    }
    if (withShake) this.shake = Math.min(1.2, this.shake + 0.85);
  }

  private addFence(gw: number, gh: number): void {
    const apron = new Mesh(
      new PlaneGeometry(gw + 90, gh + 90),
      new MeshBasicMaterial({ color: 0x3e94c8 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(gw / 2, -0.05, gh / 2);
    apron.frustumCulled = false;
    this.scene.add(apron);
    this.fenceMeshes.push(apron);

    const mat = new MeshLambertMaterial({ color: 0xfff6ea });
    const post = new BoxGeometry(0.34, 1.55, 0.34);
    const rail = new BoxGeometry(1, 0.16, 0.16);
    const posts = new InstancedMesh(post, mat, 320);
    posts.frustumCulled = false;
    posts.instanceMatrix.setUsage(DynamicDrawUsage);
    let n = 0;
    const step = 1.7;
    const placePost = (x: number, z: number) => {
      if (n >= 320) return;
      this.place(posts, n++, x, 0.78, z, 0, 0, 1);
    };
    for (let x = 0; x <= gw; x += step) {
      placePost(x, 0);
      placePost(x, gh);
    }
    for (let z = step; z < gh; z += step) {
      placePost(0, z);
      placePost(gw, z);
    }
    posts.count = n;
    posts.instanceMatrix.needsUpdate = true;
    this.scene.add(posts);
    this.fenceMeshes.push(posts);
    const rails: Array<[number, number, number, number, number]> = [
      [gw / 2, 0.48, 0, gw, 0],
      [gw / 2, 1.05, 0, gw, 0],
      [gw / 2, 0.48, gh, gw, 0],
      [gw / 2, 1.05, gh, gw, 0],
      [0, 0.48, gh / 2, gh, Math.PI / 2],
      [0, 1.05, gh / 2, gh, Math.PI / 2],
      [gw, 0.48, gh / 2, gh, Math.PI / 2],
      [gw, 1.05, gh / 2, gh, Math.PI / 2],
    ];
    for (const [x, y, z, len, rot] of rails) {
      const geo = rail.clone();
      geo.scale(len, 1, 1);
      const mesh = new Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rot;
      this.scene.add(mesh);
      this.fenceMeshes.push(mesh);
    }
  }

  punchClaim(): void {
    this.punch = 1;
    this.shake = Math.min(1, this.shake + 0.28);
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
    this.perf.beginFrame();
    this.territory.upload(this.renderer);

    if (phase === 'dead') {
      this.renderer.render(this.scene, this.camera);
      this.perf.endFrame(performance.now(), this.renderer.info.render.calls, petCount);
      return;
    }

    for (const mesh of this.pets) mesh.count = 0;
    let shadowN = 0;
    let labelN = 0;
    for (const label of this.labels) label.on = false;

    if (phase === 'title') {
      this.ground.visible = false;
      this.platform.visible = true;
      for (const wall of this.fenceMeshes) wall.visible = false;
      for (const ribbon of this.ribbons) ribbon.clear();
      this.ring.visible = false;
      const spin = this.time * 0.35;
      for (let i = 0; i < this.pets.length; i++) {
        const mesh = this.pets[i]!;
        if (i === hero) {
          const bob = Math.sin(this.time * 3) * 0.08;
          this.place(mesh, 0, 0, bob, 0, spin, Math.sin(this.time * 6) * 0.05, 1.5);
        } else {
          const ang = spin * 0.35 + (i / SPECIES.length) * Math.PI * 2;
          const bob = Math.sin(this.time * 6 + i) * 0.06;
          this.place(mesh, 0, Math.sin(ang) * 5.3, bob, Math.cos(ang) * 5.3, -ang, Math.sin(this.time * 6 + i) * 0.08, 0.78);
        }
        mesh.count = 1;
        mesh.instanceMatrix.needsUpdate = true;
      }
      const ang = this.time * 0.22;
      this.camera.position.set(Math.sin(ang) * 9.5, 5.6, Math.cos(ang) * 9.5);
      this.camera.lookAt(0, 0.9, 0);
      this.coins.count = 0;
      this.orbs.count = 0;
      this.loot.count = 0;
      this.shadows.count = 0;
      this.selfScreen = false;
    } else {
      this.ground.visible = true;
      this.platform.visible = false;
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
          continue;
        }
        const wx = pet.x * WORLD;
        const wz = pet.z * WORLD;
        const bob = Math.sin(this.time * 9 + pet.id) * 0.05;
        const roll = Math.sin(this.time * 9 + pet.id) * 0.05;
        const mesh = this.pets[pet.pet];
        if (mesh && mesh.count < PET_CAP) {
          this.placePet(mesh, mesh.count, wx, bob, wz, pet.h, roll, pet.self ? 1.05 : 1, 1);
          mesh.count++;
        }
        if (shadowN < SHADOW_CAP) this.place(this.shadows, shadowN++, wx, 0.02, wz, 0, 0, pet.self ? 1.05 : 0.9);
        const path = this.paths[pet.id];
        path?.push(pet.x, pet.z, pet.h);
        const trail = this.trails[pet.id];
        if (pet.outside) {
          trail?.push(pet.x, pet.z, pet.h);
          if (ribbon && trail && trail.n >= 2) {
            const col = PALETTE[(Math.max(1, pet.id) - 1) % PALETTE.length]!;
            ribbon.setColor(
              (col[0] + (255 - col[0]) * 0.42) / 255,
              (col[1] + (255 - col[1]) * 0.42) / 255,
              (col[2] + (255 - col[2]) * 0.42) / 255,
            );
            ribbon.draw(trail);
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
          if (!path.sample(6.4 * (t + 1), this.sample)) continue;
          const newest = t === 0;
          const hop = newest ? pet.hop : 0;
          const hopT = hop > 0 ? 1 - hop / 0.42 : 1;
          const squash = hop > 0 ? 1 + Math.sin(hopT * Math.PI) * 0.5 : 1;
          const lift = hop > 0 ? Math.sin(hopT * Math.PI) * 0.6 : 0;
          const fb = Math.sin(this.time * 8 + t * 1.7) * 0.045;
          this.placePet(
            follower,
            follower.count,
            this.sample.x * WORLD,
            fb + lift,
            this.sample.z * WORLD,
            this.sample.h,
            0,
            0.88,
            squash,
          );
          follower.count++;
          if (shadowN < SHADOW_CAP) {
            this.place(this.shadows, shadowN++, this.sample.x * WORLD, 0.02, this.sample.z * WORLD, 0, 0, 0.72);
          }
          if (t === shown - 1 && pet.trainExtra > 0 && labelN < this.labels.length) {
            const label = this.labels[labelN++]!;
            const p = this.project(this.sample.x, 1.3, this.sample.z);
            label.on = p.ok;
            label.sx = p.x;
            label.sy = p.y;
            label.text = `+${pet.trainExtra}`;
          }
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
          this.ring.position.set(wx, 0.03, wz);
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
      if (shadowN > 0) this.shadows.instanceMatrix.needsUpdate = true;
      if (!selfAlive) {
        this.ring.visible = false;
        this.selfScreen = false;
      }

      this.punch *= Math.exp(-dt * 4);
      this.shake *= Math.exp(-dt * 6);
      const zoom = 1 + Math.min(0.22, this.landPct * 2.2);
      const aspect = Math.max(0.42, this.camera.aspect);
      const span = 14 * zoom;
      const dist = span / (2 * Math.tan((20 * Math.PI) / 180) * aspect);
      const elev = (70 * Math.PI) / 180;
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
      this.camera.lookAt(this.lookX, 0.35, this.lookZ);

      this.layoutPickups(this.coins, pickups, pickupCount, 0);
      this.layoutPickups(this.orbs, pickups, pickupCount, 1);
      this.layoutPickups(this.loot, pickups, pickupCount, 2);
    }

    this.stepParticles(dt);
    this.renderer.render(this.scene, this.camera);
    this.perf.endFrame(performance.now(), this.renderer.info.render.calls, phase === 'play' ? petCount : SPECIES.length);
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
      this.place(this.parts, w, nx, ny, nz, life * 6, 0, 0.4 + life * 1.4);
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

function makeInstances(geo: BufferGeometry, color: number, cap: number): InstancedMesh {
  const mesh = new InstancedMesh(geo, new MeshBasicMaterial({ color }), cap);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  return mesh;
}
