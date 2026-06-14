# <Game> — Sprite Spec  ·  TEMPLATE — replace placeholders with this game's art direction

> The forge-facing **source of truth** for every sprite this game loads. Sprites are
> generated externally by the **`agent-sprite-forge`** Codex skill
> (`https://github.com/0x0funky/agent-sprite-forge`, driven with `$generate2dsprite`)
> from this spec, then dropped into `art/sprites/` **by filename — no code change
> required**. See **`AGENTS.md`** in this folder for the generate workflow.
>
> This is a STARTER STUB. If the game renders with vector/primitive draws today,
> that's fine — list each element here with a "primitive fallback = the current
> draw" so dropping in a PNG upgrades just that element with **no visual regression**.
> A game can stay 100% vector and never fill this in; the file just makes the art
> pipeline ready the moment you want sprites.

## Style / direction
- **TODO:** overall art style (e.g. painterly fantasy-realism · crisp pixel-art ·
  neon vector), palette, lighting, perspective (top-down / side-on / 3-4 portrait),
  image-smoothing on or off.

## Filename convention
- **TODO:** how files are named, e.g. `sprites/<kind>-<key>.png`. The loader picks
  PNGs up by filename — keep names stable once chosen.

## Native sizes
- **TODO:** the native pixel size for each asset kind (the forge renders to these).

## Render mode — forge vs hyper-real
- **Default = the stylized `$generate2dsprite` forge** (all entries below, unless flagged).
- Mark any asset that must be **photorealistic** (NOT a stylized game sprite) with
  **`🎞 hyper-real`** on its row in `ITEM-LIST.md` — those **skip the forge** and are
  generated with a photoreal image model instead (e.g. a **casino dealer** portrait).

## Per-asset notes
- **TODO:** who/what each asset is — silhouette, palette, characterful details. The
  flat by-filename checklist (what to actually generate) lives in `ITEM-LIST.md`.
