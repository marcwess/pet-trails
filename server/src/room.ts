import {
  FLAG_ALIVE,
  FLAG_BOT,
  FLAG_OUTSIDE,
  RARITY_ORDER,
  SPECIES,
  parseClientMsg,
  type DeltaMsg,
  type EntSnap,
  type Kit,
  type WelcomeMsg,
  type WireEvent,
  Sim,
} from '@pet-trails/shared';
import type { WebSocket } from 'ws';

export interface Conn {
  ws: WebSocket;
  id: number | null;
  name: string;
  pet: number;
  /** `null` means the client sent a kit the tables reject. */
  kit: Kit | null;
  level: number;
  wantPlay: boolean;
  home: Room;
}

/**
 * One persistent room. The sim is authoritative; sockets only carry inputs
 * and compact deltas (changed cells, not the whole grid).
 */
export class Room {
  readonly sim: Sim;
  readonly createdAt = Date.now();
  /** Set by the hub. A dead player, or a finished round, asks to move to a fresh room. */
  onRejoin: ((conn: Conn) => void) | null = null;
  private readonly conns: Conn[] = [];
  constructor(seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) {
    this.sim = new Sim({}, seed);
    this.sim.lockstep = true;
  }

  /** Still in its opening seconds: a new player may join this round. */
  isOpen(now = Date.now()): boolean {
    return !this.sim.over && !this.sim.sealed && now - this.createdAt < this.sim.cfg.roundOpenSec * 1000;
  }

  /** No sockets and no longer joinable. The hub can stop ticking it. */
  idle(now = Date.now()): boolean {
    return this.conns.length === 0 && !this.isOpen(now);
  }

  hasSlot(): boolean {
    return this.conns.length < this.sim.cfg.maxEntities && !this.sim.over;
  }

  addSocket(ws: WebSocket): void {
    const conn: Conn = { ws, id: null, name: 'You', pet: -1, kit: null, level: 1, wantPlay: false, home: this };
    this.conns.push(conn);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = typeof data === 'string' ? data : data.toString();
      conn.home.onMessage(conn, text);
    });
    ws.on('close', () => conn.home.drop(conn));
    ws.on('error', () => conn.home.drop(conn));
  }

  /**
   * Hold the socket out of every match until Play. Seating on page load put the
   * player in a room that filled with bots and sealed while they were still on Home.
   */
  static park(ws: WebSocket, join: () => Room): void {
    const conn: Conn = {
      ws,
      id: null,
      name: 'You',
      pet: -1,
      kit: null,
      level: 1,
      wantPlay: false,
      home: undefined as unknown as Room,
    };
    let seated = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = typeof data === 'string' ? data : data.toString();
      if (!seated) {
        const msg = parseClientMsg(text);
        if (!msg) return;
        if (msg.t === 'hello') {
          conn.name = msg.name ?? 'You';
          if (msg.pet !== undefined) conn.pet = msg.pet;
          if (msg.kit !== undefined) conn.kit = msg.kit;
          if (msg.level !== undefined) conn.level = msg.level;
          return;
        }
        if (msg.t === 'ping') {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong', n: msg.n }));
          return;
        }
        if (msg.t === 'play') {
          seated = true;
          conn.wantPlay = true;
          join().seat(conn);
          return;
        }
        return;
      }
      conn.home.onMessage(conn, text);
    });
    const leave = () => {
      if (seated) conn.home.drop(conn);
    };
    ws.on('close', leave);
    ws.on('error', leave);
  }

  /** First Play, or a move from another room. */
  seat(conn: Conn): void {
    this.receive(conn);
  }

  /** Drop the player out of this room without closing the socket, then join `next`. */
  moveTo(conn: Conn, next: Room): void {
    this.detach(conn);
    next.receive(conn);
  }

  private detach(conn: Conn): void {
    const i = this.conns.indexOf(conn);
    if (i >= 0) this.conns.splice(i, 1);
    if (conn.id !== null) {
      this.sim.remove(conn.id);
      conn.id = null;
    }
    conn.wantPlay = false;
  }

  private receive(conn: Conn): void {
    conn.home = this;
    conn.id = null;
    conn.wantPlay = true;
    if (!this.conns.includes(conn)) this.conns.push(conn);
    this.spawn(conn);
  }

  /** One authoritative tick plus a fan-out of deltas. */
  step(): void {
    let humans = 0;
    for (const c of this.conns) if (c.id !== null) humans++;
    this.sim.step({ humans });
    this.broadcast();
  }

  private onMessage(conn: Conn, text: string): void {
    const msg = parseClientMsg(text);
    if (!msg) return;
    if (msg.t === 'hello') {
      conn.name = msg.name ?? 'You';
      if (msg.pet !== undefined) conn.pet = msg.pet;
      if (msg.kit !== undefined) conn.kit = msg.kit;
      if (msg.level !== undefined) conn.level = msg.level;
      if (conn.wantPlay) this.spawn(conn);
      return;
    }
    if (msg.t === 'play') {
      conn.wantPlay = true;
      this.spawn(conn);
      return;
    }
    if (msg.t === 'ability' && conn.id !== null) {
      this.sim.useAbility(conn.id);
      return;
    }
    if (msg.t === 'input' && conn.id !== null) {
      this.sim.setInput(conn.id, msg.x, msg.y, msg.seq);
      return;
    }
    if (msg.t === 'ping') {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify({ t: 'pong', n: msg.n }));
      }
    }
  }

  private spawn(conn: Conn): void {
    const pet = conn.pet >= 0 && conn.pet < SPECIES.length ? conn.pet : Math.floor(Math.random() * SPECIES.length);
    conn.pet = pet;
    if (conn.id === null) {
      // The socket was seated when the page loaded. If the player idled on Home past the
      // opening window, this round is already sealed: start in one that is still open.
      if (this.onRejoin && !this.isOpen()) {
        this.onRejoin(conn);
        return;
      }
      const p = this.sim.addHuman(conn.name, pet, conn.kit, conn.level);
      if (!p) {
        if (this.onRejoin) {
          this.onRejoin(conn);
          return;
        }
        this.send(conn, { t: 'full' });
        return;
      }
      conn.id = p.id;
      // First look at the room. Send every current polygon, not a cell snapshot.
      this.sendWelcome(conn);
      this.sendDelta(conn, this.sim.consumeEvents(), this.sim.land.encodeAll());
      return;
    }
    const existing = this.sim.players[conn.id];
    // Eliminated pets stay out. Play Again moves the socket to a room that is still opening.
    if (!existing?.alive || this.sim.over) {
      this.onRejoin?.(conn);
      return;
    }
  }

  private drop(conn: Conn): void {
    const i = this.conns.indexOf(conn);
    if (i >= 0) this.conns.splice(i, 1);
    if (conn.id !== null) {
      this.sim.remove(conn.id);
      conn.id = null;
    }
  }

  private broadcast(): void {
    const events = this.sim.consumeEvents() as WireEvent[];
    const lands = this.sim.landPatch();
    for (const conn of this.conns) {
      if (conn.id === null || conn.ws.readyState !== conn.ws.OPEN) continue;
      this.sendDelta(conn, events, lands);
    }
  }

  private sendDelta(conn: Conn, events: WireEvent[], lands: number[]): void {
    const id = conn.id;
    if (id === null) return;
    const self = this.sim.players[id];
    if (!self) return;
    const ents: EntSnap[] = [];
    for (const p of this.sim.roster) {
      if (!p.active) continue;
      let f = 0;
      if (p.alive) f |= FLAG_ALIVE;
      if (p.bot) f |= FLAG_BOT;
      if (p.outside) f |= FLAG_OUTSIDE;
      const visible = Math.min(this.sim.cfg.maxTrainVisible, p.trainLen);
      const tr: number[] = [];
      for (let i = 0; i < visible; i++) tr.push(p.train[i]!);
      ents.push({
        i: p.id,
        x: round3(p.x),
        y: round3(p.y),
        h: round3(p.heading),
        l: p.land,
        p: p.pet,
        f,
        k: p.kills,
        c: p.coins,
        xp: Math.round(p.xp),
        tn: p.trainLen,
        tr,
        ry: Math.max(0, RARITY_ORDER.indexOf(p.rarity)),
        cd: Math.max(0, (p.cdUntil - this.sim.tick) / this.sim.cfg.tickHz),
        st:
          (this.sim.tick < p.dashUntil ? 1 : 0) |
          (this.sim.tick < p.shieldUntil ? 2 : 0) |
          (this.sim.tick < p.slowUntil ? 4 : 0),
        lv: p.level,
      });
    }
    const delta: DeltaMsg = {
      t: 'delta',
      tick: this.sim.tick,
      ack: self.lastSeq,
      you: [round3(self.x), round3(self.y), round3(self.heading)],
      ents,
      events,
    };
    if (lands.length > 0) delta.lands = lands;
    delta.pickups = this.encodePickups();
    this.send(conn, delta);
  }

  private sendWelcome(conn: Conn): void {
    const names: WelcomeMsg['names'] = [];
    for (const p of this.sim.roster) {
      if (!p.active) continue;
      names.push({ i: p.id, n: p.name, p: p.pet, b: p.bot ? 1 : 0 });
    }
    const msg: WelcomeMsg = {
      t: 'welcome',
      id: conn.id!,
      tick: this.sim.tick,
      gridW: this.sim.cfg.gridW,
      gridH: this.sim.cfg.gridH,
      pet: conn.pet,
      tickHz: this.sim.cfg.tickHz,
      seed: this.sim.seed,
      names,
    };
    this.send(conn, msg);
  }

  private encodePickups(): number[] {
    const out: number[] = [];
    for (const item of this.sim.activePickups()) {
      out.push(item.id, item.kind, round3(item.x), round3(item.y));
    }
    return out;
  }

  private send(conn: Conn, msg: object): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
