# Pet Trails

Paper.io-style territory game in the browser. You steer a Kenney Cube Pet, draw a trail, and close a loop to claim the land inside. Other pets are bots on a local server, or the same simulation running in the page when no server is reachable.

Milestone 1 is the first playable: one random pet, shared deterministic rules, an authoritative WebSocket server, and an offline fallback so the static build still runs.

## Play locally

Requires Node 22+.

```bash
npm install
npm run dev
```

That builds `shared/`, then starts the server on [http://localhost:8787](http://localhost:8787) and the client on [http://localhost:5173](http://localhost:5173).

- Drag anywhere to steer. On a desktop you can also use the mouse or WASD.
- Leave your patch to draw a trail. Re-enter your own land to claim the enclosed loop.
- Cutting a trail or winning a head-on (strictly more land) adds that pet to your train.
- `?perf=1` shows fps, frame time, draw calls, entities, and ping.
- `?server=ws://host:port` overrides the server URL.

`npm test` runs the shared simulation tests and a 60-second headless server soak. `npm run typecheck` checks the server and client.

## Online and offline

The client reads `public/config.json` (`serverUrl`, default `ws://localhost:8787`). If that socket does not open within about 3 seconds, the page runs the same shared simulation locally with bots and shows an **Offline** chip. A live socket shows **Online**.

GitHub Pages uses that same fallback, so the static build is playable with no server. To point a deployed client at your host, either set `serverUrl` to a `wss://` URL before the Pages build, or open the site with `?server=wss://your-host`.

## GitHub Pages

`.github/workflows/pages.yml` builds the client with base path `/pet-trails/` and deploys `client/dist` to GitHub Pages on every push to `main`. Enable Pages with “GitHub Actions” as the source (repo Settings → Pages).

## Server hosting

The server is a Node process (`server/src/main.ts`) listening on `PORT` (default `8787`) and `0.0.0.0`. Health checks are `GET /health` and `GET /healthz`.

Docker:

```bash
docker build -t pet-trails .
docker run --rm -p 8787:8787 pet-trails
```

Fly.io: edit the `app` name in `fly.toml`, then `fly deploy`. The HTTP service is WebSocket-capable and checks `/health`.

Render: the repo includes `render.yaml` (Docker web service, health check `/health`).

## Layout

- `shared/` — grid, movement, trails, flood-fill claims, kills, pickups, bots, profile math, and every tunable in `shared/src/config.ts`
- `server/` — authoritative room (up to 16 entities, bots filling toward 10) at 20 Hz with compact cell deltas
- `client/` — Vite + three.js. Territory is a `DataTexture` updated with `texSubImage2D` on dirty rows
- `public/assets/pets/` — 24 Kenney Cube Pets GLBs and their shared texture (CC0)

## Credits

Cube Pets by [Kenney](https://kenney.nl), CC0. See `public/assets/pets/License.txt`.
