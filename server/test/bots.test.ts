import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/index.ts';

test('server with bots survives 60 simulated seconds and produces kills and claims', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 123456 });
  try {
    const ticks = srv.room.sim.cfg.tickHz * 60;
    for (let i = 0; i < ticks; i++) srv.room.step();
    const { kills, claims, deaths, claimedCells } = srv.room.sim.stats;
    assert.ok(claims > 0, `expected claims, got ${claims}`);
    assert.ok(kills > 0, `expected kills, got ${kills} (deaths ${deaths}, claimed cells ${claimedCells})`);
    assert.ok(claimedCells > 50, `expected real territory, got ${claimedCells}`);
    let alive = 0;
    for (const p of srv.room.sim.roster) if (p.active && p.alive) alive++;
    assert.ok(alive >= 8, `room should stay busy, alive=${alive}`);
    assert.ok(srv.room.sim.auditLand());
  } finally {
    await srv.close();
  }
});

test('websocket join receives a welcome, the grid, and deltas', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 99 });
  try {
    const messages: Array<Buffer | string> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (data, isBinary) => {
      messages.push(isBinary ? Buffer.from(data as Buffer) : data.toString());
    });
    ws.send(JSON.stringify({ t: 'hello', name: 'Tester', pet: 3 }));
    ws.send(JSON.stringify({ t: 'play' }));
    srv.room.step();
    srv.room.step();
    await new Promise((r) => setTimeout(r, 50));
    const welcome = messages.find((m) => typeof m === 'string' && m.includes('"welcome"'));
    assert.ok(welcome, 'missing welcome');
    const grid = messages.find((m) => Buffer.isBuffer(m) && m[0] === 1);
    assert.ok(grid, 'missing grid snapshot');
    const cells = srv.room.sim.cfg.gridW * srv.room.sim.cfg.gridH;
    assert.equal((grid as Buffer).length, 5 + cells * 2);
    const delta = messages.find((m) => typeof m === 'string' && m.includes('"delta"'));
    assert.ok(delta, 'missing delta');
    ws.send(JSON.stringify({ t: 'input', seq: 1, x: 1, y: 0 }));
    srv.room.step();
    ws.close();
  } finally {
    await srv.close();
  }
});
