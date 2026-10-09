import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVES, PASSIVES, SPECIES, createStarterProfile, mulberry32, randomSeed } from '../src/index.ts';

test('a fresh profile is a common pet with a rolled kit', () => {
  const counts = new Array<number>(SPECIES.length).fill(0);
  const seen = new Set<number>();
  for (let seed = 1; seed <= SPECIES.length * 80; seed++) {
    const profile = createStarterProfile(mulberry32(seed >>> 0));
    assert.equal(profile.pet.rarity, 'common');
    assert.equal(profile.pet.level, 1);
    assert.equal(profile.pet.xp, 0);
    assert.ok(profile.pet.species >= 0 && profile.pet.species < SPECIES.length);
    assert.notEqual(profile.pet.actives[0], profile.pet.actives[1]);
    assert.ok((ACTIVES as readonly string[]).includes(profile.pet.actives[0]));
    assert.ok((ACTIVES as readonly string[]).includes(profile.pet.actives[1]));
    assert.notEqual(profile.pet.passives[0], profile.pet.passives[1]);
    assert.ok((PASSIVES as readonly string[]).includes(profile.pet.passives[0]));
    assert.ok((PASSIVES as readonly string[]).includes(profile.pet.passives[1]));
    counts[profile.pet.species]!++;
    seen.add(profile.pet.species);
  }
  assert.equal(seen.size, SPECIES.length);
  for (let i = 0; i < counts.length; i++) {
    assert.ok(counts[i]! > 20, `${SPECIES[i]} showed up ${counts[i]} times`);
  }
});

test('randomSeed is not one shared constant', () => {
  const seeds = new Set<number>();
  for (let i = 0; i < 24; i++) seeds.add(randomSeed());
  assert.ok(seeds.size > 16, `only ${seeds.size} distinct seeds`);
});
