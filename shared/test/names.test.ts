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
      assert.ok(squareGap(centers[i]!, centers[j]!, 18) >= 8, `squares ${i} and ${j} are ${squareGap(centers[i]!, centers[j]!, 18).toFixed(1)} apart`);
    }
  }
});

test('a spawn square stays off existing land, not only off heads', () => {
  const sim = new Sim({ targetPopulation: 0, pickupTarget: 0, spawnSize: 18, gridW: 200, gridH: 200 }, 11);
  const human = sim.addHuman('You', 0);
  assert.ok(human);
  sim.debugGiveRect(human.id, 70, 70, 60, 60);
  const bot = sim.addBot();
  assert.ok(bot);
  const size = 18;
  const x0 = Math.floor(bot.x - size / 2);
  const y0 = Math.floor(bot.y - size / 2);
  assert.equal(sim.land.hitsExcept(bot.id, x0, y0, size, size), false, 'spawn square overlaps land');
  assert.equal(
    sim.land.hitsExcept(bot.id, x0 - 4, y0 - 4, size + 8, size + 8),
    false,
    'spawn square comes within 4 cells of existing land',
  );
});

function squareGap(a: [number, number], b: [number, number], size: number): number {
  const ax0 = a[0] - size / 2;
  const ax1 = a[0] + size / 2;
  const ay0 = a[1] - size / 2;
  const ay1 = a[1] + size / 2;
  const bx0 = b[0] - size / 2;
  const bx1 = b[0] + size / 2;
  const by0 = b[1] - size / 2;
  const by1 = b[1] + size / 2;
  const ox = ax1 > bx0 && bx1 > ax0;
  const oy = ay1 > by0 && by1 > ay0;
  if (ox && oy) return 0;
  const dx = ox ? 0 : Math.max(bx0 - ax1, ax0 - bx1);
  const dy = oy ? 0 : Math.max(by0 - ay1, ay0 - by1);
  return Math.hypot(dx, dy);
}
