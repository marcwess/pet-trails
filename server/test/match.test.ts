import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/index.ts';

function connect(port: number, name: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', function onMsg(data, isBinary) {
      if (isBinary) return;
      const text = data.toString();
      if (!text.includes('"welcome"')) return;
      ws.off('message', onMsg);
      resolve(ws);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', name, pet: 1 }));
      ws.send(JSON.stringify({ t: 'play' }));
    });
  });
}

test('a new player joins a room still in its opening seconds', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 42 });
  try {
    const a = await connect(srv.port, 'Ann');
    srv.room.step();
    const b = await connect(srv.port, 'Bea');
    srv.room.step();
    assert.equal(srv.rooms.length, 1);
    const names = srv.room.sim.roster.filter((p) => p.active && !p.bot).map((p) => p.name);
    assert.deepEqual(names.sort(), ['Ann', 'Bea']);
    a.close();
    b.close();
  } finally {
    await srv.close();
  }
});

test('a room older than the opening window starts a fresh one', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 7 });
  try {
    const a = await connect(srv.port, 'Ann');
    srv.room.step();
    (srv.room as { createdAt: number }).createdAt = Date.now() - 20_000;
    const b = await connect(srv.port, 'Bea');
    assert.equal(srv.rooms.length, 2);
    const fresh = srv.rooms[1]!;
    fresh.step();
    assert.equal(
      srv.room.sim.roster.some((p) => p.active && p.name === 'Bea'),
      false,
    );
    assert.ok(fresh.sim.roster.some((p) => p.active && p.alive && p.name === 'Bea'));
    a.close();
    b.close();
  } finally {
    await srv.close();
  }
});

test('play again after a defeat joins a new room and does not respawn in the old one', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 11 });
  try {
    const ws = await connect(srv.port, 'Ann');
    srv.room.step();
    const ann = srv.room.sim.roster.find((p) => p.name === 'Ann' && p.active);
    assert.ok(ann);
    const bot = srv.room.sim.roster.find((p) => p.bot && p.alive);
    assert.ok(bot);
    const oldId = ann.id;
    srv.room.sim.debugClear(ann.id);
    srv.room.sim.debugClear(bot.id);
    srv.room.sim.debugGiveRect(ann.id, 4, 4, 3, 3);
    srv.room.sim.debugGiveRect(bot.id, 16, 16, 8, 8);
    srv.room.sim.debugPlace(ann.id, 12.2, 12, 0);
    srv.room.sim.debugPlace(bot.id, 12.9, 12, Math.PI);
    ann.frozen = true;
    bot.frozen = true;
    srv.room.step();
    assert.equal(ann.alive, false, ann.deathReason);
    const welcomed = new Promise<void>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary && data.toString().includes('"welcome"')) resolve();
      });
    });
    ws.send(JSON.stringify({ t: 'play' }));
    await welcomed;
    assert.equal(srv.rooms.length, 2);
    assert.equal(srv.room.sim.players[oldId]?.active, false);
    const fresh = srv.rooms[1]!;
    fresh.step();
    const again = fresh.sim.roster.find((p) => p.active && p.name === 'Ann');
    assert.ok(again?.alive, 'Play Again should be alive in the new room');
    assert.equal(srv.room.sim.roster.some((p) => p.active && p.alive && p.name === 'Ann'), false);
    ws.close();
  } finally {
    await srv.close();
  }
});

test('play after idling on Home past the opening window starts in a fresh room', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 5 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ t: 'hello', name: 'Cal', pet: 2 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(srv.rooms.length, 1);
    (srv.room as { createdAt: number }).createdAt = Date.now() - 30_000;
    const welcomed = new Promise<void>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary && data.toString().includes('"welcome"')) resolve();
      });
    });
    ws.send(JSON.stringify({ t: 'play' }));
    await welcomed;
    assert.equal(srv.rooms.length, 2);
    assert.equal(srv.room.sim.roster.some((p) => p.active && p.name === 'Cal'), false);
    assert.ok(srv.rooms[1]!.sim.roster.some((p) => p.active && p.name === 'Cal'));
    assert.equal(srv.room.idle(), true, 'the abandoned room can be dropped');
    assert.equal(srv.rooms[1]!.idle(), false);
    ws.close();
  } finally {
    await srv.close();
  }
});
