import type { GameConfig } from './config.js';
import type { Grid } from './grid.js';
import type { Player } from './player.js';

export interface BotView {
  tick: number;
  cfg: GameConfig;
  grid: Grid;
  players: Array<Player | null>;
  rng: () => number;
  dt: number;
}

function steer(p: Player, angle: number): void {
  p.desiredX = Math.cos(angle);
  p.desiredY = Math.sin(angle);
}

function goHome(p: Player, view: BotView): void {
  p.botPhase = 3;
  p.botMoved = 0;
  const land = view.grid.landCount[p.id] ?? 0;
  if (land <= 0) {
    steer(p, view.rng() * Math.PI * 2);
    return;
  }
  const cx = view.grid.sumX[p.id]! / land;
  const cy = view.grid.sumY[p.id]! / land;
  p.desiredX = cx - p.x;
  p.desiredY = cy - p.y;
}

function legLength(p: Player, view: BotView): number {
  const { cfg } = view;
  let leg = cfg.botLegMin + view.rng() * (cfg.botLegMax - cfg.botLegMin);
  if (view.rng() < 0.22) leg *= 1.85;
  if (p.botStyle === 0) leg *= 0.85;
  return leg;
}

function nearestTrail(p: Player, view: BotView): { x: number; y: number; dist: number; land: number } | null {
  const { w } = view.grid;
  const range = view.cfg.botHuntRange;
  let bestD = range;
  let best: { x: number; y: number; dist: number; land: number } | null = null;
  for (let id = 1; id < view.players.length; id++) {
    const e = view.players[id];
    if (!e || !e.active || !e.alive || e.id === p.id || e.trailLen < 4) continue;
    const step = Math.max(1, (e.trailLen / 24) | 0);
    for (let t = 0; t < e.trailLen; t += step) {
      const i = e.trail[t]!;
      const x = (i % w) + 0.5;
      const y = ((i / w) | 0) + 0.5;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y, dist: d, land: view.grid.landCount[e.id] ?? 0 };
      }
    }
  }
  return best;
}

function trailThreatened(p: Player, view: BotView): boolean {
  if (p.trailLen < 4) return false;
  const { w } = view.grid;
  const step = Math.max(1, (p.trailLen / 10) | 0);
  for (let t = 0; t < p.trailLen; t += step) {
    const i = p.trail[t]!;
    const x = (i % w) + 0.5;
    const y = ((i / w) | 0) + 0.5;
    for (let id = 1; id < view.players.length; id++) {
      const e = view.players[id];
      if (!e || !e.active || !e.alive || e.id === p.id) continue;
      if (Math.hypot(e.x - x, e.y - y) < 7) return true;
    }
  }
  return false;
}

/** Turn away from the bot's own trail and the map edge. */
function avoid(p: Player, view: BotView): boolean {
  const { grid, cfg } = view;
  const edge = 6;
  if (p.x < edge || p.x > cfg.gridW - edge || p.y < edge || p.y > cfg.gridH - edge) {
    p.desiredX = cfg.gridW / 2 - p.x;
    p.desiredY = cfg.gridH / 2 - p.y;
    return true;
  }
  const dx = Math.cos(p.heading);
  const dy = Math.sin(p.heading);
  for (const dist of [3.2, 6.5]) {
    const x = p.x + dx * dist;
    const y = p.y + dy * dist;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) continue;
    const i = grid.idx(cx, cy);
    if (grid.trail[i] === p.id && grid.owner[i] !== p.id) {
      const s = p.botTurnSign || 1;
      p.desiredX = -dy * s;
      p.desiredY = dx * s;
      return true;
    }
  }
  return false;
}

/**
 * Free-angle loops of varying size. Bots head home when a rival nears their
 * trail, hunt exposed trails, and sometimes commit to a long risky loop.
 */
export function updateBot(p: Player, view: BotView): void {
  const { cfg } = view;
  if (p.outside) p.botMoved += cfg.speed * view.dt;

  if (avoid(p, view)) return;

  if (p.outside && (trailThreatened(p, view) || biggerNeighbor(p, view))) {
    goHome(p, view);
    return;
  }

  const thinkDue = view.tick >= p.botNextThink;
  if (thinkDue) {
    p.botNextThink = view.tick + Math.max(1, Math.round(cfg.botThinkSec * cfg.tickHz));
    if (view.rng() < cfg.botMistakeChance) {
      steer(p, p.heading + (view.rng() - 0.5) * 1.4);
      return;
    }
    const huntBias = p.botStyle === 1 ? 0.72 : 0.34;
    const committed = p.botPhase === 1 && p.botTurns < 2;
    if (view.rng() < huntBias) {
      const target = nearestTrail(p, view);
      const close = !!target && target.dist < (committed ? 11 : 18);
      const worth = !!target && !committed && p.land > target.land * 1.4 && target.dist < 28;
      if (target && (close || worth)) {
        p.botPhase = 4;
        p.desiredX = target.x - p.x;
        p.desiredY = target.y - p.y;
        p.botMoved = 0;
        return;
      }
    }
  }

  if (p.botPhase === 4) {
    if (p.botMoved > 42 || (!p.outside && p.trailLen === 0 && p.botMoved > 4)) {
      if (p.outside) goHome(p, view);
      else p.botPhase = 0;
    }
    return;
  }

  if (!p.outside && (p.botPhase === 0 || p.botPhase === 3)) {
    const ang = p.heading + (view.rng() - 0.5) * 0.8;
    steer(p, ang);
    p.botPhase = 1;
    p.botTurns = 0;
    p.botMoved = 0;
    p.botLeg = legLength(p, view);
    const rx = p.x - cfg.gridW / 2;
    const ry = p.y - cfg.gridH / 2;
    if (rx * rx + ry * ry < 45 * 45) {
      const ang = Math.atan2(p.desiredY, p.desiredX);
      const out = -Math.sin(ang) * rx + Math.cos(ang) * ry;
      p.botTurnSign = out >= 0 ? 1 : -1;
    } else {
      p.botTurnSign = view.rng() < 0.5 ? -1 : 1;
    }
    return;
  }

  if (p.botPhase === 1 && p.outside && p.botMoved >= p.botLeg) {
    p.botTurns++;
    if (p.botTurns >= 3) {
      goHome(p, view);
      return;
    }
    steer(p, p.heading + p.botTurnSign * (Math.PI / 2));
    p.botMoved = 0;
    p.botLeg = legLength(p, view);
    return;
  }

  if (p.botPhase === 3) {
    goHome(p, view);
    if (!p.outside) p.botPhase = 0;
    return;
  }
}

function biggerNeighbor(p: Player, view: BotView): boolean {
  const r = view.cfg.botThreatRange;
  for (let id = 1; id < view.players.length; id++) {
    const e = view.players[id];
    if (!e || !e.active || !e.alive || e.id === p.id) continue;
    if (e.land <= p.land) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) < r) return true;
  }
  return false;
}
