import {
  ACTIVES,
  CONFIG,
  PASSIVES,
  RARITY_ODDS,
  RARITY_ORDER,
  type ActiveId,
  type GameConfig,
  type PassiveId,
  type RarityName,
} from './config.js';
import { levelPower } from './cosmetics.js';

/** One pet's rolled kit. Equipped slots pick which of the two is live. */
export interface Kit {
  rarity: RarityName;
  actives: [ActiveId, ActiveId];
  passives: [PassiveId, PassiveId];
  equippedActive: 0 | 1;
  equippedPassive: 0 | 1;
}

export const DEFAULT_KIT: Kit = {
  rarity: 'common',
  actives: ['dash', 'shield'],
  passives: ['swift', 'magnet'],
  equippedActive: 0,
  equippedPassive: 0,
};

export function isRarity(value: unknown): value is RarityName {
  return typeof value === 'string' && (RARITY_ORDER as readonly string[]).includes(value);
}

export function isActive(value: unknown): value is ActiveId {
  return typeof value === 'string' && (ACTIVES as readonly string[]).includes(value);
}

export function isPassive(value: unknown): value is PassiveId {
  return typeof value === 'string' && (PASSIVES as readonly string[]).includes(value);
}

/** Rarity multiplier times the level bonus (`levelGain` per level above 1). */
export function rarityScale(rarity: RarityName, cfg: GameConfig = CONFIG, level = 1): number {
  return (cfg.rarityMult[rarity] ?? 1) * levelPower(level, cfg);
}

/** Effect size and duration grow with rarity and level. */
export function effectOf(base: number, rarity: RarityName, cfg: GameConfig = CONFIG, level = 1): number {
  return base * rarityScale(rarity, cfg, level);
}

/** Cooldowns shrink with rarity and level. */
export function cooldownOf(base: number, rarity: RarityName, cfg: GameConfig = CONFIG, level = 1): number {
  const scale = rarityScale(rarity, cfg, level);
  return scale > 0 ? base / scale : base;
}

export function cooldownBase(kind: ActiveId, cfg: GameConfig = CONFIG): number {
  const a = cfg.abilities;
  if (kind === 'dash') return a.dashCd;
  if (kind === 'shield') return a.shieldCd;
  if (kind === 'paint') return a.paintCd;
  if (kind === 'frost') return a.frostCd;
  return a.recallCd;
}

/**
 * Speed multiplier from the swift passive, an active dash, and a frost slow.
 * The sim and the client prediction both use this, so they move at the same pace.
 */
export function speedMultiplier(
  rarity: RarityName,
  passive: PassiveId,
  dashing: boolean,
  slowMul: number | null,
  cfg: GameConfig = CONFIG,
  level = 1,
): number {
  const a = cfg.abilities;
  const scale = rarityScale(rarity, cfg, level);
  let mul = 1;
  if (passive === 'swift') mul *= 1 + a.swiftSpeed * scale;
  if (dashing) mul *= 1 + (a.dashSpeed - 1) * scale;
  if (slowMul !== null) mul *= slowMul;
  return mul;
}

export function rollRarity(rng: () => number): RarityName {
  const t = rng();
  let acc = 0;
  for (const name of RARITY_ORDER) {
    acc += RARITY_ODDS[name];
    if (t < acc) return name;
  }
  return 'common';
}

/**
 * Accept a kit only when both pairs are known and distinct and the equipped
 * index points at one of them. Anything else is rejected.
 */
export function parseKit(raw: unknown): Kit | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isRarity(o.rarity)) return null;
  const actives = readPair(o.actives, isActive);
  const passives = readPair(o.passives, isPassive);
  if (!actives || !passives) return null;
  if (actives[0] === actives[1] || passives[0] === passives[1]) return null;
  if (o.eqA !== 0 && o.eqA !== 1) return null;
  if (o.eqP !== 0 && o.eqP !== 1) return null;
  return {
    rarity: o.rarity,
    actives,
    passives,
    equippedActive: o.eqA,
    equippedPassive: o.eqP,
  };
}

function readPair<T extends string>(value: unknown, ok: (v: unknown) => v is T): [T, T] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (!ok(value[0]) || !ok(value[1])) return null;
  return [value[0], value[1]];
}
