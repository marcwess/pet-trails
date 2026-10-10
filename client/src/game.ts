import {
  ABILITY_ICON,
  CONFIG,
  cloneMulti,
  FLAG_ALIVE,
  FLAG_BOT,
  FLAG_OUTSIDE,
  PALETTE,
  RARITY_ORDER,
  SPECIES,
  SPECIES_LABEL,
  Sim,
  applyXp,
  cooldownBase,
  cooldownOf,
  equippedPet,
  kitOf,
  levelPower,
  recolorId,
  trailId,
  unlockNames,
  mapBlob,
  randomSeed,
  ringArea,
  integrateBody,
  angleDelta,
  effectOf,
  lerpAngle,
  speedMultiplier,
  xpForLevel,
  type ActiveId,
  type DeltaMsg,
  type EntSnap,
  type PetInstance,
  type Profile,
  type Ring,
  type WelcomeMsg,
  type WireEvent,
} from '@pet-trails/shared';
import { consumeSteps } from './clock.js';
import { Collection } from './collection.js';
import { Hud, cssColor, type BoardRow } from './hud.js';
import { Input } from './input.js';
import { sfx } from './sfx.js';
import { NetClient } from './net.js';
import { saveProfile } from './profileStore.js';
import { Renderer, type DrawPet, type DrawPickup } from './render.js';
import { gfx } from './gfx.js';
import type { Perf } from './perf.js';
import type { Territory } from './territory.js';

/** How long a seated pet waits at spawn before walking its facing direction. */
const PARK_MS = 2500;

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
  level: number;
  train: Uint8Array;
  trainShown: number;
  trainLen: number;
  hop: number;
  outside: boolean;
  blinkUntil: number;
  rarity: number;
  status: number;
  cdLeft: number;
  cdAt: number;
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
  turnVel: number;
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
  private boundary: Ring | null = null;
  private predPrevX = 0;
  private predPrevY = 0;
  private predPrevH = 0;
  private predAcc = 0;
  private readonly predHist: Array<{ seq: number; x: number; y: number; h: number; dx: number; dy: number; mul: number; tv: number }> = [];
  private offX = 0;
  private offY = 0;
  private offH = 0;
  private offVx = 0;
  private offVy = 0;
  private offVh = 0;
  private localDashUntil = 0;
  private remoteClock = 0;
  private remoteInit = false;
  private frameDt = 0;
  private winTimer = 0;
  /** Elimination beat before the title screen. The camera stays where the pet fell. */
  private homeTimer = 0;
  private homeReward: { coins: number; xp: number; levelUp: boolean } | null = null;
  private seq = 1;
  private alpha = 1;
  private snapCam = false;
  private serverTick = 0;
  private serverTickAt = 0;
  private serverAck = 0;
  /** When the pet was seated and parked. Auto-start fires PARK_MS later. */
  private parkedAt = 0;
  private hitLeft = 0;
  private previewSpecies: number | null = null;
  private previewLevel = 1;
  private readonly collection: Collection;
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
  private readonly body: Body = { x: 0, y: 0, heading: 0, desiredX: 0, desiredY: 0, turnVel: 0 };
  private predTurn = 0;
  private lastSendAt = 0;
  private heldLands: number[] | null = null;
  private heldUntil = 0;
  private deferAdopt = false;
  private jerkMax = 0;
  private longFrames = 0;
  private metricFrames = 0;
  private dtMax = 0;
  private readonly jerkRing = new Float32Array(240);
  private jerkWrite = 0;
  private prevSx = 0;
  private prevSy = 0;
  private prevVx = 0;
  private prevVy = 0;
  private metricInit = false;
  private predX = 0;
  private predY = 0;
  private predH = 0;
  private predDX = 0;
  private predDY = 0;
  private predPrimed = false;
  /** False until the welcome for the round we just joined. Deltas before that belong to the previous room. */
  private joined = false;
  /** True once the player has aimed, or the park timer kicked the pet off. Until then we do not transmit the spawn heading. */
  private sentSteer = false;
  /** Last rendered own-pet position, in cells. Metrics and the trail both use this. */
  private shownX = 0;
  private shownY = 0;
  private shownH = 0;
  /** Reconciliation steps whose error exceeded half a cell. */
  private fixCount = 0;
  private displayName = 'You';
  private arenaArea = ringArea(mapBlob(1, CONFIG.gridW, CONFIG.gridH));
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
        name: '',
        rarity: 0,
        dash: false,
        shield: false,
        slow: false,
        recolor: 0,
        trail: 0,
      });
    }
    for (let i = 0; i < 72; i++) this.drawPickups.push({ x: 0, z: 0, kind: 0 });
    for (let i = 0; i < 6; i++) this.board.push({ name: '', pct: '', me: false, color: '#fff', show: false });
    this.net.onMode = (mode) => {
      this.hud.setChip(mode);
      if (mode === 'offline' && this.phase === 'playing' && !this.offline) this.onDisconnect();
    };
    this.net.onWelcome = (msg) => this.onWelcome(msg);
    this.net.onDelta = (msg) => this.onDelta(msg);
    this.net.onFull = () => {
      if (this.phase !== 'title' && this.net.mode !== 'online') this.startOffline();
    };
    this.hud.onPlay(() => void this.play());
    this.hud.onAbility(() => this.cast());
    this.hud.onPet(() => this.renderer.poke());
    this.collection = new Collection(profile, {
      save: () => saveProfile(this.profile),
      preview: (species, level) => {
        this.previewSpecies = species;
        this.previewLevel = level ?? 1;
      },
      line: () => this.hud.setPetLine(this.petLabel()),
      portrait: (species) => this.renderer.portraitURLs[species] ?? '',
      silhouette: (species) => this.renderer.silhouetteURLs[species] ?? '',
    });
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
      landVerts: () => this.territory.vertexCount(),
      landPoly: (id?: number) => this.territory.polygon(id ?? this.selfId),
      steer: (x: number, y: number) => {
        this.input.desiredX = x;
        this.input.desiredY = y;
      },
      project: (x: number, y: number) => this.renderer.project(x, 0, y),
      smooth: () => this.smoothView(),
      inputDebug: () => ({ ...this.input.debug(), seq: this.seq, ack: this.serverAck }),
      trace: () => this.net.trace.slice(),
      feel: () => {
        const cam = this.renderer.frameCam();
        const screen = this.renderer.project(this.shownX, 0, this.shownY);
        return {
          x: this.shownX,
          y: this.shownY,
          h: this.shownH,
          sx: screen.x,
          sy: screen.y,
          camX: cam.x,
          camY: cam.y,
          camZ: cam.z,
          fixes: this.fixCount,
        };
      },
      showPets: () => this.collection.showPets(),
      showBoxes: () => this.collection.showBoxes(),
      cast: (kind?: string) => this.cast(kind),
      screen: () => this.collection.phase(),
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
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    this.joined = false;
    this.sentSteer = false;
    this.predPrimed = false;
    this.selfId = 0;
    this.seq = 0;
    this.serverAck = 0;
    this.predDX = 0;
    this.predDY = 0;
    this.predTurn = 0;
    this.predHist.length = 0;
    for (const ent of this.ents) ent.used = false;
    this.died = false;
    this.shownKills = 0;
    sfx.play();
    this.shownPct = 0;
    this.peakPct = 0;
    this.winTimer = 0;
    this.homeTimer = 0;
    this.homeReward = null;
    this.pendingWin = null;
    this.fixCount = 0;
    // Drop the previous seat before the socket can deliver another delta.
    this.joined = false;
    this.sentSteer = false;
    this.predPrimed = false;
    this.selfId = 0;
    this.seq = 0;
    this.serverAck = 0;
    this.predDX = 0;
    this.predDY = 0;
    this.predHist.length = 0;
    for (const ent of this.ents) ent.used = false;
    this.hud.hideWin();
    this.hud.hideOut();
    this.hud.showDeath(null);
    this.hud.setYou('0.0%', 0, 0);
    this.displayName = readName();
    const mode = await this.net.whenSettled();
    this.hud.showTitle(false);
    this.hud.showHud(true);
    this.hud.showSteer();
    this.snapCam = true;
    if (mode === 'online') {
      this.offline = null;
      const pet = this.equipped();
      const kit = kitOf(pet);
      this.net.send({
        t: 'hello',
        name: this.displayName,
        pet: pet.species,
        level: pet.level,
        rarity: kit.rarity,
        actives: kit.actives,
        passives: kit.passives,
        eqA: kit.equippedActive,
        eqP: kit.equippedPassive,
      });
      this.net.send({ t: 'play' });
      this.phase = 'playing';
    } else {
      this.offline = null;
      this.startOffline();
    }
  }

  private startOffline(): void {
    const params = new URLSearchParams(location.search);
    const pop = Number(params.get('pop'));
    const sim = new Sim(
      params.has('solo')
        ? { targetPopulation: 1, pickupTarget: 0 }
        : Number.isFinite(pop) && pop >= 1
          ? { targetPopulation: Math.min(11, Math.floor(pop)), pickupTarget: 0 }
          : {},
      randomSeed(),
    );
    sim.lockstep = true;
    const player = sim.addHuman(this.displayName, this.equipped().species, kitOf(this.equipped()), this.equipped().level);
    if (!player) return;
    this.joined = true;
    this.sentSteer = false;
    this.parkedAt = performance.now();
    this.seq = 0;
    this.offline = sim;
    this.selfId = player.id;
    this.applyArena(sim.seed);
    const ids: number[] = [];
    for (let id = 1; id <= sim.cfg.maxEntities; id++) if (sim.land.get(id).length > 0) ids.push(id);
    this.territory.adopt(sim.land, ids);
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
      icon: '⚡',
      rows: [
        { k: 'Status', v: 'Offline', icon: '●' },
        { k: 'Next', v: 'Play again', icon: '▶' },
      ],
    });
  }

  private tick(dt: number): void {
    if (this.hitLeft > 0) this.hitLeft = Math.max(0, this.hitLeft - dt);
    const frame = this.hitLeft > 0 ? 0 : dt;
    for (const ent of this.ents) if (ent.hop > 0) ent.hop = Math.max(0, ent.hop - dt);
    const self = this.ents[this.selfId];
    if (self) this.renderer.landPct = self.land / this.arenaArea;
    const seated = this.phase === 'playing' && (this.offline !== null || this.joined);
    if (this.phase === 'playing' && !this.sentSteer) this.input.claimHeld();
    this.input.sample();
    if (seated && !this.sentSteer && (this.offline !== null || this.predPrimed) && performance.now() - this.parkedAt >= PARK_MS) {
      this.kickoff();
    }
    const parked = seated && !this.sentSteer;
    if (parked) this.hud.showSteer();
    else if (this.phase === 'playing') this.hud.hideSteer();
    const stick = this.input.stick();
    this.hud.setStick(stick.x, stick.y, stick.dx, stick.dy, stick.on && this.phase === 'playing');
    this.frameDt = dt;
    if (this.phase === 'playing') {
      if (this.offline) this.stepOffline(dt);
      else this.stepOnline(dt);
      this.hud.setLeft(this.aliveCount());
    }
    if (this.winTimer > 0) {
      this.winTimer -= dt;
      if (this.winTimer <= 0) this.finishWin();
    }
    if (this.homeTimer > 0) {
      this.homeTimer -= dt;
      if (this.homeTimer <= 0) this.returnHome();
    }
    this.hud.showAbility(this.phase === 'playing');
    if (this.phase === 'playing') this.hud.setAbility(this.abilityIcon(), this.abilityLeft(), this.abilityTotal());
    this.renderer.heroRecolor = recolorId(this.previewSpecies === null ? this.equipped().level : this.previewLevel);
    const screen = this.collection.phase();
    this.renderer.stageKind =
      screen === 'detail' ? 'detail' : screen === 'reveal' || screen === 'burst' || screen === 'shake' ? 'reveal' : 'home';
    if (screen === 'detail') {
      const tt = document.querySelector('.turntable');
      const r = tt ? tt.getBoundingClientRect() : null;
      const vh = window.innerHeight || 1;
      this.renderer.detailBox = r && r.height > 0 ? { cy: (r.top + r.bottom) / 2 / vh, h: r.height / vh } : null;
    } else if (this.renderer.stageKind === 'reveal') {
      // The pet stands in the band above the card (where the card will land while it is still hidden).
      const card = document.getElementById('reveal-card');
      const r = card && !card.hidden ? card.getBoundingClientRect() : null;
      const vh = window.innerHeight || 1;
      const bottom = r && r.height > 0 ? r.top / vh : 0.6;
      const top = 0.06;
      this.renderer.detailBox = bottom - top > 0.1 ? { cy: (top + bottom) / 2, h: bottom - top } : null;
    } else this.renderer.detailBox = null;
    if (this.phase === 'title' && screen !== 'detail') {
      const slot = document.querySelector('.stage-slot');
      const r = slot ? slot.getBoundingClientRect() : null;
      const vh = window.innerHeight || 1;
      this.renderer.homeBox = r && r.height > 0 ? { top: r.top / vh, bottom: r.bottom / vh } : null;
    }
    if (this.heldLands && performance.now() >= this.heldUntil) {
      this.territory.applyEncoded(this.heldLands);
      this.heldLands = null;
    }
    if (this.deferAdopt && this.offline && performance.now() >= this.heldUntil) {
      const sim = this.offline;
      const ids: number[] = [];
      for (let id = 1; id <= sim.cfg.maxEntities; id++) if (sim.land.get(id).length > 0) ids.push(id);
      this.territory.adopt(sim.land, ids);
      this.deferAdopt = false;
    }
    if (this.phase === 'title') {
      this.hud.setPetCard(this.cardView());
      this.hud.setEconomy(this.profile.coins, this.profile.freeBoxes, CONFIG.boxPrice, this.profile.pets.length);
    }
    if (this.phase === 'playing') this.noteMotion(dt);
    this.hud.setDebug(this.debugLine());
    const petCount = this.fillDraw();
    const view = this.phase === 'title' ? 'title' : this.phase === 'dead' ? 'dead' : 'play';
    const hero = this.previewSpecies ?? this.equipped().species;
    this.renderer.parkHint = parked;
    this.renderer.update(frame || dt * 0.15, view, hero, this.drawPets, petCount, this.drawPickups, this.phase === 'title' ? 0 : this.pickupCount, this.snapCam && this.phase === 'playing');
    if (this.phase !== 'title') this.snapCam = false;
    if (gfx.cpu) this.hud.setLabels(this.renderer.labels);
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
    const stepped = consumeSteps(this.acc, dt, tickDt, 5);
    this.acc = stepped.acc;
    for (let i = 0; i < stepped.steps; i++) {
      const mag = Math.hypot(this.input.desiredX, this.input.desiredY);
      if (mag > 0.15) this.sentSteer = true;
      if (this.sentSteer) {
        const ix = mag > 0.15 ? this.input.desiredX / mag : 0;
        const iy = mag > 0.15 ? this.input.desiredY / mag : 0;
        this.seq++;
        sim.setInput(this.selfId, ix, iy, this.seq);
      }
      sim.step({ humans: 1 });
      this.consume(sim.consumeEvents());
      this.syncOffline(sim, false);
      this.pickupCount = 0;
      sim.forEachActivePickup(this.readPickup);
    }
    this.alpha = stepped.alpha;
  }

  private stepOnline(dt: number): void {
    if (!this.joined) return;
    const mag = Math.hypot(this.input.desiredX, this.input.desiredY);
    if (mag > 0.15) {
      this.predDX = this.input.desiredX / mag;
      this.predDY = this.input.desiredY / mag;
      this.sentSteer = true;
    }
    const tickDt = 1 / CONFIG.tickHz;
    if (!this.predPrimed || !this.sentSteer) {
      this.predAcc = Math.min(tickDt, this.predAcc + Math.max(0, dt));
      const first = this.sentSteer && this.seq === 0;
      if (this.sentSteer && (first || this.predAcc >= tickDt) && this.seq - this.serverAck < 8) {
        if (!first) this.predAcc -= tickDt;
        this.seq++;
        this.net.send({ t: 'input', seq: this.seq, x: this.predDX, y: this.predDY });
        this.lastSendAt = performance.now();
      }
      this.resendStuck();
      this.decayOffset(dt);
      return;
    }
    if (this.serverAck > this.seq) this.seq = this.serverAck;
    const lead = 8;
    const stepped = consumeSteps(this.predAcc, dt, tickDt, 5);
    let steps = stepped.steps;
    const room = lead - (this.seq - this.serverAck);
    if (steps > room) {
      const extra = steps - Math.max(0, room);
      steps = Math.max(0, room);
      this.predAcc = Math.min(tickDt, stepped.acc + extra * tickDt);
    } else {
      this.predAcc = stepped.acc;
    }
    for (let i = 0; i < steps; i++) {
      this.predPrevX = this.predX;
      this.predPrevY = this.predY;
      this.predPrevH = this.predH;
      const mul = this.predSpeedMul();
      this.body.x = this.predX;
      this.body.y = this.predY;
      this.body.heading = this.predH;
      this.body.turnVel = this.predTurn;
      this.body.desiredX = this.predDX;
      this.body.desiredY = this.predDY;
      const cfg = this.predCfg(mul);
      integrateBody(this.body, tickDt, cfg, undefined, this.boundary ?? undefined);
      this.predX = this.body.x;
      this.predY = this.body.y;
      this.predH = this.body.heading;
      this.predTurn = this.body.turnVel ?? 0;
      this.seq++;
      this.net.send({ t: 'input', seq: this.seq, x: this.predDX, y: this.predDY });
      this.lastSendAt = performance.now();
      this.predHist.push({
        seq: this.seq,
        x: this.predX,
        y: this.predY,
        h: this.predH,
        dx: this.predDX,
        dy: this.predDY,
        mul,
        tv: this.predTurn,
      });
      if (this.predHist.length > 48) this.predHist.shift();
    }
    this.resendStuck();
    this.decayOffset(dt);
  }

  /** Reused so a dash tick does not allocate a config object. */
  private readonly speedCfg = { ...CONFIG };

  private predCfg(mul: number): typeof CONFIG {
    if (mul === 1) return CONFIG;
    this.speedCfg.speed = CONFIG.speed * mul;
    this.speedCfg.turnRate = CONFIG.turnRate * mul;
    return this.speedCfg;
  }

  /** If the next seq never got through, send it again instead of waiting out the skip. */
  private resendStuck(): void {
    const next = this.serverAck + 1;
    if (this.seq < next) return;
    let sample: (typeof this.predHist)[number] | null = null;
    for (let i = 0; i < this.predHist.length; i++) {
      if (this.predHist[i]!.seq === next) sample = this.predHist[i]!;
    }
    if (performance.now() - this.lastSendAt < 120) return;
    if (sample) {
      this.net.send({ t: 'input', seq: sample.seq, x: sample.dx, y: sample.dy });
    } else if (this.sentSteer && next === this.seq) {
      this.net.send({ t: 'input', seq: next, x: this.predDX, y: this.predDY });
    } else {
      return;
    }
    this.lastSendAt = performance.now();
  }

  private decayOffset(dt: number): void {
    const w = 20;
    [this.offX, this.offVx] = springTo(this.offX, this.offVx, 0, dt, w);
    [this.offY, this.offVy] = springTo(this.offY, this.offVy, 0, dt, w);
    [this.offH, this.offVh] = springTo(this.offH, this.offVh, 0, dt, w);
    if (this.offX * this.offX + this.offY * this.offY < 1e-4 && this.offVx * this.offVx + this.offVy * this.offVy < 1e-3) {
      this.offX = 0;
      this.offY = 0;
      this.offVx = 0;
      this.offVy = 0;
    }
    if (Math.abs(this.offH) < 1e-3 && Math.abs(this.offVh) < 1e-2) {
      this.offH = 0;
      this.offVh = 0;
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
        if (this.phase === 'playing' && p.alive) this.noteLand(ent.land, ent.kills, p.trainLen);
      } else {
        ent.kills = p.kills;
      }
      ent.coins = p.coins;
      ent.xp = p.xp;
      ent.outside = p.outside;
      ent.rarity = Math.max(0, RARITY_ORDER.indexOf(p.rarity));
      ent.status =
        (sim.tick < p.dashUntil ? 1 : 0) | (sim.tick < p.shieldUntil ? 2 : 0) | (sim.tick < p.slowUntil ? 4 : 0);
      ent.cdLeft = Math.max(0, (p.cdUntil - sim.tick) / sim.cfg.tickHz);
      ent.cdAt = performance.now();
      ent.level = p.level;
      if (p.trainLen > ent.trainLen) ent.hop = 0.72;
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

  private applyArena(seed: number): void {
    const ring = mapBlob(seed >>> 0, CONFIG.gridW, CONFIG.gridH);
    this.boundary = ring;
    this.arenaArea = ringArea(ring);
    this.renderer.setBoundary(ring);
  }

  private kickoff(): void {
    const h = this.facing();
    const x = Math.cos(h);
    const y = Math.sin(h);
    this.input.desiredX = x;
    this.input.desiredY = y;
    this.input.steering = true;
    this.predDX = x;
    this.predDY = y;
    this.sentSteer = true;
  }

  private facing(): number {
    if (this.offline) {
      const player = this.offline.players[this.selfId];
      if (player) return player.heading;
    }
    if (this.predPrimed) return this.predH;
    const ent = this.ents[this.selfId];
    if (ent && ent.used) return ent.h;
    return 0;
  }

  private onWelcome(msg: WelcomeMsg): void {
    this.joined = true;
    this.sentSteer = false;
    this.parkedAt = performance.now();
    this.selfId = msg.id;
    this.seq = 0;
    this.serverAck = 0;
    this.predDX = 0;
    this.predDY = 0;
    this.predTurn = 0;
    this.predPrimed = false;
    this.predHist.length = 0;
    for (const ent of this.ents) ent.used = false;
    this.offX = this.offY = this.offH = 0;
    this.offVx = this.offVy = this.offVh = 0;
    this.fixCount = 0;
    this.remoteInit = false;
    this.territory.clearAll();
    for (const ent of this.ents) ent.used = false;
    if (Number.isFinite(msg.seed)) this.applyArena(msg.seed);
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
    if (!this.joined) return;
    this.serverTick = msg.tick;
    this.serverTickAt = performance.now();
    this.serverAck = msg.ack;
    if (msg.events) {
      for (const ev of msg.events) {
        if (ev.e !== 'kill') continue;
        const stolen = cloneMulti(this.territory.polygon(ev.victim));
        if (stolen.length === 0) continue;
        const rgb = PALETTE[(Math.max(1, ev.victim) - 1) % PALETTE.length]!;
        this.renderer.sweepLand(stolen, rgb[0], rgb[1], rgb[2], ev.x, ev.y);
      }
    }
    const winEv = msg.events?.find((ev) => ev.e === 'win');
    if (winEv && winEv.e === 'win' && msg.lands && msg.lands.length > 0) {
      this.heldLands = msg.lands;
      const ent = this.ents[winEv.id];
      this.armWin(ent?.x ?? 0, ent?.z ?? 0, winEv.id);
    } else if (msg.lands && msg.lands.length > 0) {
      this.territory.applyEncoded(msg.lands);
    }
    if (msg.events) this.applyEvents(msg.events);
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
        this.predX = this.predPrevX = msg.you[0];
        this.predY = this.predPrevY = msg.you[1];
        this.predH = this.predPrevH = msg.you[2];
        this.predAcc = 0;
        this.serverAck = msg.ack;
        if (this.seq < msg.ack) this.seq = msg.ack;
        if (!this.sentSteer) {
          this.predDX = 0;
          this.predDY = 0;
        }
        this.predTurn = 0;
        this.offX = this.offY = this.offH = 0;
        this.predPrimed = true;
        this.snapCam = true;
      } else if (self.alive) {
        this.reconcile(msg.you[0], msg.you[1], msg.you[2], msg.ack);
      }
    }
  }

  /** Blend a server correction into the predicted pet. The picture never snaps. */
  private reconcile(sx: number, sy: number, sh: number, ack: number): void {
    let sample: (typeof this.predHist)[number] | null = null;
    for (let i = this.predHist.length - 1; i >= 0; i--) {
      if (this.predHist[i]!.seq <= ack) {
        sample = this.predHist[i]!;
        break;
      }
    }
    if (!sample) return;
    const err = Math.hypot(sx - sample.x, sy - sample.y);
    const herr = Math.abs(angleDelta(sample.h, sh));
    if (err < 0.28 && herr < 0.1) return;
    if (err > 0.5) this.fixCount++;
    if (err > 8) {
      this.snapPredict(sx, sy, sh);
      return;
    }
    const shown = this.renderedPredict();
    let x = sx;
    let y = sy;
    let h = sh;
    let tv = sample.tv;
    const tickDt = 1 / CONFIG.tickHz;
    for (let i = 0; i < this.predHist.length; i++) {
      const s = this.predHist[i]!;
      if (s.seq <= sample.seq) continue;
      const body = { x, y, heading: h, desiredX: s.dx, desiredY: s.dy, turnVel: tv };
      const cfg = this.predCfg(s.mul);
      integrateBody(body, tickDt, cfg, undefined, this.boundary ?? undefined);
      x = body.x;
      y = body.y;
      h = body.heading;
      tv = body.turnVel ?? 0;
      s.x = x;
      s.y = y;
      s.h = h;
      s.tv = tv;
    }
    this.predTurn = tv;
    let last: (typeof this.predHist)[number] | null = null;
    let prev: { x: number; y: number; h: number } | null = null;
    for (let i = 0; i < this.predHist.length; i++) {
      const s = this.predHist[i]!;
      if (s.seq <= sample.seq) continue;
      prev = last ? { x: last.x, y: last.y, h: last.h } : { x: sx, y: sy, h: sh };
      last = s;
    }
    if (last && prev) {
      this.predPrevX = prev.x;
      this.predPrevY = prev.y;
      this.predPrevH = prev.h;
      this.predX = last.x;
      this.predY = last.y;
      this.predH = last.h;
    } else {
      this.predPrevX = sx;
      this.predPrevY = sy;
      this.predPrevH = sh;
      this.predX = sx;
      this.predY = sy;
      this.predH = sh;
    }
    const next = this.renderedPredict();
    this.offX += shown.x - next.x;
    this.offY += shown.y - next.y;
    this.offH += angleDelta(next.h, shown.h);
  }

  private renderedPredict(): { x: number; y: number; h: number } {
    const tickDt = 1 / CONFIG.tickHz;
    const t = tickDt > 0 ? Math.min(1, this.predAcc / tickDt) : 1;
    return {
      x: this.predPrevX + (this.predX - this.predPrevX) * t + this.offX,
      y: this.predPrevY + (this.predY - this.predPrevY) * t + this.offY,
      h: lerpAngle(this.predPrevH, this.predH, t) + this.offH,
    };
  }

  private snapPredict(x: number, y: number, h: number): void {
    this.predPrevX = this.predX = x;
    this.predPrevY = this.predY = y;
    this.predPrevH = this.predH = h;
    this.offX = this.offY = this.offH = 0;
    this.offVx = this.offVy = this.offVh = 0;
    this.predTurn = 0;
    this.predHist.length = 0;
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
      if (this.phase === 'playing' && alive) this.noteLand(ent.land, ent.kills, snap.tn);
    } else {
      ent.kills = snap.k;
    }
    ent.coins = snap.c;
    ent.xp = snap.xp;
    ent.rarity = snap.ry;
    ent.status = snap.st;
    ent.cdLeft = snap.cd;
    ent.cdAt = performance.now();
    ent.level = snap.lv;
    if (snap.tn > ent.trainLen) ent.hop = 0.72;
    ent.trainLen = snap.tn;
    ent.trainShown = Math.min(CONFIG.maxTrainVisible, snap.tr.length, snap.tn);
    for (let i = 0; i < ent.trainShown; i++) ent.train[i] = snap.tr[i] ?? 0;
    if (ent.sn > 0) {
      // A respawn or a recall moves farther in one tick than any glide can. Pop to the
      // new spot instead of sliding across the map between the two snapshots.
      const last = (ent.sc + 7) % 8;
      if (Math.hypot(snap.x - ent.sx[last]!, snap.y - ent.sz[last]!) > 6) ent.sn = 0;
    }
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

  private consume(events: WireEvent[]): void {
    if (this.offline) {
      for (const ev of events) {
        if (ev.e !== 'kill') continue;
        const stolen = cloneMulti(this.territory.polygon(ev.victim));
        if (stolen.length === 0) continue;
        const rgb = PALETTE[(Math.max(1, ev.victim) - 1) % PALETTE.length]!;
        this.renderer.sweepLand(stolen, rgb[0], rgb[1], rgb[2], ev.x, ev.y);
      }
      const win = events.find((ev) => ev.e === 'win');
      if (win && win.e === 'win') {
        this.deferAdopt = true;
        const ent = this.ents[win.id];
        this.armWin(ent?.x ?? 0, ent?.z ?? 0, win.id);
      } else {
        this.territory.adopt(this.offline.land, this.offline.land.changedIds());
      }
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
        const killer = this.ents[ev.killer];
        this.renderer.burst(ev.x, ev.y, ev.victim, mine, killer?.x, killer?.z);
        if (mine) this.hitLeft = 0.06;
        if (ev.killer === this.selfId) {
          const victim = this.ents[ev.victim];
          const me = this.ents[this.selfId];
          if (me) {
            this.shownKills = Math.max(this.shownKills + 1, me.kills + 1);
            me.kills = this.shownKills;
            this.noteLand(me.land, me.kills, me.trainLen);
          }
          this.hud.killBanner(victim?.name || 'a pet');
          sfx.tap();
          buzz(14);
        }
      } else if (ev.e === 'claim') {
        this.renderer.clearPath(ev.id);
        this.renderer.dropCoveredTrails(ev.id);
        if (ev.id === this.selfId && ev.n > 12) {
          const pct = (ev.n / this.arenaArea) * 100;
          const at = this.renderer.project(ev.x, 1.6, ev.y);
          this.hud.popup(at.x, at.y, `+${pct.toFixed(1)}%`, 'claim');
          this.renderer.coinBurst(ev.x, ev.y);
          if (ev.n > 40) this.renderer.punchClaim();
          if (ev.n > 180) buzz(10);
        }
      } else if (ev.e === 'die') {
        if (ev.id === this.selfId && !this.died) this.onDeath(ev);
      } else if (ev.e === 'win') {
        if (ev.id === this.selfId) this.onWin(ev);
        else this.hud.winBanner(`${ev.name} conquered the map!`);
      } else if (ev.e === 'pickup' && ev.id === this.selfId) {
        const p = this.renderer.project(ev.x, 1.2, ev.y);
        if (ev.kind === 2) this.hud.popup(p.x, p.y, 'Loot!', 'loot');
        else if (ev.kind === 1) this.hud.popup(p.x, p.y, `+${ev.xp} XP`, 'xp');
        else this.hud.popup(p.x, p.y, `+${ev.amount}`, 'coin');
      } else if (ev.e === 'ability') {
        this.renderer.abilityFx(ev.kind, ev.x, ev.y, ev.r, ev.fx, ev.fy);
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
    this.grantRun(ev.coins, ev.xp);
    this.hud.setYou(`${pctNum.toFixed(1)}%`, ev.kills, ev.train);
    this.hud.hideSteer();
    this.hud.showHud(false);
    this.hud.showDeath(null);
    this.hud.showOut(`Out - ${placeLabel(ev.rank, ev.total)}`);
    this.homeTimer = 1.3;
    sfx.out();
    buzz(20);
  }

  private fillDraw(): number {
    let n = 0;
    const renderTick = this.offline ? 0 : this.presentationTick();
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
      draw.name = ent.name;
      draw.rarity = ent.rarity;
      draw.dash = (ent.status & 1) !== 0;
      draw.shield = (ent.status & 2) !== 0;
      draw.slow = (ent.status & 4) !== 0;
      draw.recolor = recolorId(ent.level);
      draw.trail = trailId(ent.level);
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
        const tickDt = 1 / CONFIG.tickHz;
        const t = tickDt > 0 ? Math.min(1, this.predAcc / tickDt) : 1;
        draw.x = this.predPrevX + (this.predX - this.predPrevX) * t + this.offX;
        draw.z = this.predPrevY + (this.predY - this.predPrevY) * t + this.offY;
        draw.h = lerpAngle(this.predPrevH, this.predH, t) + this.offH;
      } else {
        sampleEnt(ent, renderTick, draw);
      }
      if (draw.self) {
        this.shownX = draw.x;
        this.shownY = draw.z;
        this.shownH = draw.h;
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
    const total = this.arenaArea;
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
      this.noteLand(me.land, Math.max(me.kills, this.shownKills), me.trainLen);
    }
  }

  /** HUD percent and the You leaderboard row, from the same land count. */
  private noteLand(land: number, kills: number, train = 0): void {
    const pctNum = (land / this.arenaArea) * 100;
    this.shownPct = pctNum;
    if (pctNum > this.peakPct) this.peakPct = pctNum;
    const text = `${pctNum.toFixed(1)}%`;
    this.hud.setYou(text, kills, train);
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
        bot: false,
        xp: p?.xp ?? 0,
        level: p?.level ?? 1,
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
      bot: self?.bot ?? false,
      xp: self?.xp ?? 0,
      level: self?.level ?? 1,
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
    const mine = this.selfId;
    if (this.offline) {
      for (const p of this.offline.roster) {
        if (!p.active || p.trailLen === 0) continue;
        if (own ? p.id !== mine : p.id === mine) continue;
        const step = Math.max(1, Math.ceil(p.trailLen / Math.max(1, limit)));
        for (let i = 0; i < p.trailLen && out.length < limit; i += step) {
          out.push({ x: p.trailX[i]!, y: p.trailY[i]!, owner: p.id });
        }
      }
      return out;
    }
    for (let id = 1; id < this.ents.length && out.length < limit; id++) {
      if (own ? id !== mine : id === mine) continue;
      const loop = this.renderer.exportTrail(id);
      if (loop.n < 1) continue;
      const step = Math.max(1, Math.ceil(loop.n / Math.max(1, limit)));
      for (let i = 0; i < loop.n && out.length < limit; i += step) {
        out.push({ x: loop.x[i]!, y: loop.y[i]!, owner: id });
      }
    }
    return out;
  }

  private cardView() {
    const pet = this.equipped();
    const need = xpForLevel(pet.level);
    const boost = Math.round((levelPower(pet.level) - 1) * 100);
    return {
      name: SPECIES_LABEL[SPECIES[pet.species] ?? 'cat'] ?? 'Pet',
      level: pet.level,
      rarity: pet.rarity,
      xp: pet.level >= CONFIG.levelCap ? 1 : need > 0 ? pet.xp / need : 0,
      boost,
      unlocks: unlockNames(pet.level),
      reward: this.homeReward,
    };
  }

  private armWin(x: number, z: number, id: number): void {
    const rgb = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
    this.renderer.winWave(x, z, rgb[0], rgb[1], rgb[2]);
    this.heldUntil = performance.now() + 1200;
  }

  private noteMotion(dt: number): void {
    const screen = this.renderer.project(this.shownX, 0, this.shownY);
    if (!screen.ok) return;
    if (!this.metricInit) {
      this.prevSx = screen.x;
      this.prevSy = screen.y;
      this.metricInit = true;
      return;
    }
    const vx = screen.x - this.prevSx;
    const vy = screen.y - this.prevSy;
    const jerk = Math.hypot(vx - this.prevVx, vy - this.prevVy);
    this.jerkRing[this.jerkWrite % this.jerkRing.length] = jerk;
    this.jerkWrite++;
    if (jerk > this.jerkMax) this.jerkMax = jerk;
    if (dt > 0.024) this.longFrames++;
    if (dt > this.dtMax) this.dtMax = dt;
    this.metricFrames++;
    this.prevSx = screen.x;
    this.prevSy = screen.y;
    this.prevVx = vx;
    this.prevVy = vy;
  }

  private smoothView(): {
    jerkMax: number;
    jerkP95: number;
    longFrames: number;
    frames: number;
    dtMax: number;
    fps: number;
  } {
    const n = Math.min(this.jerkWrite, this.jerkRing.length);
    let p95 = 0;
    if (n > 0) {
      const copy = new Float32Array(n);
      if (this.jerkWrite <= this.jerkRing.length) copy.set(this.jerkRing.subarray(0, n));
      else {
        const start = this.jerkWrite % this.jerkRing.length;
        copy.set(this.jerkRing.subarray(start));
        copy.set(this.jerkRing.subarray(0, start), this.jerkRing.length - start);
      }
      const sorted = Array.from(copy).sort((a, b) => a - b);
      p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
    }
    return {
      jerkMax: this.jerkMax,
      jerkP95: p95,
      longFrames: this.longFrames,
      frames: this.metricFrames,
      dtMax: this.dtMax,
      fps: this.perf.stats.fps,
    };
  }

  private debugLine(): string {
    if (!this.hud.debugOn) return '';
    const d = this.input.debug();
    return (
      `touches ${d.touches} id ${d.pointerId}\n` +
      `stick ${d.active ? 'down' : 'up'} ${d.dirX.toFixed(2)},${d.dirY.toFixed(2)}\n` +
      `seq ${this.seq} ack ${this.serverAck}`
    );
  }

  petLabel(): string {
    const pet = this.equipped();
    const species = SPECIES[pet.species] ?? 'cat';
    const label = SPECIES_LABEL[species];
    return `Your pet · ${label} · Lv ${pet.level}`;
  }

  /** Mirror the server's speed multiplier so dash, swift, and frost don't rubber-band. */
  private predSpeedMul(): number {
    const pet = this.equipped();
    const status = this.ents[this.selfId]?.status ?? 0;
    const dashing = (status & 1) !== 0 || performance.now() < this.localDashUntil;
    return speedMultiplier(
      pet.rarity,
      pet.passives[pet.equippedPassive],
      dashing,
      (status & 4) !== 0 ? CONFIG.abilities.frostSlow : null,
      CONFIG,
      pet.level,
    );
  }

  private presentationTick(): number {
    const target = this.serverTick + ((performance.now() - this.serverTickAt) / 1000) * CONFIG.tickHz - 2;
    if (!this.remoteInit) {
      this.remoteClock = target;
      this.remoteInit = true;
      return this.remoteClock;
    }
    const step = Math.max(0, this.frameDt) * CONFIG.tickHz;
    const err = target - this.remoteClock;
    if (Math.abs(err) > 10) {
      // Far off (tab was hidden, room changed): jump once instead of fast-forwarding.
      this.remoteClock = target;
      return this.remoteClock;
    }
    // Slew, never jump. A late packet slows the clock a little; a burst speeds it up a
    // little. Snapping to the target made every remote pet hop on each hiccup.
    let rate = Math.max(0.6, Math.min(1.4, 1 + err * 0.35));
    // Ease off as the clock nears the newest snapshot, so a long stall glides to a stop
    // rather than running out of buffer and then leaping when data returns.
    const lead = this.serverTick - this.remoteClock;
    if (lead < 1) rate *= Math.max(0, lead);
    this.remoteClock += step * rate;
    return this.remoteClock;
  }

  private aliveCount(): number {
    let n = 0;
    for (const ent of this.ents) if (ent.used && ent.alive) n++;
    return n;
  }

  private pendingWin: Extract<WireEvent, { e: 'win' }> | null = null;

  private onWin(ev: Extract<WireEvent, { e: 'win' }>): void {
    this.pendingWin = ev;
    this.winTimer = 1.7;
    this.hud.winBanner('You conquered the map!');
    sfx.win();
    this.renderer.confetti(ev.id === this.selfId ? this.shownX : 0, ev.id === this.selfId ? this.shownY : 0);
  }

  private finishWin(): void {
    const ev = this.pendingWin;
    this.pendingWin = null;
    this.hud.hideWin();
    if (!ev || this.died) return;
    this.died = true;
    this.grantRun(ev.coins, ev.xp);
    this.returnHome();
  }

  /** Bank a run's coins and XP, and remember the line the home card will count up. */
  private grantRun(coins: number, xp: number): void {
    const levels = applyXp(this.equipped(), Math.round(xp), CONFIG.levelCap);
    this.profile.coins += Math.round(coins);
    saveProfile(this.profile);
    this.homeReward = {
      coins: Math.max(0, Math.round(coins)),
      xp: Math.max(0, Math.round(xp)),
      levelUp: levels > 0,
    };
  }

  /** Leave the held camera and sit on the title menu. Play starts a fresh round. */
  private returnHome(): void {
    this.homeTimer = 0;
    this.winTimer = 0;
    this.pendingWin = null;
    this.phase = 'title';
    this.api.phase = 'title';
    this.hud.hideWin();
    this.hud.hideOut();
    this.hud.showDeath(null);
    this.hud.showHud(false);
    this.hud.showTitle(true);
    this.hud.setPetCard(this.cardView());
  }

  private equipped(): PetInstance {
    return equippedPet(this.profile);
  }

  private cast(kind?: string): void {
    if (this.phase !== 'playing') return;
    if (!this.offline) {
      const pet = this.equipped();
      if (pet.actives[pet.equippedActive] === 'dash') {
        this.localDashUntil = performance.now() + effectOf(CONFIG.abilities.dashSec, pet.rarity, CONFIG, pet.level) * 1000;
      }
      this.net.send({ t: 'ability' });
      return;
    }
    const p = this.offline.players[this.selfId];
    if (!p) return;
    if (kind && (['dash', 'shield', 'paint', 'frost', 'recall'] as const).includes(kind as ActiveId)) {
      p.activeId = kind as ActiveId;
      p.cdUntil = 0;
    }
    if (!this.offline.useAbility(this.selfId)) return;
    this.consume(this.offline.consumeEvents());
    this.syncOffline(this.offline, false);
  }

  private abilityIcon(): string {
    if (this.offline) {
      const p = this.offline.players[this.selfId];
      if (p) return ABILITY_ICON[p.activeId];
    }
    return ABILITY_ICON[this.equipped().actives[this.equipped().equippedActive]];
  }

  private abilityTotal(): number {
    if (this.offline) {
      const p = this.offline.players[this.selfId];
      if (p) return cooldownOf(cooldownBase(p.activeId, this.offline.cfg), p.rarity, this.offline.cfg, p.level);
    }
    const pet = this.equipped();
    return cooldownOf(cooldownBase(pet.actives[pet.equippedActive]), pet.rarity, CONFIG, pet.level);
  }

  private abilityLeft(): number {
    if (this.offline) {
      const p = this.offline.players[this.selfId];
      if (!p) return 0;
      return Math.max(0, (p.cdUntil - this.offline.tick) / this.offline.cfg.tickHz);
    }
    const ent = this.ents[this.selfId];
    if (!ent) return 0;
    return Math.max(0, ent.cdLeft - (performance.now() - ent.cdAt) / 1000);
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
    level: 1,
    train: new Uint8Array(CONFIG.maxTrainVisible),
    trainShown: 0,
    trainLen: 0,
    hop: 0,
    outside: false,
    blinkUntil: 0,
    rarity: 0,
    status: 0,
    cdLeft: 0,
    cdAt: 0,
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

function readName(): string {
  const el = document.getElementById('name') as HTMLInputElement | null;
  const name = (el?.value ?? 'You').trim().slice(0, 16);
  return name || 'You';
}

/** Critically damped spring toward `target`. Closed form, so a hitch cannot ring. */
function springTo(pos: number, vel: number, target: number, dt: number, w: number): [number, number] {
  const t = Math.max(0, dt);
  const x = pos - target;
  const e = Math.exp(-w * t);
  const b = vel + w * x;
  const next = (x + b * t) * e;
  return [target + next, (b - w * (x + b * t)) * e];
}

function placeLabel(rank: number, total: number): string {
  const n = Math.max(1, rank | 0);
  const mod = n % 100;
  const suf = mod >= 11 && mod <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  const of = Math.max(n, total | 0);
  return `${n}${suf} of ${of}`;
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
        bot: boolean;
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
      landVerts: () => number;
      landPoly: (id?: number) => Array<Array<Array<[number, number]>>>;
      steer: (x: number, y: number) => void;
      project: (x: number, y: number) => { x: number; y: number; ok: boolean };
      smooth: () => {
        jerkMax: number;
        jerkP95: number;
        longFrames: number;
        frames: number;
        dtMax: number;
        fps: number;
      };
      inputDebug: () => {
        active: boolean;
        steering: boolean;
        pointerId: number;
        touches: number;
        seq: number;
        ack: number;
      };
      trace: () => string[];
      feel: () => {
        x: number;
        y: number;
        h: number;
        sx: number;
        sy: number;
        camX: number;
        camY: number;
        camZ: number;
        fixes: number;
      };
      showPets: () => void;
      showBoxes: () => void;
      cast: (kind?: string) => void;
      screen: () => string;
    };
  }
}
