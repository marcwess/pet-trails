import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/index.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the server rejects a bad kit and keeps a legal one', async () => {
  const srv = await startServer({ port: 0, tick: false, seed: 42 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        t: 'hello',
        name: 'Cheater',
        pet: 2,
        rarity: 'legendary',
        actives: ['dash', 'dash'],
        passives: ['swift', 'lucky'],
        eqA: 0,
        eqP: 0,
      }),
    );
    ws.send(JSON.stringify({ t: 'play' }));
    await delay(40);
    srv.room.step();
    const cheater = srv.room.sim.roster.find((p) => p.name === 'Cheater');
    assert.ok(cheater);
    assert.equal(cheater!.rarity, 'common');
    assert.equal(cheater!.activeId, 'dash');
    assert.equal(cheater!.passiveId, 'swift');

    const ok = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    await new Promise<void>((resolve, reject) => {
      ok.on('open', () => resolve());
      ok.on('error', reject);
    });
    ok.send(
      JSON.stringify({
        t: 'hello',
        name: 'Fair',
        pet: 4,
        rarity: 'rare',
        actives: ['paint', 'frost'],
        passives: ['scholar', 'lucky'],
        eqA: 1,
        eqP: 0,
      }),
    );
    ok.send(JSON.stringify({ t: 'play' }));
    await delay(40);
    srv.room.step();
    const fair = srv.room.sim.roster.find((p) => p.name === 'Fair');
    assert.ok(fair);
    assert.equal(fair!.rarity, 'rare');
    assert.equal(fair!.activeId, 'frost');
    assert.equal(fair!.passiveId, 'scholar');

    const until = fair!.cdUntil;
    ok.send(JSON.stringify({ t: 'ability' }));
    await delay(30);
    assert.ok(fair!.cdUntil > srv.room.sim.tick || fair!.shieldUntil > 0 || fair!.land > 0);
    const cd = fair!.cdUntil;
    ok.send(JSON.stringify({ t: 'ability' }));
    await delay(30);
    assert.equal(fair!.cdUntil, cd, 'cooldown must not refresh');
    assert.ok(cd > until || cd > 0);

    ws.close();
    ok.close();
  } finally {
    await srv.close();
  }
});
