import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

export interface ServerHandle {
  port: number;
  room: Room;
  close: () => Promise<void>;
}

export function startServer(opts?: { port?: number; host?: string; tick?: boolean; seed?: number }): Promise<ServerHandle> {
  const port = opts?.port ?? (Number(process.env.PORT) || 8787);
  const host = opts?.host ?? '0.0.0.0';
  const tick = opts?.tick !== false;
  const room = new Room(opts?.seed);
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
  wss.on('connection', (ws) => room.addSocket(ws));

  let timer: NodeJS.Timeout | null = null;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      if (tick) {
        const hz = room.sim.cfg.tickHz;
        timer = setInterval(() => {
          try {
            room.step();
          } catch (err) {
            console.error('tick failed', err);
          }
        }, 1000 / hz);
      }
      resolve({
        port: bound,
        room,
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

