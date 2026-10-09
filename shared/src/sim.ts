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
  private readonly aliveBuf: Player[] = [];
  private botView: BotView;

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
    p.name = BOT_NAMES[this.nameSeq % BOT_NAMES.length]! + (this.nameSeq >= BOT_NAMES.length ? ` ${1 + ((this.nameSeq / BOT_NAMES.length) | 0)}` : '');
    this.nameSeq++;
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
    p.alive = false;
    p.active = false;
    p.trailLen = 0;
    p.land = 0;
    this.events.push({ e: 'leave', id });
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
    const spot = this.findSpawn();
    const size = this.cfg.spawnSize;
    this.grid.fillRect(p.id, spot.x, spot.y, size, size);
    p.x = spot.x + size / 2;
    p.y = spot.y + size / 2;
    p.heading = this.rng() * Math.PI * 2;
    p.desiredX = Math.cos(p.heading);
    p.desiredY = Math.sin(p.heading);
    p.alive = true;
    p.outside = false;
    p.land = this.grid.landCount[p.id] ?? 0;
    p.respawnTick = 0;
    p.botPhase = 0;
    p.botMoved = 0;
    p.botNextThink = this.tick + rngInt(this.rng, 6);
  }

  private findSpawn(): { x: number; y: number } {
    const size = this.cfg.spawnSize;
    const { gridW: w, gridH: h } = this.cfg;
    for (let attempt = 0; attempt < 48; attempt++) {
      const x = 2 + rngInt(this.rng, Math.max(1, w - size - 4));
      const y = 2 + rngInt(this.rng, Math.max(1, h - size - 4));
      if (!this.areaClear(x, y, size)) continue;
      const cx = x + size / 2;
      const cy = y + size / 2;
      let far = true;
      for (const o of this.roster) {
        if (!o.active || !o.alive) continue;
        if (Math.hypot(o.x - cx, o.y - cy) < size + 6) {
          far = false;
          break;
        }
      }
      if (far) return { x, y };
    }
    return {
      x: 2 + rngInt(this.rng, Math.max(1, w - size - 4)),
      y: 2 + rngInt(this.rng, Math.max(1, h - size - 4)),
    };
  }

  private areaClear(x0: number, y0: number, size: number): boolean {
    const x1 = Math.min(this.grid.w, x0 + size);
    const y1 = Math.min(this.grid.h, y0 + size);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
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
    const own = this.grid.owner[i]!;

    if (tr === p.id && own !== p.id) {
      this.kill(p, null, 'self');
      return false;
    }
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
    const n = this.grid.applyClaim(p.id);
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

  private kill(victim: Player, killer: Player | null, reason: DeathReason): void {
    if (!victim.alive) return;
    const total = this.cfg.gridW * this.cfg.gridH;
    const land = this.grid.landCount[victim.id] ?? 0;
    victim.lastPct = (land / total) * 100;
    victim.lastRank = this.rankOf(victim.id);
    victim.lastTime = victim.aliveMs;
    victim.deathReason = reason;
    victim.deathKiller = killer ? killer.id : 0;
    victim.alive = false;
    victim.outside = false;

    const credit = killer && killer.id !== victim.id && killer.alive && reason !== 'self';
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
