import { CONFIG, type GameConfig, type RarityName } from './config.js';

/** Recolor milestones. 0 is the original colormap. */
export const RECOLORS = [
  { level: 5, id: 'shadow', name: 'Shadow' },
  { level: 10, id: 'golden', name: 'Golden' },
  { level: 15, id: 'frost', name: 'Frost' },
  { level: 20, id: 'neon', name: 'Neon' },
] as const;

/** Trail milestones. 0 means no cosmetic. */
export const TRAILS = [
  { level: 3, id: 'sparkle', name: 'Sparkle' },
  { level: 8, id: 'hearts', name: 'Hearts' },
  { level: 12, id: 'rainbow', name: 'Rainbow' },
  { level: 18, id: 'paws', name: 'Paw prints' },
] as const;

/** 1 at level 1. Each further level adds `levelGain`. */
export function levelPower(level: number, cfg: GameConfig = CONFIG): number {
  const lv = Math.max(1, Math.min(cfg.levelCap, level | 0));
  return 1 + (lv - 1) * cfg.levelGain;
}

/** Effect size: base × rarity × level. */
export function abilityPower(base: number, rarity: RarityName, level: number, cfg: GameConfig = CONFIG): number {
  return base * (cfg.rarityMult[rarity] ?? 1) * levelPower(level, cfg);
}

/** Cooldown shrinks as rarity and level go up. */
export function abilityCooldown(base: number, rarity: RarityName, level: number, cfg: GameConfig = CONFIG): number {
  const scale = (cfg.rarityMult[rarity] ?? 1) * levelPower(level, cfg);
  return scale > 0 ? base / scale : base;
}

/** 0 original, 1 shadow, 2 golden, 3 frost, 4 neon. */
export function recolorId(level: number): number {
  let id = 0;
  for (let i = 0; i < RECOLORS.length; i++) if (level >= RECOLORS[i]!.level) id = i + 1;
  return id;
}

/** 0 none, 1 sparkle, 2 hearts, 3 rainbow, 4 paw prints. */
export function trailId(level: number): number {
  let id = 0;
  for (let i = 0; i < TRAILS.length; i++) if (level >= TRAILS[i]!.level) id = i + 1;
  return id;
}

export function unlockNames(level: number): string[] {
  const names: string[] = [];
  for (const item of TRAILS) if (level >= item.level) names.push(item.name);
  for (const item of RECOLORS) if (level >= item.level) names.push(item.name);
  return names;
}

/** Unlocks that appear strictly after `from` and at or before `to`. */
export function gainedUnlocks(from: number, to: number): string[] {
  const names: string[] = [];
  for (const item of TRAILS) if (item.level > from && item.level <= to) names.push(`${item.name} trail`);
  for (const item of RECOLORS) if (item.level > from && item.level <= to) names.push(`${item.name} recolor`);
  return names;
}
