import { PALETTE } from '@pet-trails/shared';
import { DataTexture, LinearFilter, LinearSRGBColorSpace, RGBAFormat, UnsignedByteType, type WebGLRenderer } from 'three';

const S = 4;
const MAX_OWNERS = 24;
const LOOP_N = 480;
const MAX_E = 16384;
const MAX_P = 16384;
/** How far, in cells, the smoothed contour is allowed to repaint. Wide enough to cut a 1-cell stair. */
const BAND = 1.6;
/** Texels this far outside the contour stay opaque so bilinear corners do not notch. */
const SKIRT = 0.13;
/** Darker band on the outer edge. Half a texel is 0.125, so this is one texel row. */
const RIM = 0.15;
/** Previous ramp texels kept per owner so the next claim can erase them without scanning the map. */
const TOUCH_N = 32768;

/**
 * Territory is a single DataTexture. After the initial upload, only dirty
 * pixel rows go to the GPU via texSubImage2D.
 *
 * Cells are painted solid. A finished claim (not every frame) snaps that
 * owner's contour onto the trail and relaxes the stairs, then rewrites the
 * edge band. Empty texels stay alpha 0. The renderer draws one tight quad
 * per owner and alpha-tests this texture, so the mint clear color shows
 * through and land quads do not cover the whole screen.
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

  /** Gameplay cells owned by `id`, not the mesh. A spawn square is about 18×18. */
  ownerBounds(id: number): { x0: number; y0: number; x1: number; y1: number; w: number; h: number; cells: number } | null {
    let x0 = this.gridW;
    let y0 = this.gridH;
    let x1 = -1;
    let y1 = -1;
    let cells = 0;
    const n = this.gridW * this.gridH;
    for (let i = 0; i < n; i++) {
      if (this.owner[i] !== id) continue;
      const x = i % this.gridW;
      const y = (i / this.gridW) | 0;
      cells++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (cells === 0) return null;
    return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cells };
  }

  /**
   * Inclusive cell bounds for every owner that currently has land.
   * `into` is packed as id, x0, y0, x1, y1. Returns the owner count.
   */
  landSpans(into: Int16Array): number {
    let n = 0;
    for (let id = 1; id < MAX_OWNERS; id++) {
      if (!this.bbOn[id]) continue;
      const o = n * 5;
      if (o + 4 >= into.length) break;
      into[o] = id;
      into[o + 1] = this.bbMinX[id]!;
      into[o + 2] = this.bbMinY[id]!;
      into[o + 3] = this.bbMaxX[id]!;
      into[o + 4] = this.bbMaxY[id]!;
      n++;
    }
    return n;
  }

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
  private readonly rowX0: Uint16Array;
  private readonly rowX1: Uint16Array;
  private rowCount = 0;
  private now = 0;
  private ready = false;
  /** 1 → 0 over the claim bounce. The renderer reads this. */
  claimPulse = 0;
  claimX0 = 0;
  claimY0 = 0;
  claimX1 = 0;
  claimY1 = 0;

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
  private readonly ox = new Float32Array(MAX_P);
  private readonly oy = new Float32Array(MAX_P);
  private readonly sd: Float32Array;
  private readonly sdStamp: Uint16Array;
  private readonly touch: Int32Array;
  private readonly touchAt: Int32Array;
  private readonly touchLen = new Int32Array(MAX_OWNERS);
  private readonly bbMinX = new Int16Array(MAX_OWNERS);
  private readonly bbMinY = new Int16Array(MAX_OWNERS);
  private readonly bbMaxX = new Int16Array(MAX_OWNERS);
  private readonly bbMaxY = new Int16Array(MAX_OWNERS);
  private readonly bbOn = new Uint8Array(MAX_OWNERS);
  private readonly due = new Float32Array(MAX_OWNERS);
  private sid = 1;
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
    this.rowX0 = new Uint16Array(this.texH);
    this.rowX1 = new Uint16Array(this.texH);
    this.data = new Uint8Array(new ArrayBuffer(this.texW * this.texH * 4));
    this.eHead = new Int32Array((gridW + 1) * (gridH + 1));
    this.eHead.fill(-1);
    this.sd = new Float32Array(this.texW * this.texH);
    this.sdStamp = new Uint16Array(this.texW * this.texH);
    this.touch = new Int32Array(this.texW * this.texH);
    this.touchAt = new Int32Array(MAX_OWNERS * TOUCH_N);
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
    this.touchLen.fill(0);
    this.bbOn.fill(0);
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
    this.schedule(id);
  }

  applyRuns(runs: ArrayLike<number>, animate: boolean, ox: number, oy: number): void {
    void ox;
    void oy;
    let boxReset = false;
    for (let k = 0; k + 3 < runs.length; ) {
      const start = runs[k++]!;
      const o = runs[k++]!;
      const tr = runs[k++]!;
      const len = runs[k++]!;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        const prevDraw = this.fade[idx]! > 0 ? this.fadeOwner[idx]! : this.drawOwner[idx]!;
        const prevOwner = this.owner[idx]!;
        this.fade[idx] = 0;
        this.flash[idx] = 0;
        if (o === prevOwner && o === prevDraw) {
          this.trail[idx] = tr;
          this.drawTrail[idx] = tr;
          continue;
        }
        this.owner[idx] = o;
        this.trail[idx] = tr;
        this.drawOwner[idx] = o;
        this.drawTrail[idx] = tr;
        const cx = idx % this.gridW;
        const cy = (idx / this.gridW) | 0;
        if (animate && o !== 0) {
          if (!boxReset) {
            this.claimX0 = cx;
            this.claimY0 = cy;
            this.claimX1 = cx;
            this.claimY1 = cy;
            boxReset = true;
          } else {
            if (cx < this.claimX0) this.claimX0 = cx;
            if (cy < this.claimY0) this.claimY0 = cy;
            if (cx > this.claimX1) this.claimX1 = cx;
            if (cy > this.claimY1) this.claimY1 = cy;
          }
          this.claimPulse = 1;
        }
        this.paintCell(cx, cy, true);
        if (o !== 0) this.grow(o, cx, cy);
        if (prevDraw !== o) this.schedule(prevDraw);
        if (o !== 0) this.schedule(o);
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
      this.paintIndex(i, prevDraw);
    }
    this.qN = w;
    this.cool(dt);
    this.flushEdges();
    if (this.claimPulse > 0) this.claimPulse = Math.max(0, this.claimPulse - dt / 0.55);
  }

  private cool(_dt: number): void {
    if (this.hotN === 0) return;
    let w = 0;
    for (let k = 0; k < this.hotN; k++) {
      const i = this.hot[k]!;
      const cx = i % this.gridW;
      const cy = (i / this.gridW) | 0;
      if (this.flash[i]! > 0) this.flash[i] = 0;
      if (this.fade[i]! > 0) {
        const prevOwner = this.fadeOwner[i]!;
        this.fade[i] = 0;
        this.drawOwner[i] = 0;
        this.drawTrail[i] = 0;
        this.paintCell(cx, cy, true);
        this.schedule(prevOwner);
      }
      this.hotMark[i] = 0;
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
    const rowLength = typeof gl2.UNPACK_ROW_LENGTH === 'number';
    if (rowLength) gl.pixelStorei(gl2.UNPACK_ROW_LENGTH, this.texW);
    let y = 0;
    while (y < this.texH) {
      if (!this.rowDirty[y]) {
        y++;
        continue;
      }
      let y2 = y + 1;
      let x0 = this.rowX0[y]!;
      let x1 = this.rowX1[y]!;
      while (y2 < this.texH && this.rowDirty[y2] && y2 - y < 24) {
        const nx0 = Math.min(x0, this.rowX0[y2]!);
        const nx1 = Math.max(x1, this.rowX1[y2]!);
        if (y2 > y && nx1 - nx0 > x1 - x0 + 64) break;
        x0 = nx0;
        x1 = nx1;
        y2++;
      }
      const width = x1 - x0 + 1;
      const height = y2 - y;
      const offset = (y * this.texW + x0) * 4;
      if (rowLength) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.data, offset);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, this.texW, height, gl.RGBA, gl.UNSIGNED_BYTE, this.data, y * this.texW * 4);
      }
      y = y2;
    }
    if (rowLength) gl.pixelStorei(gl2.UNPACK_ROW_LENGTH, 0);
    this.rowDirty.fill(0);
    this.rowCount = 0;
  }

  private paintAll(): void {
    this.bbOn.fill(0);
    const n = this.gridW * this.gridH;
    for (let i = 0; i < n; i++) {
      const cx = i % this.gridW;
      const cy = (i / this.gridW) | 0;
      const o = this.drawOwner[i]!;
      if (o) this.grow(o, cx, cy);
      this.paintCell(cx, cy, true);
    }
    this.dirtyN = 0;
    this.dirtyOn.fill(0);
    this.rowDirty.fill(0);
    this.rowCount = 0;
    for (let id = 1; id < MAX_OWNERS; id++) {
      if (this.bbOn[id]) this.rebuild(id);
    }
  }

  private paintIndex(i: number, prevDraw: number): void {
    const cx = i % this.gridW;
    const cy = (i / this.gridW) | 0;
    this.paintCell(cx, cy, true);
    const shown = this.shownOwner(cx, cy);
    this.grow(prevDraw, cx, cy);
    this.grow(shown, cx, cy);
    this.schedule(prevDraw);
    this.schedule(shown);
  }

  private grow(id: number, cx: number, cy: number): void {
    if (id <= 0 || id >= MAX_OWNERS || cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return;
    if (!this.bbOn[id]) {
      this.bbOn[id] = 1;
      this.bbMinX[id] = cx;
      this.bbMaxX[id] = cx;
      this.bbMinY[id] = cy;
      this.bbMaxY[id] = cy;
      return;
    }
    if (cx < this.bbMinX[id]!) this.bbMinX[id] = cx;
    if (cx > this.bbMaxX[id]!) this.bbMaxX[id] = cx;
    if (cy < this.bbMinY[id]!) this.bbMinY[id] = cy;
    if (cy > this.bbMaxY[id]!) this.bbMaxY[id] = cy;
  }

  private schedule(id: number): void {
    if (id <= 0 || id >= MAX_OWNERS) return;
    if (!this.dirtyOn[id]) this.due[id] = this.now;
    this.markOwner(id);
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
    const fadeByte = this.fade[i] ?? 0;
    const owner = fadeByte > 0 ? this.fadeOwner[i]! : this.drawOwner[i]!;
    const rgb = this.rgb(owner, cx, cy);
    const y0 = (this.gridH - 1 - cy) * S;
    const x0 = cx * S;
    const fade = owner ? rgb.fade : 0;
    const a = owner ? Math.round(Math.max(0, Math.min(1, fade)) * 255) : 0;
    const r = a ? Math.round(rgb.r) : 0;
    const g = a ? Math.round(rgb.g) : 0;
    const b = a ? Math.round(rgb.b) : 0;
    for (let py = 0; py < S; py++) {
      const row = (y0 + py) * this.texW;
      for (let px = 0; px < S; px++) {
        const p = (row + x0 + px) * 4;
        this.data[p] = r;
        this.data[p + 1] = g;
        this.data[p + 2] = b;
        if (writeAlpha) this.data[p + 3] = a;
      }
      this.markSpan(y0 + py, x0, x0 + S - 1);
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

  private markSpan(row: number, x0: number, x1: number): void {
    if (row < 0 || row >= this.texH) return;
    const a = Math.max(0, x0);
    const b = Math.min(this.texW - 1, x1);
    if (!this.rowDirty[row]) {
      this.rowDirty[row] = 1;
      this.rowX0[row] = a;
      this.rowX1[row] = b;
      this.rowCount++;
      return;
    }
    if (a < this.rowX0[row]!) this.rowX0[row] = a;
    if (b > this.rowX1[row]!) this.rowX1[row] = b;
  }

  /**
   * Smooth due owners before the upload. A fresh claim (stored trail) goes
   * first so the painted edge is the curve on the same frame the cells arrive.
   */
  private flushEdges(): void {
    if (this.dirtyN === 0) return;
    let budget = 2;
    for (let pass = 0; pass < 2 && budget > 0; pass++) {
      for (let k = 0; k < this.dirtyN && budget > 0; k++) {
        const owner = this.dirtyIds[k]!;
        if (!this.dirtyOn[owner]) continue;
        const loop = this.loopN[owner]! >= 2;
        if ((pass === 0) !== loop) continue;
        if (this.ownerPending(owner) || this.now < this.due[owner]!) continue;
        this.rebuild(owner);
        this.dirtyOn[owner] = 0;
        budget--;
      }
    }
    let w = 0;
    for (let k = 0; k < this.dirtyN; k++) {
      const owner = this.dirtyIds[k]!;
      if (!this.dirtyOn[owner]) continue;
      this.dirtyIds[w++] = owner;
    }
    this.dirtyN = w;
  }

  private ownerPending(owner: number): boolean {
    for (let k = 0; k < this.qN; k++) {
      const i = this.qIdx[k]!;
      if (this.owner[i] === owner) return true;
    }
    return false;
  }

  private rebuild(owner: number): void {
    const edges = this.traceLoops(owner);
    this.undoRamp(owner);
    if (edges === 0) {
      this.touchLen[owner] = 0;
      this.bbOn[owner] = 0;
      return;
    }
    this.writeLoops(owner, this.loopN[owner]! >= 2);
    this.saveTouches(owner);
  }

  /** Put the previous coverage band back to solid cells so a moved curve cannot ghost. */
  private undoRamp(owner: number): void {
    if (this.touchLen[owner] === -1) {
      this.repaintBox(owner);
      return;
    }
    const n = this.touchLen[owner]!;
    const base = owner * TOUCH_N;
    for (let k = 0; k < n; k++) {
      const idx = this.touchAt[base + k]!;
      const tx = idx % this.texW;
      const ty = (idx / this.texW) | 0;
      const sim = this.simOf(tx, ty);
      const cx = Math.floor(sim.x);
      const cy = Math.floor(sim.y);
      const cell = this.shownOwner(cx, cy);
      if (cell !== owner && cell !== 0) continue;
      const rgb = this.rgb(cell === owner ? owner : 0, cx, cy);
      const fade = cell === owner ? rgb.fade : 0;
      const a = cell === owner ? Math.round(Math.max(0, Math.min(1, fade)) * 255) : 0;
      const p = idx * 4;
      this.data[p] = a ? Math.round(rgb.r) : 0;
      this.data[p + 1] = a ? Math.round(rgb.g) : 0;
      this.data[p + 2] = a ? Math.round(rgb.b) : 0;
      this.data[p + 3] = a;
      this.markSpan(ty, tx, tx);
    }
  }

  private saveTouches(owner: number): void {
    if (this.touchN > TOUCH_N) {
      this.touchLen[owner] = -1;
      return;
    }
    const base = owner * TOUCH_N;
    for (let k = 0; k < this.touchN; k++) this.touchAt[base + k] = this.touch[k]!;
    this.touchLen[owner] = this.touchN;
  }

  /** Overflow path: the saved band was truncated, so repaint the owner's box solid. */
  private repaintBox(owner: number): void {
    if (!this.bbOn[owner]) return;
    const pad = 2;
    const x0 = Math.max(0, this.bbMinX[owner]! - pad);
    const y0 = Math.max(0, this.bbMinY[owner]! - pad);
    const x1 = Math.min(this.gridW - 1, this.bbMaxX[owner]! + pad);
    const y1 = Math.min(this.gridH - 1, this.bbMaxY[owner]! + pad);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.shownOwner(cx, cy);
        if (cell === owner || cell === 0) this.paintCell(cx, cy, true);
      }
    }
  }

  /**
   * Walk every boundary loop. Spawn squares stay on the cell grid. A claim
   * with a stored trail is snapped onto that curve and relaxed so the stair
   * corners move onto the path, then the whole band is re-rasterized.
   */
  private writeLoops(owner: number, useLoop: boolean): void {
    this.sid++;
    if (this.sid === 65535) {
      this.sdStamp.fill(0);
      this.sid = 1;
    }
    this.touchN = 0;
    const stride = this.gridH + 1;
    for (let e = 0; e < this.edgeCount; e++) this.eSeen[e] = 0;
    for (let start = 0; start < this.edgeCount; start++) {
      if (this.eSeen[start]) continue;
      let count = this.collectLoop(start, stride);
      if (count < 4) continue;
      if (useLoop) count = this.snapLoop(owner, count);
      if (count < 4) continue;
      if (count > 1400) count = this.decimate(count, 1400);
      count = this.relax(count, useLoop ? 12 : 0);
      this.accumulate(count);
    }
    this.commitRaster(owner);
  }

  /**
   * Pull corners toward their neighbors. Movement stays within half a cell of
   * the snapped trail so the painted edge and the owned cells do not diverge.
   */
  private relax(n: number, times: number): number {
    if (times <= 0 || n < 4) return n;
    for (let i = 0; i < n; i++) {
      this.ox[i] = this.ax[i]!;
      this.oy[i] = this.ay[i]!;
    }
    const keep = 0.62;
    const share = (1 - keep) / 2;
    const cap = 0.2;
    for (let t = 0; t < times; t++) {
      for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        const q = (i + 1) % n;
        let x = this.ax[i]! * keep + (this.ax[p]! + this.ax[q]!) * share;
        let y = this.ay[i]! * keep + (this.ay[p]! + this.ay[q]!) * share;
        const dx = x - this.ox[i]!;
        const dy = y - this.oy[i]!;
        const d = Math.hypot(dx, dy);
        if (d > cap) {
          x = this.ox[i]! + (dx / d) * cap;
          y = this.oy[i]! + (dy / d) * cap;
        }
        this.bx[i] = x;
        this.by[i] = y;
      }
      for (let i = 0; i < n; i++) {
        this.ax[i] = this.bx[i]!;
        this.ay[i] = this.by[i]!;
      }
    }
    return n;
  }

  /** Nearest-edge distance. Positive is inside a counter-clockwise loop. */
  private signedDist(x: number, y: number, n: number): number {
    let best = 1e9;
    let sign = 1;
    for (let i = 0; i < n; i++) {
      const ax = this.ax[i]!;
      const ay = this.ay[i]!;
      const bx = this.ax[(i + 1) % n]!;
      const by = this.ay[(i + 1) % n]!;
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      let t = 0;
      if (len2 > 1e-8) t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
      const cx = ax + vx * t;
      const cy = ay + vy * t;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < best) {
        best = dist;
        const cross = vx * (y - ay) - vy * (x - ax);
        sign = cross >= 0 ? 1 : -1;
      }
    }
    return sign * best;
  }

  private accumulate(n: number): void {
    if (n < 4) return;
    let minX = 1e9;
    let maxX = -1e9;
    let minY = 1e9;
    let maxY = -1e9;
    for (let i = 0; i < n; i++) {
      const x = this.ax[i]!;
      const y = this.ay[i]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const t0 = this.texOf(minX - BAND, maxY + BAND);
    const t1 = this.texOf(maxX + BAND, minY - BAND);
    const x0 = Math.max(0, Math.floor(Math.min(t0.tx, t1.tx)));
    const x1 = Math.min(this.texW - 1, Math.ceil(Math.max(t0.tx, t1.tx)));
    const y0 = Math.max(0, Math.floor(Math.min(t0.ty, t1.ty)));
    const y1 = Math.min(this.texH - 1, Math.ceil(Math.max(t0.ty, t1.ty)));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const sim = this.simOf(tx, ty);
        const signed = this.signedDist(sim.x, sim.y, n);
        if (Math.abs(signed) > BAND) continue;
        const idx = ty * this.texW + tx;
        const prev = this.sdStamp[idx] === this.sid ? Math.abs(this.sd[idx]!) : Infinity;
        if (Math.abs(signed) < prev) {
          if (this.sdStamp[idx] !== this.sid && this.touchN < this.touch.length) this.touch[this.touchN++] = idx;
          this.sdStamp[idx] = this.sid;
          this.sd[idx] = signed;
        }
      }
    }
  }

  private edgeCount = 0;

  private traceLoops(owner: number): number {
    for (let i = 0; i < this.eUsedN; i++) this.eHead[this.eUsed[i]!] = -1;
    this.eUsedN = 0;
    this.edgeCount = 0;
    const w = this.gridW;
    const h = this.gridH;
    const stride = h + 1;
    const x0 = this.bbOn[owner] ? Math.max(0, this.bbMinX[owner]! - 1) : 0;
    const y0 = this.bbOn[owner] ? Math.max(0, this.bbMinY[owner]! - 1) : 0;
    const x1 = this.bbOn[owner] ? Math.min(w - 1, this.bbMaxX[owner]! + 1) : w - 1;
    const y1 = this.bbOn[owner] ? Math.min(h - 1, this.bbMaxY[owner]! + 1) : h - 1;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
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
      let best = 0.85;
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
      if (best < 0.85) {
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

  /**
   * Paint only the smoothed contour. Texels outside it are cleared even when
   * the cell is still owned, so the stair of raw cells cannot show past the
   * curve. The darker rim is the outer texel row, continuous, on that edge.
   * Alpha is 0 or 255 so the test cannot punch a dashed line.
   */
  private commitRaster(owner: number): void {
    for (let k = 0; k < this.touchN; k++) {
      const idx = this.touch[k]!;
      if (this.sdStamp[idx] !== this.sid) continue;
      const signed = this.sd[idx]!;
      const tx = idx % this.texW;
      const ty = (idx / this.texW) | 0;
      const sim = this.simOf(tx, ty);
      const cx = Math.floor(sim.x);
      const cy = Math.floor(sim.y);
      const cell = this.shownOwner(cx, cy);
      if (cell > 0 && cell !== owner) continue;
      const p = idx * 4;
      if (signed < -SKIRT) {
        this.data[p] = 0;
        this.data[p + 1] = 0;
        this.data[p + 2] = 0;
        this.data[p + 3] = 0;
        this.markSpan(ty, tx, tx);
        continue;
      }
      const rgb = this.rgb(owner, cx, cy);
      const shade = signed < RIM ? 0.62 : 1;
      this.data[p] = Math.round(rgb.r * shade);
      this.data[p + 1] = Math.round(rgb.g * shade);
      this.data[p + 2] = Math.round(rgb.b * shade);
      this.data[p + 3] = 255;
      this.markSpan(ty, tx, tx);
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
