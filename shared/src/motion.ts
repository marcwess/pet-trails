import type { GameConfig } from './config.js';

export interface Body {
  x: number;
  y: number;
  heading: number;
  desiredX: number;
  desiredY: number;
}

/** Shortest signed angle from `from` to `to`, in radians. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAngle(from: number, to: number, t: number): number {
  return from + angleDelta(from, to) * t;
}

/**
 * Advance a body by `dt` seconds: turn toward the desired direction at the
 * configured rate, then move forward. `onCell` fires for every newly entered
 * grid cell (4-connected, so diagonal steps cannot leak a flood fill).
 * Return false from `onCell` to stop on that cell. The map fence never kills:
 * a step past it is clamped and the heading is deflected along the wall.
 */
export function integrateBody(
  body: Body,
  dt: number,
  cfg: Pick<GameConfig, 'speed' | 'turnRate' | 'gridW' | 'gridH'>,
  onCell?: (cx: number, cy: number) => boolean,
): void {
  if (body.desiredX !== 0 || body.desiredY !== 0) {
    const target = Math.atan2(body.desiredY, body.desiredX);
    const max = cfg.turnRate * dt;
    const d = angleDelta(body.heading, target);
    if (d > max) body.heading += max;
    else if (d < -max) body.heading -= max;
    else body.heading = target;
  }

  const x0 = body.x;
  const y0 = body.y;
  let nx = x0 + Math.cos(body.heading) * cfg.speed * dt;
  let ny = y0 + Math.sin(body.heading) * cfg.speed * dt;
  const m = 0.35;
  const hitL = nx < m;
  const hitR = nx > cfg.gridW - m;
  const hitB = ny < m;
  const hitT = ny > cfg.gridH - m;
  if (hitL) nx = m;
  if (hitR) nx = cfg.gridW - m;
  if (hitB) ny = m;
  if (hitT) ny = cfg.gridH - m;
  if (hitL || hitR || hitB || hitT) slideAlongWall(body, hitL, hitR, hitB, hitT);

  if (!onCell) {
    body.x = nx;
    body.y = ny;
    return;
  }

  const stopped = walkCells(x0, y0, nx, ny, onCell);
  if (stopped) {
    body.x = stopped.cx + 0.5;
    body.y = stopped.cy + 0.5;
    return;
  }
  body.x = nx;
  body.y = ny;
}

/** Drop the outward component so the pet slides along the fence. */
function slideAlongWall(body: Body, hitL: boolean, hitR: boolean, hitB: boolean, hitT: boolean): void {
  let vx = Math.cos(body.heading);
  let vy = Math.sin(body.heading);
  if ((hitL && vx < 0) || (hitR && vx > 0)) vx = 0;
  if ((hitB && vy < 0) || (hitT && vy > 0)) vy = 0;
  if (Math.abs(vx) < 1e-8 && Math.abs(vy) < 1e-8) {
    if (hitL || hitR) vy = body.desiredY < 0 ? -1 : 1;
    else vx = body.desiredX < 0 ? -1 : 1;
  }
  body.heading = Math.atan2(vy, vx);
}

/**
 * Visit every grid cell the segment enters, not including the start cell.
 * On an exact corner crossing, both orthogonal cells are visited so a trail
 * stays 4-connected. Returns the cell where `visit` returned false.
 */
export function walkCells(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (cx: number, cy: number) => boolean,
): { cx: number; cy: number } | null {
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = Infinity;
  let tMaxY = Infinity;
  if (stepX > 0) tMaxX = (cx + 1 - x0) / dx;
  else if (stepX < 0) tMaxX = (cx - x0) / dx;
  if (stepY > 0) tMaxY = (cy + 1 - y0) / dy;
  else if (stepY < 0) tMaxY = (cy - y0) / dy;

  let guard = 0;
  while ((cx !== endX || cy !== endY) && guard++ < 12) {
    if (tMaxX < tMaxY) {
      cx += stepX;
      tMaxX += tDeltaX;
      if (!visit(cx, cy)) return { cx, cy };
    } else if (tMaxY < tMaxX) {
      cy += stepY;
      tMaxY += tDeltaY;
      if (!visit(cx, cy)) return { cx, cy };
    } else {
      cx += stepX;
      tMaxX += tDeltaX;
      if (!visit(cx, cy)) return { cx, cy };
      cy += stepY;
      tMaxY += tDeltaY;
      if (!visit(cx, cy)) return { cx, cy };
    }
  }
  return null;
}
