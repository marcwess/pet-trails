import {
  CONFIG,
  FLAG_ALIVE,
  FLAG_BOT,
  FLAG_OUTSIDE,
  PALETTE,
  SPECIES,
  SPECIES_LABEL,
  Sim,
  applyXp,
  randomSeed,
  integrateBody,
  lerpAngle,
  type DeltaMsg,
  type EntSnap,
  type Profile,
  type WelcomeMsg,
  type WireEvent,
} from '@pet-trails/shared';
import { Hud, cssColor, deathTitle, type BoardRow, type DeathView } from './hud.js';
import { Input } from './input.js';
import { NetClient } from './net.js';
import { saveProfile } from './profileStore.js';
import { Renderer, type DrawPet, type DrawPickup } from './render.js';
import type { Perf } from './perf.js';
import type { Territory } from './territory.js';

type Phase = 'title' | 'playing' | 'dead';

interface Ent {
  used: boolean;
  id: number;
  name: string;
  pet: number;
  bot: boolean;
  alive: boolean;
  land: number;
  kills: number;
  coins: number;
  xp: number;
  train: Uint8Array;
  trainShown: number;
  trainLen: number;
  hop: number;
  outside: boolean;
  blinkUntil: number;
  prevX: number;
  prevZ: number;
  prevH: number;
  x: number;
  z: number;
  h: number;
  sx: Float32Array;
  sz: Float32Array;
  sh: Float32Array;
  st: Float32Array;
  sn: number;
  sc: number;
}

interface Body {
  x: number;
  y: number;
  heading: number;
  desiredX: number;
  desiredY: number;
}

export class Game {
  phase: Phase = 'title';
  private readonly ents: Ent[] = [];
  private readonly drawPets: DrawPet[] = [];
  private readonly drawPickups: DrawPickup[] = [];
  private pickupCount = 0;
  private selfId = 0;
  private offline: Sim | null = null;
  private acc = 0;
  private sendAcc = 0;
  private seq = 1;
  private alpha = 1;
  private snapCam = false;
  private serverTick = 0;
  private serverTickAt = 0;
  private steerUntil = 0;
  private hitLeft = 0;
  private boardAcc = 0;
  private shownKills = 0;
  /** Land percent last written to the HUD. The death sheet uses this same number. */
  private shownPct = 0;
  private peakPct = 0;
  private died = false;
  private readonly board: BoardRow[] = [];
  private readonly order: number[] = [];
  private readonly seen = new Uint8Array(CONFIG.maxEntities + 1);
  private seenStamp = 1;
  private readonly api: NonNullable<Window['__game']>;
  private readonly body: Body = { x: 0, y: 0, heading: 0, desiredX: 0, desiredY: 0 };
  private predX = 0;
  private predY = 0;
  private predH = 0;
  private predDX = 0;
  private predDY = 0;
  private predPrimed = false;
  private readonly readPickup = (id: number, kind: number, x: number, y: number) => {
    if (this.pickupCount >= this.drawPickups.length) return;
    const slot = this.drawPickups[this.pickupCount++]!;
    slot.x = x;
    slot.z = y;
    slot.kind = kind;
    void id;
  };

  constructor(
    private readonly renderer: Renderer,
    private readonly territory: Territory,
    private readonly hud: Hud,
    private readonly input: Input,
    private readonly net: NetClient,
    private readonly perf: Perf,
    private readonly profile: Profile,
  ) {
    for (let i = 0; i <= CONFIG.maxEntities; i++) this.ents.push(makeEnt(i));
    for (let i = 0; i < CONFIG.maxEntities; i++) {
      this.drawPets.push({
        id: 0,
        x: 0,
        z: 0,
        h: 0,
        pet: 0,
        alive: false,
        train: new Uint8Array(CONFIG.maxTrainVisible),
        trainShown: 0,
        trainExtra: 0,
        self: false,
        outside: false,
        hop: 0,
        blink: false,
      });
    }
    for (let i = 0; i < 72; i++) this.drawPickups.push({ x: 0, z: 0, kind: 0 });
    for (let i = 0; i < 6; i++) this.board.push({ name: '', pct: '', me: false, color: '#fff', show: false });
    this.net.onMode = (mode) => {
      this.hud.setChip(mode);
      if (mode === 'offline' && this.phase === 'playing' && !this.offline) this.onDisconnect();
    };
    this.net.onWelcome = (msg) => this.onWelcome(msg);
    this.net.onGrid = (owner, trail) => {
      this.territory.applySnapshot(owner, trail);
      this.renderer.clearPaths();
    };
    this.net.onDelta = (msg) => this.onDelta(msg);
    this.net.onFull = () => {
      if (this.phase !== 'title') this.startOffline();
    };
    this.hud.onPlay(() => void this.play());
    this.hud.setChip(this.net.mode);
    this.api = {
      phase: 'title',
      mode: this.net.mode,
      ready: true,
      perf: this.perf.stats,
      snapshotUploads: 0,
      player: () => this.playerView(),
      sampleTrails: (limit = 240) => this.sampleTrails(limit, false),
      sampleOwnTrail: (limit = 80) => this.sampleTrails(limit, true),
      entities: () => this.entityList(),
      landCheck: () => this.landCheck(),
    };
  }

  start(): void {
    this.net.start();
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.tick(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.__game = this.api;
  }

  private async play(): Promise<void> {
    this.died = false;
    this.shownKills = 0;
    this.shownPct = 0;
    this.peakPct = 0;
    this.hud.showDeath(null);
    this.hud.setYou('0.0%', 0);
    const mode = await this.net.whenSettled();
    this.hud.showTitle(false);
    this.hud.showHud(true);
    this.steerUntil = performance.now() + 4500;
    this.snapCam = true;
    this.predPrimed = false;
    if (mode === 'online') {
      this.offline = null;
      this.net.send({ t: 'hello', name: 'You', pet: this.profile.pet.species });
      this.net.send({ t: 'play' });
      this.phase = 'playing';
    } else if (this.offline) {
      this.offline.grid.beginTick();
      this.offline.respawn(this.selfId);
      this.consume(this.offline.consumeEvents(), this.offline.cellRuns());
      this.syncOffline(this.offline, false);
      this.phase = 'playing';
      this.snapCam = true;
      this.alpha = 1;
      this.acc = 0;
    } else {
      this.startOffline();
    }
  }

  private startOffline(): void {
    const sim = new Sim({}, randomSeed());
    const player = sim.addHuman('You', this.profile.pet.species);
    if (!player) return;
    this.offline = sim;
    this.selfId = player.id;
    this.territory.applySnapshot(sim.grid.owner, sim.grid.trail);
    this.renderer.clearPaths();
    for (const ent of this.ents) ent.used = false;
    this.syncOffline(sim, true);
    this.phase = 'playing';
    this.snapCam = true;
    this.alpha = 1;
    this.acc = 0;
  }

  private onDisconnect(): void {
    this.phase = 'dead';
    this.hud.showHud(false);
    this.hud.showDeath({
      title: 'Connection lost',
      rows: [
        { k: 'Status', v: 'Offline' },
        { k: 'Next', v: 'Play again' },
      ],
    });
  }

  private tick(dt: number): void {
    if (this.hitLeft > 0) this.hitLeft = Math.max(0, this.hitLeft - dt);
    const frame = this.hitLeft > 0 ? 0 : dt;
    for (const ent of this.ents) if (ent.hop > 0) ent.hop = Math.max(0, ent.hop - dt);
    const self = this.ents[this.selfId];
    if (self) this.renderer.landPct = self.land / (CONFIG.gridW * CONFIG.gridH);
    const viewH = this.predPrimed ? this.predH : (self?.h ?? 0);
    this.input.sample(viewH);
    if ((this.input.steering || performance.now() > this.steerUntil) && this.phase === 'playing') this.hud.hideSteer();
    if (this.phase === 'playing') {
      if (this.offline) this.stepOffline(frame);
      else this.stepOnline(frame);
    }
    const petCount = this.fillDraw();
    const view = this.phase === 'title' ? 'title' : this.phase === 'dead' ? 'dead' : 'play';
    this.renderer.update(frame || dt * 0.15, view, this.profile.pet.species, this.drawPets, petCount, this.drawPickups, this.phase === 'title' ? 0 : this.pickupCount, this.snapCam && this.phase === 'playing');
    if (this.phase !== 'title') this.snapCam = false;
    this.hud.setLabels(this.renderer.labels);
    this.boardAcc += dt;
    if (this.boardAcc > 0.2 && this.phase === 'playing') {
      this.boardAcc = 0;
      this.updateBoard();
    }
    this.perf.stats.ping = this.net.ping;
    this.api.phase = this.phase;
    this.api.mode = this.net.mode;
    this.api.snapshotUploads = this.territory.snapshotUploads;
  }

  private stepOffline(dt: number): void {
    const sim = this.offline;
    if (!sim) return;
    const tickDt = sim.tickDt;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= tickDt && steps < 4) {
      this.acc -= tickDt;
      steps++;
      const mag = Math.hypot(this.input.desiredX, this.input.desiredY);
      if (mag > 0.15) sim.setInput(this.selfId, this.input.desiredX / mag, this.input.desiredY / mag, this.seq++);
      sim.step({ humans: 1 });
      this.consume(sim.consumeEvents(), sim.cellRuns());
      this.syncOffline(sim, false);
      this.pickupCount = 0;
      sim.forEachActivePickup(this.readPickup);
    }
    this.alpha = tickDt > 0 ? this.acc / tickDt : 1;
  }

  private stepOnline(dt: number): void {
    const mag = Math.hypot(this.input.desiredX, this.input.desiredY);
    if (mag > 0.15) {
      this.predDX = this.input.desiredX / mag;
      this.predDY = this.input.desiredY / mag;
    }
    if (this.predPrimed) {
      this.body.x = this.predX;
      this.body.y = this.predY;
      this.body.heading = this.predH;
      this.body.desiredX = this.predDX;
      this.body.desiredY = this.predDY;
      integrateBody(this.body, dt, CONFIG);
      this.predX = this.body.x;
      this.predY = this.body.y;
      this.predH = this.body.heading;
    }
    this.sendAcc += dt;
    if (this.sendAcc >= CONFIG.tickHz ** -1) {
      this.sendAcc = 0;
      this.net.send({ t: 'input', seq: this.seq++, x: this.predDX, y: this.predDY });
    }
  }

  private syncOffline(sim: Sim, first: boolean): void {
    this.seenStamp = this.seenStamp >= 250 ? 1 : this.seenStamp + 1;
    if (this.seenStamp === 1) this.seen.fill(0);
    const stamp = this.seenStamp;
    for (const p of sim.roster) {
      if (!p.active) continue;
      this.seen[p.id] = stamp;
      const ent = this.ents[p.id]!;
      const spawn = !ent.used || first;
      ent.used = true;
      ent.id = p.id;
      ent.name = p.bot ? p.name : 'You';
      ent.pet = p.pet;
      ent.bot = p.bot;
      const prevAlive = ent.alive;
      if (!ent.alive && p.alive) {
        this.renderer.clearPath(p.id);
        ent.blinkUntil = performance.now() + 2000;
        if (p.id === this.selfId) {
          this.shownPct = 0;
          this.peakPct = 0;
        }
      }
      ent.alive = p.alive;
      ent.land = p.land;
      if (p.id === this.selfId) {
        if (!prevAlive && p.alive) this.shownKills = p.kills;
        else if (p.kills > this.shownKills) this.shownKills = p.kills;
        ent.kills = Math.max(p.kills, this.shownKills);
        if (this.phase === 'playing' && p.alive) this.noteLand(ent.land, ent.kills);
      } else {
        ent.kills = p.kills;
      }
      ent.coins = p.coins;
      ent.xp = p.xp;
      ent.outside = p.outside;
      if (p.trainLen > ent.trainLen) ent.hop = 0.42;
      ent.trainShown = Math.min(CONFIG.maxTrainVisible, p.trainLen);
      ent.trainLen = p.trainLen;
      for (let i = 0; i < ent.trainShown; i++) ent.train[i] = p.train[i]!;
      if (spawn) {
        ent.prevX = p.x;
        ent.prevZ = p.y;
        ent.prevH = p.heading;
      } else {
        ent.prevX = ent.x;
        ent.prevZ = ent.z;
        ent.prevH = ent.h;
      }
      ent.x = p.x;
      ent.z = p.y;
      ent.h = p.heading;
      if (!p.alive) this.renderer.clearPath(p.id);
    }
    for (const ent of this.ents) {
      if (ent.used && ent.id !== 0 && this.seen[ent.id] !== stamp) ent.used = false;
    }
  }

  private onWelcome(msg: WelcomeMsg): void {
    this.selfId = msg.id;
    for (const n of msg.names) {
      const ent = this.ents[n.i];
      if (!ent) continue;
      ent.used = true;
      ent.id = n.i;
      ent.name = n.i === msg.id ? 'You' : n.n;
      ent.pet = n.p;
      ent.bot = n.b === 1;
    }
  }

  private onDelta(msg: DeltaMsg): void {
    this.serverTick = msg.tick;
    this.serverTickAt = performance.now();
    let claim: { n: number; x: number; y: number } | null = null;
    if (msg.events) {
      for (const ev of msg.events) {
        if (ev.e === 'claim' && (!claim || ev.n > claim.n)) claim = ev;
      }
      this.applyEvents(msg.events);
    }
    if (msg.cells && msg.cells.length > 0) {
      const animate = !!claim && claim.n > 28;
      this.territory.applyRuns(msg.cells, animate, claim ? claim.x : 0, claim ? claim.y : 0);
    }
    for (const snap of msg.ents) this.applySnap(snap);
    if (msg.pickups) {
      this.pickupCount = 0;
      const list = msg.pickups;
      for (let i = 0; i + 3 < list.length && this.pickupCount < this.drawPickups.length; i += 4) {
        const slot = this.drawPickups[this.pickupCount++]!;
        slot.kind = list[i + 1]!;
        slot.x = list[i + 2]!;
        slot.z = list[i + 3]!;
      }
    }
    const self = this.ents[this.selfId];
    if (self && msg.you) {
      if (!this.predPrimed) {
        this.predX = msg.you[0];
        this.predY = msg.you[1];
        this.predH = msg.you[2];
        this.predPrimed = true;
        this.snapCam = true;
      } else if (self.alive) {
        this.reconcile(msg.you[0], msg.you[1], msg.you[2]);
      }
    }
  }

  private reconcile(sx: number, sy: number, sh: number): void {
    const dx = sx - this.predX;
    const dy = sy - this.predY;
    const err = Math.hypot(dx, dy);
    const lead = CONFIG.speed * Math.min(0.3, Math.max(0.05, this.net.ping / 1000));
    if (err > lead + 1.8) {
      this.predX = sx;
      this.predY = sy;
      this.predH = sh;
      return;
    }
    if (err > lead + 0.55 && err > 0.001) {
      const extra = err - lead;
      this.predX += (dx / err) * extra * 0.35;
      this.predY += (dy / err) * extra * 0.35;
    }
  }

  private applySnap(snap: EntSnap): void {
    const ent = this.ents[snap.i];
    if (!ent) return;
    ent.used = true;
    ent.id = snap.i;
    ent.pet = snap.p;
    ent.bot = (snap.f & FLAG_BOT) !== 0;
    const alive = (snap.f & FLAG_ALIVE) !== 0;
    const prevAlive = ent.alive;
    if (ent.alive && !alive) this.renderer.clearPath(ent.id);
    if (!ent.alive && alive) {
      ent.blinkUntil = performance.now() + 2000;
      if (snap.i === this.selfId) {
        this.shownPct = 0;
        this.peakPct = 0;
      }
    }
    ent.alive = alive;
    ent.outside = (snap.f & FLAG_OUTSIDE) !== 0;
    ent.land = snap.l;
    if (snap.i === this.selfId) {
      if (!prevAlive && alive) this.shownKills = snap.k;
      else if (snap.k > this.shownKills) this.shownKills = snap.k;
      ent.kills = Math.max(snap.k, this.shownKills);
      if (this.phase === 'playing' && alive) this.noteLand(ent.land, ent.kills);
    } else {
      ent.kills = snap.k;
    }
    ent.coins = snap.c;
    ent.xp = snap.xp;
    if (snap.tn > ent.trainLen) ent.hop = 0.42;
    ent.trainLen = snap.tn;
    ent.trainShown = Math.min(CONFIG.maxTrainVisible, snap.tr.length, snap.tn);
    for (let i = 0; i < ent.trainShown; i++) ent.train[i] = snap.tr[i] ?? 0;
    ent.sx[ent.sc] = snap.x;
    ent.sz[ent.sc] = snap.y;
    ent.sh[ent.sc] = snap.h;
    ent.st[ent.sc] = this.serverTick;
    ent.sc = (ent.sc + 1) % 8;
    if (ent.sn < 8) ent.sn++;
    ent.x = snap.x;
    ent.z = snap.y;
    ent.h = snap.h;
    if (!ent.name) ent.name = ent.bot ? 'Pet' : 'You';
    if (snap.i === this.selfId) ent.name = 'You';
  }

  private consume(events: WireEvent[], cells: number[]): void {
    let claim: { n: number; x: number; y: number } | null = null;
    for (const ev of events) if (ev.e === 'claim' && (!claim || ev.n > claim.n)) claim = ev;
    if (cells.length > 0) {
      const animate = !!claim && claim.n > 28;
      this.territory.applyRuns(cells, animate, claim ? claim.x : 0, claim ? claim.y : 0);
    }
    this.applyEvents(events);
  }

  private applyEvents(events: WireEvent[]): void {
    for (const ev of events) {
      if (ev.e === 'spawn') {
        const ent = this.ents[ev.id];
        if (!ent) continue;
        ent.used = true;
        ent.id = ev.id;
        ent.name = ev.id === this.selfId ? 'You' : ev.name;
        ent.pet = ev.pet;
        ent.bot = ev.bot;
        ent.alive = true;
        ent.blinkUntil = performance.now() + 2000;
        this.renderer.clearPath(ev.id);
      } else if (ev.e === 'leave') {
        const ent = this.ents[ev.id];
        if (ent) ent.used = false;
      } else if (ev.e === 'kill') {
        this.renderer.clearPath(ev.victim);
        const mine = ev.killer === this.selfId || ev.victim === this.selfId;
        this.renderer.burst(ev.x, ev.y, ev.victim, mine);
        if (mine) this.hitLeft = 0.06;
        if (ev.killer === this.selfId) {
          const victim = this.ents[ev.victim];
          const me = this.ents[this.selfId];
          if (me) {
            this.shownKills = Math.max(this.shownKills + 1, me.kills + 1);
            me.kills = this.shownKills;
            this.noteLand(me.land, me.kills);
          }
          this.hud.toast(`Caught ${victim?.name || 'a pet'}!`);
          buzz(14);
        }
      } else if (ev.e === 'claim') {
        const loop = this.renderer.exportTrail(ev.id);
        if (loop.n >= 2) this.territory.offerLoop(ev.id, loop.x, loop.y, loop.n);
        this.renderer.clearPath(ev.id);
        this.renderer.dropCoveredTrails(ev.id);
        if (ev.id === this.selfId && ev.n > 12) {
          const pct = (ev.n / (CONFIG.gridW * CONFIG.gridH)) * 100;
          const at = this.renderer.project(ev.x, 1.6, ev.y);
          this.hud.popup(at.x, at.y, `+${pct.toFixed(1)}%`, 'claim');
          if (ev.n > 40) this.renderer.punchClaim();
          if (ev.n > 180) buzz(10);
        }
      } else if (ev.e === 'die') {
        if (ev.id === this.selfId && !this.died) this.onDeath(ev);
      } else if (ev.e === 'pickup' && ev.id === this.selfId) {
        const p = this.renderer.project(ev.x, 1.2, ev.y);
        if (ev.kind === 2) this.hud.popup(p.x, p.y, 'Loot!', 'loot');
        else if (ev.kind === 1) this.hud.popup(p.x, p.y, `+${ev.xp} XP`, 'xp');
        else this.hud.popup(p.x, p.y, `+${ev.amount}`, 'coin');
      }
    }
  }

  private onDeath(ev: Extract<WireEvent, { e: 'die' }>): void {
    this.died = true;
    this.phase = 'dead';
    this.api.phase = 'dead';
    const me = this.ents[this.selfId];
    const pctNum = Math.max(ev.pct, this.shownPct, this.peakPct);
    this.shownPct = pctNum;
    if (pctNum > this.peakPct) this.peakPct = pctNum;
    if (me) me.alive = false;
    this.updateBoard();
    const levels = applyXp(this.profile.pet, Math.round(ev.xp), CONFIG.levelCap);
    this.profile.coins += ev.coins;
    saveProfile(this.profile);
    this.hud.setYou(`${pctNum.toFixed(1)}%`, ev.kills);
    const rows: DeathView['rows'] = [
      { k: 'Territory', v: `${pctNum.toFixed(1)}%` },
      { k: 'Rank', v: `#${ev.rank}` },
      { k: 'Kills', v: String(ev.kills) },
      { k: 'Train', v: String(ev.train) },
      { k: 'Coins', v: `+${ev.coins}` },
      { k: 'XP', v: `+${Math.round(ev.xp)}` },
      { k: 'Time', v: formatTime(ev.time) },
    ];
    if (levels > 0) rows.push({ k: levels > 1 ? `Level up! ×${levels}` : 'Level up!', v: `Lv ${this.profile.pet.level}`, up: true });
    this.hud.hideSteer();
    this.hud.showDeath({ title: deathTitle(ev.reason), rows });
    buzz(20);
  }

  private fillDraw(): number {
    let n = 0;
    const renderTick = this.offline ? 0 : this.serverTick + ((performance.now() - this.serverTickAt) / 1000) * CONFIG.tickHz - 2;
    for (let id = 1; id < this.ents.length && n < this.drawPets.length; id++) {
      const ent = this.ents[id]!;
      if (!ent.used) continue;
      const draw = this.drawPets[n++]!;
      draw.id = ent.id;
      draw.pet = ent.pet;
      draw.alive = ent.alive;
      draw.self = ent.id === this.selfId;
      draw.train = ent.train;
      draw.trainShown = ent.trainShown;
      draw.trainExtra = Math.max(0, ent.trainLen - ent.trainShown);
      draw.outside = ent.outside;
      draw.hop = ent.hop;
      draw.blink = ent.blinkUntil > performance.now();
      if (!ent.alive) {
        draw.x = ent.x;
        draw.z = ent.z;
        draw.h = ent.h;
        continue;
      }
      if (this.offline) {
        const t = this.alpha;
        draw.x = ent.prevX + (ent.x - ent.prevX) * t;
        draw.z = ent.prevZ + (ent.z - ent.prevZ) * t;
        draw.h = lerpAngle(ent.prevH, ent.h, t);
      } else if (draw.self && this.predPrimed) {
        draw.x = this.predX;
        draw.z = this.predY;
        draw.h = this.predH;
      } else {
        sampleEnt(ent, renderTick, draw);
      }
    }
    return n;
  }

  private updateBoard(): void {
    this.order.length = 0;
    for (let id = 1; id < this.ents.length; id++) {
      const ent = this.ents[id]!;
      if (ent.used && ent.alive) this.order.push(id);
    }
    this.order.sort((a, b) => this.ents[b]!.land - this.ents[a]!.land);
    const total = CONFIG.gridW * CONFIG.gridH;
    const topIds: number[] = [];
    const listed = new Set<number>();
    for (const id of this.order) {
      if (listed.has(id) || topIds.length >= 5) continue;
      listed.add(id);
      topIds.push(id);
    }
    const me = this.ents[this.selfId];
    const pinSelf = !!me && me.used && (me.alive || this.phase === 'dead');
    if (pinSelf && !listed.has(this.selfId) && topIds.length < 6) {
      listed.add(this.selfId);
      topIds.push(this.selfId);
    }
    for (let i = 0; i < 6; i++) {
      const row = this.board[i]!;
      const id = topIds[i];
      const ent = id ? this.ents[id] : undefined;
      if (!ent || !ent.used) {
        row.show = false;
        continue;
      }
      row.show = true;
      row.me = ent.id === this.selfId;
      row.name = row.me ? 'You' : ent.name;
      row.pct = ent.id === this.selfId ? `${this.shownPct.toFixed(1)}%` : `${((ent.land / total) * 100).toFixed(1)}%`;
      row.color = cssColor(ent.id);
    }
    this.hud.setBoard(this.board);
    if (me && me.used && me.alive && this.phase === 'playing') {
      this.noteLand(me.land, Math.max(me.kills, this.shownKills));
    }
  }

  /** HUD percent and the You leaderboard row, from the same land count. */
  private noteLand(land: number, kills: number): void {
    const pctNum = (land / (CONFIG.gridW * CONFIG.gridH)) * 100;
    this.shownPct = pctNum;
    if (pctNum > this.peakPct) this.peakPct = pctNum;
    const text = `${pctNum.toFixed(1)}%`;
    this.hud.setYou(text, kills);
    let patched = false;
    for (const row of this.board) {
      if (!row.me || !row.show) continue;
      row.pct = text;
      patched = true;
    }
    if (patched) this.hud.setBoard(this.board);
  }

  private landCheck(): {
    id: number;
    cells: ReturnType<Territory['ownerBounds']>;
    pixels: Renderer['landMeasure'];
    screen: { x0: number; y0: number; x1: number; y1: number; dpr: number } | null;
  } {
    const id = this.selfId;
    const c = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
    this.renderer.queueColorMeasure(c[0], c[1], c[2]);
    const cells = this.territory.ownerBounds(id);
    let screen: { x0: number; y0: number; x1: number; y1: number; dpr: number } | null = null;
    if (cells) {
      const pts = [
        this.renderer.project(cells.x0, 0.02, cells.y0),
        this.renderer.project(cells.x1 + 1, 0.02, cells.y0),
        this.renderer.project(cells.x0, 0.02, cells.y1 + 1),
        this.renderer.project(cells.x1 + 1, 0.02, cells.y1 + 1),
      ].filter((p) => p.ok);
      if (pts.length >= 3) {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        screen = {
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
          dpr: window.devicePixelRatio || 1,
        };
      }
    }
    return { id, cells, pixels: this.renderer.landMeasure, screen };
  }

  private playerView() {
    const self = this.ents[this.selfId];
    if (this.offline) {
      const p = this.offline.players[this.selfId];
      return {
        id: this.selfId,
        x: p?.x ?? 0,
        y: p?.y ?? 0,
        heading: p?.heading ?? 0,
        land: p?.land ?? 0,
        alive: !!p?.alive && this.phase === 'playing',
        kills: p?.kills ?? 0,
        train: p?.trainLen ?? 0,
        outside: p?.outside ?? false,
      };
    }
    return {
      id: this.selfId,
      x: this.predPrimed ? this.predX : (self?.x ?? 0),
      y: this.predPrimed ? this.predY : (self?.z ?? 0),
      heading: this.predPrimed ? this.predH : (self?.h ?? 0),
      land: self?.land ?? 0,
      alive: !!self?.alive && this.phase === 'playing',
      kills: self?.kills ?? 0,
      train: self?.trainLen ?? 0,
      outside: self?.outside ?? false,
    };
  }

  private entityList() {
    const out: Array<{ id: number; x: number; y: number; land: number; alive: boolean; bot: boolean; train: number; name: string; outside: boolean }> = [];
    for (const ent of this.ents) {
      if (!ent.used || !ent.alive) continue;
      out.push({
        id: ent.id,
        x: ent.x,
        y: ent.z,
        land: ent.land,
        alive: true,
        bot: ent.bot,
        train: ent.trainLen,
        name: ent.name,
        outside: ent.outside,
      });
    }
    return out;
  }

  private sampleTrails(limit: number, own: boolean) {
    const out: Array<{ x: number; y: number; owner: number }> = [];
    const { trail, gridW, gridH } = this.territory;
    const mine = this.selfId;
    for (let i = 0; i < gridW * gridH && out.length < limit; i++) {
      const owner = trail[i]!;
      if (owner === 0) continue;
      if (own ? owner === mine : owner !== mine) out.push({ x: (i % gridW) + 0.5, y: ((i / gridW) | 0) + 0.5, owner });
    }
    return out;
  }

  petLabel(): string {
    const species = SPECIES[this.profile.pet.species] ?? 'cat';
    const label = SPECIES_LABEL[species];
    return `Your pet · ${label} · Lv ${this.profile.pet.level}`;
  }
}

function makeEnt(id: number): Ent {
  return {
    used: false,
    id,
    name: '',
    pet: 0,
    bot: false,
    alive: false,
    land: 0,
    kills: 0,
    coins: 0,
    xp: 0,
    train: new Uint8Array(CONFIG.maxTrainVisible),
    trainShown: 0,
    trainLen: 0,
    hop: 0,
    outside: false,
    blinkUntil: 0,
    prevX: 0,
    prevZ: 0,
    prevH: 0,
    x: 0,
    z: 0,
    h: 0,
    sx: new Float32Array(8),
    sz: new Float32Array(8),
    sh: new Float32Array(8),
    st: new Float32Array(8),
    sn: 0,
    sc: 0,
  };
}

function sampleEnt(ent: Ent, tick: number, draw: DrawPet): void {
  if (ent.sn === 0) {
    draw.x = ent.x;
    draw.z = ent.z;
    draw.h = ent.h;
    return;
  }
  const start = (ent.sc - ent.sn + 8) % 8;
  let prev = -1;
  let next = -1;
  for (let k = 0; k < ent.sn; k++) {
    const i = (start + k) % 8;
    if (ent.st[i]! <= tick) prev = i;
    else {
      next = i;
      break;
    }
  }
  if (prev < 0) {
    draw.x = ent.sx[start]!;
    draw.z = ent.sz[start]!;
    draw.h = ent.sh[start]!;
    return;
  }
  if (next < 0) {
    draw.x = ent.sx[prev]!;
    draw.z = ent.sz[prev]!;
    draw.h = ent.sh[prev]!;
    return;
  }
  const span = ent.st[next]! - ent.st[prev]!;
  const t = span > 1e-4 ? (tick - ent.st[prev]!) / span : 0;
  draw.x = ent.sx[prev]! + (ent.sx[next]! - ent.sx[prev]!) * t;
  draw.z = ent.sz[prev]! + (ent.sz[next]! - ent.sz[prev]!) * t;
  draw.h = lerpAngle(ent.sh[prev]!, ent.sh[next]!, t);
}

function formatTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`;
}

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* optional */
  }
}

declare global {
  interface Window {
    __game?: {
      phase: string;
      mode: string;
      ready: boolean;
      perf: Perf['stats'];
      snapshotUploads: number;
      player: () => {
        id: number;
        x: number;
        y: number;
        heading: number;
        land: number;
        alive: boolean;
        kills: number;
        train: number;
        outside: boolean;
      };
      sampleTrails: (limit?: number) => Array<{ x: number; y: number; owner: number }>;
      sampleOwnTrail: (limit?: number) => Array<{ x: number; y: number; owner: number }>;
      entities: () => Array<{ id: number; x: number; y: number; land: number; alive: boolean; bot: boolean; train: number; name: string; outside: boolean }>;
      landCheck: () => {
        id: number;
        cells: { x0: number; y0: number; x1: number; y1: number; w: number; h: number; cells: number } | null;
        pixels: {
          pixels: number;
          boxW: number;
          boxH: number;
          minX: number;
          minY: number;
          maxX: number;
          maxY: number;
        } | null;
        screen: { x0: number; y0: number; x1: number; y1: number; dpr: number } | null;
      };
    };
  }
}
