# Doodle Duel multiplayer server

This directory is the authoritative Node.js WebSocket service for Doodle Duel. It owns rooms, seats, round transitions, hidden words, timers, drawing permissions, scoring, hints, chat filtering, power-ups, reconnects and the final podium. The browser client never receives the answer unless it is the drawer or the round has ended.

## Run locally

```bash
pnpm install --frozen-lockfile
HOST=127.0.0.1 PORT=8787 ALLOWED_ORIGINS=http://127.0.0.1:3000 pnpm start
```

The service exposes `GET /healthz` and accepts WebSocket connections at `/ws?room=ABCD`. Room codes are 4–8 alphanumeric characters. When `STATIC_ROOT` points at the client `dist/` folder, the same process can serve the built game, but the recommended Render setup keeps the server as a separate web service and serves the Vite client from any static host.

Set `ALLOWED_ORIGINS` to the exact browser origin(s) that may connect, separated by commas. For a quick private Render test you can leave it empty; for production, always set it explicitly.

## Render

The project root contains `render.yaml` configured for a Node service rooted at `server/`. Render should run `pnpm install --frozen-lockfile` and `pnpm start`; Render injects `PORT`. Add an `ALLOWED_ORIGINS` environment variable containing the client URL, for example `https://your-game.pages.dev`.

After deployment, copy the WebSocket service URL into the client hosting environment as `VITE_GAME_SERVER_URL`, using the `wss://` origin without a trailing slash. The browser then connects to `wss://your-service.onrender.com/ws?room=ABCD`. If you prefer to serve the client from the same Render service, set `STATIC_ROOT=../dist` and build the client before starting the service.

## Protocol summary

The client sends `join`, `add_bot`, `start`, `settings`, `choose_word`, `draw`, `canvas`, `chat`, `powerup`, `reaction`, `shake`, `kick`, `report` and `play_again`. The server sends `welcome`, per-player `round_private`, authoritative `state`, `canvas_snapshot`, `draw`, `canvas_action`, `chat`, `reaction`, `powerup`, `shake`, `round_result`, `private_notice`, `kicked`, `pong` and `error` packets. Bots are server-side players with no socket: they auto-select a word, broadcast brush strokes through the same authoritative draw path, and guess after a short delay when a human is drawing.

Rooms are in memory. A process restart drops active rooms and scores, and disconnected seats are reserved for up to 60 seconds. This is an intentionally bounded casual party-game server, not a persistent identity or anti-cheat service.

## Checks

```bash
pnpm test
```

The tests start an isolated service, join two players, start a round, choose a hidden word, relay a draw operation, award a correct guess and check `/healthz`.
