import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnRadius } from '../src/shape.ts';
import { Sim } from '../src/sim.ts';

test('freed bot names are reused and never gain a number suffix', () => {
  const sim = new Sim({ targetPopulation: 0, pickupTarget: 0, maxEntities: 16 }, 3);
  const first: string[] = [];
  for (let i = 0; i < 10; i++) {
    const bot = sim.addBot();
    assert.ok(bot);
    first.push(bot.name);
    assert.equal(/\d/.test(bot.name), false, bot.name);
  }
  assert.equal(new Set(first).size, 10);
  for (const p of [...sim.roster]) {
    if (p.active && p.bot) sim.remove(p.id);
  }
  const second: string[] = [];
  for (let i = 0; i < 10; i++) {
    const bot = sim.addBot();
    assert.ok(bot);
    second.push(bot.name);
    assert.equal(/\s\d+$/.test(bot.name), false, bot.name);
    assert.equal(/\d/.test(bot.name), false, bot.name);
    assert.ok(first.includes(bot.name), `${bot.name} was not a freed name`);
  }
  assert.equal(new Set(second).size, 10);
  for (let round = 0; round < 3; round++) {
    for (const p of [...sim.roster]) {
      if (p.active && p.bot) sim.remove(p.id);
    }
    for (let i = 0; i < 10; i++) {
      const bot = sim.addBot();
      assert.ok(bot);
      assert.equal(/\d/.test(bot.name), false, bot.name);
    }
  }
});

test('bot spawn circles are not packed against the player', () => {
  const sim = new Sim({ targetPopulation: 0, pickupTarget: 0, spawnSize: 18 }, 5);
  const human = sim.addHuman('You', 0);
  assert.ok(human);
  const radius = spawnRadius(18);
  const centers: Array<[number, number]> = [[human.x, human.y]];
  for (let i = 0; i < 6; i++) {
    const bot = sim.addBot();
    assert.ok(bot);
    centers.push([bot.x, bot.y]);
  }
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const d = Math.hypot(centers[i]![0] - centers[j]![0], centers[i]![1] - centers[j]![1]);
      assert.ok(d > 30, `spawns ${i} and ${j} are ${d.toFixed(1)} apart`);
      assert.ok(d - radius * 2 >= 8, `circles ${i} and ${j} are ${(d - radius * 2).toFixed(1)} apart`);
    }
  }
});

test('a spawn circle stays off existing land and inside the blob', () => {
  const sim = new Sim({ targetPopulation: 0, pickupTarget: 0, spawnSize: 18, gridW: 200, gridH: 200 }, 11);
  const human = sim.addHuman('You', 0);
  assert.ok(human);
  sim.debugGiveRect(human.id, 70, 70, 60, 60);
  const bot = sim.addBot();
  assert.ok(bot);
  const radius = spawnRadius(18);
  const x0 = bot.x - radius;
  const y0 = bot.y - radius;
  assert.equal(sim.land.hitsExcept(bot.id, x0, y0, radius * 2, radius * 2), false, 'spawn circle overlaps land');
  assert.equal(
    sim.land.hitsExcept(bot.id, x0 - 4, y0 - 4, radius * 2 + 8, radius * 2 + 8),
    false,
    'spawn circle comes within 4 cells of existing land',
  );
  const room = sim.land.fenceAt(bot.x, bot.y);
  assert.equal(room.inside, true);
  assert.ok(room.dist > radius, `spawn sits ${room.dist.toFixed(2)} from the fence, radius ${radius.toFixed(2)}`);
});
