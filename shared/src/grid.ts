/** Territory + trail grid. Flood fill claims the interior of a closed trail. */

export class Grid {
  readonly w: number;
  readonly h: number;
  readonly owner: Uint8Array;
  readonly trail: Uint8Array;
  readonly landCount: Int32Array;
  readonly sumX: Float64Array;
  readonly sumY: Float64Array;
  /** 1 = reachable from the border without crossing the claimer's land or trail. */
  readonly visited: Uint8Array;
  readonly changed: Int32Array;
  changedCount = 0;

  private readonly queue: Int32Array;
  private readonly stamp: Uint16Array;
  private changeStamp = 1;

  constructor(w: number, h: number, maxPlayers: number) {
    const n = w * h;
    this.w = w;
    this.h = h;
    this.owner = new Uint8Array(n);
    this.trail = new Uint8Array(n);
    this.landCount = new Int32Array(maxPlayers + 1);
    this.sumX = new Float64Array(maxPlayers + 1);
    this.sumY = new Float64Array(maxPlayers + 1);
    this.visited = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.stamp = new Uint16Array(n);
    this.changed = new Int32Array(n);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  beginTick(): void {
    this.changedCount = 0;
    this.changeStamp++;
    if (this.changeStamp >= 65535) {
      this.stamp.fill(0);
      this.changeStamp = 1;
    }
  }

  private mark(i: number): void {
    if (this.stamp[i] !== this.changeStamp) {
      this.stamp[i] = this.changeStamp;
      this.changed[this.changedCount++] = i;
    }
  }

  setOwner(i: number, id: number): void {
    const prev = this.owner[i];
    if (prev === id) return;
    const x = (i % this.w) + 0.5;
    const y = ((i / this.w) | 0) + 0.5;
    if (prev) {
      this.landCount[prev]--;
      this.sumX[prev] -= x;
      this.sumY[prev] -= y;
    }
    if (id) {
      this.landCount[id]++;
      this.sumX[id] += x;
      this.sumY[id] += y;
    }
    this.owner[i] = id;
    this.mark(i);
  }

  setTrail(i: number, id: number): void {
    if (this.trail[i] === id) return;
    this.trail[i] = id;
    this.mark(i);
  }

  clearPlayer(id: number): void {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      if (this.owner[i] === id) this.setOwner(i, 0);
      if (this.trail[i] === id) this.setTrail(i, 0);
    }
    this.landCount[id] = 0;
    this.sumX[id] = 0;
    this.sumY[id] = 0;
  }

  fillRect(id: number, x0: number, y0: number, rw: number, rh: number): void {
    const x1 = Math.min(this.w, x0 + rw);
    const y1 = Math.min(this.h, y0 + rh);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) this.setOwner(this.idx(x, y), id);
    }
  }

  /**
   * Mark every cell reachable from the map border without crossing `playerId`'s
   * owned land or trail. Unvisited cells are the loop interior plus that land.
   */
  floodOutside(playerId: number): void {
    const { w, h, owner, trail, visited, queue } = this;
    visited.fill(0);
    let qt = 0;
    let qh = 0;
    const push = (i: number) => {
      if (visited[i]) return;
      if (owner[i] === playerId || trail[i] === playerId) return;
      visited[i] = 1;
      queue[qt++] = i;
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      push(y * w);
      push(y * w + (w - 1));
    }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) push(i - 1);
      if (x + 1 < w) push(i + 1);
      if (y > 0) push(i - w);
      if (y + 1 < h) push(i + w);
    }
  }

  /**
   * After `floodOutside`, take every unvisited cell that isn't already ours,
   * plus our trail. Enemy trails on old land are left alone.
   */
  applyClaim(playerId: number): number {
    const { owner, trail, visited } = this;
    const n = this.w * this.h;
    let claimed = 0;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const wasOwner = owner[i];
      const wasTrail = trail[i];
      if (wasOwner !== playerId) {
        this.setOwner(i, playerId);
        claimed++;
      }
      if (wasTrail === playerId) this.setTrail(i, 0);
      else if (wasTrail !== 0 && wasOwner !== playerId) this.setTrail(i, 0);
    }
    return claimed;
  }

  /** True when a head or trail cell sits in the newly enclosed region (not on our old land). */
  inNewRegion(i: number, playerId: number): boolean {
    return this.visited[i] === 0 && this.owner[i] !== playerId;
  }
}

/** Flat RLE: [startIndex, owner, trail, length, ...] over the cells dirtied this tick. */
export function encodeCellRuns(grid: Grid): number[] {
  const n = grid.changedCount;
  if (n === 0) return [];
  const idx = grid.changed.subarray(0, n);
  idx.sort();
  const out: number[] = [];
  let runStart = idx[0]!;
  let runLen = 1;
  let o = grid.owner[runStart]!;
  let tr = grid.trail[runStart]!;
  for (let k = 1; k < n; k++) {
    const i = idx[k]!;
    if (i === runStart + runLen && grid.owner[i] === o && grid.trail[i] === tr) {
      runLen++;
    } else {
      out.push(runStart, o, tr, runLen);
      runStart = i;
      runLen = 1;
      o = grid.owner[i]!;
      tr = grid.trail[i]!;
    }
  }
  out.push(runStart, o, tr, runLen);
  return out;
}
