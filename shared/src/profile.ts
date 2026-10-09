import type { ActiveId, PassiveId, RarityName } from './config.js';
import { ACTIVES, PASSIVES, SPECIES } from './config.js';

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

/** Client-side for the playtest. Shape is ready to move server-side with accounts. */
export interface Profile {
  v: 1;
  coins: number;
  freeBoxes: number;
  pet: PetInstance;
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

export function createStarterProfile(rng: () => number): Profile {
  const species = Math.floor(rng() * SPECIES.length);
  const kit = rollKit(rng);
  return {
    v: 1,
    coins: 0,
    freeBoxes: 1,
    pet: {
      instanceId: `pet-${species}-${Math.floor(rng() * 1e9).toString(36)}`,
      species,
      rarity: 'common',
      level: 1,
      xp: 0,
      actives: kit.actives,
      passives: kit.passives,
      equippedActive: 0,
      equippedPassive: 0,
    },
  };
}
