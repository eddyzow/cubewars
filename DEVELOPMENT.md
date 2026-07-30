# Cube Wars — local development

The backend serves the frontend. One command runs everything; there is no
separate static server or Live Server extension needed.

## First-time setup

```bash
npm install
cp .env.example .env   # then fill in MONGODB_URI and JWT_SECRET
```

`server.js` and `.env` are gitignored on purpose — the public repo stays
frontend-only. Keep a backup of both somewhere private.

## Running

```bash
npm run dev
```

Then open <http://localhost:3001>. nodemon restarts the server when
`server.js` changes. Frontend changes in `docs/` just need a browser refresh.

## How the two halves connect

- `server.js` serves `docs/` as static files (`express.static`) and falls back
  to `docs/index.html` for any unmatched route.
- `docs/main.js` picks its backend automatically from `location.hostname`:
  on `localhost`/`127.0.0.1` it connects to the page's own origin via `io()`;
  anywhere else it uses the Heroku URL. **No need to hand-edit a `build` flag.**
- Because dev is same-origin, CORS is not involved locally.

## Layout

| Path | What |
| --- | --- |
| `server.js` | Backend: Socket.IO, auth, Mongo, matchmaking + authoritative 32Hz match loop. Gitignored. |
| `docs/` | Frontend. Deployed separately to GitHub Pages. |
| `.env` | Secrets + `PORT`. Gitignored. |

(Game code files are listed under **The game → Files** below.)

## The game

**Real-time 1v1 arena fighter** (the stacker concept was retired). Two cubes
duel in a 1500x880 arena: WASD move, mouse aim, click to shoot, SPACE melee,
E dash — and dashing **into** the opponent is a heavy slam. HP depletion = KO.

- **Terrain per match, from the seed**: crates block movement and eat bullets;
  contour-ringed hills grant high ground (shots fly faster, hit harder, and
  clear crates).
- **Powerups**: heal, damage, speed, rapid-fire, shield (30-dmg absorb pool).
- **Presentation**: MATCH FOUND card screen, 3-2-1-GO countdown, victory/defeat
  stingers (Champion sound pack), 27-track battle-music rotation.
- **Netcode**: server-authoritative at 32Hz with client prediction +
  reconciliation; opponent smoothed by render interpolation; projectiles
  extrapolated between ticks for 60fps+ smoothness. Matchmaking through the
  Tesseract queue; Elo-style ratings damped by rankedConfidence.

### Files

| Path | What |
| --- | --- |
| `docs/arenaEngine.js` | Rules. Pure logic, deterministic, runs in Node — the server requires() it as the authority. |
| `docs/arenaRenderer.js` | Pixi presentation: continuous animation, terrain, HUD, SFX/music managers. |
| `docs/arenaController.js` | Input, fixed-timestep loop (setInterval, not rAF — background tabs), bot. |
| `docs/arenaNet.js` | Client prediction + reconciliation against server snapshots. |
| `test-arena.js` | 69 engine assertions. `npm test`. |

### Notes

- nodemon watches `server.js` **and** `docs/arenaEngine.js` (shared module —
  a stale engine on the server desyncs prediction).
- The sim loop is deliberately `setInterval`: rAF freezes in background tabs,
  which would forfeit online matches.
- Settings (volume/shake) persist in localStorage under `cw_settings`.

## Deploying

- **Frontend** → push to GitHub; Pages serves `docs/`.
- **Backend** → Heroku app `cubewars`. `npm start` runs without `--env-file`
  because Heroku injects config vars. Set them once:

  ```bash
  heroku config:set -a cubewars MONGODB_URI='...' JWT_SECRET='...' NODE_ENV=production
  ```

  Heroku's git has the backend on the **`master`** branch, but the app deploys
  `main` — which is why the live dyno has no server. Push explicitly:

  ```bash
  git push heroku HEAD:main
  ```

## Known issues

1. **`mongodb` is pinned to v3.** `server.js` calls `ObjectId(a)` without
   `new`, which throws on v4+. Upgrading requires changing that call.
2. **No dynos running** on the Heroku app (`heroku ps -a cubewars`). Remember to
   set the rotated `MONGODB_URI` / `JWT_SECRET` as Heroku config vars before
   deploying, or production will fail to connect.
3. **Passwords are unsalted SHA-256** ([server.js](server.js) `hashPassword`).
   Fine for INDEV, but move to bcrypt or argon2 before any real launch — an
   unsalted hash means identical passwords produce identical hashes, and SHA-256
   is fast enough to brute-force.

## Resolved

- **MongoDB auth** — the cluster was paused, then reprovisioned; the old
  password stopped working. Both `MONGODB_URI` and `JWT_SECRET` were rotated on
  2026-07-30 and the full auth chain (register → login → token verify →
  rank data) is verified working. The 9 pre-existing user accounts survived.
