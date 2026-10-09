import type { DeathReason } from './player.js';

export type SimEvent =
  | { e: 'spawn'; id: number; name: string; pet: number; bot: boolean }
  | { e: 'leave'; id: number }
  | { e: 'kill'; killer: number; victim: number; x: number; y: number; pet: number }
  | {
      e: 'die';
      id: number;
      reason: DeathReason;
      killer: number;
      pct: number;
      kills: number;
      train: number;
      coins: number;
      xp: number;
      time: number;
      rank: number;
    }
  | { e: 'claim'; id: number; n: number; x: number; y: number }
  | { e: 'pickup'; id: number; kind: number; amount: number; x: number; y: number; xp: number }
  | {
      e: 'ability';
      id: number;
      kind: string;
      x: number;
      y: number;
      r: number;
      fx: number;
      fy: number;
    };

export interface SimStats {
  kills: number;
  claims: number;
  deaths: number;
  claimedCells: number;
}
