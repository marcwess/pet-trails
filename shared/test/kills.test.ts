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
  sim.grid.clearPlayer(a.id);
  sim.grid.clearPlayer(b.id);
  return { sim, a, b };
}

test('hitting the fence slides along the wall and does not kill', () => {
  const sim = new Sim(
    { gridW: 40, gridH: 40, spawnSize: 4, speed: 16, turnRate: 12, tickHz: 20, pickupTarget: 0 },
    4,
  );
  const a = sim.addHuman('A', 0);
  assert.ok(a);
  sim.debugPlace(a.id, 3, 12, Math.PI);
  const y0 = a.y;
  for (let i = 0; i < 24; i++) {
    sim.setInput(a.id, -1, 1, i + 1);
    sim.step();
  }
  assert.equal(a.alive, true);
  assert.equal(a.deathReason, '');
  assert.ok(a.x <= 0.4, `x ${a.x} should sit on the fence`);
  assert.ok(a.y > y0 + 6, `y ${a.y} should have slid north from ${y0}`);
  assert.ok(Math.cos(a.heading) > -0.05, `heading ${a.heading} still points out through the wall`);
  assert.equal(
    sim.consumeEvents().some((e) => e.e === 'die'),
    false,
  );
});

test('cutting a trail kills the owner and credits the cutter', () => {
  const { sim, a, b } = placePair(1);
  sim.debugGiveRect(a.id, 2, 2, 4, 4);
  sim.debugGiveRect(b.id, 20, 20, 4, 4);
  const trailCell = sim.grid.idx(12, 12);
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
  assert.equal(sim.grid.landCount[a.id], 0);
  assert.ok(b.coins >= sim.cfg.killCoins);
  assert.ok(sim.auditLand());
});

test('a self-crossing loop stays alive and claims both lobes', () => {
  const sim = new Sim(
    { gridW: 80, gridH: 80, spawnSize: 6, speed: 20, turnRate: 80, tickHz: 20, pickupTarget: 0 },
    4,
  );
  const p = sim.addHuman('Ada', 3);
  assert.ok(p);
  sim.grid.clearPlayer(p.id);
  sim.debugGiveRect(p.id, 20, 30, 8, 8);
  sim.debugPlace(p.id, 26.5, 34.5, 0);
  p.alive = true;
  p.outside = false;
  p.trailLen = 0;
  const start = p.land;
  const drive = (x: number, y: number, ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      sim.setInput(p.id, x, y, sim.tick + 1);
      sim.step();
      assert.equal(p.alive, true, `died ${p.deathReason} at ${p.x.toFixed(1)},${p.y.toFixed(1)} tick ${sim.tick}`);
    }
  };
  // East out of home, around the lower lobe, through the outbound trail,
  // around the upper lobe, then west back onto the land.
  drive(1, 0, 20);
  drive(0, -1, 12);
  drive(-1, 0, 16);
  drive(0, 1, 12);
  assert.equal(p.outside, true, 'crossing the outbound trail must not end the run');
  assert.ok(p.trailLen > 10, 'the trail keeps going through the cross');
  drive(0, 1, 12);
  drive(1, 0, 16);
  drive(0, -1, 12);
  drive(-1, 0, 22);
  assert.equal(p.alive, true);
  assert.equal(p.deathReason, '');
  assert.ok(p.land > start + 80, `land ${p.land} did not take both lobes from ${start}`);
  const at = (x: number, y: number) => sim.grid.owner[sim.grid.idx(x, y)];
  assert.equal(at(38, 28), p.id, 'lower lobe');
  assert.equal(at(38, 40), p.id, 'upper lobe');
  assert.equal(at(32, 33), p.id, 'cell just south of the cross');
  assert.equal(at(32, 35), p.id, 'cell just north of the cross');
  assert.equal(at(5, 5), 0, 'open map stays unclaimed');
  assert.ok(sim.auditLand());
  assert.equal(
    sim.consumeEvents().some((e) => e.e === 'die'),
    false,
  );
});

test('bots can cross their own trails and the fence without those deaths', () => {
  const sim = new Sim(
    { gridW: 80, gridH: 80, spawnSize: 8, targetPopulation: 6, pickupTarget: 0 },
    11,
  );
  const human = sim.addHuman('A', 0);
  assert.ok(human);
  human.frozen = true;
  for (let i = 0; i < 400; i++) {
    sim.step({ humans: 1 });
    for (const e of sim.consumeEvents()) {
      if (e.e !== 'die') continue;
      assert.ok(e.reason === 'trail' || e.reason === 'headon' || e.reason === 'enclosed', `unexpected ${e.reason}`);
    }
  }
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
  assert.equal(sim.grid.landCount[b.id], 0);
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
  sim.grid.clearPlayer(a.id);
  sim.grid.clearPlayer(b.id);
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
