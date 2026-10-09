import assert from 'node:assert/strict';
import test from 'node:test';
import { offlineSocketReason } from '../src/net.ts';

test('https pages do not open ws:// and an empty url stays offline', () => {
  assert.equal(offlineSocketReason('https:', ''), 'empty');
  assert.equal(offlineSocketReason('https:', '   '), 'empty');
  assert.equal(offlineSocketReason('https:', 'ws://localhost:8787'), 'mixed');
  assert.equal(offlineSocketReason('https:', 'WS://game.example/room'), 'mixed');
  assert.equal(offlineSocketReason('http:', 'ws://localhost:8787'), null);
  assert.equal(offlineSocketReason('https:', 'wss://pet-trails.fly.dev'), null);
  assert.equal(offlineSocketReason('http:', ''), 'empty');
});
