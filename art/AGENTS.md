# Art directory — agent instructions (sprite generation)

> You are an AI coding agent (Codex, etc.) running in a game's `art/` directory.
> This file is auto-discovered (the [agents.md](https://agents.md/) convention).
> It defines what **"make the sprites"** means for this game. Follow it exactly.
>
> (Canonical copy lives at `terrabyte-arcade/templates/art/AGENTS.md`; every game's
> `art/` keeps a copy. Edit the canonical, then re-sync — don't let it drift.)

## When asked to "make / generate / regenerate the sprites"

1. **Read the two briefs in THIS directory FIRST — they are the source of truth:**
   - **`SPRITE-SPEC.md`** — the **HOW**: art style/direction, per-asset look, exact
     pixel sizes, perspective, and the **filename convention**.
   - **`ITEM-LIST.md`** — the **WHAT**: the flat checklist of every PNG by filename
     with a status marker (🗂 = to-generate · 🔄 = regenerate · ✅ = done, skip it).
   Generate exactly what the spec describes — its sizes, its look, its filenames.

2. **Default generator = the `agent-sprite-forge` Codex skill**
   (`https://github.com/0x0funky/agent-sprite-forge`), invoked with **`$generate2dsprite`**.
   This is the stylized-2D-sprite pipeline we use for game art. Drive it from the
   spec; save the forge's raw contact sheets into **`sprite-forge-output/`**.

3. **Slice + verify** (if these helpers exist in this dir — they usually do):
   - `python export_assets.py` — slices the raw contact sheets and removes the
     chroma-key background, writing finished PNGs into **`sprites/`** by filename.
   - `python check_sprite_assets.py` — verifies every expected PNG exists at the
     correct size; fix gaps until it passes.
   If those scripts aren't present, write the finished PNGs straight to
   `sprites/<filename>.png`.

4. **Output goes to `sprites/` by filename.** The game's loader picks PNGs up by
   name with **no code change** (it falls back to placeholders until each lands), so
   you never edit `src/` to add art — just produce correctly-named files.

## EXCEPTION — hyper-real / photoreal assets do NOT use the stylized forge

Some assets are meant to be **photorealistic, not stylized game sprites** — e.g. a
**casino dealer** portrait. `SPRITE-SPEC.md` / `ITEM-LIST.md` flags these with a
**`🎞 hyper-real`** marker (or a `render: hyperreal` note on the row). For those:

- **Do NOT run `$generate2dsprite`** / the sprite forge on them.
- Generate them with a **photorealistic image model** instead, following the spec's
  framing / size / filename, and drop them into `sprites/` the same way.

Default assumption: **unmarked ⇒ forge sprite.** If an asset's intended mode is
genuinely unclear from the spec, ask before generating rather than guessing.
