import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from '../src/sim.ts';

function cell(sim: Sim, x: number, y: number): number {
  return sim.idx(x, y);
}

test('flood fill claims the interior and leaves the exterior', () => {
  const sim = new Sim({ gridW: 16, gridH: 16, spawnSize: 3 }, 1);
  const p = sim.addHuman('Ada', 3);
  assert.ok(p);
  sim.debugClear(p.id);
  p.trailLen = 0;
  // Block on the left, rectangle trail closing a pocket to the right.
  sim.debugGiveRect(p.id, 2, 4, 3, 4); // x 2..5, y 4..8
  const trail: number[] = [];
  const push = (x: number, y: number) => trail.push(cell(sim, x, y));
  for (let x = 5; x <= 9; x++) push(x, 4);
  for (let y = 5; y <= 8; y++) push(9, y);
  for (let x = 8; x >= 2; x--) push(x, 8);
  for (let y = 7; y >= 5; y--) push(2, y);
  sim.debugSetTrail(p.id, trail);
  const gained = sim.debugClaim(p.id);
  assert.ok(gained > 0, `expected an interior claim, gained ${gained}`);
  assert.equal(sim.ownerAt(7.5, 6.5), p.id, 'pocket cell claimed');
  assert.equal(sim.ownerAt(14.5, 14.5), 0, 'far exterior stays neutral');
  assert.equal(sim.ownerAt(0.5, 0.5), 0, 'border stays neutral');
  assert.equal(p.trailLen, 0);
  assert.ok(sim.auditLand());
  const ev = sim.consumeEvents().filter((e) => e.e === 'claim');
  assert.equal(ev.length, 1);
});

test('a claim fully encloses a rival and captures only the loop', () => {
  const sim = new Sim({ gridW: 16, gridH: 16, spawnSize: 3 }, 2);
  const a = sim.addHuman('Ada', 1);
  const b = sim.addHuman('Bea', 4);
  assert.ok(a && b);
  sim.debugClear(a.id);
  sim.debugClear(b.id);
  sim.debugGiveRect(a.id, 2, 4, 3, 4);
  sim.debugGiveRect(b.id, 13, 13, 2, 2);
  const trail: number[] = [];
  for (let x = 5; x <= 9; x++) trail.push(cell(sim, x, 4));
  for (let y = 5; y <= 8; y++) trail.push(cell(sim, 9, y));
  for (let x = 8; x >= 2; x--) trail.push(cell(sim, x, 8));
  sim.debugSetTrail(a.id, trail);
  sim.debugPlace(b.id, 7.5, 6.5, 0);
  b.alive = true;
  b.outside = true;
  sim.debugClaim(a.id);
  assert.equal(b.alive, false);
  assert.equal(b.deathReason, 'enclosed');
  assert.equal(a.kills, 1);
  assert.equal(a.trainLen, 1);
  assert.equal(a.train[0], b.pet);
  assert.equal(sim.ownerAt(7.5, 6.5), a.id);
  assert.equal(sim.ownerAt(13.5, 13.5), 0, 'victim land outside the loop is wiped');
  assert.ok(sim.auditLand());
});

test('enemy land outside the loop is not stolen and they live', () => {
  const sim = new Sim({ gridW: 16, gridH: 16, spawnSize: 3 }, 3);
  const a = sim.addHuman('Ada', 0);
  const b = sim.addHuman('Bea', 2);
  assert.ok(a && b);
  sim.debugClear(a.id);
  sim.debugClear(b.id);
  sim.debugGiveRect(a.id, 2, 4, 3, 4);
  sim.debugGiveRect(b.id, 12, 2, 3, 3);
  const trail: number[] = [];
  for (let x = 5; x <= 8; x++) trail.push(cell(sim, x, 5));
  for (let y = 6; y <= 7; y++) trail.push(cell(sim, 8, y));
  for (let x = 7; x >= 4; x--) trail.push(cell(sim, x, 7));
  sim.debugSetTrail(a.id, trail);
  sim.debugPlace(b.id, 13.2, 3.2, 0);
  const bLand = b.land;
  sim.debugClaim(a.id);
  assert.equal(b.alive, true);
  assert.equal(sim.land.areaOf(b.id), bLand);
  assert.equal(sim.ownerAt(12.5, 2.5), b.id);
});

test('a claim steals only the overlap and leaves the rest of a living rival', () => {
  const sim = new Sim({ gridW: 24, gridH: 24, spawnSize: 3 }, 8);
  const a = sim.addHuman('Ada', 0);
  const b = sim.addHuman('Bea', 2);
  assert.ok(a && b);
  sim.debugClear(a.id);
  sim.debugClear(b.id);
  sim.debugGiveRect(a.id, 2, 4, 3, 4);
  // Straddles the pocket: part will be inside the loop, the east end stays Bea's.
  sim.debugGiveRect(b.id, 6, 5, 8, 3);
  const trail: number[] = [];
  for (let x = 5; x <= 9; x++) trail.push(cell(sim, x, 4));
  for (let y = 5; y <= 8; y++) trail.push(cell(sim, 9, y));
  for (let x = 8; x >= 2; x--) trail.push(cell(sim, x, 8));
  sim.debugSetTrail(a.id, trail);
  sim.debugPlace(b.id, 13.2, 6.2, 0);
  b.alive = true;
  const before = sim.land.areaOf(b.id);
  sim.debugClaim(a.id);
  assert.equal(b.alive, true, b.deathReason);
  assert.equal(sim.ownerAt(7.5, 6.5), a.id, 'overlap belongs to the claimer');
  assert.equal(sim.ownerAt(12.5, 6.5), b.id, 'land outside the loop stays');
  assert.ok(sim.land.areaOf(b.id) < before - 1, `expected a steal, area ${sim.land.areaOf(b.id)} from ${before}`);
  assert.ok(sim.auditLand());
});

test('scripted square closes and grows land', () => {
  const sim = new Sim(
    { gridW: 40, gridH: 40, spawnSize: 6, speed: 16, turnRate: 80, tickHz: 20, pickupTarget: 0 },
    4,
  );
  const p = sim.addHuman('Ada', 3);
  assert.ok(p);
  sim.debugClear(p.id);
  sim.debugGiveRect(p.id, 8, 8, 6, 6);
  sim.debugPlace(p.id, 11, 11, 0);
  p.alive = true;
  p.outside = false;
  p.trailLen = 0;
  const start = p.land;
  const drive = (x: number, y: number, ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      sim.setInput(p.id, x, y, sim.tick + 1);
      sim.step();
      assert.equal(p.alive, true, `died early reason=${p.deathReason} tick=${sim.tick}`);
    }
  };
  drive(1, 0, 14);
  drive(0, 1, 14);
  drive(-1, 0, 12);
  drive(0, -1, 16);
  assert.ok(p.land > start + 5, `land ${p.land} did not grow from ${start}`);
  assert.ok(sim.stats.claims >= 1);
  assert.ok(sim.auditLand());
});
