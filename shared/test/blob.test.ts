import assert from 'node:assert/strict';
import test from 'node:test';
import { mapBlob, ringArea, spawnRadius } from '../src/shape.ts';
import { Sim } from '../src/sim.ts';

test('the map blob is a smooth seeded curve and the corners stay outside', () => {
  const w = 200;
  const h = 200;
  const ring = mapBlob(7, w, h);
  const again = mapBlob(7, w, h);
  assert.deepEqual(again, ring);
  const other = mapBlob(8, w, h);
  assert.notDeepEqual(other, ring);
  const sim = new Sim({ gridW: w, gridH: h, targetPopulation: 0, pickupTarget: 0 }, 7);
  assert.equal(sim.land.insideMap(w / 2, h / 2), true);
  assert.equal(sim.land.insideMap(0.4, 0.4), false, 'corner is playable');
  assert.equal(sim.land.insideMap(w - 0.4, 0.4), false);
  assert.equal(sim.land.insideMap(0.4, h - 0.4), false);
  assert.equal(sim.land.insideMap(w - 0.4, h - 0.4), false);
  const area = ringArea(ring);
  assert.ok(area > w * h * 0.35 && area < w * h * 0.92, `blob area ${area}`);
  assert.ok(Math.abs(sim.land.mapArea - area) < 0.05);
  const n = ring.length - 1;
  let sharp = 0;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % n]!;
    const ax = cur[0] - prev[0];
    const ay = cur[1] - prev[1];
    const bx = next[0] - cur[0];
    const by = next[1] - cur[1];
    const al = Math.hypot(ax, ay);
    const bl = Math.hypot(bx, by);
    const dot = (ax * bx + ay * by) / (al * bl);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (turn > 0.35) sharp++;
  }
  assert.equal(sharp, 0, `${sharp} corners on the blob`);
});

test('a fresh spawn is a circle inside the blob', () => {
  const sim = new Sim({ targetPopulation: 0, pickupTarget: 0, spawnSize: 18 }, 3);
  const p = sim.addHuman('Ada', 0);
  assert.ok(p);
  const radius = spawnRadius(18);
  const want = Math.PI * radius * radius;
  const area = sim.land.areaOf(p.id);
  assert.ok(Math.abs(area - want) / want < 0.04, `area ${area} vs ${want}`);
  assert.equal(sim.land.contains(p.id, p.x, p.y), true);
  assert.equal(sim.land.contains(p.id, p.x + radius * 0.55, p.y), true);
  assert.equal(sim.land.contains(p.id, p.x + radius, p.y + radius), false, 'bounding-square corner is land');
  const room = sim.land.fenceAt(p.x, p.y);
  assert.ok(room.inside && room.dist > radius, `fence dist ${room.dist}`);
  const ring = sim.land.get(p.id)[0]?.[0];
  assert.ok(ring && ring.length >= 16, 'circle is faceted');
  const n = ring!.length - 1;
  let maxTurn = 0;
  for (let i = 0; i < n; i++) {
    const prev = ring![(i - 1 + n) % n]!;
    const cur = ring![i]!;
    const next = ring![(i + 1) % n]!;
    const ax = cur[0] - prev[0];
    const ay = cur[1] - prev[1];
    const bx = next[0] - cur[0];
    const by = next[1] - cur[1];
    const al = Math.hypot(ax, ay);
    const bl = Math.hypot(bx, by);
    if (al < 1e-4 || bl < 1e-4) continue;
    const dot = (ax * bx + ay * by) / (al * bl);
    maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, dot))));
  }
  assert.ok(maxTurn < 0.45, `spawn corner ${maxTurn.toFixed(2)} rad`);
});
