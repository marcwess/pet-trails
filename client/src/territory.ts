import { cloneMulti, LandBook, multiArea, multiContains, type MultiPolygon } from '@pet-trails/shared';

const MAX_ID = 16;

/**
 * Client copy of each owner's polygon. Meshes rebuild from `consumeDirty`.
 * There is no territory texture, so joining does not upload a full-grid image.
 */
export class Territory {
  readonly gridW: number;
  readonly gridH: number;
  snapshotUploads = 0;
  claimPulse = 0;
  claimId = 0;
  claimX0 = 0;
  claimY0 = 0;
  claimX1 = 0;
  claimY1 = 0;
  private readonly polys: MultiPolygon[];
  private readonly area: Float64Array;
  private readonly dirty = new Set<number>();
  private readonly scratch: LandBook;

  constructor(gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.polys = [];
    for (let i = 0; i <= MAX_ID; i++) this.polys.push([]);
    this.area = new Float64Array(MAX_ID + 1);
    this.scratch = new LandBook(MAX_ID, gridW, gridH);
  }

  update(dt: number): void {
    if (this.claimPulse > 0) this.claimPulse = Math.max(0, this.claimPulse - dt / 0.55);
  }

  /** Authoritative polygons, already simplified. Cloned so the sim can keep mutating. */
  adopt(book: LandBook, ids: ArrayLike<number>): void {
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      if (id < 1 || id > MAX_ID) continue;
      this.polys[id] = cloneMulti(book.get(id));
      this.afterWrite(id);
    }
  }

  /** Quantized patch from the server. */
  applyEncoded(data: ArrayLike<number>): void {
    if (data.length === 0) return;
    this.scratch.beginTick();
    this.scratch.applyEncoded(data);
    this.adopt(this.scratch, this.scratch.changedIds());
  }

  consumeDirty(): number[] {
    const ids = [...this.dirty];
    this.dirty.clear();
    return ids;
  }

  polygon(id: number): MultiPolygon {
    return this.polys[id] ?? [];
  }

  contains(id: number, x: number, y: number): boolean {
    const mp = this.polys[id];
    return !!mp && mp.length > 0 && multiContains(mp, x, y);
  }

  coveredByOther(id: number, x: number, y: number): boolean {
    for (let o = 1; o <= MAX_ID; o++) {
      if (o === id) continue;
      const mp = this.polys[o]!;
      if (mp.length > 0 && multiContains(mp, x, y)) return true;
    }
    return false;
  }

  vertexCount(): number {
    let n = 0;
    for (let id = 1; id <= MAX_ID; id++) {
      for (const poly of this.polys[id]!) {
        for (const ring of poly) n += Math.max(0, ring.length - 1);
      }
    }
    return n;
  }

  ownerBounds(id: number): { x0: number; y0: number; x1: number; y1: number; w: number; h: number; cells: number } | null {
    const mp = this.polys[id];
    if (!mp || mp.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of mp) {
      for (const ring of poly) {
        for (const p of ring) {
          if (p[0] < minX) minX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] > maxY) maxY = p[1];
        }
      }
    }
    if (!Number.isFinite(minX)) return null;
    const x0 = Math.floor(minX);
    const y0 = Math.floor(minY);
    const x1 = Math.ceil(maxX) - 1;
    const y1 = Math.ceil(maxY) - 1;
    return {
      x0,
      y0,
      x1,
      y1,
      w: Math.max(1, x1 - x0 + 1),
      h: Math.max(1, y1 - y0 + 1),
      cells: Math.round(this.area[id] ?? 0),
    };
  }

  private afterWrite(id: number): void {
    const next = multiArea(this.polys[id]!);
    const prev = this.area[id] ?? 0;
    this.area[id] = next;
    this.dirty.add(id);
    if (next > prev + 8) {
      const box = this.ownerBounds(id);
      if (box) {
        this.claimX0 = box.x0;
        this.claimY0 = box.y0;
        this.claimX1 = box.x1;
        this.claimY1 = box.y1;
        this.claimId = id;
        this.claimPulse = 1;
      }
    }
  }
}
