const q = new URLSearchParams(globalThis.location?.search ?? '');

function num(key: string, fallback: number): number {
  const raw = q.get(key);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Frame-time switches. The defaults are the shipped path. The profile turns
 * one cost back on (or off) at a time:
 * `basic=1`, `shadow=1`, `over=0`, `cpu=0`, `vignette=1`, `dpr=1`.
 * The playable floor is the clear color. Nothing samples a floor texture.
 */
export const gfx = {
  basic: q.get('basic') === '1',
  shadow: q.get('shadow') === '1',
  over: q.get('over') !== '0',
  cpu: q.get('cpu') !== '0',
  vignette: q.get('vignette') === '1',
  dpr: num('dpr', Math.min(globalThis.devicePixelRatio || 1, 2)),
};
