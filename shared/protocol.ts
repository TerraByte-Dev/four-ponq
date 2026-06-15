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

// Gameplay-setting value unions, shared verbatim with the sim. Type-only import
// (compiles away) — keeps protocol.ts runtime-dependency-free for both tsconfigs.
import type { BotDifficulty, GameVariant, TriangleMotionMode } from "../src/sim/types";

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
  /**
   * Introduce yourself. You are seated (lobby) or made a spectator (live match).
   * `publicId` is the caller's arcade-hub profile public id (from GET /api/profile);
   * the server relays it in {t:"room"} so every client can fetch + show this
   * player's hand-drawn hub avatar via GET /api/profile/by-id/<publicId>. Optional
   * because the /api/profile fetch is async — clients that learn it after connect
   * send {t:"setProfile"} instead.
   */
  | { t: "hello"; name: string; publicId?: string }
  /** Live rename — updates your roster name (and seat name, if seated). */
  | { t: "setName"; name: string }
  /** Late profile id (the async /api/profile resolved after hello). Relayed in {t:"room"}. */
  | { t: "setProfile"; publicId: string }
  /** Change-only input; each field is sticky until the next input message. */
  | { t: "input"; ccw: boolean; cw: boolean; charge: boolean }
  /** Spectator asks for a seat ("Jump in?"). Seated now, or at the next serve. */
  | { t: "join" }
  /** Ready toggle on the ready screen (lobby / matchOver). */
  | { t: "ready"; on: boolean }
  /** Legacy alias for { t:"ready", on:true }. */
  | { t: "start" }
  /** Toggle bot-fill for empty slots. Host-only + ready-screen-only (server-enforced). */
  | { t: "setBots"; on: boolean }
  /**
   * Host-only, ready-screen-only change to a shared gameplay setting. The server
   * applies it to the authoritative sim and echoes the value back in {t:"room"}.
   * (Theme is intentionally absent — it stays a per-client cosmetic preference.)
   */
  | { t: "setSetting"; key: "difficulty" | "gameVariant" | "triangleMotion"; value: string };

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
  /**
   * Arcade-hub profile public id, if this seat's human reported one. Clients use
   * it to fetch + render the player's hand-drawn doodle avatar via
   * GET /api/profile/by-id/<publicId>. Empty/absent for bots, open seats, or
   * humans without a hub profile (the renderer falls back to a name-initial disc).
   */
  publicId?: string;
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
      /** Slot of the current host (lowest-slot connected human); -1 if room empty. */
      hostSlot: number;
      /** Authoritative shared gameplay settings, so every client agrees + can display them. */
      difficulty: BotDifficulty;
      gameVariant: GameVariant;
      triangleMotion: TriangleMotionMode;
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
      /**
       * Authoritative center-triangle orientation (radians). The triangle's
       * reactive swivel is server-side gameplay — the ball bounces off THIS pose,
       * so it MUST be on the wire and rendered (interpolated) by every client.
       * Before this existed the client span its own local triangle and balls
       * appeared to bounce off empty space.
       */
      triangleRotation: number;
    }
  /** Fire-and-forget gameplay event for client sound/fx. */
  | { t: "event"; kind: string; data?: unknown } // ballHit | goal | eliminated | matchOver | serve | countdownTick
  /** Recoverable protocol/room error. */
  | { t: "error"; code: string; message: string }; // roomFull | badMessage | notSpectator | ...
