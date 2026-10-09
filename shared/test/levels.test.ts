import assert from 'node:assert/strict';
import test from 'node:test';
import { abilityCooldown, abilityPower, levelPower, recolorId, trailId, gainedUnlocks } from '../src/index.ts';

test('level multiplies ability strength and shortens cooldowns', () => {
  assert.equal(levelPower(1), 1);
  assert.ok(Math.abs(levelPower(10) - 1.18) < 1e-9);
  assert.ok(Math.abs(levelPower(20) - 1.38) < 1e-9);
  assert.equal(levelPower(99), levelPower(20));
  const common = abilityPower(10, 'common', 1);
  const grown = abilityPower(10, 'common', 10);
  const legend = abilityPower(10, 'legendary', 20);
  assert.ok(grown > common);
  assert.ok(legend > grown);
  assert.ok(abilityCooldown(10, 'legendary', 20) < abilityCooldown(10, 'common', 1));
});

test('recolors and trails unlock on the milestone levels', () => {
  assert.equal(recolorId(4), 0);
  assert.equal(recolorId(5), 1);
  assert.equal(recolorId(10), 2);
  assert.equal(recolorId(15), 3);
  assert.equal(recolorId(20), 4);
  assert.equal(trailId(2), 0);
  assert.equal(trailId(3), 1);
  assert.equal(trailId(8), 2);
  assert.equal(trailId(12), 3);
  assert.equal(trailId(18), 4);
  assert.deepEqual(gainedUnlocks(9, 10), ['Golden recolor']);
  assert.deepEqual(gainedUnlocks(2, 3), ['Sparkle trail']);
});

test('pet level feeds the sim ability numbers', async () => {
  const { Sim, CONFIG, cooldownOf, cooldownBase, effectOf } = await import('../src/index.ts');
  assert.ok(effectOf(10, 'common', CONFIG, 20) > effectOf(10, 'common', CONFIG, 1) * 1.3);
  assert.ok(cooldownOf(cooldownBase('paint'), 'rare', CONFIG, 20) < cooldownOf(cooldownBase('paint'), 'rare', CONFIG, 1));
  const kit = { rarity: 'common' as const, actives: ['paint', 'dash'] as ['paint', 'dash'], passives: ['magnet', 'lucky'] as ['magnet', 'lucky'], equippedActive: 0 as const, equippedPassive: 0 as const };
  const grow = (level: number) => {
    const sim = new Sim({ targetPopulation: 1, pickupTarget: 0 }, 7);
    const p = sim.addHuman('A', 0, kit, level)!;
    sim.debugClear(p.id);
    sim.debugGiveCircle(p.id, 30, 30, 3);
    sim.debugPlace(p.id, 80, 80, 0);
    const before = sim.land.areaOf(p.id);
    assert.ok(sim.useAbility(p.id));
    return sim.land.areaOf(p.id) - before;
  };
  assert.ok(grow(20) > grow(1) * 1.2, `${grow(20)} vs ${grow(1)}`);
});
