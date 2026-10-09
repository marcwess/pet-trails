import { PALETTE } from '@pet-trails/shared';
import { DataTexture, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, type WebGLRenderer } from 'three';

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
    this.rowDirty = new Uint8Array(this.texH);
    this.data = new Uint8Array(new ArrayBuffer(this.texW * this.texH * 4));
    this.texture = new DataTexture(this.data, this.texW, this.texH, RGBAFormat, UnsignedByteType);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
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
    this.queued.fill(0);
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
        this.owner[idx] = o;
        this.trail[idx] = tr;
        const cx = idx % this.gridW;
        const cy = (idx / this.gridW) | 0;
        let delay = 0;
        if (animate) {
          const dx = cx + 0.5 - ox;
          const dy = cy + 0.5 - oy;
          delay = Math.min(0.4, Math.hypot(dx, dy) * 0.013);
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
      this.paintIndex(i, true);
    }
    this.qN = w;
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

  private key(cx: number, cy: number): number {
    const i = cy * this.gridW + cx;
    const tr = this.drawTrail[i]!;
    return tr ? tr + 256 : this.drawOwner[i]!;
  }

  private paintCell(cx: number, cy: number): void {
    const i = cy * this.gridW + cx;
    const owner = this.drawOwner[i]!;
    const trail = this.drawTrail[i]!;
    const mine = this.key(cx, cy);
    let r: number;
    let g: number;
    let b: number;
    if (trail) {
      const c = PALETTE[(trail - 1) % PALETTE.length]!;
      r = c[0] + (255 - c[0]) * 0.58;
      g = c[1] + (255 - c[1]) * 0.58;
      b = c[2] + (255 - c[2]) * 0.58;
    } else if (owner) {
      const c = PALETTE[(owner - 1) % PALETTE.length]!;
      r = c[0];
      g = c[1];
      b = c[2];
    } else {
      const alt = ((cx + cy) & 1) === 0;
      r = alt ? 188 : 174;
      g = alt ? 228 : 214;
      b = alt ? 196 : 184;
    }
    const filled = owner !== 0 || trail !== 0;
    // Plane rotateX(-90) puts texture v=1 at world Z=0, and WebGL puts the last
    // buffer row at v=1. Write sim y=0 into that row so land sits under the pet.
    const y0 = (this.gridH - 1 - cy) * S;
    const x0 = cx * S;
    for (let py = 0; py < S; py++) {
      const row = (y0 + py) * this.texW;
      for (let px = 0; px < S; px++) {
        let cr = r;
        let cg = g;
        let cb = b;
        if (filled) {
          let differ = false;
          if (px === 0 || px === S - 1) {
            const nx = cx + (px === 0 ? -1 : 1);
            if (nx < 0 || nx >= this.gridW || this.key(nx, cy) !== mine) differ = true;
          }
          if (py === 0 || py === S - 1) {
            const ny = cy + (py === 0 ? -1 : 1);
            if (ny < 0 || ny >= this.gridH || this.key(cx, ny) !== mine) differ = true;
          }
          if (differ) {
            cr = r * 0.58;
            cg = g * 0.58;
            cb = b * 0.58;
          } else if (trail && px >= 1 && px <= 2 && py >= 1 && py <= 2) {
            cr = Math.min(255, cr + 22);
            cg = Math.min(255, cg + 22);
            cb = Math.min(255, cb + 22);
          }
        }
        const p = (row + x0 + px) * 4;
        this.data[p] = cr;
        this.data[p + 1] = cg;
        this.data[p + 2] = cb;
        this.data[p + 3] = 255;
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
