/**
 * Shared simulation types. Zero Phaser imports — everything here can run
 * headless on a Node server (netcode milestone 1 groundwork).
 */

import type { Vec2 } from "./math";

export type GameMode = "menu" | "playing" | "paused" | "matchOver";
export type BotDifficulty = "easy" | "medium" | "hard";
export type TouchType = "none" | "player" | "triangle";
export type TriangleMotionMode = "steady" | "reactive";
export type GameVariant = "classic" | "rotating";
/** The center obstacle: the classic solid triangle, or the hollow 3-segment "trinity". */
export type CenterShape = "triangle" | "trinity";

/** rng() returns a float in [0, 1) — inject a seeded one for deterministic replays. */
export type Rng = () => number;

/** The sim-relevant subset of a player. The scene's PlayerState extends this with render fields. */
export interface SimPlayer {
  id: number;
  shields: number;
  eliminated: boolean;
  paddleAngle: number;
  arcStart: number;
  arcEnd: number;
  humanControlled: boolean;
  lastHumanInputAt: number;
  charge: number;
  paddleAssistMultiplier: number;
}

export interface ArenaGeometry {
  center: Vec2;
  radius: number;
  paddleThickness: number;
  paddleAngleSpan: number;
  triangleRadius: number;
}

export interface PaddleSegment {
  start: Vec2;
  end: Vec2;
  offset: number;
}

export interface PlayerInput {
  counterclockwise: boolean;
  clockwise: boolean;
  /** Held catch/charge key (Space today). Gates charged-shot catches. */
  catchHeld: boolean;
}

/**
 * The full mutable simulation state. The scene owns one instance and passes
 * it to the pure step functions; object-valued fields (ball, velocity,
 * players) are shared by reference with the scene so render code sees every
 * mutation without copying. Times are in milliseconds of sim-elapsed time.
 */
export interface SimState {
  players: SimPlayer[];
  ball: Vec2;
  velocity: Vec2;
  mode: GameMode;
  botFill: boolean;
  botDifficulty: BotDifficulty;
  gameVariant: GameVariant;
  triangleMotionMode: TriangleMotionMode;
  /** Which center obstacle is in play. Rotates on the same triangleRotation/Steady-Reactive machinery. */
  centerShape: CenterShape;
  /** Consecutive Hollow-Trinity ring bounces without leaving the ring — drives the anti-trap escape kick. */
  centerHitStreak: number;
  triangleRotation: number;
  triangleAngularVelocity: number;
  elapsed: number;
  lastScoreAt: number;
  triangleCollisionDisabledUntil: number;
  roundNumber: number;
  roundResolving: boolean;
  lastTouchType: TouchType;
  lastTouchPlayerId?: number;
  caughtByPlayerId?: number;
  caughtAt: number;
  caughtLaunchSpeed: number;
  roundReadyAt: number;
}

/**
 * Side-effect notifications emitted by the sim. The scene maps these to
 * sound/particles/HUD/messages/scheduling; a future server maps them to
 * network events. Vectors are snapshots (safe to keep references).
 */
export type SimEvent =
  | {
    kind: "paddleHit";
    playerId: number;
    contact: Vec2;
    radial: Vec2;
    tangent: Vec2;
    /** Burst-trail direction sign, computed from pre-reflection velocity. */
    tangentSign: number;
    repeatHit: boolean;
    /** True when this hit turned into a charged-shot catch (no reflect happened). */
    caught: boolean;
  }
  | { kind: "catchStart"; playerId: number }
  | { kind: "catchLaunch"; playerId: number }
  | { kind: "triangleHit" }
  | { kind: "barrierHit" }
  | { kind: "goal"; scorerId: number; shieldsRemaining: number; eliminated: boolean }
  | { kind: "matchOver"; winnerId?: number }
  | { kind: "serve"; direction: Vec2 };
