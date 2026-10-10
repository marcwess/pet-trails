import assert from 'node:assert/strict';
import test from 'node:test';
import { STEER_RADIUS, Steer } from '../src/steer.ts';

test('a second finger does not steal the stick', () => {
  const steer = new Steer();
  steer.down(1, 100, 200, false);
  steer.move(1, 140, 200);
  const before = steer.sample();
  steer.down(2, 20, 20, false);
  steer.move(2, 80, 80);
  const after = steer.sample();
  assert.equal(after.pointerId, 1);
  assert.equal(after.dirX, before.dirX);
  assert.equal(after.touches, 2);
  assert.ok(after.steering);
});

test('cancelling the steer finger adopts another finger and re-anchors', () => {
  const steer = new Steer();
  steer.down(1, 100, 200, false);
  steer.move(1, 160, 200);
  steer.down(2, 40, 80, false);
  steer.cancel(1);
  const sample = steer.sample();
  assert.equal(sample.pointerId, 2);
  assert.equal(sample.originX, 40);
  assert.equal(sample.originY, 80);
  assert.equal(sample.active, true);
});

test('a cancel with no spare finger releases', () => {
  const steer = new Steer();
  steer.down(1, 10, 10, false);
  steer.move(1, 80, 10);
  steer.cancel(1);
  assert.equal(steer.sample().active, false);
});

test('the anchor slides once the drag leaves the radius', () => {
  const steer = new Steer();
  steer.down(1, 0, 0, false);
  steer.move(1, STEER_RADIUS + 30, 0);
  const sample = steer.sample();
  assert.ok(Math.hypot(sample.x - sample.originX, sample.y - sample.originY) <= STEER_RADIUS + 0.01);
  assert.ok(sample.dirX > 0.9);
  assert.ok(Math.abs(sample.dirY) < 0.05);
});

test('a control finger never becomes the stick', () => {
  const steer = new Steer();
  steer.down(7, 10, 10, true);
  assert.equal(steer.sample().active, false);
  steer.down(8, 30, 40, false);
  assert.equal(steer.sample().pointerId, 8);
});

test('a held Play thumb becomes the steer when the seat is claimed', () => {
  const steer = new Steer();
  steer.down(3, 200, 700, true);
  steer.move(3, 200, 660);
  assert.equal(steer.sample().active, false);
  steer.claimHeld();
  const sample = steer.sample();
  assert.equal(sample.pointerId, 3);
  assert.equal(sample.originX, 200);
  assert.equal(sample.originY, 700);
  assert.ok(sample.steering);
  assert.ok(sample.dirY > 0.9);
});

test('a thumb still on Play is armed and the next drag steers', () => {
  const steer = new Steer();
  steer.down(3, 180, 720, true);
  steer.claimHeld();
  assert.equal(steer.sample().active, true);
  assert.equal(steer.sample().steering, false);
  steer.move(3, 180, 660);
  assert.equal(steer.sample().steering, true);
  assert.ok(steer.sample().dirY > 0.9);
});

test('noteViewport does not drop the finger', () => {
  const steer = new Steer();
  steer.down(1, 12, 12, false);
  steer.move(1, 70, 12);
  steer.noteViewport();
  assert.equal(steer.sample().active, true);
  assert.equal(steer.sample().pointerId, 1);
});
