/** Every tunable in the game lives here. Rarity multipliers are data for M2; M1 combat does not apply them. */

export interface GameConfig {
  gridW: number;
  gridH: number;
  /** World units per grid cell. The pet is about 4–5 cells wide. */
  worldScale: number;
  tickHz: number;
  maxEntities: number;
  targetPopulation: number;
  speed: number;
  turnRate: number;
  spawnSize: number;
  headRadius: number;
  pickupRadius: number;
  maxTrainStored: number;
  maxTrainVisible: number;
  coinValue: number;
  xpOrbValue: number;
  lootCoins: number;
  lootXp: number;
  killCoins: number;
  killXp: number;
  claimXpPerCell: number;
  pickupTarget: number;
  rareLootChance: number;
  killDropCoins: number;
  botThinkSec: number;
  botMistakeChance: number;
  botThreatRange: number;
  botHuntRange: number;
  botLegMin: number;
  botLegMax: number;
  botRespawnSec: number;
  levelCap: number;
  /** Base ability numbers. M2 multiplies by rarity and level. */
  abilities: {
    dashSpeed: number;
    dashSec: number;
    shieldSec: number;
    paintRadius: number;
    frostRadius: number;
    frostSlow: number;
    frostSec: number;
    recallSafe: boolean;
    swiftSpeed: number;
    magnetRadius: number;
    luckyCoins: number;
    luckyLoot: number;
    scholarXp: number;
    headStartExtra: number;
  };
  rarityMult: Record<RarityName, number>;
}

export type RarityName = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export const RARITY_ORDER: RarityName[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const RARITY_ODDS: Record<RarityName, number> = {
  common: 0.55,
  uncommon: 0.25,
  rare: 0.12,
  epic: 0.06,
  legendary: 0.02,
};

export const CONFIG: GameConfig = {
  gridW: 200,
  gridH: 200,
  worldScale: 0.28,
  tickHz: 20,
  maxEntities: 16,
  targetPopulation: 11,
  speed: 13.5,
  turnRate: 5.1,
  spawnSize: 18,
  headRadius: 0.9,
  pickupRadius: 2.1,
  maxTrainStored: 48,
  maxTrainVisible: 12,
  coinValue: 1,
  xpOrbValue: 8,
  lootCoins: 25,
  lootXp: 20,
  killCoins: 12,
  killXp: 30,
  claimXpPerCell: 0.05,
  pickupTarget: 46,
  rareLootChance: 0.08,
  killDropCoins: 4,
  botThinkSec: 0.14,
  botMistakeChance: 0.06,
  botThreatRange: 14,
  botHuntRange: 38,
  botLegMin: 16,
  botLegMax: 34,
  botRespawnSec: 1.15,
  levelCap: 20,
  abilities: {
    dashSpeed: 1.85,
    dashSec: 0.45,
    shieldSec: 2.2,
    paintRadius: 4.5,
    frostRadius: 6,
    frostSlow: 0.45,
    frostSec: 2,
    recallSafe: true,
    swiftSpeed: 0.12,
    magnetRadius: 1.8,
    luckyCoins: 0.25,
    luckyLoot: 0.08,
    scholarXp: 0.25,
    headStartExtra: 3,
  },
  rarityMult: {
    common: 1,
    uncommon: 1.15,
    rare: 1.3,
    epic: 1.5,
    legendary: 1.75,
  },
};

export function makeConfig(over: Partial<GameConfig> = {}): GameConfig {
  return {
    ...CONFIG,
    ...over,
    abilities: { ...CONFIG.abilities, ...(over.abilities ?? {}) },
    rarityMult: { ...CONFIG.rarityMult, ...(over.rarityMult ?? {}) },
  };
}

/** Bright, distinct player colors. Index 0 is player id 1. */
export const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [255, 79, 94],
  [255, 159, 28],
  [255, 209, 0],
  [126, 217, 60],
  [14, 196, 142],
  [0, 190, 255],
  [70, 120, 255],
  [150, 92, 255],
  [255, 82, 196],
  [255, 122, 140],
  [255, 112, 64],
  [176, 220, 48],
  [0, 200, 186],
  [88, 154, 255],
  [196, 92, 255],
  [255, 96, 160],
];

export const SPECIES = [
  'beaver',
  'bee',
  'bunny',
  'cat',
  'caterpillar',
  'chick',
  'cow',
  'crab',
  'deer',
  'dog',
  'elephant',
  'fish',
  'fox',
  'giraffe',
  'hog',
  'koala',
  'lion',
  'monkey',
  'panda',
  'parrot',
  'penguin',
  'pig',
  'polar',
  'tiger',
] as const;

export type SpeciesId = (typeof SPECIES)[number];

export const SPECIES_LABEL: Record<SpeciesId, string> = {
  beaver: 'Beaver',
  bee: 'Bee',
  bunny: 'Bunny',
  cat: 'Cat',
  caterpillar: 'Caterpillar',
  chick: 'Chick',
  cow: 'Cow',
  crab: 'Crab',
  deer: 'Deer',
  dog: 'Dog',
  elephant: 'Elephant',
  fish: 'Fish',
  fox: 'Fox',
  giraffe: 'Giraffe',
  hog: 'Hog',
  koala: 'Koala',
  lion: 'Lion',
  monkey: 'Monkey',
  panda: 'Panda',
  parrot: 'Parrot',
  penguin: 'Penguin',
  pig: 'Pig',
  polar: 'Polar Bear',
  tiger: 'Tiger',
};

export const BOT_NAMES = [
  'Mochi',
  'Noodle',
  'Biscuit',
  'Pepper',
  'Waffle',
  'Pebble',
  'Dumpling',
  'Maple',
  'Sushi',
  'Cookie',
  'Peanut',
  'Mango',
  'Olive',
  'Butter',
  'Clover',
  'Pip',
  'Juniper',
  'Toffee',
  'Berry',
  'Nib',
];

export const ACTIVES = ['dash', 'shield', 'paint', 'frost', 'recall'] as const;
export const PASSIVES = ['swift', 'magnet', 'lucky', 'scholar', 'headstart'] as const;
export type ActiveId = (typeof ACTIVES)[number];
export type PassiveId = (typeof PASSIVES)[number];

export function paletteIndex(playerId: number): number {
  if (playerId <= 0) return 0;
  return (playerId - 1) % PALETTE.length;
}
