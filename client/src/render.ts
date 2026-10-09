import { PALETTE, SPECIES } from '@pet-trails/shared';
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
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
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import type { Perf } from './perf.js';
import type { Territory } from './territory.js';

const PET_CAP = 64;
const PICK_CAP = 72;
const PART_CAP = 80;
const SHADOW_CAP = 180;
const PATH_N = 140;

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
      if (dx * dx + dz * dz < 0.09) return;
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
    out.x = this.xs[prev]!;
    out.z = this.zs[prev]!;
    out.h = this.hs[prev]!;
    return true;
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

    const groundGeo = new PlaneGeometry(territory.gridW, territory.gridH);
    groundGeo.rotateX(-Math.PI / 2);
    groundGeo.translate(territory.gridW / 2, 0, territory.gridH / 2);
    this.ground = new Mesh(groundGeo, new MeshBasicMaterial({ map: territory.texture }));
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);

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
    for (let i = 0; i < 17; i++) this.paths.push(new PathBuf());

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
    for (let k = 0; k < 14; k++) {
      if (this.partCount >= PART_CAP) break;
      const i = this.partCount++;
      const ang = (k / 14) * Math.PI * 2;
      const sp = 2.2 + (k % 4) * 0.45;
      this.px[i] = x;
      this.py[i] = 0.45;
      this.pz[i] = z;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = 2.4 + (k % 3) * 0.4;
      this.vz[i] = Math.sin(ang) * sp;
      this.life[i] = 0.42;
      this.pr[i] = c[0] / 255;
      this.pg[i] = c[1] / 255;
      this.pb[i] = c[2] / 255;
    }
    if (withShake) this.shake = Math.min(1.15, this.shake + 0.7);
  }

  punchClaim(): void {
    this.punch = 1;
  }

  clearPaths(): void {
    for (const p of this.paths) p.clear();
  }

  clearPath(id: number): void {
    this.paths[id]?.clear();
  }

  update(
    dt: number,
    phase: 'title' | 'play',
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

    for (const mesh of this.pets) mesh.count = 0;
    let shadowN = 0;
    let labelN = 0;
    for (const label of this.labels) label.on = false;

    if (phase === 'title') {
      this.ground.visible = false;
      this.platform.visible = true;
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
      let selfX = 0;
      let selfZ = 0;
      let selfAlive = false;
      for (let i = 0; i < petCount; i++) {
        const pet = pets[i]!;
        if (!pet.alive) {
          this.paths[pet.id]?.clear();
          continue;
        }
        const bob = Math.sin(this.time * 9 + pet.id) * 0.055;
        const roll = Math.sin(this.time * 9 + pet.id) * 0.07;
        const mesh = this.pets[pet.pet];
        if (mesh && mesh.count < PET_CAP) {
          this.place(mesh, mesh.count, pet.x, bob, pet.z, Math.PI / 2 - pet.h, roll, pet.self ? 1.08 : 1);
          mesh.count++;
        }
        if (shadowN < SHADOW_CAP) this.place(this.shadows, shadowN++, pet.x, 0.03, pet.z, 0, 0, pet.self ? 1.15 : 1);
        const path = this.paths[pet.id];
        path?.push(pet.x, pet.z, pet.h);
        const shown = pet.trainShown;
        for (let t = 0; t < shown; t++) {
          const species = pet.train[t] ?? 0;
          const follower = this.pets[species];
          if (!follower || follower.count >= PET_CAP || !path) continue;
          if (!path.sample(1.15 * (t + 1), this.sample)) continue;
          const fb = Math.sin(this.time * 9 + t * 0.7) * 0.05;
          this.place(follower, follower.count, this.sample.x, fb, this.sample.z, Math.PI / 2 - this.sample.h, 0, 0.82);
          follower.count++;
          if (shadowN < SHADOW_CAP) this.place(this.shadows, shadowN++, this.sample.x, 0.03, this.sample.z, 0, 0, 0.7);
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
          selfAlive = true;
          this.ring.visible = true;
          this.ring.position.set(pet.x, 0.04, pet.z);
          const col = PALETTE[(Math.max(1, pet.id) - 1) % PALETTE.length]!;
          (this.ring.material as MeshBasicMaterial).color.setRGB(col[0] / 255, col[1] / 255, col[2] / 255);
          const screen = this.project(pet.x, 0.6, pet.z);
          this.selfScreen = screen.ok;
          this.selfSX = screen.x;
          this.selfSY = screen.y;
        }
      }
      for (const mesh of this.pets) if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
      this.shadows.count = shadowN;
      if (shadowN > 0) this.shadows.instanceMatrix.needsUpdate = true;
      if (!selfAlive) {
        this.ring.visible = false;
        this.selfScreen = false;
      }

      this.punch *= Math.exp(-dt * 4);
      this.shake *= Math.exp(-dt * 6);
      const height = 25 - this.punch * 1.6;
      const back = 16.5;
      if (!this.camInit || snapCam) {
        this.camX = selfX;
        this.camY = height;
        this.camZ = selfZ + back;
        this.camInit = true;
      } else {
        const k = 1 - Math.exp(-dt * 5);
        this.camX += (selfX - this.camX) * k;
        this.camY += (height - this.camY) * k;
        this.camZ += (selfZ + back - this.camZ) * k;
      }
      const jx = (Math.random() - 0.5) * this.shake * 0.7;
      const jz = (Math.random() - 0.5) * this.shake * 0.45;
      this.camera.position.set(this.camX + jx, this.camY, this.camZ + jz);
      this.camera.lookAt(this.camX, 0.3, selfZ);

      this.layoutPickups(this.coins, pickups, pickupCount, 0);
      this.layoutPickups(this.orbs, pickups, pickupCount, 1);
      this.layoutPickups(this.loot, pickups, pickupCount, 2);
    }

    this.stepParticles(dt);
    this.renderer.render(this.scene, this.camera);
    this.perf.endFrame(performance.now(), this.renderer.info.render.calls, phase === 'play' ? petCount : SPECIES.length);
  }

  project(x: number, y: number, z: number): { x: number; y: number; ok: boolean } {
    this.proj.set(x, y, z).project(this.camera);
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
      this.place(mesh, n, p.x, bob, p.z, spin + i, 0, 1);
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
