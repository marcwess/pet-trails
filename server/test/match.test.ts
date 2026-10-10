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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a human seat is never AI-driven, and the first input turns within 100ms', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 19 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ t: 'hello', name: 'Mia', pet: 21 }));
    await delay(30);
    for (let i = 0; i < 20; i++) srv.room.step();
    assert.equal(
      srv.room.sim.roster.some((p) => p.active && p.name === 'Mia'),
      false,
      'sitting on Home must not spawn the player into the bot match',
    );
    (srv.room as { createdAt: number }).createdAt = Date.now() - 30_000;
    const welcome = new Promise<number>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString();
        if (!text.includes('"welcome"')) return;
        resolve((JSON.parse(text) as { id: number }).id);
      });
    });
    ws.send(JSON.stringify({ t: 'play' }));
    const id = await welcome;
    const home = srv.rooms.find((room) => room.sim.players[id]?.active && room.sim.players[id]?.name === 'Mia');
    assert.ok(home, 'Play seats the socket in a room');
    assert.notEqual(home, srv.room, 'an aged room is not reused');
    const me = home!.sim.players[id]!;
    assert.equal(me.bot, false, 'the followed id is a human');
    assert.equal(me.id, id);
    const x = me.x;
    const y = me.y;
    const h = me.heading;
    for (let i = 0; i < 15; i++) home!.step();
    assert.equal(me.bot, false);
    assert.equal(me.botPhase, 0, 'bot AI must not run on the human');
    assert.equal(me.alive, true);
    assert.equal(me.x, x, 'the pet must not wander before the first steer');
    assert.equal(me.y, y);
    assert.equal(me.heading, h);
    const ix = -Math.sin(h);
    const iy = Math.cos(h);
    ws.send(JSON.stringify({ t: 'input', seq: 500, x: 1, y: 0 }));
    ws.send(JSON.stringify({ t: 'input', seq: 1, x: ix, y: iy }));
    await delay(30);
    home!.step();
    home!.step();
    assert.equal(me.bot, false);
    assert.equal(me.botPhase, 0);
    assert.equal(me.lastSeq, 1, 'seq 1 applies; a stale seq from the previous room does not skip ahead');
    assert.ok(Math.abs(me.heading - h) > 0.1, 'heading changes within two ticks (100ms)');
    assert.ok(Math.abs(me.desiredX - ix) < 0.05 && Math.abs(me.desiredY - iy) < 0.05);
    ws.close();
  } finally {
    await srv.close();
  }
});

test('play again re-keys the socket onto a new human and the old id is not a bot', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 23 });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  try {
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket never opened')), 1500);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    await opened;
    const welcome = () =>
      new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('welcome never arrived')), 1500);
        const onMsg = (data: Buffer | string, isBinary: boolean) => {
          if (isBinary) return;
          const text = data.toString();
          if (!text.includes('"welcome"')) return;
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve((JSON.parse(text) as { id: number }).id);
        };
        ws.on('message', onMsg);
      });
    const firstWelcome = welcome();
    ws.send(JSON.stringify({ t: 'hello', name: 'Ann', pet: 1 }));
    ws.send(JSON.stringify({ t: 'play' }));
    const firstId = await firstWelcome;
    srv.room.step();
    const first = srv.room.sim.players[firstId];
    assert.ok(first?.active && first.name === 'Ann');
    assert.equal(first.bot, false);
    const h0 = first.heading;
    ws.send(JSON.stringify({ t: 'input', seq: 1, x: -Math.sin(h0), y: Math.cos(h0) }));
    await delay(20);
    srv.room.step();
    srv.room.step();
    assert.equal(first.lastSeq, 1, 'the first life consumes seq 1');
    const bot = srv.room.sim.roster.find((p) => p.bot && p.alive);
    assert.ok(bot);
    srv.room.sim.debugClear(first.id);
    srv.room.sim.debugClear(bot.id);
    srv.room.sim.debugGiveRect(first.id, 4, 4, 3, 3);
    srv.room.sim.debugGiveRect(bot.id, 16, 16, 8, 8);
    srv.room.sim.debugPlace(first.id, 12.2, 12, 0);
    srv.room.sim.debugPlace(bot.id, 12.9, 12, Math.PI);
    first.frozen = true;
    bot.frozen = true;
    srv.room.step();
    assert.equal(first.alive, false);
    const nextWelcome = welcome();
    ws.send(JSON.stringify({ t: 'play' }));
    const id = await nextWelcome;
    const old = srv.room.sim.players[firstId];
    assert.equal(old?.active === true && old.bot === true, false, 'the old id must not come back as a bot');
    const fresh = srv.rooms.find((room) => room !== srv.room && room.sim.players[id]?.name === 'Ann');
    assert.ok(fresh, 'Play Again seats this socket in a different room');
    const again = fresh.sim.players[id]!;
    assert.equal(again.bot, false, 'the new seat is human');
    assert.equal(again.alive, true);
    assert.equal(again.lastSeq, 0, 'the new seat does not inherit the previous round seq');
    assert.equal(again.steered, false);
    const h = again.heading;
    // A high seq left over from the previous round must not skip the new seat.
    ws.send(JSON.stringify({ t: 'input', seq: 500, x: 1, y: 0 }));
    ws.send(JSON.stringify({ t: 'input', seq: 1, x: -Math.sin(h), y: Math.cos(h) }));
    await delay(20);
    fresh.step();
    fresh.step();
    assert.equal(again.bot, false);
    assert.equal(again.botPhase, 0);
    assert.equal(again.lastSeq, 1, 'seq 1 applies on the new seat');
    assert.ok(Math.abs(again.heading - h) > 0.1, 'the new seat turns within two ticks');
    assert.equal(srv.room.sim.players[firstId]?.bot === true && srv.room.sim.players[firstId]?.active === true, false);
  } finally {
    ws.terminate();
    await srv.close();
  }
});
