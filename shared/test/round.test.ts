import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from '../src/sim.ts';

test('a late burst of inputs drains two per tick, and a silent client keeps gliding', () => {
  const sim = new Sim(
    { gridW: 80, gridH: 80, targetPopulation: 1, pickupTarget: 0, speed: 16.2, turnRate: 6.12, tickHz: 20 },
    2,
  );
  const a = sim.addHuman('A', 0);
  assert.ok(a);
  sim.lockstep = true;
  sim.debugPlace(a.id, 40, 40, 0);
  for (let s = 1; s <= 5; s++) sim.setInput(a.id, 1, 0, s);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 2, 'a backlog takes a second step');
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 4);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 5, 'normal depth is one step per tick');
  const x = a.x;
  for (let i = 0; i < 6; i++) sim.step({ humans: 1 });
  assert.equal(a.x, x, 'a short gap waits');
  sim.step({ humans: 1 });
  assert.ok(a.x > x, 'a long silence moves along the held heading');
  assert.equal(a.lastSeq, 6, 'and spends the next seq');
  sim.setInput(a.id, 0, 1, 6);
  sim.setInput(a.id, 1, 0, 7);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 7, 'the stale input is dropped');
});

test('queued inputs apply one per tick in order', () => {
  const sim = new Sim(
    { gridW: 80, gridH: 80, targetPopulation: 1, pickupTarget: 0, speed: 16.2, turnRate: 6.12, tickHz: 20 },
    2,
  );
  const a = sim.addHuman('A', 0);
  assert.ok(a);
  sim.lockstep = true;
  sim.debugPlace(a.id, 40, 40, 0);
  sim.setInput(a.id, 1, 0, 1);
  sim.setInput(a.id, 0, 1, 2);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 1);
  assert.ok(a.x > 40.5, 'first input moves east');
  const h1 = a.heading;
  sim.setInput(a.id, -1, 0, 3);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 2);
  assert.ok(a.heading > h1, 'second input starts the turn north');
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 3);
  const heldX = a.x;
  const heldY = a.y;
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 3, 'an empty queue does not invent a newer ack');
  assert.equal(a.x, heldX, 'lockstep holds still until the next input arrives');
  assert.equal(a.y, heldY);
  sim.setInput(a.id, 0, 0, 4);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 4, 'a quiet stick still spends the tick');
  assert.ok(a.x !== heldX || a.y !== heldY);
  const beforeGap = a.x;
  sim.setInput(a.id, 0, 1, 6);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 4, 'a missing seq waits instead of skipping ahead');
  assert.equal(a.x, beforeGap);
  sim.setInput(a.id, 1, 0, 5);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 5);
  sim.step({ humans: 1 });
  assert.equal(a.lastSeq, 6);
});

test('last pet standing floods the map and is the winner', () => {
  const sim = new Sim(
    {
      gridW: 36,
      gridH: 36,
      spawnSize: 4,
      speed: 6,
      turnRate: 20,
      tickHz: 20,
      pickupTarget: 0,
      headRadius: 1.2,
      targetPopulation: 2,
      roundOpenSec: 0,
      roundCapSec: 999,
    },
    2,
  );
  const a = sim.addHuman('Ada', 1);
  assert.ok(a);
  sim.step({ humans: 1 });
  assert.equal(sim.sealed, true);
  const bot = sim.roster.find((p) => p.bot && p.active && p.alive);
  assert.ok(bot);
  sim.debugClear(a.id);
  sim.debugClear(bot.id);
  sim.debugGiveRect(a.id, 2, 2, 8, 8);
  sim.debugGiveRect(bot.id, 22, 22, 3, 3);
  sim.debugPlace(a.id, 14.2, 14, 0);
  sim.debugPlace(bot.id, 15.2, 14, Math.PI);
  a.frozen = true;
  bot.frozen = true;
  a.outside = false;
  bot.outside = false;
  sim.step({ humans: 1 });
  assert.equal(bot.alive, false);
  assert.equal(a.alive, true);
  assert.equal(sim.over, true);
  const win = sim.consumeEvents().find((e) => e.e === 'win');
  assert.ok(win && win.e === 'win');
  assert.equal(win.id, a.id);
  assert.equal(win.name, 'Ada');
  assert.ok(win.total >= 2);
  assert.equal(sim.land.areaOf(bot.id), 0);
  const mid = sim.land.fenceAt(sim.cfg.gridW / 2, sim.cfg.gridH / 2);
  assert.equal(mid.inside, true);
  assert.equal(sim.ownerAt(sim.cfg.gridW / 2, sim.cfg.gridH / 2), a.id);
  assert.equal(sim.ownerAt(23.5, 23.5), a.id);
  assert.ok(sim.auditLand());
});

test('at five minutes the biggest owner wins without shrinking the fence', () => {
  const sim = new Sim(
    {
      gridW: 40,
      gridH: 40,
      spawnSize: 4,
      speed: 8,
      turnRate: 12,
      tickHz: 20,
      pickupTarget: 0,
      targetPopulation: 3,
      roundOpenSec: 100,
      roundCapSec: 100,
      roundHeatSec: 100,
    },
    8,
  );
  const a = sim.addHuman('Ada', 0);
  assert.ok(a);
  a.frozen = true;
  sim.step({ humans: 1 });
  for (const p of sim.roster) if (p.bot) p.frozen = true;
  const bots = sim.roster.filter((p) => p.bot && p.alive);
  assert.ok(bots.length >= 1);
  sim.debugClear(a.id);
  sim.debugGiveRect(a.id, 8, 8, 10, 10);
  let n = 0;
  for (const b of bots) {
    sim.debugClear(b.id);
    sim.debugGiveRect(b.id, 2 + n * 4, 28, 2, 2);
    n++;
  }
  const ringBefore = sim.land.mapRing.length;
  sim.cfg.roundCapSec = 0;
  sim.step({ humans: 1 });
  assert.equal(sim.over, true);
  const win = sim.consumeEvents().find((e) => e.e === 'win');
  assert.ok(win && win.e === 'win');
  assert.equal(win.id, a.id);
  assert.equal(sim.land.mapRing.length, ringBefore);
  assert.equal(sim.ownerAt(12, 12), a.id);
  let alive = 0;
  for (const p of sim.roster) if (p.active && p.alive) alive++;
  assert.equal(alive, 1);
});

test('eliminated bots stay dead and heat rises as the field thins', () => {
  const sim = new Sim(
    {
      gridW: 48,
      gridH: 48,
      targetPopulation: 6,
      pickupTarget: 0,
      roundOpenSec: 0.05,
      roundCapSec: 999,
      roundHeatSec: 999,
    },
    4,
  );
  const a = sim.addHuman('Ada', 0);
  assert.ok(a);
  a.frozen = true;
  sim.step({ humans: 1 });
  for (const p of sim.roster) if (p.bot) p.frozen = true;
  assert.equal(sim.sealed, true);
  const alive = () => sim.roster.filter((p) => p.active && p.alive).length;
  assert.ok(alive() > 5);
  assert.equal(sim.heat, 0, 'a full field farms land');
  const bots = sim.roster.filter((p) => p.bot && p.alive);
  const removed = bots.pop()!;
  sim.remove(removed.id);
  while (alive() > 3) sim.remove(bots.pop()!.id);
  sim.step({ humans: 1 });
  assert.equal(alive(), 3);
  assert.equal(sim.heat, 0.6);
  assert.equal(removed.active, false);
  const ids = new Set(sim.roster.filter((p) => p.active).map((p) => p.id));
  for (let i = 0; i < 30; i++) sim.step({ humans: 1 });
  assert.equal(sim.over, false);
  for (const p of sim.roster) {
    if (p.active && p.alive) assert.equal(ids.has(p.id), true, 'a new pet joined a sealed round');
  }
  assert.ok(alive() <= 3);
});

test('the late clock heats bots even while the field is full', () => {
  const sim = new Sim(
    {
      targetPopulation: 11,
      pickupTarget: 0,
      roundOpenSec: 100,
      roundCapSec: 999,
      roundHeatSec: 0.05,
    },
    1,
  );
  const a = sim.addHuman('Ada', 0);
  assert.ok(a);
  a.frozen = true;
  sim.step({ humans: 1 });
  assert.equal(sim.heat, 1);
  assert.ok(sim.roster.filter((p) => p.active && p.alive).length > 8);
});

test('a bot that falls while the room is still open comes back; after the seal it stays out', () => {
  const sim = new Sim({ targetPopulation: 6, pickupTarget: 0, roundOpenSec: 2, roundCapSec: 999, roundHeatSec: 999 }, 9);
  const a = sim.addHuman('Ada', 0);
  assert.ok(a);
  a.frozen = true;
  sim.step({ humans: 1 });
  const kill = (p: unknown) => (sim as unknown as { kill: (v: unknown, k: null, r: string) => void }).kill(p, null, 'time');
  const early = sim.roster.find((p) => p.bot && p.alive)!;
  kill(early);
  assert.equal(early.alive, false);
  for (let i = 0; i < Math.ceil(sim.cfg.botRespawnSec * sim.cfg.tickHz) + 1; i++) sim.step({ humans: 1 });
  assert.equal(early.alive, true, 'refilled during the opening');
  while (!sim.sealed) sim.step({ humans: 1 });
  const late = sim.roster.find((p) => p.bot && p.alive && p !== early)!;
  kill(late);
  for (let i = 0; i < 60; i++) sim.step({ humans: 1 });
  assert.equal(late.alive, false, 'out is out once sealed');
});
