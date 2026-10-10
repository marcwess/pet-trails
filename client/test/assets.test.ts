import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SPECIES } from '@pet-trails/shared';

const root = path.resolve(import.meta.dirname, '../dist/assets/pets');

test('every roster species is copied into the client build', () => {
  assert.equal(SPECIES.length, 24);
  for (const id of SPECIES) {
    const file = path.join(root, `animal-${id}.glb`);
    assert.ok(existsSync(file), file);
    assert.ok(statSync(file).size > 1000, `${id} glb is empty`);
  }
  for (const id of ['pig', 'lion']) {
    assert.ok(statSync(path.join(root, `animal-${id}.glb`)).size > 10_000, id);
  }
  const map = path.join(root, 'Textures/colormap.png');
  assert.ok(existsSync(map));
  assert.ok(statSync(map).size > 1000);
});
