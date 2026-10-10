import type { GameConfig } from './config.js';
import type { LandBook } from './land.js';
import { angleDelta } from './motion.js';
import type { Player } from './player.js';

export interface BotView {
  tick: number;
  cfg: GameConfig;
  land: LandBook;
  players: Array<Player | null>;
  rng: () => number;
  dt: number;
  /** 0 while the round is full, 1 when few pets remain or the clock is late. */
  heat: number;
}

function steer(p: Player, angle: number): void {
  p.desiredX = Math.cos(angle);
  p.desiredY = Math.sin(angle);
}

function goHome(p: Player, view: BotView): void {
  p.botPhase = 3;
  p.botMoved = 0;
  const home = view.land.home(p.id);
  if (!home) {
    steer(p, view.rng() * Math.PI * 2);
    return;
  }
  p.desiredX = home.x - p.x;
  p.desiredY = home.y - p.y;
}

function legLength(p: Player, view: BotView): number {
  const { cfg } = view;
  let leg = cfg.botLegMin + view.rng() * (cfg.botLegMax - cfg.botLegMin);
  if (view.rng() < 0.22) leg *= 1.85;
  if (p.botStyle === 0) leg *= 0.85;
  return leg;
}

function nearestTrail(p: Player, view: BotView): { x: number; y: number; dist: number; land: number } | null {
  const range = view.cfg.botHuntRange;
  let bestD = range;
  let best: { x: number; y: number; dist: number; land: number } | null = null;
  for (let id = 1; id < view.players.length; id++) {
    const e = view.players[id];
    if (!e || !e.active || !e.alive || e.id === p.id || e.trailLen < 4) continue;
    const step = Math.max(1, (e.trailLen / 24) | 0);
    for (let t = 0; t < e.trailLen; t += step) {
      const x = e.trailX[t]!;
      const y = e.trailY[t]!;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y, dist: d, land: view.land.areaOf(e.id) };
      }
    }
  }
  return best;
}

function trailThreatened(p: Player, view: BotView): boolean {
  if (p.trailLen < 4) return false;
  const step = Math.max(1, (p.trailLen / 10) | 0);
  for (let t = 0; t < p.trailLen; t += step) {
    const x = p.trailX[t]!;
    const y = p.trailY[t]!;
    for (let id = 1; id < view.players.length; id++) {
      const e = view.players[id];
      if (!e || !e.active || !e.alive || e.id === p.id) continue;
      if (Math.hypot(e.x - x, e.y - y) < 7) return true;
    }
  }
  return false;
}

/**
 * A rival trail just ahead of the head. Cutting it is a kill, so a hunting bot wants it;
 * a bot that is only farming land swerves instead, which keeps a full field from
 * wiping itself out by accident in the first seconds of a round.
 */
function rivalTrailAhead(p: Player, view: BotView): { x: number; y: number } | null {
  const hx = Math.cos(p.heading);
  const hy = Math.sin(p.heading);
  const cx = p.x + hx * 3;
  const cy = p.y + hy * 3;
  for (let id = 1; id < view.players.length; id++) {
    const e = view.players[id];
    if (!e || !e.active || !e.alive || e.id === p.id || e.trailLen < 2) continue;
    for (let t = 0; t < e.trailLen; t++) {
      // Inside a capsule from the head to 5 cells ahead, about 1.4 cells wide.
      const dx = e.trailX[t]! - p.x;
      const dy = e.trailY[t]! - p.y;
      if (Math.abs(e.trailX[t]! - cx) > 4 || Math.abs(e.trailY[t]! - cy) > 4) continue;
      const along = dx * hx + dy * hy;
      if (along < 0.3 || along > 5) continue;
      const across = dx * hy - dy * hx;
      if (across > -1.4 && across < 1.4) return { x: e.trailX[t]!, y: e.trailY[t]! };
    }
  }
  return null;
}

/** Steer back inside when the curved fence is close. A bot's own trail is safe to cross. */
function avoid(p: Player, view: BotView): boolean {
  const hit = view.land.fenceAt(p.x, p.y);
  if (hit.inside && hit.dist > 6) return false;
  const pull = hit.inside ? 1.6 : 3.2;
  const side = p.botTurnSign < 0 ? -1 : 1;
  p.desiredX = -hit.nx * pull + hit.tx * side * 0.45;
  p.desiredY = -hit.ny * pull + hit.ty * side * 0.45;
  return true;
}

/**
 * Free-angle loops of varying size. Bots head home when a rival nears their
 * trail, hunt exposed trails, and sometimes commit to a long risky loop.
 */
export function updateBot(p: Player, view: BotView): void {
  const { cfg } = view;
  const heat = Math.max(0, Math.min(1, view.heat || 0));
  if (p.outside) p.botMoved += cfg.speed * view.dt;

  if (avoid(p, view)) return;

  if (p.botPhase !== 4 && view.rng() > heat * 0.8) {
    const cut = rivalTrailAhead(p, view);
    if (cut) {
      // Turn away from the trail point, toward whichever side it is not on.
      const side = Math.cos(p.heading) * (cut.y - p.y) - Math.sin(p.heading) * (cut.x - p.x) > 0 ? -1 : 1;
      steer(p, p.heading + side * 1.4);
      return;
    }
  }

  if (p.outside && (trailThreatened(p, view) || biggerNeighbor(p, view))) {
    goHome(p, view);
    return;
  }

  if (p.botPhase === 2) {
    if (!p.outside) {
      p.botPhase = 0;
      return;
    }
    // Desired stays a small step ahead of heading, so the shared turn-rate
    // limit draws a wide arc instead of a square corner.
    steer(p, p.heading + p.botTurnSign * 0.09);
    if (Math.abs(angleDelta(p.botDir, p.heading)) >= 1.05) {
      p.botTurns++;
      steer(p, p.heading);
      p.botMoved = 0;
      p.botLeg = legLength(p, view) * (1 - heat * 0.4);
      if (p.botTurns >= 3) {
        goHome(p, view);
        return;
      }
      p.botPhase = 1;
    }
    return;
  }

  const thinkDue = view.tick >= p.botNextThink;
  if (thinkDue) {
    const think = cfg.botThinkSec * (1 - heat * 0.55);
    p.botNextThink = view.tick + Math.max(1, Math.round(think * cfg.tickHz));
    if (view.rng() < cfg.botMistakeChance * (1 - heat * 0.85)) {
      steer(p, p.heading + (view.rng() - 0.5) * 1.4);
      return;
    }
    const baseHunt = p.botStyle === 1 ? 0.72 : 0.34;
    // Elimination rounds: with a full field bots mostly farm land, so the round lasts a
    // few minutes. Heat (few pets left, or late clock) brings the hunting back.
    const huntBias = baseHunt * (0.08 + 0.92 * heat) + (0.94 - baseHunt) * heat;
    const committed = p.botPhase === 1 && p.botTurns < 2;
    if (view.rng() < huntBias) {
      const target = nearestTrail(p, view);
      const reach = 0.5 + 0.5 * heat;
      const close = !!target && target.dist < (committed ? 11 : 18) * reach;
      const worth = !!target && !committed && heat > 0.3 && p.land > target.land * 1.4 && target.dist < 28;
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
    p.botLeg = legLength(p, view) * (1 - heat * 0.4);
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
    p.botPhase = 2;
    p.botDir = p.heading;
    p.botMoved = 0;
    return;
  }

  if (p.botPhase === 3) {
    goHome(p, view);
    if (!p.outside) p.botPhase = 0;
    return;
  }
}

/** Bots spend the equipped active when it actually helps. */
export function botWantsAbility(p: Player, view: BotView): boolean {
  if (!p.alive || view.tick < p.cdUntil) return false;
  const kind = p.activeId;
  if (kind === 'shield') return p.outside && p.trailLen > 6 && rivalNearTrail(p, view, 8);
  if (kind === 'recall') {
    const home = view.land.home(p.id);
    if (!home || !p.outside || p.trailLen < 16) return false;
    const far = Math.hypot(home.x - p.x, home.y - p.y) > 18;
    return far && (p.trailLen > 28 || rivalNearTrail(p, view, 9));
  }
  if (kind === 'dash') return nearestRival(p, view) < 12;
  if (kind === 'frost') {
    const scale = view.cfg.rarityMult[p.rarity] ?? 1;
    return nearestRival(p, view) < view.cfg.abilities.frostRadius * scale;
  }
  if (kind === 'paint') return p.outside && p.trailLen > 14;
  return false;
}

function nearestRival(p: Player, view: BotView): number {
  let best = Infinity;
  for (let id = 1; id < view.players.length; id++) {
    const e = view.players[id];
    if (!e || !e.active || !e.alive || e.id === p.id) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d < best) best = d;
  }
  return best;
}

function rivalNearTrail(p: Player, view: BotView, range: number): boolean {
  if (p.trailLen < 4) return false;
  const step = Math.max(1, (p.trailLen / 10) | 0);
  for (let t = 0; t < p.trailLen; t += step) {
    const x = p.trailX[t]!;
    const y = p.trailY[t]!;
    for (let id = 1; id < view.players.length; id++) {
      const e = view.players[id];
      if (!e || !e.active || !e.alive || e.id === p.id) continue;
      if (Math.hypot(e.x - x, e.y - y) < range) return true;
    }
  }
  return false;
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
