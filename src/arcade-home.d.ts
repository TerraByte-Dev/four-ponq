/**
 * Type surface for the Terrabyte Arcade HOME overlay.
 *
 * The overlay itself is injected at runtime by the hub at /__arcade/home.js
 * (it 404s in local dev), so this is an ambient declaration only — no import.
 * Mirrors the v2 API contract that all arcade games depend on verbatim.
 */

interface ArcadeHomeMenuItemContext {
  close(): void;
  refresh(): void;
}

interface ArcadeHomeMenuItem {
  id?: string;
  label?: string;
  /** Dynamic label; re-read on every open AND after any select. Wins over `label`. */
  getLabel?: () => string;
  onSelect: (ctx: ArcadeHomeMenuItemContext) => void;
  /** Default false. true => overlay closes (game resumes) after onSelect. */
  closeOnSelect?: boolean;
  kind?: "primary" | "default";
  /** Re-evaluated on every open; disabled items render dimmed + inert. */
  disabled?: () => boolean;
}

interface ArcadeHomeMenuConfig {
  items: ArcadeHomeMenuItem[];
}

interface ArcadeHomeOverlay {
  version: string;
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** v2: register/replace this game's menu section. Safe before OR after boot. */
  registerGameMenu?: (config: ArcadeHomeMenuConfig) => void;
  /** v2: remove the game's items. */
  clearGameMenu?: () => void;
}

interface Window {
  __arcadeHomeOverlay?: ArcadeHomeOverlay;
  __arcadeHome?: ArcadeHomeOverlay;
}
