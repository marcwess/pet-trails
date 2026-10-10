/**
 * Fixed-step accumulator. `alpha` is the fraction of the next tick already
 * covered, so a renderer can interpolate at 60, 90, 120, or an irregular rAF.
 */
export function consumeSteps(
  acc: number,
  dt: number,
  tick: number,
  maxSteps: number,
): { acc: number; steps: number; alpha: number } {
  let next = acc + (dt > 0 ? dt : 0);
  const cap = tick * Math.max(1, maxSteps);
  if (next > cap) next = cap;
  let steps = 0;
  const limit = Math.max(1, maxSteps);
  while (next >= tick && steps < limit) {
    next -= tick;
    steps++;
  }
  const alpha = tick > 0 ? Math.min(1, Math.max(0, next / tick)) : 1;
  return { acc: next, steps, alpha };
}

/** Frame-rate independent blend. `k` is the rate in 1/seconds. */
export function expBlend(k: number, dt: number): number {
  if (dt <= 0) return 0;
  return 1 - Math.exp(-k * dt);
}
