# Pet Trails — Design Brief (working title)

Browser game, mobile-first (portrait phone, touch), also playable on desktop. A paper.io 2–style territory game starring Kenney Cube Pets, with real-time multiplayer plus server-side bots, a pet-collection meta, and an RPG leveling layer.

## Pillars
1. Instant, readable, juicy territory battles (paper.io 2 feel): fast rounds, drag to steer, big color fills.
2. Your pet train: every rival you defeat follows behind you as a copy of their pet. Visible bragging rights.
3. Collect & farm pets: mystery boxes roll species, rarity, and a random ability kit. Players farm for their favorite pet + ability combo.
4. Pets level up from XP earned in runs, unlocking upgrades, recolors, and trail cosmetics.

## Core round
- Player spawns with a small square of their own colored land.
- Steering: touch-drag anywhere (relative virtual stick; direction = drag vector from touch-down point), smooth turn-rate-limited heading. Desktop: mouse direction or WASD/arrows. Pet always moves forward.
- Leaving your land draws a trail. Returning to your land closes the loop and claims every cell enclosed (flood fill), plus the trail cells.
- Death: (a) anyone's head touches your trail while you're outside your land, you die (the cutter gets the kill; if you hit your own trail you die with no kill credit); (b) head-on collisions: the player with more land wins (paper.io 2 rule); (c) another player's claim fully encloses you.
- On defeat: the victim's land becomes neutral, the killer gets a coin/XP bonus, and a copy of the victim's pet joins the killer's train (follows the head's path history, bobbing, max ~12 visible, then shows "+N"). Train is cosmetic/score (no collision) in v1.
- Map pickups: coins (soft currency), XP orbs, rare loot drops (chance for a key/box shard or bonus coins) spawning in neutral areas and occasionally dropped on kills.
- Round: rooms are persistent (drop-in/drop-out, like paper.io); a player's run ends on death. Results screen: % map, kills, train length, coins, XP gained, level-ups. Then "Play again" in one tap.
- Leaderboard (top 5 by % land) on the HUD; your rank always shown.

## Multiplayer (day one)
- Authoritative Node.js + TypeScript game server over WebSockets (Colyseus or plain `ws`, agent's call; justify). Server ticks at 20–30 Hz, owns the grid, movement, collisions, claims, pickups, kills, and bot AI.
- Rooms of up to ~16 entities; bots fill every room to ~10 entities and leave as humans join, so it always feels busy. Bots get pet names and random pets/rarities and play like humans (expand, grab territory, retreat when threatened, hunt exposed trails, occasionally make mistakes).
- Client: interpolation for others, light prediction for your own head so steering feels instant on mobile. Delta-compressed state (only changed cells / entity snapshots), binary or compact JSON.
- Grid: ~150x150 cells per room (tunable). Territory rendered from a small texture updated with partial uploads (no full re-uploads every frame).
- Hosting: client on GitHub Pages (static). Server on a WebSocket-capable host (Fly.io / Render / Railway; a Dockerfile plus configs for at least one). Server URL configurable; `?server=` override. Local dev: `npm run dev` runs both.
- Anti-cheat: the server is authoritative for gameplay. Progression in v1 is stored client-side (localStorage) for the playtest, but the data model must be ready to move server-side (accounts) in v2, since rarity affects PvP stats.

## Pets, rarity, abilities
- 24 species = the Kenney Cube Pets GLBs (`3D assets/Cube Pets/Models/GLB format/animal-*.glb`, one shared colormap texture). All are available in every rarity.
- Rarities and odds from a standard mystery box: Common 55%, Uncommon 25%, Rare 12%, Epic 6%, Legendary 2%. Rarity scales ability strength: x1.00 / 1.15 / 1.30 / 1.50 / 1.75 (bigger effects, longer durations, shorter cooldowns). Rarity shows as a colored frame, a glow, and a border on the pet card.
- Ability pool: 5 actives + 5 passives. When a pet is obtained it rolls 2 distinct actives and 2 distinct passives (stored per pet instance). Only one active and one passive can be equipped at a time (switchable in the pet screen between rounds). Duplicates of a species are allowed and roll fresh kits, which is the farming loop.
- Actives (one button, cooldown):
  1. Dash: burst of speed for a short time.
  2. Shield: for a few seconds, your trail can't be cut (a bubble shows it).
  3. Paint Bomb: instantly claim a circle of land around you.
  4. Frost Nova: slow nearby rivals.
  5. Recall: teleport back to your own land, safely dropping the open trail.
- Passives:
  1. Swift: +move speed.
  2. Magnet: bigger pickup radius.
  3. Lucky: +coins and +loot chance.
  4. Scholar: +XP gain.
  5. Head Start: respawn with more starting land.
- All numbers live in one tunable config table (base value, per-rarity multiplier, per-level gain).

## Pet leveling (RPG)
- XP from runs (land claimed, kills, orbs) goes to the equipped pet. Level cap 20 for v1, with a rising curve.
- Each level gives a small boost to the pet's abilities. Milestones: recolor variants at 5/10/15/20 (palette swaps of the shared colormap: e.g. shadow, golden, frost, neon), trail cosmetics at 3/8/12/18 (sparkle, hearts, rainbow, footprints), and a level badge.
- The pet collection screen shows species, rarity, level/XP bar, both rolled actives and passives (equipped highlighted), recolors and trails.

## Economy (v1, soft currency only)
- Coins from runs buy a Mystery Box (price tunable, ~1 box per 3–5 good runs). Box opening is a big juicy reveal (shake, burst, rarity color, the pet hops out).
- New players start with 1 random Common pet + 1 free box.
- Later: premium currency, ads, daily quests, events, season pass.

## Feel bar (non-negotiable — lessons from the previous project)
- Must feel as smooth and readable as paper.io 2 on an iPhone in Chrome (WebKit): steady 60fps, no mid-play resizes or shader compiles, pooled effects, DPR cap 2, no per-frame allocations in hot paths, and a `?perf=1` overlay.
- Bright, colorful, clean UI with a rounded font, big touch targets, and one consistent button style. Camera follows the player at a tilted top-down 3D angle showing the cube pets' faces.
- Verify by actually playing in a browser at 390x844 and comparing against paper.io 2 footage, not just screenshots or bot tests.

## Milestones
- M1 (first playable): server + bots + client round with territory, trails, kills, train, pickups, results screen; client on Pages, server deployable; one free pet.
- M2: pets/rarities/abilities/boxes/leveling/cosmetics (local save).
- M3: polish, audio, onboarding, portal-ready build (CrazyGames/Poki/itch), accounts + server-side progression.
