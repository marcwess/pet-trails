import type { DeathReason } from './player.js';

export type ClientMsg =
  | { t: 'hello'; name?: string; pet?: number }
  | { t: 'input'; seq: number; x: number; y: number }
  | { t: 'play' }
  | { t: 'ping'; n: number };

export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  tick: number;
  gridW: number;
  gridH: number;
  pet: number;
  tickHz: number;
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
}

export interface DeltaMsg {
  t: 'delta';
  tick: number;
  ack: number;
  you: [number, number, number];
  ents: EntSnap[];
  /** RLE [start, owner, trail, length, ...] */
  cells?: number[];
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
    }
  | { e: 'claim'; id: number; n: number; x: number; y: number }
  | { e: 'pickup'; id: number; kind: number; amount: number; x: number; y: number; xp: number };

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
    const m = msg as { name?: unknown; pet?: unknown };
    const pet = typeof m.pet === 'number' && Number.isFinite(m.pet) ? m.pet | 0 : undefined;
    return { t: 'hello', name: sanitizeName(m.name), ...(pet !== undefined ? { pet } : {}) };
  }
  if (t === 'input') {
    const m = msg as { seq?: unknown; x?: unknown; y?: unknown };
    if (typeof m.seq !== 'number' || typeof m.x !== 'number' || typeof m.y !== 'number') return null;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
    return { t: 'input', seq: m.seq | 0, x: m.x, y: m.y };
  }
  if (t === 'play') return { t: 'play' };
  if (t === 'ping') {
    const n = (msg as { n?: unknown }).n;
    if (typeof n !== 'number') return null;
    return { t: 'ping', n };
  }
  return null;
}
