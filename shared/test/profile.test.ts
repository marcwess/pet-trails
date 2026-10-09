import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVES, PASSIVES, SPECIES, createStarterProfile, equippedPet, mulberry32, randomSeed } from '../src/index.ts';

test('a fresh profile is a common pet with a rolled kit', () => {
  const counts = new Array<number>(SPECIES.length).fill(0);
  const seen = new Set<number>();
  for (let seed = 1; seed <= SPECIES.length * 80; seed++) {
    const profile = createStarterProfile(mulberry32(seed >>> 0));
    const pet = equippedPet(profile);
    assert.equal(profile.v, 2);
    assert.equal(profile.freeBoxes, 1);
    assert.equal(profile.pets.length, 1);
    assert.equal(pet.rarity, 'common');
    assert.equal(pet.level, 1);
    assert.equal(pet.xp, 0);
    assert.ok(pet.species >= 0 && pet.species < SPECIES.length);
    assert.notEqual(pet.actives[0], pet.actives[1]);
    assert.ok((ACTIVES as readonly string[]).includes(pet.actives[0]));
    assert.ok((ACTIVES as readonly string[]).includes(pet.actives[1]));
    assert.notEqual(pet.passives[0], pet.passives[1]);
    assert.ok((PASSIVES as readonly string[]).includes(pet.passives[0]));
    assert.ok((PASSIVES as readonly string[]).includes(pet.passives[1]));
    counts[pet.species]!++;
    seen.add(pet.species);
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
