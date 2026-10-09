import {
  FLAG_ALIVE,
  FLAG_BOT,
  FLAG_OUTSIDE,
  SPECIES,
  parseClientMsg,
  type DeltaMsg,
  type EntSnap,
  type WelcomeMsg,
  type WireEvent,
  Sim,
} from '@pet-trails/shared';
import type { WebSocket } from 'ws';

interface Conn {
  ws: WebSocket;
  id: number | null;
  name: string;
  pet: number;
  wantPlay: boolean;
}

/**
 * One persistent room. The sim is authoritative; sockets only carry inputs
 * and compact deltas (changed cells, not the whole grid).
 */
export class Room {
  readonly sim: Sim;
  private readonly conns: Conn[] = [];
  constructor(seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) {
    this.sim = new Sim({}, seed);
  }

  addSocket(ws: WebSocket): void {
    const conn: Conn = { ws, id: null, name: 'You', pet: -1, wantPlay: false };
    this.conns.push(conn);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = typeof data === 'string' ? data : data.toString();
      this.onMessage(conn, text);
    });
    ws.on('close', () => this.drop(conn));
    ws.on('error', () => this.drop(conn));
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
      if (conn.wantPlay) this.spawn(conn);
      return;
    }
    if (msg.t === 'play') {
      conn.wantPlay = true;
      this.spawn(conn);
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
      const p = this.sim.addHuman(conn.name, pet);
      if (!p) {
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
    if (existing) existing.pet = pet;
    // The client already has the map. Send only this owner's new square.
    this.sim.land.beginTick();
    this.sim.respawn(conn.id);
    this.sendWelcome(conn);
    this.sendDelta(conn, this.sim.consumeEvents(), this.sim.landPatch());
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
