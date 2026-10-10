import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, type Conn } from './room.js';

export interface ServerHandle {
  port: number;
  /** The first room. Tests that share one match still use this. */
  room: Room;
  rooms: Room[];
  close: () => Promise<void>;
}

export function startServer(opts?: { port?: number; host?: string; tick?: boolean; seed?: number }): Promise<ServerHandle> {
  const port = opts?.port ?? (Number(process.env.PORT) || 8787);
  const host = opts?.host ?? '0.0.0.0';
  const tick = opts?.tick !== false;
  const rooms: Room[] = [];
  const openFor = (room: Room) => room.sim.cfg.roundOpenSec * 1000;
  const makeRoom = () => {
    const room = new Room(opts?.seed === undefined ? undefined : opts.seed + rooms.length);
    room.onRejoin = (conn) => reseat(conn);
    rooms.push(room);
    return room;
  };
  const pick = (): Room => {
    const now = Date.now();
    for (const room of rooms) {
      if (room.sim.over || !room.hasSlot()) continue;
      if (now - room.createdAt >= openFor(room)) continue;
      return room;
    }
    return makeRoom();
  };
  const reseat = (conn: Conn) => {
    const now = Date.now();
    for (const candidate of rooms) {
      if (candidate === conn.home || candidate.sim.over || !candidate.hasSlot()) continue;
      if (now - candidate.createdAt >= openFor(candidate)) continue;
      conn.home.moveTo(conn, candidate);
      return;
    }
    const fresh = makeRoom();
    conn.home.moveTo(conn, fresh);
  };
  const room = makeRoom();
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pet-trails');
  });
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  wss.on('connection', (ws) => pick().addSocket(ws));

  let timer: NodeJS.Timeout | null = null;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      if (tick) {
        const hz = room.sim.cfg.tickHz;
        timer = setInterval(() => {
          for (const live of rooms) {
            try {
              live.step();
            } catch (err) {
              console.error('tick failed', err);
            }
          }
        }, 1000 / hz);
      }
      resolve({
        port: bound,
        room,
        rooms,
        close: () =>
          new Promise((done) => {
            if (timer) clearInterval(timer);
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

