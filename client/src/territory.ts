import { PALETTE } from '@pet-trails/shared';
import { DataTexture, LinearFilter, LinearSRGBColorSpace, RGBAFormat, UnsignedByteType, type WebGLRenderer } from 'three';

const S = 4;
const MAX_OWNERS = 24;
const LOOP_N = 480;
const MAX_E = 16384;
const MAX_P = 16384;
/** Signed-distance band, in cells, around the smoothed contour. */
const FEATHER = 1.35;

/**
 * Territory is a single DataTexture. After the initial upload, only dirty
 * pixel rows go to the GPU via texSubImage2D.
 *
 * Cell ownership is painted solid, then each owner's contour is corner-cut
 * (Chaikin) and, once a claim's trail polyline is known, snapped to that
 * centerline. A signed-distance ramp in the texture is what the ground shader
 * smoothsteps, so diagonal edges stay curved at screen resolution.
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

  private readonly dirtyIds = new Int32Array(MAX_OWNERS);
  private readonly dirtyOn = new Uint8Array(MAX_OWNERS);
  private dirtyN = 0;
  private readonly loopX = new Float32Array(MAX_OWNERS * LOOP_N);
  private readonly loopY = new Float32Array(MAX_OWNERS * LOOP_N);
  private readonly loopN = new Int16Array(MAX_OWNERS);
  private readonly ex0 = new Int16Array(MAX_E);
  private readonly ey0 = new Int16Array(MAX_E);
  private readonly ex1 = new Int16Array(MAX_E);
  private readonly ey1 = new Int16Array(MAX_E);
  private readonly enext = new Int32Array(MAX_E);
  private readonly eSeen = new Uint8Array(MAX_E);
  private readonly eHead: Int32Array;
  private readonly eUsed = new Int32Array(MAX_E);
  private eUsedN = 0;
  private readonly ax = new Float32Array(MAX_P);
  private readonly ay = new Float32Array(MAX_P);
  private readonly bx = new Float32Array(MAX_P);
  private readonly by = new Float32Array(MAX_P);
  private readonly sd: Float32Array;
  private readonly sdStamp: Uint16Array;
  private readonly touch: Int32Array;
  private readonly once: Uint32Array;
  private sid = 1;
  private onceId = 1;
  private touchN = 0;

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
    this.eHead = new Int32Array((gridW + 1) * (gridH + 1));
    this.eHead.fill(-1);
    this.sd = new Float32Array(this.texW * this.texH);
    this.sdStamp = new Uint16Array(this.texW * this.texH);
    this.touch = new Int32Array(this.texW * this.texH);
    this.once = new Uint32Array(n);
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
    this.loopN.fill(0);
    this.paintAll();
    this.snapshotUploads++;
    this.ready = false;
    this.texture.needsUpdate = true;
  }

  /**
   * Trail centerline in cell coordinates, oldest to newest. The next smooth
   * rebuild snaps that owner's contour onto this polyline once the radial
   * reveal has finished.
   */
  offerLoop(id: number, xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): void {
    if (id <= 0 || id >= MAX_OWNERS || n < 2) return;
    const count = Math.min(LOOP_N, n);
    const base = id * LOOP_N;
    for (let i = 0; i < count; i++) {
      this.loopX[base + i] = xs[i]!;
      this.loopY[base + i] = ys[i]!;
    }
    this.loopN[id] = count;
    this.markOwner(id);
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
      const prevDraw = this.fade[i]! > 0 ? this.fadeOwner[i]! : this.drawOwner[i]!;
      this.drawOwner[i] = this.owner[i]!;
      this.drawTrail[i] = this.trail[i]!;
      if (this.drawOwner[i] !== 0) {
        this.flash[i] = 255;
        this.touchHot(i);
      }
      this.paintIndex(i, prevDraw);
    }
    this.qN = w;
    this.cool(dt);
    this.flushEdges();
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
      const cx = i % this.gridW;
      const cy = (i / this.gridW) | 0;
      let live = false;
      if (this.flash[i]! > 0) {
        this.flash[i] = Math.max(0, this.flash[i]! - drop);
        live = true;
      }
      if (this.fade[i]! > 0) {
        const prevOwner = this.fadeOwner[i]!;
        this.fade[i] = Math.max(0, this.fade[i]! - drop * 1.6);
        if (this.fade[i] === 0) {
          this.drawOwner[i] = 0;
          this.drawTrail[i] = 0;
          this.paintCell(cx, cy, true);
          this.markOwner(prevOwner);
          this.noteNeighbors(cx, cy);
        } else {
          this.paintCell(cx, cy, true);
          this.markOwner(prevOwner);
        }
        live = true;
      } else if (this.flash[i] === 0 || live) {
        this.paintCell(cx, cy, false);
      }
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
    for (let i = 0; i < n; i++) {
      if (this.drawOwner[i]) this.markOwner(this.drawOwner[i]!);
      this.paintCell(i % this.gridW, (i / this.gridW) | 0, true);
    }
    this.flushEdges();
    this.rowDirty.fill(0);
    this.rowCount = 0;
  }

  private paintIndex(i: number, prevDraw: number): void {
    const cx = i % this.gridW;
    const cy = (i / this.gridW) | 0;
    this.paintCell(cx, cy, true);
    this.markOwner(prevDraw);
    this.markOwner(this.shownOwner(cx, cy));
    this.noteNeighbors(cx, cy);
  }

  private noteNeighbors(cx: number, cy: number): void {
    if (cx > 0) this.markOwner(this.shownOwner(cx - 1, cy));
    if (cx + 1 < this.gridW) this.markOwner(this.shownOwner(cx + 1, cy));
    if (cy > 0) this.markOwner(this.shownOwner(cx, cy - 1));
    if (cy + 1 < this.gridH) this.markOwner(this.shownOwner(cx, cy + 1));
  }

  private markOwner(id: number): void {
    if (id <= 0 || id >= MAX_OWNERS) return;
    if (this.dirtyOn[id]) return;
    this.dirtyOn[id] = 1;
    this.dirtyIds[this.dirtyN++] = id;
  }

  private shownOwner(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return -1;
    const i = cy * this.gridW + cx;
    if (this.fade[i]! > 0) return this.fadeOwner[i]!;
    return this.drawOwner[i]!;
  }

  private paintCell(cx: number, cy: number, writeAlpha: boolean): void {
    const i = cy * this.gridW + cx;
    const fade = this.fade[i] ?? 0;
    const owner = fade > 0 ? this.fadeOwner[i]! : this.drawOwner[i]!;
    const rgb = this.rgb(owner, cx, cy);
    const y0 = (this.gridH - 1 - cy) * S;
    const x0 = cx * S;
    const a = owner ? Math.round(255 * rgb.fade) : 0;
    for (let py = 0; py < S; py++) {
      const row = (y0 + py) * this.texW;
      for (let px = 0; px < S; px++) {
        const p = (row + x0 + px) * 4;
        this.data[p] = rgb.r;
        this.data[p + 1] = rgb.g;
        this.data[p + 2] = rgb.b;
        if (writeAlpha) this.data[p + 3] = a;
      }
      this.markRow(y0 + py);
    }
  }

  private rgb(owner: number, cx: number, cy: number): { r: number; g: number; b: number; fade: number } {
    let flash = 0;
    let fade = 1;
    if (owner && cx >= 0 && cy >= 0 && cx < this.gridW && cy < this.gridH) {
      const i = cy * this.gridW + cx;
      const shown = this.fade[i]! > 0 ? this.fadeOwner[i]! : this.drawOwner[i]!;
      if (shown === owner) {
        flash = this.flash[i] ?? 0;
        if (this.fade[i]! > 0) fade = this.fade[i]! / 255;
      }
    }
    if (!owner) return { r: 186, g: 224, b: 196, fade: 0 };
    const c = PALETTE[(owner - 1) % PALETTE.length]!;
    const f = flash / 255;
    return {
      r: c[0] + (255 - c[0]) * f * 0.72,
      g: c[1] + (255 - c[1]) * f * 0.72,
      b: c[2] + (255 - c[2]) * f * 0.72,
      fade,
    };
  }

  private markRow(row: number): void {
    if (row < 0 || row >= this.texH || this.rowDirty[row]) return;
    this.rowDirty[row] = 1;
    this.rowCount++;
  }

  private flushEdges(): void {
    if (this.dirtyN === 0) return;
    const n = this.dirtyN;
    for (let k = 0; k < n; k++) {
      const owner = this.dirtyIds[k]!;
      this.dirtyOn[owner] = 0;
      this.solidify(owner);
      this.stampOwner(owner);
    }
    this.dirtyN = 0;
  }

  /** Restore a solid silhouette so a previous ramp cannot leave a stair behind. */
  private solidify(owner: number): void {
    this.onceId++;
    const id = this.onceId;
    const w = this.gridW;
    const h = this.gridH;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (this.shownOwner(cx, cy) !== owner) continue;
        this.paintOnce(cx, cy, id);
        let edge = false;
        if (this.shownOwner(cx - 1, cy) !== owner) edge = true;
        else if (this.shownOwner(cx + 1, cy) !== owner) edge = true;
        else if (this.shownOwner(cx, cy - 1) !== owner) edge = true;
        else if (this.shownOwner(cx, cy + 1) !== owner) edge = true;
        if (!edge) continue;
        for (let dy = -3; dy <= 3; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            if (this.shownOwner(nx, ny) !== 0) continue;
            this.paintOnce(nx, ny, id);
          }
        }
      }
    }
  }

  private paintOnce(cx: number, cy: number, id: number): void {
    const i = cy * this.gridW + cx;
    if (this.once[i] === id) return;
    this.once[i] = id;
    this.paintCell(cx, cy, true);
  }

  private ownerPending(owner: number): boolean {
    for (let k = 0; k < this.qN; k++) {
      const i = this.qIdx[k]!;
      if (this.owner[i] === owner) return true;
    }
    return false;
  }

  private stampOwner(owner: number): void {
    if (this.traceLoops(owner) === 0) return;
    this.sid++;
    if (this.sid === 65535) {
      this.sdStamp.fill(0);
      this.sid = 1;
    }
    this.touchN = 0;
    this.writeLoops(owner, !this.ownerPending(owner) && this.loopN[owner]! >= 2);
  }

  /** Walk every boundary loop, smooth it, and splat a coverage ramp. */
  private writeLoops(owner: number, useLoop: boolean): void {
    const stride = this.gridH + 1;
    for (let e = 0; e < this.edgeCount; e++) this.eSeen[e] = 0;
    for (let start = 0; start < this.edgeCount; start++) {
      if (this.eSeen[start]) continue;
      let count = this.collectLoop(start, stride);
      if (count < 4) continue;
      if (useLoop) count = this.snapLoop(owner, count);
      if (count < 4) continue;
      count = this.decimate(count, 1600);
      count = this.smooth(count, useLoop ? 2 : 3);
      this.splat(count);
    }
    this.commitRamp(owner);
  }

  private edgeCount = 0;

  private traceLoops(owner: number): number {
    for (let i = 0; i < this.eUsedN; i++) this.eHead[this.eUsed[i]!] = -1;
    this.eUsedN = 0;
    this.edgeCount = 0;
    const w = this.gridW;
    const h = this.gridH;
    const stride = h + 1;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (this.shownOwner(cx, cy) !== owner) continue;
        if (this.shownOwner(cx, cy - 1) !== owner) this.addEdge(cx, cy, cx + 1, cy, stride);
        if (this.shownOwner(cx + 1, cy) !== owner) this.addEdge(cx + 1, cy, cx + 1, cy + 1, stride);
        if (this.shownOwner(cx, cy + 1) !== owner) this.addEdge(cx + 1, cy + 1, cx, cy + 1, stride);
        if (this.shownOwner(cx - 1, cy) !== owner) this.addEdge(cx, cy + 1, cx, cy, stride);
      }
    }
    return this.edgeCount;
  }

  private addEdge(x0: number, y0: number, x1: number, y1: number, stride: number): void {
    if (this.edgeCount >= MAX_E) return;
    const e = this.edgeCount++;
    this.ex0[e] = x0;
    this.ey0[e] = y0;
    this.ex1[e] = x1;
    this.ey1[e] = y1;
    const k = x0 * stride + y0;
    this.enext[e] = this.eHead[k]!;
    if (this.eHead[k] === -1) this.eUsed[this.eUsedN++] = k;
    this.eHead[k] = e;
  }

  private collectLoop(start: number, stride: number): number {
    let e = start;
    let n = 0;
    for (let guard = 0; guard < this.edgeCount && n < MAX_P; guard++) {
      this.eSeen[e] = 1;
      this.ax[n] = this.ex0[e]!;
      this.ay[n] = this.ey0[e]!;
      n++;
      const k = this.ex1[e]! * stride + this.ey1[e]!;
      let nxt = this.eHead[k] ?? -1;
      let found = -1;
      let hops = 0;
      while (nxt !== -1 && hops++ < 8) {
        if (!this.eSeen[nxt]) {
          found = nxt;
          break;
        }
        nxt = this.enext[nxt]!;
      }
      if (found < 0) break;
      e = found;
    }
    if (n < 4) return 0;
    const k0 = this.ex0[start]! * stride + this.ey0[start]!;
    const endK = this.ex1[e]! * stride + this.ey1[e]!;
    if (endK !== k0 && (this.ex1[e] !== this.ex0[start] || this.ey1[e] !== this.ey0[start])) return 0;
    return n;
  }

  private snapLoop(owner: number, n: number): number {
    const base = owner * LOOP_N;
    const ln = this.loopN[owner]!;
    let w = 0;
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i < n; i++) {
      let x = this.ax[i]!;
      let y = this.ay[i]!;
      let best = 1.25;
      let bx = x;
      let by = y;
      for (let s = 0; s < ln - 1; s++) {
        const ax = this.loopX[base + s]!;
        const ay = this.loopY[base + s]!;
        const bx0 = this.loopX[base + s + 1]!;
        const by0 = this.loopY[base + s + 1]!;
        const vx = bx0 - ax;
        const vy = by0 - ay;
        const len2 = vx * vx + vy * vy;
        let t = 0;
        if (len2 > 1e-8) t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
        const cx = ax + vx * t;
        const cy = ay + vy * t;
        const d = Math.hypot(x - cx, y - cy);
        if (d < best) {
          best = d;
          bx = cx;
          by = cy;
        }
      }
      if (best < 1.25) {
        x = bx;
        y = by;
      }
      if (w > 0 && (x - prevX) * (x - prevX) + (y - prevY) * (y - prevY) < 0.04) continue;
      this.bx[w] = x;
      this.by[w] = y;
      prevX = x;
      prevY = y;
      w++;
    }
    if (w < 4) return n;
    for (let i = 0; i < w; i++) {
      this.ax[i] = this.bx[i]!;
      this.ay[i] = this.by[i]!;
    }
    return w;
  }

  private decimate(n: number, cap: number): number {
    let count = n;
    while (count > cap) {
      let w = 0;
      for (let i = 0; i < count; i += 2) {
        this.bx[w] = this.ax[i]!;
        this.by[w] = this.ay[i]!;
        w++;
      }
      for (let i = 0; i < w; i++) {
        this.ax[i] = this.bx[i]!;
        this.ay[i] = this.by[i]!;
      }
      count = w;
    }
    return count;
  }

  private smooth(n: number, times: number): number {
    let count = n;
    let srcX = this.ax;
    let srcY = this.ay;
    let dstX = this.bx;
    let dstY = this.by;
    for (let t = 0; t < times; t++) {
      let w = 0;
      for (let i = 0; i < count && w + 2 < MAX_P; i++) {
        const j = (i + 1) % count;
        const px = srcX[i]!;
        const py = srcY[i]!;
        const qx = srcX[j]!;
        const qy = srcY[j]!;
        dstX[w] = px * 0.75 + qx * 0.25;
        dstY[w] = py * 0.75 + qy * 0.25;
        w++;
        dstX[w] = px * 0.25 + qx * 0.75;
        dstY[w] = py * 0.25 + qy * 0.75;
        w++;
      }
      count = w;
      const tx = srcX;
      srcX = dstX;
      dstX = tx;
      const ty = srcY;
      srcY = dstY;
      dstY = ty;
    }
    if (srcX !== this.ax) {
      for (let i = 0; i < count; i++) {
        this.ax[i] = srcX[i]!;
        this.ay[i] = srcY[i]!;
      }
    }
    return count;
  }

  private splat(n: number): void {
    const feather = FEATHER;
    for (let i = 0; i < n; i++) {
      const ax = this.ax[i]!;
      const ay = this.ay[i]!;
      const bx = this.ax[(i + 1) % n]!;
      const by = this.ay[(i + 1) % n]!;
      const minX = Math.min(ax, bx) - feather;
      const maxX = Math.max(ax, bx) + feather;
      const minY = Math.min(ay, by) - feather;
      const maxY = Math.max(ay, by) + feather;
      const t0 = this.texOf(minX, maxY);
      const t1 = this.texOf(maxX, minY);
      let x0 = Math.max(0, Math.floor(Math.min(t0.tx, t1.tx)));
      let x1 = Math.min(this.texW - 1, Math.ceil(Math.max(t0.tx, t1.tx)));
      let y0 = Math.max(0, Math.floor(Math.min(t0.ty, t1.ty)));
      let y1 = Math.min(this.texH - 1, Math.ceil(Math.max(t0.ty, t1.ty)));
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const sim = this.simOf(tx, ty);
          let t = 0;
          if (len2 > 1e-8) t = Math.max(0, Math.min(1, ((sim.x - ax) * vx + (sim.y - ay) * vy) / len2));
          const cx = ax + vx * t;
          const cy = ay + vy * t;
          const dx = sim.x - cx;
          const dy = sim.y - cy;
          const dist = Math.hypot(dx, dy);
          if (dist > feather) continue;
          const cross = vx * (sim.y - ay) - vy * (sim.x - ax);
          const signed = (cross >= 0 ? 1 : -1) * dist;
          const idx = ty * this.texW + tx;
          const prev = this.sdStamp[idx] === this.sid ? Math.abs(this.sd[idx]!) : Infinity;
          if (dist < prev) {
            if (this.sdStamp[idx] !== this.sid) {
              if (this.touchN < this.touch.length) this.touch[this.touchN++] = idx;
            }
            this.sdStamp[idx] = this.sid;
            this.sd[idx] = signed;
          }
        }
      }
    }
  }

  private commitRamp(owner: number): void {
    const feather = FEATHER;
    for (let k = 0; k < this.touchN; k++) {
      const idx = this.touch[k]!;
      if (this.sdStamp[idx] !== this.sid) continue;
      const signed = this.sd[idx]!;
      const coverage = Math.max(0, Math.min(1, 0.5 + signed / (feather * 2)));
      const tx = idx % this.texW;
      const ty = (idx / this.texW) | 0;
      const sim = this.simOf(tx, ty);
      const cx = Math.floor(sim.x);
      const cy = Math.floor(sim.y);
      const cell = this.shownOwner(cx, cy);
      if (cell > 0 && cell !== owner) continue;
      if (signed < 0 && cell !== owner && cell !== 0 && cell !== -1) continue;
      const rgb = this.rgb(owner, cx, cy);
      const fade = cell === owner ? rgb.fade : coverage > 0 ? 1 : 0;
      const p = idx * 4;
      this.data[p] = rgb.r;
      this.data[p + 1] = rgb.g;
      this.data[p + 2] = rgb.b;
      this.data[p + 3] = Math.round(coverage * fade * 255);
      this.markRow(ty);
    }
  }

  /** Buffer texel to continuous cell position. Linear and matches paintCell. */
  private simOf(tx: number, ty: number): { x: number; y: number } {
    return {
      x: (tx + 0.5) / S,
      y: (this.texH - 0.5 - ty) / S,
    };
  }

  private texOf(sx: number, sy: number): { tx: number; ty: number } {
    return {
      tx: sx * S - 0.5,
      ty: this.texH - 0.5 - sy * S,
    };
  }
}
