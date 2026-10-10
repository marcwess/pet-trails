/**
 * Tiny WebAudio hooks. Call sites stay even if autoplay blocks the context.
 * Nothing here runs on the frame loop.
 */
let ctx: AudioContext | null = null;

function tone(freq: number, dur: number, type: OscillatorType, gain: number): void {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, ctx.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch {
    /* autoplay or a missing context */
  }
}

export const sfx = {
  tap: () => tone(540, 0.05, 'triangle', 0.035),
  play: () => tone(680, 0.14, 'square', 0.04),
  coin: () => tone(920, 0.08, 'sine', 0.045),
  out: () => tone(160, 0.22, 'triangle', 0.04),
  win: () => tone(760, 0.28, 'triangle', 0.05),
  open: () => tone(420, 0.1, 'square', 0.04),
};
