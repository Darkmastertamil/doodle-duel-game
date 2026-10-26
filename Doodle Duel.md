# Doodle Duel

Doodle Duel is a bright, real-time multiplayer draw-and-guess party game for desktop and mobile browsers. Players join without accounts, pick a nickname and avatar, race to guess secret words, earn streak bonuses and power-ups, and finish on a ranked podium.

## Included

- Public room codes and invite links.
- Host-controlled bot players: add bots from the lobby; they count as room seats, choose words automatically, draw synchronized strokes, and make delayed guesses when humans draw.
- Host controls for rounds, draw time, theme and Chaos Mode.
- 2–12 player room capacity, reconnect-friendly seats, host kick and report actions.
- Brush, eraser, color palette, brush size, undo and clear with synchronized strokes.
- Server-authoritative words, hints, timers, scoring and round transitions.
- Reveal letter, Double points, Time freeze and Shield power-ups, plus drawer Shake Canvas.
- Close-guess feedback, profanity filtering, emoji reactions, streak bonuses and sound mute.
- 600+ English words across animals, movies, food, gaming and general packs.
- Responsive three-column desktop layout that stacks for mobile.
- Render-ready Node.js WebSocket server in `server/`.

## Local development

Install the browser dependencies and server dependency once:

```bash
pnpm install
pnpm --dir server install --frozen-lockfile
```

Run the WebSocket service in one terminal:

```bash
HOST=127.0.0.1 PORT=8787 ALLOWED_ORIGINS=http://127.0.0.1:3000 pnpm dev:server
```

Run the Vite client in another:

```bash
VITE_GAME_SERVER_URL=ws://127.0.0.1:8787 pnpm dev -- --host 0.0.0.0 --port 3000
```

Open `http://127.0.0.1:3000`, create a room, then open the invite in a second browser tab. The client falls back to same-origin `/ws` when `VITE_GAME_SERVER_URL` is omitted.

## Deploying the server to Render

1. Create a Render Web Service from this repository using the included `render.yaml`, or set the service root directory to `server`.
2. Use Node 22+, build command `pnpm install --frozen-lockfile`, and start command `pnpm start`.
3. Set `ALLOWED_ORIGINS` to the exact URL where you will host the built client.
4. Deploy the client to a static host with `VITE_GAME_SERVER_URL` set to the Render service URL, for example `wss://doodle-duel-server.onrender.com`.
5. The service health check is `https://doodle-duel-server.onrender.com/healthz`.

Render's free service may sleep when idle, so the first room connection after a quiet period can take a few seconds. Rooms and scores are intentionally in memory and reset on service restart.

## Checks

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:server
```

`pnpm build` produces the static client in `dist/`. `server/` is deployed separately and owns the live WebSocket endpoint.
