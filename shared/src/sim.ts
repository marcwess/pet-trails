import { DEFAULT_KIT, cooldownBase, cooldownOf, effectOf, rarityScale, speedMultiplier, type Kit } from './abilities.js';
import { botWantsAbility, updateBot, type BotView } from './bots.js';
import { BOT_NAMES, CONFIG, SPECIES, makeConfig, type GameConfig } from './config.js';
import { LandBook, polylineNearSegment } from './land.js';
import { integrateBody } from './motion.js';
import { rollBotKit } from './profile.js';
import { circleRing, mapBlob, spawnRadius } from './shape.js';
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
/** Spread so a room shows every recolor and trail without a profile. */
const BOT_LEVELS = [1, 5, 8, 10, 12, 15, 18, 20];

/**
 * Authoritative paper.io-style simulation. Territory is a multi-polygon per
 * owner. One instance runs on the server and the same class runs offline.
 */
/** Queued inputs beyond normal jitter. At this depth a human takes two steps in one tick. */
const LOCKSTEP_SLACK = 2;
/** Ticks a human waits for its next input before the server moves it anyway. */
const LOCKSTEP_WAIT = 6;

export class Sim {
  readonly cfg: GameConfig;
  readonly seed: number;
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
    this.seed = seed >>> 0;
    this.land = new LandBook(this.cfg.maxEntities, this.cfg.gridW, this.cfg.gridH, mapBlob(this.seed, this.cfg.gridW, this.cfg.gridH));
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
      heat: 0,
    };
  }

  /** Round is closed to new players and dead pets stay dead. */
  sealed = false;
  /**
   * Server rooms set this. A human only advances on a tick that consumes one
   * queued input, so prediction and the ack describe the same steps.
   */
  lockstep = false;
  /** 0 while the field is full and the clock is young. 1 when bots should press. */
  heat = 0;
  /** Someone has conquered the map, or the clock named a winner. */
  over = false;
  /** Pets who were in the round when it sealed. Placement is "4th of this". */
  roundSize = 0;

  addHuman(name: string, pet: number, kit?: Kit | null, level = 1): Player | null {
    const p = this.alloc();
    if (!p) return null;
    p.bot = false;
    p.name = name || 'You';
    p.pet = this.clampPet(pet);
    this.setKit(p.id, kit ?? DEFAULT_KIT);
    p.level = this.clampLevel(level);
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
    p.level = BOT_LEVELS[p.id % BOT_LEVELS.length]!;
    p.botStyle = p.id % 2;
    this.setKit(p.id, rollBotKit(this.rng));
    p.botTurnSign = this.rng() < 0.5 ? -1 : 1;
    this.spawn(p);
    this.events.push({ e: 'spawn', id: p.id, name: p.name, pet: p.pet, bot: true });
    return p;
  }

  /** Apply a validated kit. Returns false and leaves the player unchanged when the kit is impossible. */
  setKit(id: number, kit: Kit | null): boolean {
    const p = this.players[id];
    if (!p || !kit) return false;
    if (kit.actives[0] === kit.actives[1] || kit.passives[0] === kit.passives[1]) return false;
    p.rarity = kit.rarity;
    p.activeId = kit.actives[kit.equippedActive];
    p.passiveId = kit.passives[kit.equippedPassive];
    return true;
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

  /**
   * Server-side active. Returns false when the pet is dead or the cooldown
   * has not finished. The effect is applied here, not on the client.
   */
  useAbility(id: number): boolean {
    const p = this.players[id];
    if (!p || !p.active || !p.alive) return false;
    if (this.tick < p.cdUntil) return false;
    const kind = p.activeId;
    const a = this.cfg.abilities;
    const scale = rarityScale(p.rarity, this.cfg, p.level);
    const fromX = p.x;
    const fromY = p.y;
    let radius = 0;
    if (kind === 'dash') {
      p.dashUntil = this.tick + Math.max(1, Math.round(effectOf(a.dashSec, p.rarity, this.cfg, p.level) * this.cfg.tickHz));
    } else if (kind === 'shield') {
      p.shieldUntil = this.tick + Math.max(1, Math.round(effectOf(a.shieldSec, p.rarity, this.cfg, p.level) * this.cfg.tickHz));
    } else if (kind === 'paint') {
      radius = effectOf(a.paintRadius, p.rarity, this.cfg, p.level);
      this.land.unionPolygon(p.id, [circleRing(p.x, p.y, radius, 48)]);
      p.land = this.land.areaOf(p.id);
    } else if (kind === 'frost') {
      radius = effectOf(a.frostRadius, p.rarity, this.cfg, p.level);
      const mul = Math.max(0.12, a.frostSlow / scale);
      const until = this.tick + Math.max(1, Math.round(effectOf(a.frostSec, p.rarity, this.cfg, p.level) * this.cfg.tickHz));
      const r2 = radius * radius;
      for (const o of this.roster) {
        if (!o.active || !o.alive || o.id === p.id) continue;
        const dx = o.x - p.x;
        const dy = o.y - p.y;
        if (dx * dx + dy * dy > r2) continue;
        if (until >= o.slowUntil) {
          o.slowUntil = until;
          o.slowMul = mul;
        }
      }
    } else if (kind === 'recall') {
      if (!a.recallSafe) return false;
      const home = this.land.home(p.id);
      if (!home) return false;
      p.x = home.x;
      p.y = home.y;
      p.trailLen = 0;
      p.outside = false;
    } else {
      return false;
    }
    const cd = cooldownOf(cooldownBase(kind, this.cfg), p.rarity, this.cfg, p.level);
    p.cdUntil = this.tick + Math.max(1, Math.round(cd * this.cfg.tickHz));
    this.events.push({ e: 'ability', id: p.id, kind, x: p.x, y: p.y, r: radius, fx: fromX, fy: fromY });
    return true;
  }

  /** Drop a pickup for tests. */
  debugPickup(x: number, y: number, kind = 0): void {
    const slot = this.pickups.find((item) => !item.active) ?? this.pickups[0];
    if (!slot) return;
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.kind = kind;
    slot.id = this.pickupSeq++;
  }

  setInput(id: number, x: number, y: number, seq: number): void {
    const p = this.players[id];
    if (!p || !p.active || !p.alive) return;
    if (seq <= p.lastSeq) return;
    const mag = Math.hypot(x, y);
    const real = mag > 0.15;
    // A heartbeat before the player has ever steered must not start the pet
    // walking its spawn heading. Take the seq so the next packet still lines up.
    if (!real && !p.steered && p.inSeq.length === 0 && seq === p.lastSeq + 1) {
      p.lastSeq = seq;
      return;
    }
    let nx = x;
    let ny = y;
    if (mag <= 0.15) {
      // A quiet stick still spends a tick, along the heading already held.
      // Dropping it would freeze the server while the client keeps gliding.
      nx = p.desiredX;
      ny = p.desiredY;
      const hold = Math.hypot(nx, ny);
      if (hold <= 1e-6) {
        nx = Math.cos(p.heading);
        ny = Math.sin(p.heading);
      } else {
        nx /= hold;
        ny /= hold;
      }
    } else {
      nx /= mag;
      ny /= mag;
    }
    const at = p.inSeq.findIndex((s) => s >= seq);
    if (at >= 0 && p.inSeq[at] === seq) {
      p.inX[at] = nx;
      p.inY[at] = ny;
      p.inReal[at] = real ? 1 : 0;
      return;
    }
    const insert = at < 0 ? p.inSeq.length : at;
    p.inSeq.splice(insert, 0, seq);
    p.inX.splice(insert, 0, nx);
    p.inY.splice(insert, 0, ny);
    p.inReal.splice(insert, 0, real ? 1 : 0);
    // A client cannot grow the queue without bound.
    if (p.inSeq.length > 64) {
      p.inSeq.splice(0, p.inSeq.length - 64);
      p.inX.splice(0, p.inX.length - 64);
      p.inY.splice(0, p.inY.length - 64);
      p.inReal.splice(0, p.inReal.length - 64);
      p.lastSeq = p.inSeq[0]! - 1;
    }
  }

  /**
   * One queued input per tick, in seq order. A burst cannot collapse several turns
   * into one step, and a packet that arrives early waits so a later seq cannot skip ahead.
   */
  /** Queued inputs that can be applied back to back, starting at the next seq. */
  private dueInputs(p: Player): number {
    let n = 0;
    while (n < p.inSeq.length && p.inSeq[n] === p.lastSeq + 1 + n) n++;
    return n;
  }

  private applyDueInput(p: Player): boolean {
    if (p.inSeq.length === 0 || p.inSeq[0] !== p.lastSeq + 1) return false;
    p.lastSeq = p.inSeq.shift()!;
    p.desiredX = p.inX.shift()!;
    p.desiredY = p.inY.shift()!;
    if (p.inReal.shift() === 1) p.steered = true;
    return true;
  }

  maintainBots(humanCount: number): void {
    if (this.sealed || this.over) return;
    const want = Math.max(0, Math.min(this.cfg.targetPopulation - humanCount, this.cfg.maxEntities - humanCount));
    let bots = 0;
    // Dead bots keep their slot. A round never refills an elimination.
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
    this.heat = this.heatNow();
    this.botView.heat = this.heat;
    const dt = this.tickDt;

    for (const p of this.roster) {
      if (!p.active || !p.alive || !p.bot) continue;
      updateBot(p, this.botView);
      if (botWantsAbility(p, this.botView)) this.useAbility(p.id);
    }

    for (const p of this.roster) {
      if (!p.active || !p.alive || p.frozen) continue;
      let steps = 1;
      if (!p.bot) {
        const consumed = this.applyDueInput(p);
        if (this.lockstep) {
          if (consumed) {
            p.starved = 0;
            // A burst that arrived late is spent over a few ticks instead of banking a
            // permanent lag between the client's steps and the server's.
            if (this.dueInputs(p) >= LOCKSTEP_SLACK) steps = 2;
          } else if (++p.starved > LOCKSTEP_WAIT && p.steered) {
            // A silent client keeps gliding on the heading it already held.
            // The next sequence number stays free: burning it here made a late
            // packet look stale, and the stick went dead until the next round.
            // A pet that has never been steered stays put instead of wandering.
          } else {
            continue;
          }
          if (!p.steered) continue;
        }
      }
      p.aliveMs += dt * 1000;
      for (let k = 0; k < steps && p.alive; k++) {
        if (k > 0 && !this.applyDueInput(p)) break;
        const x0 = p.x;
        const y0 = p.y;
        const mul = this.speedMul(p);
        integrateBody(p, dt, { ...this.cfg, speed: this.cfg.speed * mul, turnRate: this.cfg.turnRate * mul }, undefined, this.land.mapRing);
        if (!p.alive) break;
        this.followSegment(p, x0, y0, p.x, p.y);
      }
    }

    this.resolveHeadOns();
    this.collectPickups();
    this.spawnPickups();
    this.refillOpening();

    for (const p of this.roster) {
      if (!p.active) continue;
      p.land = this.land.areaOf(p.id);
    }
    this.maybeEnd();
  }

  private heatNow(): number {
    const alive = this.living();
    // The clock ramps from a third of the heat point up to full heat there, so a quiet
    // round tightens gradually instead of flipping at one instant.
    const sec = this.tick / this.cfg.tickHz;
    const from = this.cfg.roundHeatSec / 3;
    const late = Math.max(0, Math.min(1, (sec - from) / Math.max(1e-3, this.cfg.roundHeatSec - from)));
    const few = alive <= 2 ? 1 : alive <= 3 ? 0.6 : alive <= 5 ? 0.25 : 0;
    return Math.max(late, few);
  }

  private living(): number {
    let n = 0;
    for (const p of this.roster) if (p.active && p.alive) n++;
    return n;
  }

  private maybeEnd(): void {
    if (this.over) return;
    if (!this.sealed && this.tick >= this.cfg.roundOpenSec * this.cfg.tickHz) {
      this.sealed = true;
      this.roundSize = this.roster.filter((p) => p.active).length;
    }
    const alive = this.living();
    if (this.sealed && alive === 1) {
      let winner: Player | null = null;
      for (const p of this.roster) if (p.active && p.alive) winner = p;
      this.crown(winner);
      return;
    }
    if (this.tick >= this.cfg.roundCapSec * this.cfg.tickHz) {
      let winner: Player | null = null;
      for (const p of this.roster) {
        if (!p.active || !p.alive) continue;
        if (!winner || p.land > winner.land) winner = p;
      }
      this.crown(winner);
    }
  }

  /** One pet owns the blob. Everyone else is eliminated and their land is swept in. */
  private crown(winner: Player | null): void {
    if (this.over || !winner) return;
    this.over = true;
    if (this.roundSize < 1) this.roundSize = this.roster.filter((p) => p.active).length;
    const losers: Player[] = [];
    for (const p of this.roster) if (p.active && p.alive && p.id !== winner.id) losers.push(p);
    // Smallest land goes out first, so a time crown places the rest by land.
    losers.sort((a, b) => a.land - b.land);
    for (const p of losers) this.kill(p, winner, 'time');
    this.land.flood(winner.id);
    winner.land = this.land.areaOf(winner.id);
    const total = Math.max(1, this.land.mapArea);
    this.events.push({
      e: 'win',
      id: winner.id,
      name: winner.name,
      total: Math.max(1, this.roundSize),
      pct: (winner.land / total) * 100,
      kills: winner.kills,
      coins: winner.coins,
      xp: winner.xp,
      time: winner.aliveMs,
    });
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

  /** Test helper: union a smooth disk of land. Does not move the player. */
  debugGiveCircle(id: number, cx: number, cy: number, r: number): void {
    this.land.unionPolygon(id, [circleRing(cx, cy, r, 48)]);
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

  private clampLevel(level: number): number {
    if (!Number.isFinite(level)) return 1;
    return Math.max(1, Math.min(this.cfg.levelCap, level | 0));
  }

  private clampPet(pet: number): number {
    if (!Number.isFinite(pet) || pet < 0 || pet >= SPECIES.length) return rngInt(this.rng, SPECIES.length);
    return pet | 0;
  }

  private spawn(p: Player): void {
    if (p.alive) this.land.clear(p.id);
    p.resetRun();
    let size = this.cfg.spawnSize;
    if (p.passiveId === 'headstart') size += effectOf(this.cfg.abilities.headStartExtra, p.rarity, this.cfg, p.level);
    const radius = spawnRadius(size);
    const spot = this.findSpawn(p.bot, radius);
    this.land.unionPolygon(p.id, [circleRing(spot.x, spot.y, radius, 48)]);
    p.x = spot.x;
    p.y = spot.y;
    const mid = this.land.mapCenter();
    let ang = this.rng() * Math.PI * 2;
    if (p.bot) {
      const rx = p.x - mid.x;
      const ry = p.y - mid.y;
      if (rx * rx + ry * ry > 16) ang = Math.atan2(rx, -ry) + (this.rng() - 0.5) * 0.5;
    }
    const reach = 36;
    const nx = p.x + Math.cos(ang) * reach;
    const ny = p.y + Math.sin(ang) * reach;
    if (!this.land.insideMap(nx, ny)) {
      ang = Math.atan2(mid.y - p.y, mid.x - p.x) + (this.rng() - 0.5) * 0.9;
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
   * Pick a spawn disk that sits inside the blob, with a gap from existing land
   * and from every living head. The last resort still refuses to overlap land.
   */
  private findSpawn(bot: boolean, radius = spawnRadius(this.cfg.spawnSize)): { x: number; y: number } {
    const anchor = this.livingAnchor(true) ?? this.livingAnchor(false) ?? this.land.mapCenter();
    const want = bot ? 50 : 0;
    for (const gap of [14, 8, 4, 1]) {
      const spot = this.bestSpawn(radius, gap, anchor.x, anchor.y, want, radius * 2 + gap);
      if (spot) return spot;
    }
    const spot = this.bestSpawn(radius, 0, anchor.x, anchor.y, want, radius);
    if (spot) return spot;
    return this.land.mapCenter();
  }

  private bestSpawn(
    radius: number,
    gap: number,
    ax: number,
    ay: number,
    wantDist: number,
    headMin: number,
  ): { x: number; y: number } | null {
    const { gridW: w, gridH: h } = this.cfg;
    const step = Math.max(4, Math.floor(radius));
    let bestX = 0;
    let bestY = 0;
    let bestScore = -Infinity;
    let found = 0;
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        const room = this.land.fenceAt(x, y);
        if (!room.inside || room.dist < radius + 0.8) continue;
        if (!this.diskClear(x, y, radius + gap)) continue;
        const head = this.nearestLiving(x, y);
        if (head < headMin) continue;
        const dist = Math.hypot(x - ax, y - ay);
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

  private diskClear(cx: number, cy: number, radius: number): boolean {
    const x0 = cx - radius;
    const y0 = cy - radius;
    if (this.land.hitsExcept(0, x0, y0, radius * 2, radius * 2)) return false;
    const x1 = cx + radius;
    const y1 = cy + radius;
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
        this.pushTrail(p, hit[0], hit[1], 0.04, true);
        if (p.trailLen >= 3) this.finishClaim(p);
        else p.trailLen = 0;
        if (!p.alive) return false;
      }
      p.outside = false;
      return true;
    }

    if (!p.outside) {
      const hit = this.boundaryPoint(p.id, ax, ay, bx, by, false);
      this.pushTrail(p, hit[0], hit[1], 0.02, true);
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

  private pushTrail(p: Player, x: number, y: number, min: number, force = false): void {
    if (p.trailLen > 0) {
      const dx = x - p.trailX[p.trailLen - 1]!;
      const dy = y - p.trailY[p.trailLen - 1]!;
      if (dx * dx + dy * dy < min * min) {
        // The boundary sample is the point the loop closes on. Keep it even
        // when the previous sample is already within the spacing.
        if (force) {
          p.trailX[p.trailLen - 1] = x;
          p.trailY[p.trailLen - 1] = y;
        }
        return;
      }
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
        p.xp += this.xpBonus(p, n * this.cfg.claimXpPerCell);
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
    if (reason === 'trail' && this.tick < victim.shieldUntil) return;
    if (
      reason !== 'time' &&
      this.tick < victim.invulnUntil &&
      (reason === 'headon' || reason === 'trail' || reason === 'enclosed')
    ) {
      return;
    }
    const total = Math.max(1, this.land.mapArea);
    const land = this.land.areaOf(victim.id);
    victim.lastPct = (land / total) * 100;
    victim.alive = false;
    victim.outside = false;
    const place = this.living() + 1;
    victim.lastRank = place;
    victim.lastTime = victim.aliveMs;
    victim.deathReason = reason;
    victim.deathKiller = killer ? killer.id : 0;

    const credit = killer && killer.id !== victim.id && killer.alive;
    if (credit && killer) {
      killer.kills++;
      killer.coins += this.coinBonus(killer, this.cfg.killCoins);
      killer.xp += this.xpBonus(killer, this.cfg.killXp);
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
      total: Math.max(1, this.roundSize || this.roster.filter((p) => p.active).length),
    });
    if (credit && killer) this.land.takeAll(victim.id, killer.id);
    else this.land.clear(victim.id);
    victim.trailLen = 0;
    victim.land = 0;
    if (killer) killer.land = this.land.areaOf(killer.id);
    // While the room is still open a fallen bot comes back, so a player who joins
    // a few seconds in still finds a full field. Once sealed, out is out.
    if (victim.bot && !this.sealed && !this.over) {
      victim.respawnTick = this.tick + Math.max(1, Math.round(this.cfg.botRespawnSec * this.cfg.tickHz));
    }
    this.dropKillCoins(victim.x, victim.y);
  }

  private refillOpening(): void {
    if (this.sealed || this.over) return;
    for (const p of this.roster) {
      if (!p.active || !p.bot || p.alive) continue;
      if (p.respawnTick !== 0 && this.tick >= p.respawnTick) {
        this.spawn(p);
        this.events.push({ e: 'spawn', id: p.id, name: p.name, pet: p.pet, bot: true });
      }
    }
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
    for (const item of this.pickups) {
      if (!item.active) continue;
      for (const p of this.roster) {
        if (!p.active || !p.alive) continue;
        let radius = this.cfg.pickupRadius;
        if (p.passiveId === 'magnet') radius += effectOf(this.cfg.abilities.magnetRadius, p.rarity, this.cfg, p.level);
        const dx = p.x - item.x;
        const dy = p.y - item.y;
        if (dx * dx + dy * dy > radius * radius) continue;
        let coins = 0;
        let xp = 0;
        if (item.kind === 0) coins = this.cfg.coinValue;
        else if (item.kind === 1) xp = this.cfg.xpOrbValue;
        else {
          coins = this.cfg.lootCoins;
          xp = this.cfg.lootXp;
        }
        if (p.passiveId === 'lucky' && coins > 0 && this.rng() < effectOf(this.cfg.abilities.luckyLoot, p.rarity, this.cfg, p.level)) {
          coins += this.cfg.lootCoins;
        }
        coins = this.coinBonus(p, coins);
        xp = this.xpBonus(p, xp);
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
      const room = this.land.fenceAt(x, y);
      if (!room.inside || room.dist < 2) continue;
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
      let px = x + Math.cos(ang) * dist;
      let py = y + Math.sin(ang) * dist;
      const room = this.land.fenceAt(px, py);
      if (!room.inside || room.dist < 0.6) {
        px = room.x - room.nx * 1;
        py = room.y - room.ny * 1;
      }
      item.x = px;
      item.y = py;
      item.id = this.pickupSeq++;
      item.kind = 0;
      dropped++;
    }
  }

  private speedMul(p: Player): number {
    return speedMultiplier(
      p.rarity,
      p.passiveId,
      this.tick < p.dashUntil,
      this.tick < p.slowUntil ? p.slowMul : null,
      this.cfg,
      p.level,
    );
  }

  private coinBonus(p: Player, base: number): number {
    if (base === 0 || p.passiveId !== 'lucky') return base;
    return base * (1 + effectOf(this.cfg.abilities.luckyCoins, p.rarity, this.cfg, p.level));
  }

  private xpBonus(p: Player, base: number): number {
    if (base === 0 || p.passiveId !== 'scholar') return base;
    return base * (1 + effectOf(this.cfg.abilities.scholarXp, p.rarity, this.cfg, p.level));
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
