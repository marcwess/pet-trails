import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/index.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the server clamps pet level and sends it to other clients', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 7 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const messages: string[] = [];
    ws.on('message', (data) => {
      if (typeof data === 'string' || data instanceof Buffer) messages.push(data.toString());
    });
    ws.send(JSON.stringify({ t: 'hello', name: 'Ace', pet: 1, level: 99 }));
    ws.send(JSON.stringify({ t: 'play' }));
    await delay(40);
    srv.room.step();
    const ace = srv.room.sim.roster.find((p) => p.name === 'Ace');
    assert.ok(ace);
    assert.equal(ace!.level, 20);
    await delay(30);
    const delta = messages.map((m) => JSON.parse(m) as { t?: string; ents?: Array<{ lv?: number; i?: number }> }).find((m) => m.t === 'delta');
    assert.ok(delta?.ents);
    const snap = delta!.ents!.find((e) => e.i === ace!.id);
    assert.equal(snap?.lv, 20);
    ws.close();
  } finally {
    await srv.close();
  }
});
