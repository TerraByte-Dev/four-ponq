# Four Ponq Handoff

## Project

- Workspace: `C:\Users\dture\Desktop\Codex\four ponq`
- App: Phaser + TypeScript + Vite browser game
- Local dev URL: `http://127.0.0.1:5176/`
- Main files:
  - `src/main.ts`: game state, physics, collisions, rendering, audio preload/playback, HUD events, theme definitions
  - `src/styles.css`: HUD/menu styling and CSS theme skins
  - `index.html`: DOM shell, menu, controls, settings, theme selector
  - `Feedback.md`: feedback notes, if present
  - `public/audio/paddle/`: in-game paddle hit sounds
  - `public/audio/win/`: in-game victory fanfares
  - `audio-examples/`: scratch audition WAVs used while selecting sounds

## Commands

Use `npm.cmd` in PowerShell because `npm.ps1` may be blocked.

```powershell
cd "C:\Users\dture\Desktop\Codex\four ponq"
npm.cmd run dev -- --port 5176
npm.cmd run build
```

If `git` is not on PATH in a new shell, prepend:

```powershell
$env:Path="C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI;" + $env:Path
git status -sb
```

## Current Gameplay State

- Circular four-player Pong arena with active arcs redistributed after eliminations.
- P1 uses `A` / `D`; bots fill P2-P4 when enabled.
- Each player has 5 shields; at 0 shields they are eliminated.
- Match ends when only one player remains, returning to the menu overlay with `Start Again`.
- `Esc` opens the arcade HOME overlay, which pauses the game.
- Center obstacle is a slow-spinning triangle with phase-through handling if the ball gets inside it.
- Concave rail paddles use matching collision logic.
- Ball uses substep movement in `advanceBall(dt)` to reduce tunneling through paddles.
- Ball has an 850ms serve delay after reset/spawn.
- Base ball speed is 380; max normal speed is 840.
- Charged shot launches at 2x speed, capped at 980.
- Same-player repeat hit gives a small boost.
- Per-player charge meter builds by 1 on paddle hit, capped at 10.
- P1 can hold `Space` at full charge as the ball hits the paddle to catch it for up to 3 seconds, then release to fire.

## Visual Feedback

- Paddle hits now spawn a white four-line impact indicator.
- The indicator is anchored to the real curved-paddle contact point from `paddleHitTest`.
- It draws:
  - one inward radial stroke
  - two angled fan strokes
  - one shorter tangent trail
- Constants:
  - `PADDLE_HIT_INDICATOR_LIFETIME = 170`
  - `PADDLE_HIT_INDICATOR_LENGTH = 34`
  - `PADDLE_HIT_INDICATOR_GAP = 4`
  - `PADDLE_HIT_INDICATOR_FAN_ANGLE = 0.48`
- Implementation methods:
  - `spawnPaddleImpactBurst(...)`
  - `drawPaddleImpactBursts()`
  - `drawBurstStroke(...)`
  - `rotateVector(...)`

## Audio

Paddle hit sounds:

- Six hollow wooden clonk WAVs live in `public/audio/paddle/`.
- They are preloaded with keys:
  - `paddle-clonk-01` through `paddle-clonk-06`
- `playPaddleHitSound()` randomly selects one on paddle contact.
- Sound cooldown is `PADDLE_HIT_SOUND_COOLDOWN = 500`, so rapid hits do not spam audio.
- Volume is `PADDLE_HIT_SOUND_VOLUME = 0.56`.
- Visual hit indicators still fire every hit; only audio is throttled.

Win fanfares:

- Three longer final flourish WAVs live in `public/audio/win/`.
- They are preloaded with keys:
  - `win-fanfare-01` through `win-fanfare-03`
- `playWinFanfare()` randomly selects one when `remaining.length <= 1` in `handleGoals()`.
- Volume is `WIN_FANFARE_VOLUME = 0.62`.

Scratch audio:

- `audio-examples/` contains audition material and selected-source variants.
- Keep `public/audio/...` as the runtime asset source for the actual game.

## Theme System

Five themes are implemented and selectable under `Settings > Theme`:

- Neon Classic
- Solar Flare
- Deep Sea
- Arcade Candy
- Mono Grid

Theme implementation details:

- Theme type: `ThemeId = "neon" | "solar" | "deepSea" | "candy" | "mono"`
- Theme definitions live in `THEMES` in `src/main.ts`.
- Canvas rendering uses the active theme for arena background, rings, triangle, ball, paddles, arcs, and player colors.
- DOM uses `document.body.dataset.theme` and CSS variables in `src/styles.css`.
- Theme selector buttons use `data-theme-choice`.

## Git / GitHub Status

- Branch: `main`, tracking `origin/main`.
- Current worktree has uncommitted changes:
  - `index.html`
  - `src/main.ts`
  - `src/styles.css`
  - `HANDOFF.md`
  - `audio-examples/`
  - `public/`
- Earlier note: GitHub publishing had been blocked because `gh` auth was not visible inside Codex's shell.
- Suggested public repo target was `https://github.com/dture/four-ponq`.
- Before publishing, check:

```powershell
$env:Path="C:\Program Files\Git\cmd;C:\Program Files\GitHub CLI;" + $env:Path
gh auth status
git status -sb
```

## Latest Verification

Last successful check:

```powershell
npm.cmd run build
```

The build passed after adding:

- white paddle hit indicators
- six randomized paddle clonk sounds
- three randomized win fanfares

The dev server has been used at:

```text
http://127.0.0.1:5176/
```

## Notes For Next Session

- Continue working in `C:\Users\dture\Desktop\Codex\four ponq`.
- If applying big gameplay feedback, inspect `Feedback.md` first if it exists.
- Preserve `advanceBall(dt)` substepping unless deliberately replacing the collision strategy.
- If changing paddle collision or hit feedback, use the existing real contact point from `paddleHitTest`.
- If changing sounds, update both preload keys and files under `public/audio/...`.
- If adding more runtime assets, place them under `public/`; keep `audio-examples/` as scratch/source material.
- If tuning sound feel, likely first knobs:
  - `PADDLE_HIT_SOUND_VOLUME`
  - `PADDLE_HIT_SOUND_COOLDOWN`
  - `WIN_FANFARE_VOLUME`
- If tuning impact visuals, likely first knobs:
  - `PADDLE_HIT_INDICATOR_LIFETIME`
  - `PADDLE_HIT_INDICATOR_LENGTH`
  - `PADDLE_HIT_INDICATOR_FAN_ANGLE`

