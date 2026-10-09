import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveId, Kit, PassiveId, RarityName } from '../src/index.ts';
import {
  ACTIVES,
  CONFIG,
  PASSIVES,
  RARITY_ODDS,
  RARITY_ORDER,
  Sim,
  createPet,
  createStarterProfile,
  mulberry32,
  openBox,
  parseClientMsg,
  rollRarity,
} from '../src/index.ts';

function otherActive(active: ActiveId): ActiveId {
  return ACTIVES.find((id) => id !== active)!;
}

function otherPassive(passive: PassiveId): PassiveId {
  return PASSIVES.find((id) => id !== passive)!;
}

function kit(active: ActiveId, passive: PassiveId = 'magnet', rarity: RarityName = 'common'): Kit {
  return {
    rarity,
    actives: [active, otherActive(active)],
    passives: [passive, otherPassive(passive)],
    equippedActive: 0,
    equippedPassive: 0,
  };
}

function quiet(seed: number, over: Parameters<typeof Sim>[0] = {}): Sim {
  return new Sim({ targetPopulation: 1, pickupTarget: 0, ...over }, seed);
}

test('rarity odds stay inside tolerance over 10k rolls', () => {
  const rng = mulberry32(20261009);
  const counts: Record<RarityName, number> = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  const n = 10000;
  for (let i = 0; i < n; i++) counts[rollRarity(rng)]++;
  const tol: Record<RarityName, number> = { common: 0.02, uncommon: 0.015, rare: 0.012, epic: 0.01, legendary: 0.008 };
  for (const name of RARITY_ORDER) {
    const got = counts[name] / n;
    assert.ok(Math.abs(got - RARITY_ODDS[name]) < tol[name], `${name} ${(got * 100).toFixed(2)}%`);
  }
});

test('a duplicate species rolls a fresh kit', () => {
  const seq = [0, 0, 0, 0, 0, 0, 0.2, 0, 0, 0.8, 0, 0, 0, 0.3];
  let i = 0;
  const rng = () => seq[i++] ?? 0;
  const a = createPet(rng);
  const b = createPet(rng);
  assert.equal(a.species, b.species);
  assert.notEqual(a.instanceId, b.instanceId);
  assert.notDeepEqual(a.actives, b.actives);
  assert.notEqual(a.actives[0], a.actives[1]);
  assert.notEqual(b.actives[0], b.actives[1]);
  const profile = createStarterProfile(mulberry32(4));
  profile.freeBoxes = 1;
  const opened = openBox(profile, mulberry32(5));
  assert.ok(opened);
  assert.equal(profile.pets.length, 2);
  assert.notEqual(opened!.instanceId, profile.pets[0]!.instanceId);
});

test('dash, shield, paint, frost, and recall do what they say', () => {
  const plain = travel(false);
  const dashed = travel(true);
  assert.ok(dashed > plain * 1.25, `dash ${dashed.toFixed(2)} vs ${plain.toFixed(2)}`);

  assert.equal(crossed(false), false);
  assert.equal(crossed(true), true);

  const sim = quiet(5);
  const painter = sim.addHuman('A', 0, kit('paint'))!;
  sim.debugClear(painter.id);
  sim.debugGiveCircle(painter.id, 30, 30, 3);
  sim.debugPlace(painter.id, 80, 80, 0);
  const before = sim.land.areaOf(painter.id);
  assert.equal(sim.useAbility(painter.id), true);
  const gain = sim.land.areaOf(painter.id) - before;
  const r = CONFIG.abilities.paintRadius;
  assert.ok(gain > Math.PI * r * r * 0.75, `paint gained ${gain.toFixed(1)}`);
  let smooth = false;
  for (const poly of sim.land.get(painter.id)) {
    const ring = poly[0]!;
    const near = ring.some((pt) => Math.hypot(pt[0] - 80, pt[1] - 80) < r + 1.2);
    if (!near) continue;
    smooth = true;
    assert.ok(ring.length > 16, `circle collapsed to ${ring.length} points`);
    let edge = 0;
    for (let i = 1; i < ring.length; i++) {
      edge = Math.max(edge, Math.hypot(ring[i]![0] - ring[i - 1]![0], ring[i]![1] - ring[i - 1]![1]));
    }
    assert.ok(edge < r * 0.85, `edge ${edge.toFixed(2)} is a corner, not a circle`);
  }
  assert.equal(smooth, true);

  const slowed = drift(true);
  const free = drift(false);
  assert.ok(slowed < free * 0.7, `frost ${slowed.toFixed(2)} vs ${free.toFixed(2)}`);

  const back = quiet(9);
  const pet = back.addHuman('A', 0, kit('recall'))!;
  const home = back.land.home(pet.id)!;
  back.debugPlace(pet.id, home.x + 24, home.y, 0);
  back.debugSetTrail(pet.id, [Math.round(home.y) * back.cfg.gridW + Math.round(home.x + 8)]);
  assert.ok(pet.trailLen > 0);
  assert.equal(back.useAbility(pet.id), true);
  assert.equal(pet.alive, true);
  assert.equal(pet.trailLen, 0);
  assert.ok(Math.hypot(pet.x - home.x, pet.y - home.y) < 0.6);
});

test('passives change speed, pickups, coins, xp, and spawn size', () => {
  assert.ok(pace('swift') > pace('magnet') * 1.05);

  const mag = quiet(12);
  const magnet = mag.addHuman('A', 0, kit('dash', 'magnet'))!;
  mag.debugPlace(magnet.id, 50, 50, 0);
  magnet.frozen = true;
  const reach = CONFIG.pickupRadius + CONFIG.abilities.magnetRadius * 0.5;
  mag.debugPickup(50, 50 + reach, 0);
  mag.step({ humans: 1 });
  assert.ok(magnet.coins > 0, 'magnet should grab the far coin');

  const bare = quiet(12);
  const normal = bare.addHuman('A', 0, kit('dash', 'swift'))!;
  bare.debugPlace(normal.id, 50, 50, 0);
  normal.frozen = true;
  bare.debugPickup(50, 50 + reach, 0);
  bare.step({ humans: 1 });
  assert.equal(normal.coins, 0);

  const luckySim = quiet(13, { abilities: { luckyLoot: 0 } });
  const lucky = luckySim.addHuman('A', 0, kit('dash', 'lucky'))!;
  luckySim.debugPlace(lucky.id, 60, 60, 0);
  lucky.frozen = true;
  luckySim.debugPickup(60, 60, 0);
  luckySim.step({ humans: 1 });
  assert.ok(lucky.coins > CONFIG.coinValue + 0.1);

  const scholarSim = quiet(14);
  const scholar = scholarSim.addHuman('A', 0, kit('dash', 'scholar'))!;
  scholarSim.debugPlace(scholar.id, 60, 60, 0);
  scholar.frozen = true;
  scholarSim.debugPickup(60, 60, 1);
  scholarSim.step({ humans: 1 });
  assert.ok(scholar.xp > CONFIG.xpOrbValue + 0.1);

  const big = quiet(15);
  const grown = big.addHuman('A', 0, kit('dash', 'headstart'))!;
  const small = quiet(15);
  const starter = small.addHuman('A', 0, kit('dash', 'magnet'))!;
  assert.ok(grown.land > starter.land * 1.15, `${grown.land} vs ${starter.land}`);
});

test('a second ability press during cooldown does nothing', () => {
  const sim = quiet(16);
  const p = sim.addHuman('A', 0, kit('dash'))!;
  sim.debugPlace(p.id, 90, 90, 0);
  p.frozen = true;
  assert.equal(sim.useAbility(p.id), true);
  const until = p.cdUntil;
  const dash = p.dashUntil;
  assert.equal(sim.useAbility(p.id), false);
  assert.equal(p.cdUntil, until);
  assert.equal(p.dashUntil, dash);
  while (sim.tick < until) sim.step({ humans: 1 });
  assert.equal(sim.useAbility(p.id), true);
});

test('the server parser rejects an impossible kit and keeps a legal one', () => {
  const bad = parseClientMsg(
    JSON.stringify({
      t: 'hello',
      name: 'A',
      pet: 1,
      rarity: 'legendary',
      actives: ['dash', 'dash'],
      passives: ['swift', 'lucky'],
      eqA: 0,
      eqP: 0,
    }),
  );
  assert.equal(bad?.t, 'hello');
  if (bad?.t === 'hello') assert.equal(bad.kit, null);

  const unknown = parseClientMsg(
    JSON.stringify({
      t: 'hello',
      rarity: 'mythic',
      actives: ['nuke', 'dash'],
      passives: ['swift', 'lucky'],
      eqA: 0,
      eqP: 0,
    }),
  );
  if (unknown?.t === 'hello') assert.equal(unknown.kit, null);

  const good = parseClientMsg(
    JSON.stringify({
      t: 'hello',
      rarity: 'rare',
      actives: ['paint', 'frost'],
      passives: ['scholar', 'lucky'],
      eqA: 1,
      eqP: 0,
    }),
  );
  if (good?.t !== 'hello' || !good.kit) assert.fail('legal kit was dropped');
  assert.equal(good.kit.rarity, 'rare');
  assert.equal(good.kit.actives[good.kit.equippedActive], 'frost');
  assert.equal(good.kit.passives[good.kit.equippedPassive], 'scholar');
});

function travel(dash: boolean): number {
  const sim = quiet(3);
  const p = sim.addHuman('A', 0, kit('dash'))!;
  sim.debugPlace(p.id, 80, 100, 0);
  p.desiredX = 1;
  p.desiredY = 0;
  if (dash) sim.useAbility(p.id);
  const x0 = p.x;
  for (let i = 0; i < 8; i++) sim.step({ humans: 1 });
  return p.x - x0;
}

function crossed(shield: boolean): boolean {
  const sim = quiet(4);
  const a = sim.addHuman('A', 0, kit('shield'))!;
  const b = sim.addHuman('B', 1, kit('dash'))!;
  sim.debugPlace(a.id, 40, 55, 0);
  const cells: number[] = [];
  for (let x = 30; x <= 50; x++) cells.push(40 * sim.cfg.gridW + x);
  sim.debugSetTrail(a.id, cells);
  sim.debugPlace(b.id, 40, 36, Math.PI / 2);
  b.desiredX = 0;
  b.desiredY = 1;
  a.frozen = true;
  if (shield) sim.useAbility(a.id);
  for (let i = 0; i < 16; i++) {
    sim.step({ humans: 2 });
    if (b.y > 43) break;
  }
  return a.alive;
}

function drift(frost: boolean): number {
  const sim = quiet(8);
  const a = sim.addHuman('A', 0, kit('frost'))!;
  const b = sim.addHuman('B', 1, kit('dash'))!;
  sim.debugPlace(a.id, 70, 70, 0);
  sim.debugPlace(b.id, 73, 70, 0);
  b.desiredX = 1;
  b.desiredY = 0;
  a.frozen = true;
  if (frost) sim.useAbility(a.id);
  const x0 = b.x;
  for (let i = 0; i < 20; i++) sim.step({ humans: 2 });
  return b.x - x0;
}

function pace(passive: PassiveId): number {
  const sim = quiet(11);
  const p = sim.addHuman('A', 0, kit('dash', passive))!;
  sim.debugPlace(p.id, 80, 80, 0);
  p.desiredX = 1;
  p.desiredY = 0;
  const x0 = p.x;
  for (let i = 0; i < 10; i++) sim.step({ humans: 1 });
  return p.x - x0;
}
