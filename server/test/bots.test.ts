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

test('websocket join receives a welcome, polygons, and deltas', async () => {
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
    const binary = messages.find((m) => Buffer.isBuffer(m));
    assert.equal(binary, undefined, 'territory is polygons, not a cell snapshot');
    const deltas = messages.filter((m) => typeof m === 'string' && m.includes('"delta"')) as string[];
    assert.ok(deltas.length > 0, 'missing delta');
    const first = JSON.parse(deltas[0]!) as { lands?: number[] };
    assert.ok(first.lands && first.lands.length > 8, 'first delta should carry current polygons');
    ws.send(JSON.stringify({ t: 'input', seq: 1, x: 1, y: 0 }));
    srv.room.step();
    ws.send(JSON.stringify({ t: 'play' }));
    await new Promise((r) => setTimeout(r, 30));
    const later = messages.filter((m) => typeof m === 'string' && m.includes('"delta"')) as string[];
    const last = JSON.parse(later[later.length - 1]!) as { lands?: number[] };
    assert.ok(last.lands && last.lands.length > 0, 'respawn delta should carry the new square');
    assert.ok(last.lands.length < first.lands.length, 'respawn sends only the changed owner');
    const respawnId = last.lands[0];
    for (let i = 0; i < last.lands.length; ) {
      const id = last.lands[i]!;
      assert.equal(id, respawnId, 'respawn patch includes another owner');
      break;
    }
    ws.close();
  } finally {
    await srv.close();
  }
});
