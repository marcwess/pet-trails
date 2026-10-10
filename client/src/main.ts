import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import { CONFIG, SPECIES, SPECIES_LABEL, equippedPet } from '@pet-trails/shared';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { NetClient } from './net.js';
import { loadCoinGeometry, loadPetGeometries } from './pets.js';
import { Perf } from './perf.js';
import { loadProfile } from './profileStore.js';
import { Renderer } from './render.js';
import { Territory } from './territory.js';
import './style.css';

async function serverUrl(): Promise<string> {
  const params = new URLSearchParams(location.search);
  if (params.has('server')) return params.get('server') ?? '';
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`);
    if (res.ok) {
      const json = (await res.json()) as { serverUrl?: string };
      if (typeof json.serverUrl === 'string') return json.serverUrl;
    }
  } catch {
    /* no config: stay offline on https, localhost only for local http */
  }
  if (location.protocol === 'https:') return '';
  return 'ws://localhost:8787';
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const perf = new Perf(params.get('perf') === '1');
  const hud = new Hud();
  const profile = loadProfile();
  const species = SPECIES[equippedPet(profile).species] ?? 'cat';
  hud.setPetLine(`Loading pets…`);
  hud.setPlayEnabled(false);
  const territory = new Territory(CONFIG.gridW, CONFIG.gridH);
  const [loaded, coin] = await Promise.all([
    loadPetGeometries(import.meta.env.BASE_URL, (done, total) => {
      hud.setPetLine(`Loading pets ${done}/${total}`);
    }),
    loadCoinGeometry(import.meta.env.BASE_URL),
  ]);
  const renderer = new Renderer(territory, loaded.geos, loaded.material, perf, coin);
  renderer.warmup();
  renderer.buildSheet();
  if (params.get('sheet') === '1' && renderer.sheet) {
    renderer.sheet.id = 'contact-sheet';
    renderer.sheet.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:8px;width:calc(100% - 16px);height:auto;z-index:30;border-radius:18px;pointer-events:none;background:#fff';
    document.body.appendChild(renderer.sheet);
  }
  if (params.get('hz120') === '1') {
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      window.setTimeout(() => cb(performance.now()), 1000 / 120) as unknown as number;
    window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
  }
  hud.setPetLine(`Your pet · ${SPECIES_LABEL[species]} · Lv ${equippedPet(profile).level}`);
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
