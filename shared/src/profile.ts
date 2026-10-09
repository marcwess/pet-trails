import { parseKit, rollRarity, type Kit } from './abilities.js';
import type { ActiveId, PassiveId, RarityName } from './config.js';
import { ACTIVES, CONFIG, PASSIVES, SPECIES } from './config.js';

export interface PetInstance {
  instanceId: string;
  species: number;
  rarity: RarityName;
  level: number;
  xp: number;
  actives: [ActiveId, ActiveId];
  passives: [PassiveId, PassiveId];
  equippedActive: 0 | 1;
  equippedPassive: 0 | 1;
}

/**
 * Client-side for the playtest. `pets` is the whole collection and
 * `equippedId` is the one that joins a run. Ready to move server-side.
 */
export interface Profile {
  v: 2;
  coins: number;
  freeBoxes: number;
  pets: PetInstance[];
  equippedId: string;
}

export function xpForLevel(level: number): number {
  return 30 + level * 20 + level * level * 4;
}

/** Returns how many levels were gained. Caps at `cap` and zeroes overflow XP. */
export function applyXp(pet: PetInstance, amount: number, cap: number): number {
  if (amount <= 0) return 0;
  let gained = 0;
  pet.xp += amount;
  while (pet.level < cap) {
    const need = xpForLevel(pet.level);
    if (pet.xp < need) break;
    pet.xp -= need;
    pet.level++;
    gained++;
  }
  if (pet.level >= cap) pet.xp = 0;
  return gained;
}

export function rollKit(rng: () => number): Pick<PetInstance, 'actives' | 'passives'> {
  const pick2 = <T>(arr: readonly T[]): [T, T] => {
    const i = Math.floor(rng() * arr.length);
    let j = Math.floor(rng() * (arr.length - 1));
    if (j >= i) j++;
    return [arr[i]!, arr[j]!];
  };
  return { actives: pick2(ACTIVES), passives: pick2(PASSIVES) };
}

/** A bot's pet: random rarity, a fresh kit, and a random equipped pair. */
export function rollBotKit(rng: () => number): Kit {
  const rarity = rollRarity(rng);
  const kit = rollKit(rng);
  return {
    rarity,
    actives: kit.actives,
    passives: kit.passives,
    equippedActive: rng() < 0.5 ? 0 : 1,
    equippedPassive: rng() < 0.5 ? 0 : 1,
  };
}

export function kitOf(pet: PetInstance): Kit {
  return {
    rarity: pet.rarity,
    actives: pet.actives,
    passives: pet.passives,
    equippedActive: pet.equippedActive,
    equippedPassive: pet.equippedPassive,
  };
}

export function equippedPet(profile: Profile): PetInstance {
  return profile.pets.find((pet) => pet.instanceId === profile.equippedId) ?? profile.pets[0]!;
}

/** A new instance. Duplicates of a species still roll a fresh kit. */
export function createPet(rng: () => number, rarity?: RarityName): PetInstance {
  const species = Math.floor(rng() * SPECIES.length);
  const rolled = rarity ?? rollRarity(rng);
  const kit = rollKit(rng);
  return {
    instanceId: `pet-${species}-${Math.floor(rng() * 1e9).toString(36)}`,
    species,
    rarity: rolled,
    level: 1,
    xp: 0,
    actives: kit.actives,
    passives: kit.passives,
    equippedActive: 0,
    equippedPassive: 0,
  };
}

export function createStarterProfile(rng: () => number): Profile {
  const pet = createPet(rng, 'common');
  return {
    v: 2,
    coins: 0,
    freeBoxes: 1,
    pets: [pet],
    equippedId: pet.instanceId,
  };
}

export function buyBox(profile: Profile, price = CONFIG.boxPrice): boolean {
  if (profile.coins < price) return false;
  profile.coins -= price;
  profile.freeBoxes++;
  return true;
}

/** Spend a free box, or the coin price, and append a newly rolled pet. */
export function openBox(profile: Profile, rng: () => number, price = CONFIG.boxPrice): PetInstance | null {
  if (profile.freeBoxes > 0) profile.freeBoxes--;
  else if (!buyBox(profile, price)) return null;
  const pet = createPet(rng);
  profile.pets.push(pet);
  return pet;
}

/** Read a v2 profile, or lift a v1 single-pet save into the collection. */
export function normalizeProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v === 1) {
    const pet = readPet(o.pet);
    if (!pet) return null;
    return { v: 2, coins: num(o.coins), freeBoxes: num(o.freeBoxes), pets: [pet], equippedId: pet.instanceId };
  }
  if (o.v !== 2 || !Array.isArray(o.pets)) return null;
  const pets: PetInstance[] = [];
  for (const item of o.pets) {
    const pet = readPet(item);
    if (pet) pets.push(pet);
  }
  if (pets.length === 0) return null;
  const equippedId =
    typeof o.equippedId === 'string' && pets.some((pet) => pet.instanceId === o.equippedId)
      ? o.equippedId
      : pets[0]!.instanceId;
  return { v: 2, coins: num(o.coins), freeBoxes: num(o.freeBoxes), pets, equippedId };
}

function readPet(raw: unknown): PetInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const species = typeof o.species === 'number' ? o.species | 0 : -1;
  if (species < 0 || species >= SPECIES.length) return null;
  const kit = parseKit({
    rarity: o.rarity,
    actives: o.actives,
    passives: o.passives,
    eqA: o.equippedActive,
    eqP: o.equippedPassive,
  });
  if (!kit) return null;
  const level = Math.max(1, Math.min(CONFIG.levelCap, num(o.level) || 1));
  return {
    instanceId: typeof o.instanceId === 'string' && o.instanceId ? o.instanceId : `pet-${species}-saved`,
    species,
    rarity: kit.rarity,
    level,
    xp: Math.max(0, num(o.xp)),
    actives: kit.actives,
    passives: kit.passives,
    equippedActive: kit.equippedActive,
    equippedPassive: kit.equippedPassive,
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
