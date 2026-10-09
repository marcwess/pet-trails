import type { WebGLRenderer } from 'three';

export interface PerfStats {
  fps: number;
  frameMs: number;
  draws: number;
  entities: number;
  ping: number;
  texSub: number;
  texFull: number;
  texPixels: number;
  frameTexSub: number;
  frameTexFull: number;
  frameTexPixels: number;
}

/**
 * `?perf=1` overlay plus a WebGL hook so we can prove territory updates are
 * row-sized texSubImage2D calls, not a full-grid reupload every frame.
 */
export class Perf {
  readonly enabled: boolean;
  readonly stats: PerfStats = {
    fps: 0,
    frameMs: 0,
    draws: 0,
    entities: 0,
    ping: 0,
    texSub: 0,
    texFull: 0,
    texPixels: 0,
    frameTexSub: 0,
    frameTexFull: 0,
    frameTexPixels: 0,
  };
  private frames = 0;
  private acc = 0;
  private last = 0;
  private el: HTMLElement | null = null;
  private hooked = false;
  territoryH = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) return;
    this.el = document.getElementById('perf');
    if (this.el) this.el.hidden = false;
  }

  hook(renderer: WebGLRenderer): void {
    if (this.hooked) return;
    this.hooked = true;
    const gl = renderer.getContext();
    const sub = gl.texSubImage2D.bind(gl);
    const img = gl.texImage2D.bind(gl);
    const self = this;
    gl.texSubImage2D = function (this: WebGLRenderingContext, ...args: unknown[]) {
      self.noteSub(args);
      return (sub as (...a: unknown[]) => void).apply(gl, args);
    } as typeof gl.texSubImage2D;
    gl.texImage2D = function (this: WebGLRenderingContext, ...args: unknown[]) {
      self.noteImage(args);
      return (img as (...a: unknown[]) => void).apply(gl, args);
    } as typeof gl.texImage2D;
  }

  /** texSubImage2D(target, level, x, y, width, height, format, type, pixels, offset?) */
  private noteSub(args: unknown[]): void {
    const width = typeof args[4] === 'number' ? args[4] : 0;
    const height = typeof args[5] === 'number' ? args[5] : 0;
    const pixels = width * height;
    this.stats.texSub++;
    this.stats.texPixels += pixels;
    this.stats.frameTexSub++;
    this.stats.frameTexPixels += pixels;
    if (this.territoryH > 0 && height >= this.territoryH) {
      this.stats.texFull++;
      this.stats.frameTexFull++;
    }
  }

  private noteImage(args: unknown[]): void {
    const width = typeof args[3] === 'number' ? args[3] : 0;
    const height = typeof args[4] === 'number' ? args[4] : 0;
    if (this.territoryH > 0 && height >= this.territoryH && width > 64) {
      this.stats.texFull++;
      this.stats.frameTexFull++;
      this.stats.texPixels += width * height;
      this.stats.frameTexPixels += width * height;
    }
  }

  beginFrame(): void {
    this.stats.frameTexSub = 0;
    this.stats.frameTexFull = 0;
    this.stats.frameTexPixels = 0;
  }

  endFrame(now: number, draws: number, entities: number): void {
    if (!this.enabled) return;
    const dt = this.last ? now - this.last : 16;
    this.last = now;
    this.frames++;
    this.acc += dt;
    this.stats.frameMs = this.stats.frameMs * 0.85 + dt * 0.15;
    this.stats.draws = draws;
    this.stats.entities = entities;
    if (this.acc >= 400 && this.el) {
      this.stats.fps = (this.frames * 1000) / this.acc;
      this.frames = 0;
      this.acc = 0;
      const s = this.stats;
      this.el.textContent =
        `fps ${s.fps.toFixed(0)}\n` +
        `ms ${s.frameMs.toFixed(1)}\n` +
        `draws ${s.draws}\n` +
        `ents ${s.entities}\n` +
        `ping ${s.ping | 0}\n` +
        `tex ${s.frameTexSub} sub / ${s.frameTexPixels | 0}px\n` +
        `full ${s.texFull}`;
    }
  }
}
