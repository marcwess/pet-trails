import type { Kit } from './abilities.js';
import { parseKit } from './abilities.js';
import type { DeathReason } from './player.js';

export type ClientMsg =
  | { t: 'hello'; name?: string; pet?: number; kit?: Kit | null; level?: number }
  | { t: 'input'; seq: number; x: number; y: number }
  | { t: 'play' }
  | { t: 'ability' }
  | { t: 'ping'; n: number };

export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  tick: number;
  gridW: number;
  gridH: number;
  pet: number;
  tickHz: number;
  /** Room seed. The client rebuilds the same curved map outline from it. */
  seed: number;
  names: Array<{ i: number; n: string; p: number; b: number }>;
}

/** Entity snapshot. `tr` is the visible train (pet species ids), `tn` is the full length. */
export interface EntSnap {
  i: number;
  x: number;
  y: number;
  h: number;
  l: number;
  p: number;
  f: number;
  k: number;
  c: number;
  xp: number;
  tn: number;
  tr: number[];
  /** Rarity index, 0 common through 4 legendary. */
  ry: number;
  /** Seconds left on the active cooldown. */
  cd: number;
  /** Bits: 1 dash, 2 shield, 4 slowed. */
  st: number;
  /** Pet level, 1–20. Recolor and trail cosmetics are derived from it. */
  lv: number;
}

export interface DeltaMsg {
  t: 'delta';
  tick: number;
  ack: number;
  you: [number, number, number];
  ents: EntSnap[];
  /**
   * Polygons for owners that changed this tick. Flat integers:
   * [id, polyCount, (ringCount, (n, x, y, ...))...]. Coordinates are cell units × 16.
   * polyCount 0 clears that owner.
   */
  lands?: number[];
  /** Flat [id, kind, x, y, ...] */
  pickups?: number[];
  events?: WireEvent[];
}

export type WireEvent =
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
      total: number;
    }
  | {
      e: 'win';
      id: number;
      name: string;
      total: number;
      pct: number;
      kills: number;
      coins: number;
      xp: number;
      time: number;
    }
  | { e: 'claim'; id: number; n: number; x: number; y: number }
  | { e: 'pickup'; id: number; kind: number; amount: number; x: number; y: number; xp: number }
  | { e: 'ability'; id: number; kind: string; x: number; y: number; r: number; fx: number; fy: number };

export interface PongMsg {
  t: 'pong';
  n: number;
}

export interface FullMsg {
  t: 'full';
}

export const FLAG_ALIVE = 1;
export const FLAG_BOT = 2;
export const FLAG_OUTSIDE = 4;

/** `undefined` when the hello omits a kit. `null` when the kit is impossible. */
function readHelloKit(m: {
  rarity?: unknown;
  actives?: unknown;
  passives?: unknown;
  kit?: unknown;
  eqA?: unknown;
  eqP?: unknown;
}): Kit | null | undefined {
  const present = m.kit !== undefined || m.rarity !== undefined || m.actives !== undefined || m.passives !== undefined;
  if (!present) return undefined;
  const raw = m.kit !== undefined ? m.kit : m;
  return parseKit(raw);
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'You';
  const cleaned = raw.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'You';
}

export function parseClientMsg(data: string): ClientMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const t = (msg as { t?: unknown }).t;
  if (t === 'hello') {
    const m = msg as { name?: unknown; pet?: unknown; rarity?: unknown; actives?: unknown; kit?: unknown; level?: unknown };
    const pet = typeof m.pet === 'number' && Number.isFinite(m.pet) ? m.pet | 0 : undefined;
    const kit = readHelloKit(m);
    const level = typeof m.level === 'number' && Number.isFinite(m.level) ? m.level | 0 : undefined;
    return {
      t: 'hello',
      name: sanitizeName(m.name),
      ...(pet !== undefined ? { pet } : {}),
      ...(kit !== undefined ? { kit } : {}),
      ...(level !== undefined ? { level } : {}),
    };
  }
  if (t === 'input') {
    const m = msg as { seq?: unknown; x?: unknown; y?: unknown };
    if (typeof m.seq !== 'number' || typeof m.x !== 'number' || typeof m.y !== 'number') return null;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
    return { t: 'input', seq: m.seq | 0, x: m.x, y: m.y };
  }
  if (t === 'play') return { t: 'play' };
  if (t === 'ability') return { t: 'ability' };
  if (t === 'ping') {
    const n = (msg as { n?: unknown }).n;
    if (typeof n !== 'number') return null;
    return { t: 'ping', n };
  }
  return null;
}
