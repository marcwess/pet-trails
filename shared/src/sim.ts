import { updateBot, type BotView } from './bots.js';
import { BOT_NAMES, CONFIG, SPECIES, makeConfig, type GameConfig } from './config.js';
import { encodeCellRuns, Grid } from './grid.js';
import { integrateBody } from './motion.js';
import { Player, type DeathReason } from './player.js';
import { mulberry32, rngInt } from './rng.js';
import type { SimEvent, SimStats } from './types.js';

interface Pickup {
  id: number;
  kind: number;
  x: number;
  y: number;
  active: boolean;
}

const PICKUP_POOL = 72;

/**
 * Authoritative paper.io-style simulation. One instance runs on the server,
 * the same class runs offline in the browser. No per-tick allocations on the
 * hot path besides the event objects the server is about to serialize.
 */
export class Sim {
  readonly cfg: GameConfig;
  readonly grid: Grid;
  readonly players: Array<Player | null>;
  readonly roster: Player[];
  readonly tickDt: number;
  tick = 0;
  readonly stats: SimStats = { kills: 0, claims: 0, deaths: 0, claimedCells: 0 };
  events: SimEvent[] = [];

  private readonly rng: () => number;
  private readonly pickups: Pickup[];
  private pickupSeq = 1;
  private nameSeq = 0;
  private readonly usedNames = new Set<string>();
  private readonly freeNames: string[] = [];
  private readonly aliveBuf: Player[] = [];
  private botView: BotView;
  /** Scratch for claim-edge trim. Not used on the per-tick path. */
  private readonly fringe: Int32Array;
  private fringeN = 0;
  private readonly fringeMark: Uint8Array;
  private fringeStamp = 1;

  constructor(over: Partial<GameConfig> = {}, seed = 1) {
    this.cfg = makeConfig(over);
    const maxTrail = this.cfg.gridW * this.cfg.gridH;
    this.grid = new Grid(this.cfg.gridW, this.cfg.gridH, this.cfg.maxEntities);
    this.players = new Array(this.cfg.maxEntities + 1).fill(null);
    this.roster = [];
    for (let id = 1; id <= this.cfg.maxEntities; id++) {
      const p = new Player(id, maxTrail, this.cfg.maxTrainStored);
      this.roster.push(p);
      this.players[id] = p;
    }
    this.tickDt = 1 / this.cfg.tickHz;
    this.rng = mulberry32(seed >>> 0);
    this.pickups = [];
    for (let i = 0; i < PICKUP_POOL; i++) {
      this.pickups.push({ id: i + 1, kind: 0, x: 0, y: 0, active: false });
    }
    this.botView = {
      tick: 0,
      cfg: this.cfg,
      grid: this.grid,
      players: this.players,
      rng: this.rng,
      dt: this.tickDt,
    };
    const cells = this.cfg.gridW * this.cfg.gridH;
    this.fringe = new Int32Array(cells);
    this.fringeMark = new Uint8Array(cells);
  }

  addHuman(name: string, pet: number): Player | null {
    const p = this.alloc();
    if (!p) return null;
    p.bot = false;
    p.name = name || 'You';
    p.pet = this.clampPet(pet);
    this.spawn(p);
    this.events.push({ e: 'spawn', id: p.id, name: p.name, pet: p.pet, bot: false });
    return p;
  }

  addBot(): Player | null {
    const p = this.alloc();
    if (!p) return null;
    p.bot = true;
    p.name = this.takeBotName();
    p.pet = rngInt(this.rng, SPECIES.length);
    p.botStyle = p.id % 2;
    p.botTurnSign = this.rng() < 0.5 ? -1 : 1;
    this.spawn(p);
    this.events.push({ e: 'spawn', id: p.id, name: p.name, pet: p.pet, bot: true });
    return p;
  }

  remove(id: number): void {
    const p = this.players[id];
    if (!p || !p.active) return;
    if (p.alive) this.grid.clearPlayer(id);
    if (p.bot) this.releaseBotName(p.name);
    p.alive = false;
    p.active = false;
    p.trailLen = 0;
    p.land = 0;
    this.events.push({ e: 'leave', id });
  }

  private takeBotName(): string {
    while (this.freeNames.length > 0) {
      const reused = this.freeNames.pop()!;
      if (!this.usedNames.has(reused)) {
        this.usedNames.add(reused);
        return reused;
      }
    }
    for (let i = 0; i < BOT_NAMES.length; i++) {
      const name = BOT_NAMES[(this.nameSeq + i) % BOT_NAMES.length]!;
      if (this.usedNames.has(name)) continue;
      this.nameSeq = (this.nameSeq + i + 1) % BOT_NAMES.length;
      this.usedNames.add(name);
      return name;
    }
    const fallback = BOT_NAMES[this.nameSeq % BOT_NAMES.length]!;
    this.nameSeq++;
    return fallback;
  }

  private releaseBotName(name: string): void {
    if (!name || !this.usedNames.delete(name)) return;
    this.freeNames.push(name);
  }

  respawn(id: number): void {
    const p = this.players[id];
    if (!p || !p.active) return;
    if (p.alive) this.grid.clearPlayer(id);
    this.spawn(p);
    this.events.push({ e: 'spawn', id: p.id, name: p.name, pet: p.pet, bot: p.bot });
  }

  setInput(id: number, x: number, y: number, seq: number): void {
    const p = this.players[id];
    if (!p || !p.active || !p.alive) return;
    const mag = Math.hypot(x, y);
    if (mag > 0.15) {
      p.desiredX = x / mag;
      p.desiredY = y / mag;
    }
    if (seq > p.lastSeq) p.lastSeq = seq;
  }

  maintainBots(humanCount: number): void {
    const want = Math.max(0, Math.min(this.cfg.targetPopulation - humanCount, this.cfg.maxEntities - humanCount));
    let bots = 0;
    for (const p of this.roster) if (p.active && p.bot) bots++;
    while (bots > want) {
      const victim = this.pickBotToRemove();
      if (!victim) break;
      this.remove(victim.id);
      bots--;
    }
    while (bots < want) {
      if (!this.addBot()) break;
      bots++;
    }
  }

  step(opts?: { humans?: number }): void {
    this.tick++;
    this.grid.beginTick();
    if (opts && opts.humans !== undefined) this.maintainBots(opts.humans);
    this.botView.tick = this.tick;
    const dt = this.tickDt;

    for (const p of this.roster) {
      if (!p.active || !p.alive || !p.bot) continue;
      updateBot(p, this.botView);
    }

    for (const p of this.roster) {
      if (!p.active || !p.alive || p.frozen) continue;
      p.aliveMs += dt * 1000;
      integrateBody(p, dt, this.cfg, (cx, cy) => this.enterCell(p, cx, cy));
    }

    this.resolveHeadOns();
    this.collectPickups();
    this.spawnPickups();
    this.respawnBots();

    for (const p of this.roster) {
      if (!p.active) continue;
      p.land = this.grid.landCount[p.id] ?? 0;
    }
  }

  consumeEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  cellRuns(): number[] {
    return encodeCellRuns(this.grid);
  }

  activePickups(): Pickup[] {
    return this.pickups.filter((p) => p.active);
  }

  forEachActivePickup(fn: (id: number, kind: number, x: number, y: number) => void): void {
    for (const item of this.pickups) {
      if (item.active) fn(item.id, item.kind, item.x, item.y);
    }
  }

  /** Test helper: wipe the grid and stamp a rectangle of land. Does not move the player. */
  debugGiveRect(id: number, x: number, y: number, w: number, h: number): void {
    this.grid.fillRect(id, x, y, w, h);
    const p = this.players[id];
    if (p) p.land = this.grid.landCount[id] ?? 0;
  }

  debugPlace(id: number, x: number, y: number, heading = 0): void {
    const p = this.players[id];
    if (!p) return;
    p.x = x;
    p.y = y;
    p.heading = heading;
    p.desiredX = Math.cos(heading);
    p.desiredY = Math.sin(heading);
    p.invulnUntil = 0;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    p.outside = this.grid.owner[this.grid.idx(cx, cy)] !== id;
  }

  debugSetTrail(id: number, cells: number[]): void {
    const p = this.players[id];
    if (!p) return;
    p.trailLen = 0;
    for (const i of cells) {
      this.grid.setTrail(i, id);
      p.trail[p.trailLen++] = i;
    }
    p.outside = true;
  }

  /** Run the claim as if `id` just stepped back onto their land. */
  debugClaim(id: number): number {
    const p = this.players[id];
    if (!p) return 0;
    const before = this.grid.landCount[id] ?? 0;
    this.finishClaim(p);
    p.land = this.grid.landCount[id] ?? 0;
    return p.land - before;
  }

  auditLand(): boolean {
    const counts = new Int32Array(this.cfg.maxEntities + 1);
    const n = this.grid.w * this.grid.h;
    for (let i = 0; i < n; i++) counts[this.grid.owner[i]!]!++;
    for (let id = 1; id <= this.cfg.maxEntities; id++) {
      if ((counts[id] ?? 0) !== (this.grid.landCount[id] ?? 0)) return false;
    }
    return true;
  }

  private alloc(): Player | null {
    for (const p of this.roster) {
      if (!p.active) {
        p.active = true;
        p.resetRun();
        return p;
      }
    }
    return null;
  }

  private clampPet(pet: number): number {
    if (!Number.isFinite(pet) || pet < 0 || pet >= SPECIES.length) return rngInt(this.rng, SPECIES.length);
    return pet | 0;
  }

  private spawn(p: Player): void {
    if (p.alive) this.grid.clearPlayer(p.id);
    p.resetRun();
    const spot = this.findSpawn(p.bot);
    const size = this.cfg.spawnSize;
    this.grid.fillRect(p.id, spot.x, spot.y, size, size);
    p.x = spot.x + size / 2;
    p.y = spot.y + size / 2;
    const { gridW: w, gridH: h } = this.cfg;
    let ang = this.rng() * Math.PI * 2;
    if (p.bot) {
      const rx = p.x - w / 2;
      const ry = p.y - h / 2;
      if (rx * rx + ry * ry > 16) ang = Math.atan2(rx, -ry) + (this.rng() - 0.5) * 0.5;
    }
    const reach = 36;
    const nx = p.x + Math.cos(ang) * reach;
    const ny = p.y + Math.sin(ang) * reach;
    if (nx < 22 || ny < 22 || nx > w - 22 || ny > h - 22) {
      ang = Math.atan2(h / 2 - p.y, w / 2 - p.x) + (this.rng() - 0.5) * 0.9;
    }
    p.heading = ang;
    p.desiredX = Math.cos(p.heading);
    p.desiredY = Math.sin(p.heading);
    p.alive = true;
    p.outside = false;
    p.land = this.grid.landCount[p.id] ?? 0;
    p.respawnTick = 0;
    p.invulnUntil = this.tick + Math.round(this.cfg.tickHz * 2);
    p.botPhase = 0;
    p.botMoved = 0;
    p.botTurns = 0;
    p.botTurnSign = this.rng() < 0.5 ? -1 : 1;
    p.botNextThink = this.tick + rngInt(this.rng, 6);
  }

  private livingAnchor(human: boolean): { x: number; y: number } | null {
    for (const o of this.roster) {
      if (!o.active || !o.alive) continue;
      if (human ? !o.bot : o.bot) return { x: o.x, y: o.y };
    }
    return null;
  }

  /**
   * Pick a spawn square that keeps a gap from existing land and from every
   * living head. The last resort still refuses to overlap land.
   */
  private findSpawn(bot: boolean): { x: number; y: number } {
    const size = this.cfg.spawnSize;
    const { gridW: w, gridH: h } = this.cfg;
    const margin = Math.min(8, Math.max(1, Math.floor((Math.min(w, h) - size) / 4)));
    const anchor = this.livingAnchor(true) ?? this.livingAnchor(false) ?? { x: w / 2, y: h / 2 };
    const want = bot ? 50 : 0;
    for (const gap of [14, 8, 4, 1]) {
      const spot = this.bestSpawn(size, margin, gap, anchor.x, anchor.y, want, size + gap);
      if (spot) return spot;
    }
    const spot = this.bestSpawn(size, margin, 0, anchor.x, anchor.y, want, 1);
    if (spot) return spot;
    return { x: margin, y: margin };
  }

  private bestSpawn(
    size: number,
    margin: number,
    gap: number,
    ax: number,
    ay: number,
    wantDist: number,
    headMin: number,
  ): { x: number; y: number } | null {
    const { gridW: w, gridH: h } = this.cfg;
    const step = Math.max(4, Math.floor(size / 3));
    let bestX = 0;
    let bestY = 0;
    let bestScore = -Infinity;
    let found = 0;
    for (let y = margin; y + size < h - margin; y += step) {
      for (let x = margin; x + size < w - margin; x += step) {
        if (!this.areaClear(x - gap, y - gap, size + gap * 2)) continue;
        const px = x + size / 2;
        const py = y + size / 2;
        const head = this.nearestLiving(px, py);
        if (head < headMin) continue;
        const dist = Math.hypot(px - ax, py - ay);
        const score = head * 0.2 - Math.abs(dist - wantDist) + this.rng() * 6;
        found++;
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
      }
    }
    if (found === 0) return null;
    return { x: bestX, y: bestY };
  }

  private nearestLiving(x: number, y: number): number {
    let best = Infinity;
    for (const o of this.roster) {
      if (!o.active || !o.alive) continue;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < best) best = d;
    }
    return best;
  }

  private areaClear(x0: number, y0: number, size: number): boolean {
    const xa = Math.max(0, x0);
    const ya = Math.max(0, y0);
    const x1 = Math.min(this.grid.w, x0 + size);
    const y1 = Math.min(this.grid.h, y0 + size);
    if (x1 <= xa || y1 <= ya) return false;
    for (let y = ya; y < y1; y++) {
      for (let x = xa; x < x1; x++) {
        const i = this.grid.idx(x, y);
        if (this.grid.owner[i] !== 0 || this.grid.trail[i] !== 0) return false;
      }
    }
    return true;
  }

  /** @returns false when the mover died on this cell and the walk should stop. */
  private enterCell(p: Player, cx: number, cy: number): boolean {
    if (!p.alive) return false;
    if (cx < 0 || cy < 0 || cx >= this.grid.w || cy >= this.grid.h) return false;
    const i = this.grid.idx(cx, cy);
    const tr = this.grid.trail[i]!;

    // Crossing your own trail is harmless. The line keeps going, and the
    // return home claims every lobe it sealed, figure-eights included.
    if (tr !== 0 && tr !== p.id) {
      const victim = this.players[tr];
      if (victim && victim.alive) this.kill(victim, p, 'trail');
    }
    if (!p.alive) return false;

    if (this.grid.owner[i] === p.id) {
      if (p.outside && p.trailLen > 0) this.finishClaim(p);
      if (!p.alive) return false;
      p.outside = false;
      return true;
    }

    if (this.grid.trail[i] !== p.id && p.trailLen < p.trail.length) {
      this.grid.setTrail(i, p.id);
      p.trail[p.trailLen++] = i;
    }
    p.outside = true;
    return p.alive;
  }

  private finishClaim(p: Player): void {
    this.grid.floodOutside(p.id);
    const victims: Array<{ p: Player; reason: DeathReason }> = [];
    for (const o of this.roster) {
      if (!o.active || !o.alive || o.id === p.id) continue;
      const cx = Math.floor(o.x);
      const cy = Math.floor(o.y);
      if (cx >= 0 && cy >= 0 && cx < this.grid.w && cy < this.grid.h) {
        const hi = this.grid.idx(cx, cy);
        if (this.grid.inNewRegion(hi, p.id)) {
          victims.push({ p: o, reason: 'enclosed' });
          continue;
        }
      }
      for (let t = 0; t < o.trailLen; t++) {
        const j = o.trail[t]!;
        if (this.grid.inNewRegion(j, p.id)) {
          victims.push({ p: o, reason: 'trail' });
          break;
        }
      }
    }
    this.collectFringe(p);
    const branched = this.trailBranches(p);
    const before = this.grid.landCount[p.id] ?? 0;
    this.grid.applyClaim(p.id);
    if (!branched) this.trimFringe(p);
    const n = (this.grid.landCount[p.id] ?? 0) - before;
    p.trailLen = 0;
    p.outside = false;
    p.land = this.grid.landCount[p.id] ?? 0;
    if (n > 0) {
      p.xp += n * this.cfg.claimXpPerCell;
      this.stats.claims++;
      this.stats.claimedCells += n;
      this.events.push({ e: 'claim', id: p.id, n, x: p.x, y: p.y });
    }
    for (const v of victims) {
      if (v.p.alive) this.kill(v.p, p, v.reason);
    }
  }

  /**
   * Cells the flood is about to claim that sit next to the trail. Trimmed
   * after applyClaim when their centers fall outside the trail polyline.
   */
  private collectFringe(p: Player): void {
    this.fringeStamp = this.fringeStamp >= 255 ? 1 : this.fringeStamp + 1;
    if (this.fringeStamp === 1) this.fringeMark.fill(0);
    const stamp = this.fringeStamp;
    const w = this.grid.w;
    const h = this.grid.h;
    this.fringeN = 0;
    for (let t = 0; t < p.trailLen; t++) {
      const i = p.trail[t]!;
      const cx = i % w;
      const cy = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const j = y * w + x;
          if (this.fringeMark[j] === stamp) continue;
          if (this.grid.owner[j] === p.id) continue;
          if (this.grid.visited[j] !== 0) continue;
          this.fringeMark[j] = stamp;
          this.fringe[this.fringeN++] = j;
        }
      }
    }
  }

  /**
   * Drop newly claimed cells whose centers lie outside the trail centerline.
   * A self-crossing trail seals more than one lobe. The flood already unions
   * those interiors; the single-sided trim would shave one of them off.
   */
  private trimFringe(p: Player): void {
    const n = p.trailLen;
    if (n < 2 || this.fringeN === 0) return;
    const w = this.grid.w;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      const i = p.trail[t]!;
      xs[t] = (i % w) + 0.5;
      ys[t] = ((i / w) | 0) + 0.5;
    }
    const leftOutside = this.leftIsOutside(xs, ys, n);
    for (let k = 0; k < this.fringeN; k++) {
      const j = this.fringe[k]!;
      if (this.grid.owner[j] !== p.id) continue;
      const px = (j % w) + 0.5;
      const py = ((j / w) | 0) + 0.5;
      const hit = this.distToTrail(px, py, xs, ys, n);
      const outside = hit.left === leftOutside;
      if (hit.dist > 0.5 && outside) this.grid.setOwner(j, 0);
    }
  }

  private leftIsOutside(xs: Float64Array, ys: Float64Array, n: number): boolean {
    let left = 0;
    let right = 0;
    const step = Math.max(1, (n / 16) | 0);
    for (let s = 0; s < n - 1; s += step) {
      const ax = xs[s]!;
      const ay = ys[s]!;
      const bx = xs[s + 1]!;
      const by = ys[s + 1]!;
      const vx = bx - ax;
      const vy = by - ay;
      const len = Math.hypot(vx, vy);
      if (len < 0.2) continue;
      const nx = -vy / len;
      const ny = vx / len;
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      if (this.cellOutside(mx + nx * 0.75, my + ny * 0.75)) left++;
      if (this.cellOutside(mx - nx * 0.75, my - ny * 0.75)) right++;
    }
    return left >= right;
  }

  private cellOutside(x: number, y: number): boolean {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= this.grid.w || cy >= this.grid.h) return true;
    return this.grid.visited[this.grid.idx(cx, cy)] === 1;
  }

  private distToTrail(
    px: number,
    py: number,
    xs: Float64Array,
    ys: Float64Array,
    n: number,
  ): { dist: number; left: boolean } {
    let best = 1e9;
    let left = false;
    for (let s = 0; s < n - 1; s++) {
      const ax = xs[s]!;
      const ay = ys[s]!;
      const bx = xs[s + 1]!;
      const by = ys[s + 1]!;
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      let t = 0;
      if (len2 > 1e-8) t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
      const cx = ax + vx * t;
      const cy = ay + vy * t;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist < best) {
        best = dist;
        const cross = vx * (py - ay) - vy * (px - ax);
        left = cross >= 0;
      }
    }
    return { dist: best, left };
  }

  /** True when the trail touches itself (a crossing has 3 or more trail neighbors). */
  private trailBranches(p: Player): boolean {
    const { w, h, trail } = this.grid;
    const id = p.id;
    for (let t = 0; t < p.trailLen; t++) {
      const i = p.trail[t]!;
      if (trail[i] !== id) continue;
      const x = i % w;
      const y = (i / w) | 0;
      let n = 0;
      if (x > 0 && trail[i - 1] === id) n++;
      if (x + 1 < w && trail[i + 1] === id) n++;
      if (y > 0 && trail[i - w] === id) n++;
      if (y + 1 < h && trail[i + w] === id) n++;
      if (n >= 3) return true;
    }
    return false;
  }

  private kill(victim: Player, killer: Player | null, reason: DeathReason): void {
    if (!victim.alive) return;
    if (
      this.tick < victim.invulnUntil &&
      (reason === 'headon' || reason === 'trail' || reason === 'enclosed')
    ) {
      return;
    }
    const total = this.cfg.gridW * this.cfg.gridH;
    const land = this.grid.landCount[victim.id] ?? 0;
    victim.lastPct = (land / total) * 100;
    victim.lastRank = this.rankOf(victim.id);
    victim.lastTime = victim.aliveMs;
    victim.deathReason = reason;
    victim.deathKiller = killer ? killer.id : 0;
    victim.alive = false;
    victim.outside = false;

    const credit = killer && killer.id !== victim.id && killer.alive;
    if (credit && killer) {
      killer.kills++;
      killer.coins += this.cfg.killCoins;
      killer.xp += this.cfg.killXp;
      if (killer.trainLen < killer.train.length) killer.train[killer.trainLen++] = victim.pet;
      this.stats.kills++;
      this.events.push({
        e: 'kill',
        killer: killer.id,
        victim: victim.id,
        x: victim.x,
        y: victim.y,
        pet: victim.pet,
      });
    }
    this.stats.deaths++;
    this.events.push({
      e: 'die',
      id: victim.id,
      reason,
      killer: killer && credit ? killer.id : 0,
      pct: victim.lastPct,
      kills: victim.kills,
      train: victim.trainLen,
      coins: victim.coins,
      xp: victim.xp,
      time: victim.aliveMs,
      rank: victim.lastRank,
    });
    this.grid.clearPlayer(victim.id);
    victim.trailLen = 0;
    victim.land = 0;
    if (victim.bot) {
      victim.respawnTick = this.tick + Math.max(1, Math.round(this.cfg.botRespawnSec * this.cfg.tickHz));
    }
    this.dropKillCoins(victim.x, victim.y);
  }

  private rankOf(id: number): number {
    const land = this.grid.landCount[id] ?? 0;
    let better = 0;
    for (const p of this.roster) {
      if (!p.active || !p.alive || p.id === id) continue;
      if ((this.grid.landCount[p.id] ?? 0) > land) better++;
    }
    return better + 1;
  }

  private resolveHeadOns(): void {
    const buf = this.aliveBuf;
    let n = 0;
    for (const p of this.roster) {
      if (p.active && p.alive) buf[n++] = p;
    }
    const r2 = (this.cfg.headRadius * 2) * (this.cfg.headRadius * 2);
    for (let i = 0; i < n; i++) {
      const a = buf[i]!;
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = buf[j]!;
        if (!b.alive) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy > r2) continue;
        const la = this.grid.landCount[a.id] ?? 0;
        const lb = this.grid.landCount[b.id] ?? 0;
        if (la > lb) this.kill(b, a, 'headon');
        else if (lb > la) this.kill(a, b, 'headon');
        else {
          this.kill(a, null, 'headon');
          this.kill(b, null, 'headon');
        }
      }
    }
  }

  private collectPickups(): void {
    const r2 = this.cfg.pickupRadius * this.cfg.pickupRadius;
    for (const item of this.pickups) {
      if (!item.active) continue;
      for (const p of this.roster) {
        if (!p.active || !p.alive) continue;
        const dx = p.x - item.x;
        const dy = p.y - item.y;
        if (dx * dx + dy * dy > r2) continue;
        let coins = 0;
        let xp = 0;
        if (item.kind === 0) coins = this.cfg.coinValue;
        else if (item.kind === 1) xp = this.cfg.xpOrbValue;
        else {
          coins = this.cfg.lootCoins;
          xp = this.cfg.lootXp;
        }
        p.coins += coins;
        p.xp += xp;
        item.active = false;
        this.events.push({ e: 'pickup', id: p.id, kind: item.kind, amount: coins, x: item.x, y: item.y, xp });
        break;
      }
    }
  }

  private spawnPickups(): void {
    let active = 0;
    for (const item of this.pickups) if (item.active) active++;
    if (active >= this.cfg.pickupTarget) return;
    const slot = this.pickups.find((item) => !item.active);
    if (!slot) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = 1 + this.rng() * (this.cfg.gridW - 2);
      const y = 1 + this.rng() * (this.cfg.gridH - 2);
      const i = this.grid.idx(Math.floor(x), Math.floor(y));
      if (this.grid.owner[i] !== 0 || this.grid.trail[i] !== 0) continue;
      slot.active = true;
      slot.x = x;
      slot.y = y;
      slot.id = this.pickupSeq++;
      const roll = this.rng();
      slot.kind = roll < this.cfg.rareLootChance ? 2 : roll < 0.42 ? 1 : 0;
      return;
    }
  }

  private dropKillCoins(x: number, y: number): void {
    let dropped = 0;
    for (const item of this.pickups) {
      if (dropped >= this.cfg.killDropCoins) break;
      if (item.active) continue;
      const ang = this.rng() * Math.PI * 2;
      const dist = 0.4 + this.rng() * 1.4;
      item.active = true;
      item.x = Math.min(this.cfg.gridW - 1, Math.max(1, x + Math.cos(ang) * dist));
      item.y = Math.min(this.cfg.gridH - 1, Math.max(1, y + Math.sin(ang) * dist));
      item.id = this.pickupSeq++;
      item.kind = 0;
      dropped++;
    }
  }

  private respawnBots(): void {
    for (const p of this.roster) {
      if (!p.active || !p.bot || p.alive) continue;
      if (p.respawnTick !== 0 && this.tick >= p.respawnTick) {
        this.spawn(p);
        this.events.push({ e: 'spawn', id: p.id, name: p.name, pet: p.pet, bot: true });
      }
    }
  }

  private pickBotToRemove(): Player | null {
    let best: Player | null = null;
    for (const p of this.roster) {
      if (!p.active || !p.bot) continue;
      if (!p.alive) return p;
      if (!best || p.land < best.land) best = p;
    }
    return best;
  }
}

export { CONFIG };
