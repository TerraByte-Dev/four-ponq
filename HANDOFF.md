# Four Ponq — Handoff

_Last updated: 2026-06-13. The pre-2026 single-player Codex sections were removed;
four-ponq is now a graduated, networked arcade game._

## TL;DR for next session

**ALWAYS pull the live Wii-hub feedback FIRST — it is the canonical to-do list,
NOT this repo's `Feedback.md` (which is a stale, separate channel).**
`node <workshop>/scripts/feedback.mjs four-ponq` (or
`ssh terrabyte@192.168.1.207 'docker exec arcade-api cat /data/feedback.ndjson'`
and filter `gameId=four-ponq`).

**Session 2026-06-13 shipped all 3 live hub-feedback items in two deploys — both
LIVE + committed/pushed to `mine` (`53352f6` paddle/UI, `30384c7` host-settings):**
1. **Paddle physics "not physicing"** → real collision bugs fixed (see Round 1).
2. **"Can't tell when my super is charged" + can't find own lives** → charge-ready
   indicator + self-marked HUD card (Round 1).
3. **"No way to change game settings without losing"** → host-controlled settings
   on the ready screen (Round 2).

**"Boots to the offline menu" (the old top priority) appears resolved:** a clean
client on the fresh build connects straight into the lobby (verified headless),
and the two redeploys changed the bundle hash, busting any stale cached
`index.html`. If a user still reports it, it's browser cache — hard-refresh.

## Where it lives / stack

- **Dir:** `C:\Users\tatew\Desktop\MiniPCArcade\home-arcade\games\four-ponq`
  (inside the live `home-arcade` repo, but four-ponq is its **own git repo**).
- **Live:** https://four-ponq.terrabyte.vip (behind Google/Cloudflare Access login).
- **Stack:** Phaser + TypeScript + Vite client; a Node `ws` server. Pure sim in
  `src/sim/*` (no Phaser); server in `server/` + `shared/protocol.ts`; client glue
  in `src/net/client.ts`; everything render/HUD/audio in `src/main.ts`.
- **Git:** branch `feat/arcade-home-and-scale`, **pushed to remote `mine`**
  (`TerraByte-Dev/four-ponq`). **NEVER push to `origin`** (`Deaxohn/four-ponq` —
  the friend's upstream). Working tree is clean.

## Commands (Windows / PowerShell — use `npm.cmd`)

```powershell
cd C:\Users\tatew\Desktop\MiniPCArcade\home-arcade\games\four-ponq
npx tsc --noEmit ; npx tsc --noEmit -p tsconfig.server.json   # typecheck both
npm.cmd run build                                             # vite client + tsc server
```

Run locally (serves `dist/` + `/ws` on one port):

```bash
PORT=4399 node dist-server/server/index.js   # -> http://localhost:4399
```

`/__arcade/home.js` 404s locally (only the hub serves it) — expected; the game
boots fine without it. Playwright is in devDeps for headless browser checks.

## Deploy (mini PC) — code-only redeploy

Mini PC: `ssh terrabyte@192.168.1.207`, runs from `~/arcade/` (NOT a git repo).
`rsync` is absent on this Windows box, so use the filtered tar-pipe:

```bash
cd C:/Users/tatew/Desktop/MiniPCArcade/home-arcade
tar czf - --exclude='.git' --exclude='node_modules' --exclude='dist' \
  --exclude='dist-server' --exclude='audio-examples' -C games/four-ponq . \
  | ssh terrabyte@192.168.1.207 "tar xzf - -C ~/arcade/games/four-ponq"
ssh terrabyte@192.168.1.207 "cd ~/arcade && docker compose up -d --build four-ponq"  # slow; background it
```

Verify: `docker ps --filter name=four-ponq`; on the box
`curl -H 'Host: four-ponq.terrabyte.vip' http://localhost:80/` → 200; public edge
→ 302 (Access redirect). Reload Caddy ONLY if the Caddyfile changed:
`docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## RESOLVED 2026-06-13 — "boots to offline menu" (diagnosis kept for reference)

**Resolution:** a clean client on the post-Round-1/2 build connects straight into
the lobby (verified headless), and the two redeploys changed the bundle hash —
busting any stale cached `index.html`. Treat any recurrence as browser cache
(hard-refresh / clear site data). The original diagnosis is retained below.

**Symptom (user-reported 2026-06-12):** page shows the legacy menu card
(Play/Settings tabs, Start, "Bot Fill: On") instead of the four-ponq ring with
ready-up options. That menu is the **offline fallback** — it only shows when the
client never enters networked mode (WebSocket didn't connect). Expected flow: on
load → connect → menu hidden (`netSession`) → ring + ready panel; **M** opens the
settings/pause card.

**Diagnosis already done — the origin is HEALTHY:**
- Deployed client bundle IS current (live JS contains `KeyM`, `/api/profile`, `/ws`).
- Server up; `/ws` returns **101** through Caddy; `GET /presence` → `mode: lobby`.
- Ran the **exact deployed build** in headless Chromium locally → it connected,
  hid the menu, and showed the ready panel (`"Connected as P1 … in lobby"`). So
  the code path works.
- Deployed overlay `home.js` does NOT wrap `WebSocket`/`fetch`/serviceWorker.

**Conclusion:** browser/edge-side, not the deploy. Most likely a **stale cached
`index.html`** (points at an old bundle hash → JS never loads → static menu) or
the **WS failing through Cloudflare/Access** for that session.

**Next steps:**
1. User hard-refresh (Ctrl+Shift+R) / clear site data for four-ponq.terrabyte.vip
   — most likely fix.
2. Distinguishing test: click **Start**. Ring/ball appears → bundle loaded but WS
   not connecting (edge issue). Nothing happens → stale bundle (refresh fixes).
3. If it persists: DevTools → **Console** (red errors?) and **Network** on reload:
   does `assets/index-*.js` return 200 or 404? Does the `ws` request show `101` or
   fail/redirect?
4. If WS fails at the edge: check the Cloudflare Tunnel/Access config allows the
   `/ws` upgrade for four-ponq (history note: the "Access-WS gate" was confirmed
   working previously, so a regression there would be new).
5. Gating logic (verified correct, untouched this session) lives in
   `emitSession()` / `emitHud()` in `src/main.ts`:
   `menuOverlay.hidden = mode === "playing" || netSession`, where
   `netSession = networked && mode !== "paused"`.

## Done & deployed 2026-06-13 (this session) — Rounds 1 & 2

Both LIVE, committed, pushed to `mine`. `src/sim/*` is shared by the server, so
physics changes are server-authoritative (ship to everyone — hence the test).

**Round 1 — paddle physics + charge/lives HUD (`53352f6`):**
- Collisions reflect ONLY off the inner cup (concave face + wings); the convex
  back arc on the goal ring no longer bounces balls in empty space, and hits use
  the true inward face normal (was the ball→contact separation, which degenerated
  on edges and let face shots tunnel). Dropped the over-broad "reflect anything
  moving outward" clause. (`src/sim/physics.ts` paddleHitTest/SweptHitTest +
  handlePaddleCollisions.) Deliberately did NOT add a full-arc keeper — a ball
  beating an out-of-position paddle to an undefended part of its arc SHOULD score.
- `MAX_CHARGE` 10 → 4 (`constants.ts`) so the grab/super is reachable.
- HUD (`main.ts` + `styles.css`): `localSlot` marks "your" card (YOU tag) + bigger
  lives pips; charge meter has a pulsing "SUPER" ready state; your own paddle
  glows in-arena when ready. `CHARGE_READY_AT = MAX_CHARGE-1` (addCharge bumps
  before the catch check).
- **Regression test: `node scripts/verify-paddle.cjs`** — runs the built
  `dist-server` sim headless. RUN IT before any future physics deploy.

**Round 2 — host-controlled settings during ready-up (`30384c7`):**
- New `{t:"setSetting"}` client msg + `hostSlot`/`difficulty`/`gameVariant`/
  `triangleMotion` echoed in `{t:"room"}` (`shared/protocol.ts`). Host = lowest-
  slot connected human (derived in `room.ts`, auto-reassigns). Only the host, only
  on lobby/matchOver, may change rules — server enforces via `canChangeSettings`
  (`room.setSetting`/`setBots`). `setBots` is now host-gated too (was open).
- Client setters route through the server when networked (mirror `toggleBotFill`);
  `setTheme` stays per-client cosmetic. Rules controls live on the session ready
  panel (interactive for host, read-only chips for others). Rule changes apply
  silently (no ready reset); applied at next `beginMatch` (reads live sim).
- Was a real bug: difficulty/variant/triangle did NOTHING online before (never sent).

## Done earlier (prior session) — all on `feat/arcade-home-and-scale`, pushed `mine`

- **Center triangle no longer tunnels** — `handleTriangleCollision` (`src/sim/physics.ts`)
  now ejects the ball out the nearest edge when its center penetrates, instead of
  disabling collision and phasing through. The serve phase-out window still works.
- **Reactive triangle more dramatic** — `TRIANGLE_REACTIVE_MAX_SPEED 3.05→4.6`,
  damping `0.997→0.998`, and a stronger kick in `applyTriangleReactiveImpulse`.
- **Paddle collision tightened** — finer CCD substeps; reflect ANY ball heading
  outward past the paddle (kills glancing/edge leaks); always settle the ball on
  the center-facing side so a wing contact can't be nudged into the goal.
- **Per-client view rotation** — `applyViewTransform()` / `targetViewRotation()`
  spin the camera so the LOCAL player's side sits at screen-**top**, so left/right
  feel identical for P2–P4. Offline/spectator keep the default view; re-orients
  smoothly on elimination. (User was offered a "bottom / classic-Pong" alternative
  — would need a 180° flip + input invert; not done.)
- **Per-player names** — random persistent local name (`localStorage`
  `four-ponq:player-name`, e.g. `Volt42`) sent as the hello; editable in
  **Settings → Display name**; live rename via `{t:"setName"}` (added to
  `shared/protocol.ts`, `server/room.ts`, `server/index.ts`, `src/net/client.ts`).
  Fixed the old "everyone is P1" bug.
- **Hub profile integration** — `adoptArcadeProfileName()` fetches `/api/profile`
  on load and adopts the player's hub display name; falls back to the local name
  offline/unset. (Backend side below.)
- **Volume** — defaults Music 2% / SFX 5%; master `VOLUME_CEILING = 0.2` so the
  sliders' 100% equals the old 20% (`musicGain()` / `sfxGain()` in `src/main.ts`).
- **Controls** — **M** opens the game menu/pause card; **Esc** opens the arcade
  HOME (Wii) overlay (removed `data-esc="off"` from the overlay `<script>`).

## Backend/infra (home-arcade repo, branch `feat/hub-personalization`, pushed `origin`)

- **arcade-api profile store** (commit `5df0b0d`): `services/arcade-api/src/profile.ts`
  (`profiles.json` on the data volume) + `GET/POST /api/profile`, keyed by the
  verified Cloudflare Access email. Hub pushes the name on save+boot
  (`hub/src/profile.ts`). Games read it same-origin.
- **Caddyfile** (`config/Caddyfile`): the `(arcade_home)` snippet now also routes
  `/api/*` → `arcade-api:3000`, so every game subdomain can reach the profile API.
  **Deployed to the box and reloaded**, but the working-tree `Caddyfile` is
  **uncommitted** (see below).

## ⚠️ Parallel work in flight — DO NOT commit (not ours)

The `home-arcade` working tree has a large uncommitted set from a parallel hub
session — leave it for that session to land coherently:
terrabyte-sports + platform-byte-racing graduation (game folders, `docker-compose.yml`,
`hub/public/manifest.json`, their Caddyfile routes), hub **doodle-avatar** + the
**character-save API** (`services/arcade-api/src/character.ts`, `/api/character`),
the necrobyte-rivals overhaul, gauntlet sprites, blueprints. **Our** Caddyfile
`/api/*` snippet is tangled into that same uncommitted `config/Caddyfile` (it's
deployed; it'll get committed when the parallel bundle lands, or isolate just that
hunk if needed).

## Low-priority music notes (`Feedback.md` — NOT hub feedback)

> ⚠️ `Feedback.md` is a STALE local note, **not** the Wii-hub feedback store. As
> of 2026-06-13 the live hub store did not contain these music items — they are
> low priority. Confirm against the live store before spending time here.

1. Switch music on player **elimination** (4 players → round-one track, 3 →
   round-two, 2 → final), not on every score.
2. Music **cuts out when a goal is scored** — avoid the dropout.
3. The loop **doesn't loop seamlessly** (fades for a beat before restarting).

Relevant code: `currentMusicTrack()` / `updateMusic()` in `src/main.ts`. Track
selection already gates on active player count. Note `MUSIC_TRACKS` has 4 tracks
but only 3 active player-count states (4p/3p/2p → tracks 0/1/2); track 3
(`music-round-final`) is loaded but unused — wire it to the 2-player final if you
tackle #1.

## Useful tuning knobs (`src/sim/constants.ts` unless noted)

- **Audio** (`src/main.ts`): `VOLUME_CEILING`, default `musicVolume`/`sfxVolume`,
  `PADDLE_HIT_SOUND_VOLUME`, `PADDLE_HIT_SOUND_COOLDOWN`, `WIN_FANFARE_VOLUME`.
- **Reactive triangle**: `TRIANGLE_REACTIVE_MAX_SPEED`, `TRIANGLE_REACTIVE_DAMPING`,
  and the impulse math in `applyTriangleReactiveImpulse`.
- **View orientation**: `targetViewRotation()` in `src/main.ts` (to switch to
  "your side on bottom / classic-Pong", target screen-bottom and invert the
  ccw/cw input mapping).
- **Ball/paddle feel**: `BASE_BALL_SPEED 380`, `MAX_BALL_SPEED 840`, charged cap
  `980`, `REPEAT_HIT_BOOST`, `SPAWN_DELAY 850`, substep size in `advanceBall`.
