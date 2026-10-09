import { updateBot, type BotView } from './bots.js';
import { BOT_NAMES, CONFIG, SPECIES, makeConfig, type GameConfig } from './config.js';
import { LandBook, polylineNearSegment } from './land.js';
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
const TRAIL_CAP = 8192;

/**
 * Authoritative paper.io-style simulation. Territory is a multi-polygon per
 * owner. One instance runs on the server and the same class runs offline.
 */
export class Sim {
  readonly cfg: GameConfig;
  readonly land: LandBook;
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

  constructor(over: Partial<GameConfig> = {}, seed = 1) {
    this.cfg = makeConfig(over);
    this.land = new LandBook(this.cfg.maxEntities, this.cfg.gridW, this.cfg.gridH);
    this.players = new Array(this.cfg.maxEntities + 1).fill(null);
    this.roster = [];
    for (let id = 1; id <= this.cfg.maxEntities; id++) {
      const p = new Player(id, TRAIL_CAP, this.cfg.maxTrainStored);
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
      land: this.land,
      players: this.players,
      rng: this.rng,
      dt: this.tickDt,
    };
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
    if (p.alive) this.land.clear(id);
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
    if (p.alive) this.land.clear(id);
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
    this.land.beginTick();
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
      const x0 = p.x;
      const y0 = p.y;
      integrateBody(p, dt, this.cfg);
      if (!p.alive) continue;
      this.followSegment(p, x0, y0, p.x, p.y);
    }

    this.resolveHeadOns();
    this.collectPickups();
    this.spawnPickups();
    this.respawnBots();

    for (const p of this.roster) {
      if (!p.active) continue;
      p.land = this.land.areaOf(p.id);
    }
  }

  consumeEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Quantized polygons for owners dirtied since the last beginTick. */
  landPatch(): number[] {
    return this.land.encode(this.land.changedIds());
  }

  activePickups(): Pickup[] {
    return this.pickups.filter((p) => p.active);
  }

  forEachActivePickup(fn: (id: number, kind: number, x: number, y: number) => void): void {
    for (const item of this.pickups) {
      if (item.active) fn(item.id, item.kind, item.x, item.y);
    }
  }

  idx(x: number, y: number): number {
    return y * this.cfg.gridW + x;
  }

  ownerAt(x: number, y: number): number {
    return this.land.ownerAt(x, y);
  }

  /** Wipe one owner's polygon and trail without killing them. */
  debugClear(id: number): void {
    this.land.clear(id);
    const p = this.players[id];
    if (!p) return;
    p.trailLen = 0;
    p.land = 0;
  }

  /** Test helper: union a rectangle of land. Does not move the player. */
  debugGiveRect(id: number, x: number, y: number, w: number, h: number): void {
    this.land.unionRect(id, x, y, w, h);
    const p = this.players[id];
    if (p) p.land = this.land.areaOf(id);
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
    p.outside = !this.land.contains(id, x, y);
  }

  /** Cell indices become trail points at cell centers. */
  debugSetTrail(id: number, cells: number[]): void {
    const p = this.players[id];
    if (!p) return;
    p.trailLen = 0;
    const w = this.cfg.gridW;
    for (const i of cells) {
      this.pushTrail(p, (i % w) + 0.5, ((i / w) | 0) + 0.5, 0);
    }
    p.outside = true;
  }

  /** Run the claim as if `id` just stepped back onto their land. */
  debugClaim(id: number): number {
    const p = this.players[id];
    if (!p) return 0;
    const before = this.land.areaOf(id);
    this.finishClaim(p);
    p.land = this.land.areaOf(id);
    return p.land - before;
  }

  auditLand(): boolean {
    return this.land.audit();
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
    if (p.alive) this.land.clear(p.id);
    p.resetRun();
    const spot = this.findSpawn(p.bot);
    const size = this.cfg.spawnSize;
    this.land.unionRect(p.id, spot.x, spot.y, size, size);
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
    p.land = this.land.areaOf(p.id);
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
    if (this.land.hitsExcept(0, x0, y0, size, size)) return false;
    const x1 = x0 + size;
    const y1 = y0 + size;
    for (const p of this.roster) {
      if (!p.active || p.trailLen === 0) continue;
      for (let i = 0; i < p.trailLen; i += 2) {
        const x = p.trailX[i]!;
        const y = p.trailY[i]!;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return false;
      }
    }
    return true;
  }

  private followSegment(p: Player, x0: number, y0: number, x1: number, y1: number): void {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / 0.22));
    let px = x0;
    let py = y0;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (!this.consumeStep(p, px, py, x, y)) {
        p.x = x;
        p.y = y;
        return;
      }
      px = x;
      py = y;
    }
  }

  /** @returns false when the mover died on this step. Crossing your own trail is harmless. */
  private consumeStep(p: Player, ax: number, ay: number, bx: number, by: number): boolean {
    if (!p.alive) return false;
    const radius = this.cfg.headRadius;
    for (const o of this.roster) {
      if (!o.active || !o.alive || o.id === p.id || o.trailLen === 0) continue;
      if (polylineNearSegment(ax, ay, bx, by, o.trailX, o.trailY, 0, o.trailLen, radius)) {
        this.kill(o, p, 'trail');
      }
    }
    if (!p.alive) return false;

    const inside = this.land.contains(p.id, bx, by);
    if (inside) {
      if (p.outside && p.trailLen > 0) {
        const hit = this.boundaryPoint(p.id, ax, ay, bx, by, true);
        this.pushTrail(p, hit[0], hit[1], 0.04);
        if (p.trailLen >= 3) this.finishClaim(p);
        else p.trailLen = 0;
        if (!p.alive) return false;
      }
      p.outside = false;
      return true;
    }

    if (!p.outside) {
      const hit = this.boundaryPoint(p.id, ax, ay, bx, by, false);
      this.pushTrail(p, hit[0], hit[1], 0.02);
      p.outside = true;
    }
    this.pushTrail(p, bx, by, 0.28);
    p.outside = true;
    return true;
  }


  /** Binary search the segment for the land boundary. `endInside` is the state at (bx, by). */
  private boundaryPoint(id: number, ax: number, ay: number, bx: number, by: number, endInside: boolean): [number, number] {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const m = (lo + hi) * 0.5;
      const x = ax + (bx - ax) * m;
      const y = ay + (by - ay) * m;
      if (this.land.contains(id, x, y) === endInside) hi = m;
      else lo = m;
    }
    const m = (lo + hi) * 0.5;
    return [ax + (bx - ax) * m, ay + (by - ay) * m];
  }

  private pushTrail(p: Player, x: number, y: number, min: number): void {
    if (p.trailLen > 0) {
      const dx = x - p.trailX[p.trailLen - 1]!;
      const dy = y - p.trailY[p.trailLen - 1]!;
      if (dx * dx + dy * dy < min * min) return;
    }
    if (p.trailLen >= p.trailX.length) return;
    p.trailX[p.trailLen] = x;
    p.trailY[p.trailLen] = y;
    p.trailLen++;
  }

  private finishClaim(p: Player): void {
    const ok = this.land.prepareClaim(p.id, p.trailX, p.trailY, p.trailLen);
    const victims: Array<{ p: Player; reason: DeathReason }> = [];
    if (ok) {
      for (const o of this.roster) {
        if (!o.active || !o.alive || o.id === p.id) continue;
        if (this.land.pointInAdded(o.x, o.y)) {
          victims.push({ p: o, reason: 'enclosed' });
          continue;
        }
        for (let t = 0; t < o.trailLen; t++) {
          if (this.land.pointInAdded(o.trailX[t]!, o.trailY[t]!)) {
            victims.push({ p: o, reason: 'trail' });
            break;
          }
        }
      }
      const n = this.land.commitClaim(p.id);
      p.trailLen = 0;
      p.outside = false;
      p.land = this.land.areaOf(p.id);
      if (n > 0.5) {
        p.xp += n * this.cfg.claimXpPerCell;
        this.stats.claims++;
        this.stats.claimedCells += n;
        this.events.push({ e: 'claim', id: p.id, n, x: p.x, y: p.y });
      }
    } else {
      p.trailLen = 0;
      p.outside = false;
    }
    for (const v of victims) {
      if (v.p.alive) this.kill(v.p, p, v.reason);
    }
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
    const land = this.land.areaOf(victim.id);
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
    this.land.clear(victim.id);
    victim.trailLen = 0;
    victim.land = 0;
    if (victim.bot) {
      victim.respawnTick = this.tick + Math.max(1, Math.round(this.cfg.botRespawnSec * this.cfg.tickHz));
    }
    this.dropKillCoins(victim.x, victim.y);
  }

  private rankOf(id: number): number {
    const land = this.land.areaOf(id);
    let better = 0;
    for (const p of this.roster) {
      if (!p.active || !p.alive || p.id === id) continue;
      if (this.land.areaOf(p.id) > land) better++;
    }
    return better + 1;
  }

  private resolveHeadOns(): void {
    const buf = this.aliveBuf;
    let n = 0;
    for (const p of this.roster) {
      if (p.active && p.alive) buf[n++] = p;
    }
    const r2 = this.cfg.headRadius * 2 * (this.cfg.headRadius * 2);
    for (let i = 0; i < n; i++) {
      const a = buf[i]!;
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = buf[j]!;
        if (!b.alive) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy > r2) continue;
        const la = this.land.areaOf(a.id);
        const lb = this.land.areaOf(b.id);
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
      if (this.land.ownerAt(x, y) !== 0) continue;
      if (this.nearTrail(x, y, 1.25)) continue;
      slot.active = true;
      slot.x = x;
      slot.y = y;
      slot.id = this.pickupSeq++;
      const roll = this.rng();
      slot.kind = roll < this.cfg.rareLootChance ? 2 : roll < 0.42 ? 1 : 0;
      return;
    }
  }

  private nearTrail(x: number, y: number, radius: number): boolean {
    for (const p of this.roster) {
      if (!p.active || p.trailLen === 0) continue;
      if (polylineNearSegment(x, y, x, y, p.trailX, p.trailY, 0, p.trailLen, radius)) return true;
    }
    return false;
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
