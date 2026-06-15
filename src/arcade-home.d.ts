/**
 * Terrabyte Arcade — HOME overlay type surface (CANONICAL — single source of truth).
 *
 * This types the `window.__arcadeHome` API exposed by the UNIVERSAL Wii HOME
 * overlay. The overlay is ONE file — `hub/public/__arcade/home.js` — served by the
 * hub and proxied onto every game subdomain (Caddy `import arcade_home`). It is the
 * SAME on every game and is edited in ONE place (this workspace); it is never forked
 * per-game. Games do not host it — they load it with:
 *
 *     <script src="/__arcade/home.js" defer></script>
 *
 * and it 404s in local dev, so EVERY `window.__arcadeHome?.…` call must be guarded.
 *
 * Each game keeps a COPY of this file at `src/arcade-home.d.ts` (an ambient .d.ts —
 * no import). When the overlay API changes, edit THIS canonical file, then re-sync
 * the copies into every game so the type surface never drifts game-to-game.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESERVED / STANDARD KEYBINDS — identical on every arcade game:
 *   Esc      ALWAYS toggles the universal HOME overlay. The overlay owns Esc
 *            (capture-phase) on every game; games MUST NOT bind Esc.
 *   M        the GAME's own in-game menu (pause card / inventory / settings / help).
 *   (overlay) Arrow keys / Tab navigate its buttons; Enter/Space activate; Esc closes.
 *   Everything else is game-specific gameplay — just never collide with Esc or M.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface ArcadeHomeMenuItemContext {
  /** Close the overlay (the game resumes via the arcade:home-close event). */
  close(): void;
  /** Re-read every dynamic getLabel()/disabled() and repaint in place (no close). */
  refresh(): void;
}

interface ArcadeHomeMenuItem {
  id?: string;
  label?: string;
  /** Dynamic label; re-read on every open AND after any select. Wins over `label`. */
  getLabel?: () => string;
  onSelect: (ctx: ArcadeHomeMenuItemContext) => void;
  /** Default false. true => overlay closes (game resumes) after onSelect runs. */
  closeOnSelect?: boolean;
  kind?: "primary" | "default";
  /** Re-evaluated on every open; disabled items render dimmed + inert. */
  disabled?: () => boolean;
}

interface ArcadeHomeMenuConfig {
  items: ArcadeHomeMenuItem[];
}

/** One seat for the overlay's bottom Wii P1-P4 LED strip (v2.2 setPlayers API). */
interface ArcadeHomePlayer {
  /** 0-based seat (0..3); omit to place in registration order. */
  slot?: number;
  /** Shown under the seat (truncated; rendered via textContent — XSS-safe). */
  name?: string;
  /** Default true; false dims the seat (e.g. a dropped player). */
  connected?: boolean;
  /** Styles the seat as a CPU/bot fill. */
  isBot?: boolean;
  /** Marks the local player's seat. */
  you?: boolean;
}

/**
 * One chat message delivered to a game (v2.4). Same shape as the
 * `arcade:chat-message` window-event `detail`. Text is already sanitized by the
 * overlay — render it with textContent, never innerHTML.
 */
interface ArcadeChatMessage {
  /** Sender display name — matches the roster names pushed via setPlayers(). */
  from: string;
  /** The message text (sanitized). */
  text: string;
  /** Epoch ms the message was sent. */
  at: number;
  /** Source room. Always "general" today (one shared arcade-wide conversation). */
  room: string;
  /** True when YOU sent this message. */
  you: boolean;
}

interface ArcadeHomeOverlay {
  version: string;
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** v2: register/replace this game's pause-menu items. Safe before OR after boot. */
  registerGameMenu?: (config: ArcadeHomeMenuConfig) => void;
  /** v2: remove this game's items. */
  clearGameMenu?: () => void;
  /** v2.2: push the live roster to the bottom P1-P4 strip. */
  setPlayers?: (players: ArcadeHomePlayer[]) => void;
  /** v2.2: clear the roster back to empty "Open" placeholders. */
  clearPlayers?: () => void;
  /**
   * v2.3: record an achievement unlock for this player and, the FIRST time only,
   * show an "Achievement unlocked" toast. Idempotent + best-effort (POSTs to
   * arcade-api /api/achievements/unlock, keyed server-side by the Access email).
   * `id` must exist in the arcade-api catalog. See docs/arcade-achievements.md.
   */
  unlockAchievement?: (id: string) => void;
  /**
   * v2.4: post a chat message from inside the game (quick-chat / emotes). Posts to
   * the shared "general" room (the `room` arg is currently ignored — chat is
   * General-only). Attributed to the player's hub profile name, never the email.
   */
  sendChat?: (text: string, room?: string) => void;
  /**
   * v2.4: subscribe to incoming chat messages (same data as the
   * `arcade:chat-message` window event). Use to draw speech bubbles over players —
   * map `msg.from` to a seat by the names you pushed via setPlayers().
   * See docs/arcade-chat-bubbles.md.
   */
  onChatMessage?: (cb: (msg: ArcadeChatMessage) => void) => void;
  /** v2.4: remove a listener previously registered with onChatMessage. */
  offChatMessage?: (cb: (msg: ArcadeChatMessage) => void) => void;
}

interface Window {
  __arcadeHomeOverlay?: ArcadeHomeOverlay;
  /** v2 alias for __arcadeHomeOverlay — prefer this. */
  __arcadeHome?: ArcadeHomeOverlay;
}
