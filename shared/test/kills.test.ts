import assert from 'node:assert/strict';
import test from 'node:test';
import { walkCells } from '../src/motion.ts';
import { Sim } from '../src/sim.ts';

function placePair(seed: number) {
  const sim = new Sim(
    { gridW: 30, gridH: 30, spawnSize: 4, speed: 6, turnRate: 20, tickHz: 20, pickupTarget: 0, headRadius: 0.5 },
    seed,
  );
  const a = sim.addHuman('A', 1);
  const b = sim.addHuman('B', 5);
  assert.ok(a && b);
  sim.debugClear(a.id);
  sim.debugClear(b.id);
  return { sim, a, b };
}

test('crossing the map border kills you and shows a border death', () => {
  const sim = new Sim(
    { gridW: 24, gridH: 24, spawnSize: 4, speed: 30, turnRate: 40, tickHz: 20, pickupTarget: 0 },
    4,
  );
  const a = sim.addHuman('A', 0);
  assert.ok(a);
  sim.debugPlace(a.id, 2.2, 12, Math.PI);
  for (let i = 0; i < 40 && a.alive; i++) {
    sim.setInput(a.id, -1, 0, i + 1);
    sim.step();
  }
  assert.equal(a.alive, false);
  assert.equal(a.deathReason, 'border');
  const died = sim.consumeEvents().find((e) => e.e === 'die' && e.id === a.id);
  assert.ok(died && died.e === 'die' && died.reason === 'border');
});

test('cutting a trail kills the owner and credits the cutter', () => {
  const { sim, a, b } = placePair(1);
  sim.debugGiveRect(a.id, 2, 2, 4, 4);
  sim.debugGiveRect(b.id, 20, 20, 4, 4);
  const trailCell = sim.idx(12, 12);
  sim.debugSetTrail(a.id, [trailCell]);
  sim.debugPlace(a.id, 3.5, 3.5, 0);
  a.outside = true;
  a.frozen = true;
  sim.debugPlace(b.id, 12.5, 10.2, Math.PI / 2);
  b.outside = false;
  for (let i = 0; i < 12 && a.alive; i++) {
    sim.setInput(b.id, 0, 1, i + 1);
    sim.step();
  }
  assert.equal(a.alive, false);
  assert.equal(a.deathReason, 'trail');
  assert.equal(b.kills, 1);
  assert.equal(b.trainLen, 1);
  assert.equal(b.train[0], a.pet);
  assert.equal(sim.land.areaOf(a.id), 0);
  assert.ok(b.coins >= sim.cfg.killCoins);
  assert.ok(sim.auditLand());
});

test('hitting your own trail is a death with no kill credit', () => {
  const { sim, a, b } = placePair(2);
  sim.debugGiveRect(a.id, 2, 2, 4, 4);
  const trailCell = sim.idx(14, 14);
  sim.debugSetTrail(a.id, [trailCell]);
  sim.debugPlace(a.id, 14.5, 12.2, Math.PI / 2);
  b.frozen = true;
  const killsBefore = b.kills;
  for (let i = 0; i < 12 && a.alive; i++) {
    sim.setInput(a.id, 0, 1, i + 1);
    sim.step();
  }
  assert.equal(a.alive, false);
  assert.equal(a.deathReason, 'self');
  assert.equal(b.kills, killsBefore);
  assert.equal(sim.stats.kills, 0);
  assert.equal(sim.land.areaOf(a.id), 0);
});

test('head-on: more land wins, the smaller pet joins the train', () => {
  const { sim, a, b } = placePair(3);
  sim.debugGiveRect(a.id, 2, 2, 8, 8);
  sim.debugGiveRect(b.id, 18, 2, 3, 3);
  sim.debugPlace(a.id, 12.2, 15, 0);
  sim.debugPlace(b.id, 12.7, 15, Math.PI);
  a.frozen = true;
  b.frozen = true;
  a.outside = false;
  b.outside = false;
  assert.ok(a.land > b.land);
  sim.step();
  assert.equal(a.alive, true);
  assert.equal(b.alive, false);
  assert.equal(b.deathReason, 'headon');
  assert.equal(a.kills, 1);
  assert.equal(a.train[0], b.pet);
  assert.equal(sim.land.areaOf(b.id), 0);
  assert.ok(a.land > 0);
});

test('head-on tie: both die and nobody is credited', () => {
  const { sim, a, b } = placePair(4);
  sim.debugGiveRect(a.id, 2, 2, 4, 4);
  sim.debugGiveRect(b.id, 20, 2, 4, 4);
  assert.equal(a.land, b.land);
  sim.debugPlace(a.id, 12.2, 10, 0);
  sim.debugPlace(b.id, 12.7, 10, Math.PI);
  a.frozen = true;
  b.frozen = true;
  sim.step();
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.deathReason, 'headon');
  assert.equal(b.deathReason, 'headon');
  assert.equal(sim.stats.kills, 0);
  assert.equal(a.trainLen, 0);
  assert.equal(b.trainLen, 0);
});

test('a fresh spawn shrugs off a head-on until invulnerability ends', () => {
  const sim = new Sim(
    { gridW: 48, gridH: 48, spawnSize: 4, speed: 8, turnRate: 12, tickHz: 20, pickupTarget: 0, headRadius: 1.2, targetPopulation: 2 },
    9,
  );
  const a = sim.addHuman('A', 0);
  const b = sim.addHuman('B', 1);
  assert.ok(a && b);
  sim.debugClear(a.id);
  sim.debugClear(b.id);
  sim.debugGiveRect(a.id, 2, 2, 4, 4);
  sim.debugGiveRect(b.id, 40, 40, 4, 4);
  a.invulnUntil = sim.tick + 30;
  b.invulnUntil = sim.tick + 30;
  a.frozen = true;
  b.frozen = true;
  a.x = 20;
  a.y = 20;
  b.x = 20.4;
  b.y = 20;
  for (let i = 0; i < 6; i++) sim.step();
  assert.equal(a.alive, true);
  assert.equal(b.alive, true);
  a.invulnUntil = 0;
  b.invulnUntil = 0;
  sim.step();
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.deathReason, 'headon');
  assert.equal(b.deathReason, 'headon');
});

test('diagonal steps paint both corner cells so the trail stays sealed', () => {
  const seen: string[] = [];
  walkCells(0.9, 0.9, 1.3, 1.3, (x, y) => {
    seen.push(`${x},${y}`);
    return true;
  });
  assert.ok(seen.includes('1,0') || seen.includes('0,1'), `corner missing in ${seen.join(' ')}`);
  assert.ok(seen.includes('1,1'));
});
