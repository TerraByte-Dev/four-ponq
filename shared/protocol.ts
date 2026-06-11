/**
 * Four Ponq — networked multiplayer WIRE PROTOCOL (Stage 2: session layer).
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
 *
 * SESSION LAYER (Stage 2) — the universal arcade flow:
 *   - Connecting while a match is in progress seats you as a SPECTATOR
 *     (welcome.slot === -1): you receive snapshots and watch live.
 *   - A spectator sends {t:"join"} ("Jump in?"). If the room is in the ready
 *     screen (lobby/matchOver) they are seated immediately; if a match is
 *     playing they get {t:"joinPending"} and are seated at the NEXT SERVE
 *     (the natural round boundary), replacing a bot. {t:"seated"} confirms.
 *   - Between matches everyone lands on a READY screen: each human toggles
 *     {t:"ready"}; when ALL connected humans are ready the server runs a
 *     3-2-1 countdown (mode "countdown", room.countdown = seconds left) and
 *     starts the match. One human alone + bots = your ready starts it.
 *     A disconnect or un-ready during countdown cancels it (back to ready).
 *   - {t:"start"} is a legacy alias for {t:"ready", on:true}.
 */

/** Server simulation steps per second. */
export const SIM_HZ = 60;

/** Snapshots broadcast to clients per second. */
export const SNAP_HZ = 30;

/** Max human players (paddle slots) per room. */
export const MAX_PLAYERS = 4;

/** Ready-screen countdown length once all connected humans are ready. */
export const COUNTDOWN_SECONDS = 3;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMsg =
  /** Introduce yourself. You are seated (lobby) or made a spectator (live match). */
  | { t: "hello"; name: string }
  /** Change-only input; each field is sticky until the next input message. */
  | { t: "input"; ccw: boolean; cw: boolean; charge: boolean }
  /** Spectator asks for a seat ("Jump in?"). Seated now, or at the next serve. */
  | { t: "join" }
  /** Ready toggle on the ready screen (lobby / matchOver). */
  | { t: "ready"; on: boolean }
  /** Legacy alias for { t:"ready", on:true }. */
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
  /** Ready-screen state. Always false for bots and while playing. */
  ready: boolean;
}

/** Room lifecycle. lobby = never-played ready screen; matchOver = post-match ready screen. */
export type RoomMode = "lobby" | "countdown" | "playing" | "matchOver";

/**
 * Shape served as JSON by GET /presence on every multiplayer game container
 * (same origin as the game). The hub polls this (via a Caddy route on the hub
 * origin) to render the channel badge, e.g. "2 online · in match".
 * Static games simply don't serve it; the hub treats an error as "no badge".
 */
export interface PresenceInfo {
  id: string;
  humans: number;
  bots: number;
  mode: RoomMode;
  /** True when a newcomer could take a seat (free slot now or at next serve). */
  joinable: boolean;
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMsg =
  /** Sent once on connect. slot 0..3 = seated; -1 = spectator (live match or full). */
  | { t: "welcome"; clientId: string; slot: number; snapHz: number }
  /**
   * Roster + match mode + bot-fill + ready states. Sent on any room change.
   * countdown is present only while mode === "countdown" (seconds remaining).
   */
  | {
      t: "room";
      players: PlayerView[];
      mode: RoomMode;
      botFill: boolean;
      countdown?: number;
    }
  /** Join acknowledged but deferred — you'll be seated at the next serve. */
  | { t: "joinPending"; reason: "nextServe" }
  /** You now own a paddle. Sent on immediate join or at the deferred seat. */
  | { t: "seated"; slot: number }
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
  | { t: "event"; kind: string; data?: unknown } // ballHit | goal | eliminated | matchOver | serve | countdownTick
  /** Recoverable protocol/room error. */
  | { t: "error"; code: string; message: string }; // roomFull | badMessage | notSpectator | ...
