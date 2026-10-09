import { PALETTE } from '@pet-trails/shared';
import { DataTexture, LinearFilter, LinearSRGBColorSpace, RGBAFormat, UnsignedByteType, type WebGLRenderer } from 'three';

const S = 4;

/**
 * Territory is a single DataTexture. After the initial upload, only dirty
 * pixel rows go to the GPU via texSubImage2D.
 */
export class Territory {
  readonly gridW: number;
  readonly gridH: number;
  readonly texW: number;
  readonly texH: number;
  readonly owner: Uint8Array;
  readonly trail: Uint8Array;
  readonly texture: DataTexture;
  snapshotUploads = 0;

  private readonly data: Uint8Array<ArrayBuffer>;
  private readonly drawOwner: Uint8Array;
  private readonly drawTrail: Uint8Array;
  private readonly revealAt: Float32Array;
  private readonly queued: Uint8Array;
  private readonly qIdx: Int32Array;
  private qN = 0;
  private readonly flash: Uint8Array;
  private readonly fade: Uint8Array;
  private readonly fadeOwner: Uint8Array;
  private readonly hot: Int32Array;
  private readonly hotMark: Uint8Array;
  private hotN = 0;
  private readonly rowDirty: Uint8Array;
  private rowCount = 0;
  private now = 0;
  private ready = false;

  constructor(gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.texW = gridW * S;
    this.texH = gridH * S;
    const n = gridW * gridH;
    this.owner = new Uint8Array(n);
    this.trail = new Uint8Array(n);
    this.drawOwner = new Uint8Array(n);
    this.drawTrail = new Uint8Array(n);
    this.revealAt = new Float32Array(n);
    this.queued = new Uint8Array(n);
    this.qIdx = new Int32Array(n);
    this.flash = new Uint8Array(n);
    this.fade = new Uint8Array(n);
    this.fadeOwner = new Uint8Array(n);
    this.hot = new Int32Array(n);
    this.hotMark = new Uint8Array(n);
    this.rowDirty = new Uint8Array(this.texH);
    this.data = new Uint8Array(new ArrayBuffer(this.texW * this.texH * 4));
    this.texture = new DataTexture(this.data, this.texW, this.texH, RGBAFormat, UnsignedByteType);
    this.texture.colorSpace = LinearSRGBColorSpace;
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
    this.paintAll();
  }

  /** Replace the whole map (join / respawn). One full upload, then deltas only. */
  applySnapshot(owner: ArrayLike<number>, trail: ArrayLike<number>): void {
    this.owner.set(owner);
    this.trail.set(trail);
    this.drawOwner.set(owner);
    this.drawTrail.set(trail);
    this.qN = 0;
    this.hotN = 0;
    this.queued.fill(0);
    this.flash.fill(0);
    this.fade.fill(0);
    this.hotMark.fill(0);
    this.paintAll();
    this.snapshotUploads++;
    this.ready = false;
    this.texture.needsUpdate = true;
  }

  applyRuns(runs: ArrayLike<number>, animate: boolean, ox: number, oy: number): void {
    for (let k = 0; k + 3 < runs.length; ) {
      const start = runs[k++]!;
      const o = runs[k++]!;
      const tr = runs[k++]!;
      const len = runs[k++]!;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (o === 0 && this.drawOwner[idx] === 0 && this.fade[idx] === 0) {
          this.owner[idx] = 0;
          this.trail[idx] = tr;
          continue;
        }
        if (o === 0 && this.drawOwner[idx] !== 0 && tr === 0) {
          this.owner[idx] = 0;
          this.trail[idx] = 0;
          if (this.fade[idx] === 0) {
            this.fade[idx] = 255;
            this.fadeOwner[idx] = this.drawOwner[idx]!;
            this.touchHot(idx);
          }
          continue;
        }
        this.fade[idx] = 0;
        this.owner[idx] = o;
        this.trail[idx] = tr;
        const cx = idx % this.gridW;
        const cy = (idx / this.gridW) | 0;
        let delay = 0;
        if (animate && o !== 0) {
          const dx = cx + 0.5 - ox;
          const dy = cy + 0.5 - oy;
          delay = Math.min(0.35, Math.hypot(dx, dy) * 0.011);
        }
        this.revealAt[idx] = this.now + delay;
        if (!this.queued[idx]) {
          this.queued[idx] = 1;
          this.qIdx[this.qN++] = idx;
        }
      }
    }
  }

  update(dt: number): void {
    this.now += dt;
    let w = 0;
    for (let k = 0; k < this.qN; k++) {
      const i = this.qIdx[k]!;
      if (this.now < this.revealAt[i]!) {
        this.qIdx[w++] = i;
        continue;
      }
      this.queued[i] = 0;
      this.drawOwner[i] = this.owner[i]!;
      this.drawTrail[i] = this.trail[i]!;
      if (this.drawOwner[i] !== 0) {
        this.flash[i] = 255;
        this.touchHot(i);
      }
      this.paintIndex(i, true);
    }
    this.qN = w;
    this.cool(dt);
  }

  private touchHot(i: number): void {
    if (this.hotMark[i]) return;
    this.hotMark[i] = 1;
    this.hot[this.hotN++] = i;
  }

  private cool(dt: number): void {
    const drop = dt * 780;
    let w = 0;
    for (let k = 0; k < this.hotN; k++) {
      const i = this.hot[k]!;
      let live = false;
      if (this.flash[i]! > 0) {
        this.flash[i] = Math.max(0, this.flash[i]! - drop);
        live = true;
      }
      if (this.fade[i]! > 0) {
        this.fade[i] = Math.max(0, this.fade[i]! - drop * 1.6);
        if (this.fade[i] === 0) {
          this.drawOwner[i] = 0;
          this.drawTrail[i] = 0;
        }
        live = true;
      }
      if (live || this.flash[i] === 0) this.paintCell(i % this.gridW, (i / this.gridW) | 0);
      if (this.flash[i]! > 0 || this.fade[i]! > 0) this.hot[w++] = i;
      else this.hotMark[i] = 0;
    }
    this.hotN = w;
  }

  /** Push dirty rows. Does not set needsUpdate, so three will not reupload the full image. */
  upload(renderer: WebGLRenderer): void {
    if (!this.ready) {
      const props = renderer.properties.get(this.texture) as { __webglTexture?: WebGLTexture };
      if (props.__webglTexture) this.ready = true;
      return;
    }
    if (this.rowCount === 0) return;
    const gl = renderer.getContext();
    const props = renderer.properties.get(this.texture) as { __webglTexture?: WebGLTexture };
    const webglTex = props.__webglTexture;
    if (!webglTex) return;
    renderer.state.bindTexture(gl.TEXTURE_2D, webglTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    const gl2 = gl as WebGL2RenderingContext;
    if (typeof gl2.UNPACK_ROW_LENGTH === 'number') gl.pixelStorei(gl2.UNPACK_ROW_LENGTH, 0);
    const stride = this.texW * 4;
    let y = 0;
    while (y < this.texH) {
      if (!this.rowDirty[y]) {
        y++;
        continue;
      }
      let y2 = y + 1;
      while (y2 < this.texH && this.rowDirty[y2]) y2++;
      const height = y2 - y;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, this.texW, height, gl.RGBA, gl.UNSIGNED_BYTE, this.data, y * stride);
      y = y2;
    }
    this.rowDirty.fill(0);
    this.rowCount = 0;
  }

  private paintAll(): void {
    const n = this.gridW * this.gridH;
    for (let i = 0; i < n; i++) this.paintIndex(i, false);
    this.rowDirty.fill(0);
    this.rowCount = 0;
  }

  private paintIndex(i: number, markNeighbors: boolean): void {
    const cx = i % this.gridW;
    const cy = (i / this.gridW) | 0;
    this.paintCell(cx, cy);
    if (!markNeighbors) return;
    if (cx > 0) this.paintCell(cx - 1, cy);
    if (cx + 1 < this.gridW) this.paintCell(cx + 1, cy);
    if (cy > 0) this.paintCell(cx, cy - 1);
    if (cy + 1 < this.gridH) this.paintCell(cx, cy + 1);
  }

  private shownOwner(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return -1;
    const i = cy * this.gridW + cx;
    if (this.fade[i]! > 0) return this.fadeOwner[i]!;
    return this.drawOwner[i]!;
  }

  private paintCell(cx: number, cy: number): void {
    const i = cy * this.gridW + cx;
    const fade = this.fade[i] ?? 0;
    const owner = fade > 0 ? this.fadeOwner[i]! : this.drawOwner[i]!;
    const flash = this.flash[i] ?? 0;
    let r = 186;
    let g = 224;
    let b = 196;
    if (owner) {
      const c = PALETTE[(owner - 1) % PALETTE.length]!;
      const f = flash / 255;
      r = c[0] + (255 - c[0]) * f * 0.72;
      g = c[1] + (255 - c[1]) * f * 0.72;
      b = c[2] + (255 - c[2]) * f * 0.72;
    }
    const leftDiff = owner !== 0 && this.shownOwner(cx - 1, cy) !== owner;
    const rightDiff = owner !== 0 && this.shownOwner(cx + 1, cy) !== owner;
    const upDiff = owner !== 0 && this.shownOwner(cx, cy - 1) !== owner;
    const downDiff = owner !== 0 && this.shownOwner(cx, cy + 1) !== owner;
    // Plane rotateX(-90) puts texture v=1 at world Z=0, and WebGL puts the last
    // buffer row at v=1. Write sim y=0 into that row so land sits under the pet.
    const y0 = (this.gridH - 1 - cy) * S;
    const x0 = cx * S;
    const fadeA = fade > 0 ? fade / 255 : 1;
    for (let py = 0; py < S; py++) {
      const row = (y0 + py) * this.texW;
      let ay = 255;
      if (owner) {
        if (upDiff) ay = Math.min(ay, py === 0 ? 60 : py === 1 ? 150 : 255);
        if (downDiff) ay = Math.min(ay, py === S - 1 ? 60 : py === S - 2 ? 150 : 255);
      }
      for (let px = 0; px < S; px++) {
        let ax = 255;
        if (owner) {
          if (leftDiff) ax = Math.min(ax, px === 0 ? 60 : px === 1 ? 150 : 255);
          if (rightDiff) ax = Math.min(ax, px === S - 1 ? 60 : px === S - 2 ? 150 : 255);
        }
        let a = owner ? Math.min(ax, ay) * fadeA : 0;
        if (!owner) a = 0;
        const p = (row + x0 + px) * 4;
        this.data[p] = r;
        this.data[p + 1] = g;
        this.data[p + 2] = b;
        this.data[p + 3] = a;
      }
    }
    for (let py = 0; py < S; py++) {
      const row = y0 + py;
      if (!this.rowDirty[row]) {
        this.rowDirty[row] = 1;
        this.rowCount++;
      }
    }
  }
}
