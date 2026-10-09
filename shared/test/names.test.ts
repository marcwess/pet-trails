import assert from 'node:assert/strict';
import test from 'node:test';
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

test('bot spawn squares are not packed against the player', () => {
  const sim = new Sim({ targetPopulation: 0, pickupTarget: 0, spawnSize: 18 }, 5);
  const human = sim.addHuman('You', 0);
  assert.ok(human);
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
    }
  }
});
