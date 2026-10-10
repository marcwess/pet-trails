import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSteps, expBlend } from '../src/clock.ts';

const tick = 1 / 20;

test('60, 90, 120, and an irregular frame all stay inside one tick of alpha', () => {
  for (const hz of [60, 90, 120, 144]) {
    let acc = 0;
    let steps = 0;
    const dt = 1 / hz;
    for (let i = 0; i < hz; i++) {
      const out = consumeSteps(acc, dt, tick, 5);
      acc = out.acc;
      steps += out.steps;
      assert.ok(out.alpha >= 0 && out.alpha <= 1);
      assert.ok(out.acc < tick + 1e-9);
    }
    assert.ok(Math.abs(steps - 20) <= 1, `${hz}Hz produced ${steps} steps`);
  }
  let acc = 0.01;
  const hitch = consumeSteps(acc, 0.037, tick, 5);
  assert.ok(hitch.alpha >= 0 && hitch.alpha <= 1);
  assert.ok(hitch.steps >= 0);
});

test('a long frame cannot run away with the accumulator', () => {
  const out = consumeSteps(0, 1, tick, 5);
  assert.equal(out.steps, 5);
  assert.ok(out.acc < tick);
});

test('expBlend is frame-rate independent', () => {
  const k = 16;
  let once = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) once += (1 - once) * expBlend(k, dt);
  const single = expBlend(k, 1);
  assert.ok(Math.abs(once - single) < 0.02);
  assert.equal(expBlend(k, 0), 0);
  assert.ok(expBlend(k, dt) > 0 && expBlend(k, dt) < 1);
});
