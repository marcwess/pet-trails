import type { GameConfig } from './config.js';
import type { Grid } from './grid.js';
import type { Player } from './player.js';

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export interface BotView {
  tick: number;
  cfg: GameConfig;
  grid: Grid;
  players: Array<Player | null>;
  rng: () => number;
  dt: number;
}

function setDir(p: Player, dir: number): void {
  const d = ((dir % 4) + 4) % 4;
  p.botDir = d;
  p.desiredX = DIRS[d]![0];
  p.desiredY = DIRS[d]![1];
}

function goHome(p: Player, view: BotView): void {
  p.botPhase = 3;
  const land = view.grid.landCount[p.id] ?? 0;
  if (land <= 0) {
    setDir(p, (view.rng() * 4) | 0);
    return;
  }
  const cx = view.grid.sumX[p.id]! / land;
  const cy = view.grid.sumY[p.id]! / land;
  p.desiredX = cx - p.x;
  p.desiredY = cy - p.y;
}

function nearestTrail(
  p: Player,
  view: BotView,
): { x: number; y: number; dist: number; land: number } | null {
  const { w } = view.grid;
  const range = view.cfg.botHuntRange;
  let bestD = range;
  let best: { x: number; y: number; dist: number; land: number } | null = null;
  for (let id = 1; id < view.players.length; id++) {
    const e = view.players[id];
    if (!e || !e.active || !e.alive || e.id === p.id || e.trailLen === 0) continue;
    const step = Math.max(1, (e.trailLen / 28) | 0);
    for (let t = 0; t < e.trailLen; t += step) {
      const i = e.trail[t]!;
      const x = (i % w) + 0.5;
      const y = ((i / w) | 0) + 0.5;
      const dx = x - p.x;
      const dy = y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = { x, y, dist: d, land: view.grid.landCount[e.id] ?? 0 };
      }
    }
  }
  return best;
}

/** Steer off the bot's own trail and away from the map edge. */
function avoid(p: Player, view: BotView): void {
  const { grid, cfg } = view;
  let dx = p.desiredX;
  let dy = p.desiredY;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  if (p.x < 3 || p.x > cfg.gridW - 3 || p.y < 3 || p.y > cfg.gridH - 3) {
    p.desiredX = cfg.gridW / 2 - p.x;
    p.desiredY = cfg.gridH / 2 - p.y;
    return;
  }
  for (const dist of [1.25, 2.4]) {
    const x = p.x + dx * dist;
    const y = p.y + dy * dist;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) continue;
    const i = grid.idx(cx, cy);
    if (grid.trail[i] === p.id && grid.owner[i] !== p.id) {
      p.desiredX = -dy;
      p.desiredY = dx * p.botTurnSign || dx;
      return;
    }
  }
}

/**
 * Farmers draw a rectangle and come home. Hunters peel off toward exposed
 * trails. Everyone retreats from a bigger neighbor and sometimes flubs a turn.
 */
export function updateBot(p: Player, view: BotView): void {
  const { cfg } = view;
  p.botMoved += cfg.speed * view.dt;

  const thinkDue = view.tick >= p.botNextThink;
  if (!thinkDue && p.botPhase !== 3 && p.botPhase !== 4) {
    avoid(p, view);
    return;
  }
  if (thinkDue) {
    const thinkTicks = Math.max(1, Math.round(cfg.botThinkSec * cfg.tickHz));
    p.botNextThink = view.tick + thinkTicks;
  }

  if (thinkDue && view.rng() < cfg.botMistakeChance) {
    setDir(p, (view.rng() * 4) | 0);
    p.botNextThink = view.tick + Math.round(0.45 * cfg.tickHz);
    p.botPhase = p.outside ? 2 : 1;
    p.botMoved = 0;
    return;
  }

  if (p.outside) {
    for (let id = 1; id < view.players.length; id++) {
      const e = view.players[id];
      if (!e || !e.active || !e.alive || e.id === p.id) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy < cfg.botThreatRange * cfg.botThreatRange && e.land > p.land) {
        goHome(p, view);
        avoid(p, view);
        return;
      }
    }
  }

  const huntBias = p.botStyle === 1 ? 0.85 : 0.28;
  if (thinkDue && view.rng() < huntBias) {
    const target = nearestTrail(p, view);
    if (target && (p.land + 8 >= target.land * 0.7 || target.dist < 9)) {
      p.botPhase = 4;
      p.desiredX = target.x - p.x;
      p.desiredY = target.y - p.y;
      avoid(p, view);
      return;
    }
  }

  if (p.botPhase === 4) {
    if (!p.outside && p.trailLen === 0) p.botPhase = 0;
    else if (p.botMoved > 28) goHome(p, view);
    avoid(p, view);
    return;
  }

  if (!p.outside && (p.botPhase === 0 || p.botPhase === 3)) {
    setDir(p, (view.rng() * 4) | 0);
    p.botPhase = 1;
    p.botLeg = cfg.botLegMin + view.rng() * (cfg.botLegMax - cfg.botLegMin);
    p.botMoved = 0;
    return;
  }

  if (p.botPhase === 1 && p.outside && p.botMoved >= p.botLeg) {
    setDir(p, p.botDir + p.botTurnSign);
    p.botPhase = 2;
    p.botLeg = cfg.botLegMin + view.rng() * (cfg.botLegMax - cfg.botLegMin);
    p.botMoved = 0;
    avoid(p, view);
    return;
  }

  if (p.botPhase === 2 && p.botMoved >= p.botLeg) {
    goHome(p, view);
    avoid(p, view);
    return;
  }

  if (p.botPhase === 3) {
    goHome(p, view);
    if (!p.outside) p.botPhase = 0;
    else if (p.botMoved > 46) {
      setDir(p, (view.rng() * 4) | 0);
      p.botPhase = 1;
      p.botMoved = 0;
    }
    avoid(p, view);
    return;
  }

  avoid(p, view);
}
