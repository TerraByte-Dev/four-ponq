/**
 * Four Ponq — networked multiplayer WIRE PROTOCOL (Stage 1).
 *
 * SINGLE SOURCE OF TRUTH. Imported by BOTH the server (server/**) and the
 * client (src/net/**). Do not fork or redefine these types anywhere else.
 *
 * Zero runtime dependencies — types + plain constants only, so it compiles
 * cleanly under both the DOM-free server tsconfig and the client tsconfig.
 *
 * Coordinate convention: ball x/y and paddle angles are in the SAME sim space
 * the src/sim modules use. The server simulates in that space; the client maps
 * to render space exactly as main.ts does today. snap.ball is sim-space;
 * snap.paddles[] are paddleAngle values.
 */

/** Server simulation steps per second. */
export const SIM_HZ = 60;

/** Snapshots broadcast to clients per second. */
export const SNAP_HZ = 30;

/** Max human players (paddle slots) per room. */
export const MAX_PLAYERS = 4;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMsg =
  /** Join the shared room. */
  | { t: "hello"; name: string }
  /** Change-only input; each field is sticky until the next input message. */
  | { t: "input"; ccw: boolean; cw: boolean; charge: boolean }
  /** Start/restart a match from lobby or matchOver. */
  | { t: "start" }
  /** Toggle bot-fill for empty slots. */
  | { t: "setBots"; on: boolean };

// ---------------------------------------------------------------------------
// Shared view types
// ---------------------------------------------------------------------------

export interface PlayerView {
  slot: number;
  name: string;
  isBot: boolean;
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMsg =
  /** Sent once on connect. slot 0..3, or -1 = spectator (room full). */
  | { t: "welcome"; clientId: string; slot: number; snapHz: number }
  /** Lobby/roster + match mode + bot-fill state. Sent on any room change. */
  | { t: "room"; players: PlayerView[]; mode: "lobby" | "playing" | "matchOver"; botFill: boolean }
  /** Per-tick game state snapshot. Arrays are indexed by slot 0..3. */
  | {
      t: "snap";
      tick: number;
      ball: { x: number; y: number };
      paddles: number[];
      charges: number[];
      shields: number[];
      eliminated: boolean[];
    }
  /** Fire-and-forget gameplay event for client sound/fx. */
  | { t: "event"; kind: string; data?: unknown } // ballHit | goal | eliminated | matchOver | serve
  /** Recoverable protocol/room error. */
  | { t: "error"; code: string; message: string };
