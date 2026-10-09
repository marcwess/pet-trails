import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import { CONFIG, SPECIES, SPECIES_LABEL } from '@pet-trails/shared';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { NetClient } from './net.js';
import { loadPetGeometries } from './pets.js';
import { Perf } from './perf.js';
import { loadProfile } from './profileStore.js';
import { Renderer } from './render.js';
import { Territory } from './territory.js';
import './style.css';

async function serverUrl(): Promise<string> {
  const query = new URLSearchParams(location.search).get('server');
  if (query) return query;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`);
    if (res.ok) {
      const json = (await res.json()) as { serverUrl?: string };
      if (json.serverUrl) return json.serverUrl;
    }
  } catch {
    /* offline fallback */
  }
  return 'ws://localhost:8787';
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const perf = new Perf(params.get('perf') === '1');
  const hud = new Hud();
  const profile = loadProfile();
  const species = SPECIES[profile.pet.species] ?? 'cat';
  hud.setPetLine(`Loading pets…`);
  hud.setPlayEnabled(false);
  const territory = new Territory(CONFIG.gridW, CONFIG.gridH);
  const loaded = await loadPetGeometries(import.meta.env.BASE_URL, (done, total) => {
    hud.setPetLine(`Loading pets ${done}/${total}`);
  });
  const renderer = new Renderer(territory, loaded.geos, loaded.material, perf);
  renderer.warmup();
  hud.setPetLine(`Your pet · ${SPECIES_LABEL[species]} · Lv ${profile.pet.level}`);
  hud.setPlayEnabled(true);
  const input = new Input(() => (renderer.selfScreen ? { x: renderer.selfSX, y: renderer.selfSY } : null));
  const net = new NetClient(await serverUrl());
  const game = new Game(renderer, territory, hud, input, net, perf, profile);
  game.start();
}

main().catch((err) => {
  console.error(err);
  const line = document.getElementById('petline');
  if (line) line.textContent = 'Could not start the game';
});
