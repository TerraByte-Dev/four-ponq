/**
 * Gameplay tuning constants shared by the simulation modules and the scene.
 * Zero Phaser imports. Render/audio-only constants stay in main.ts.
 */

import type { BotDifficulty } from "./types";

export const MAX_SHIELDS = 5;
export const BALL_RADIUS = 10;
export const TRIANGLE_GRAVITY = 21000;
export const TRIANGLE_ROTATION_SPEED = 0.34;
export const TRIANGLE_REACTIVE_DAMPING = 0.998;
export const TRIANGLE_REACTIVE_MIN_SPEED = 0.12;
export const TRIANGLE_REACTIVE_MAX_SPEED = 4.6;
// How hard a ball impact torques the reactive triangle's spin (tuned up once the
// swivel became visible on every client — see the snapshot triangleRotation sync).
export const TRIANGLE_REACTIVE_IMPULSE_GAIN = 4.2;
export const TRIANGLE_PHASE_DELAY = 1000;
// Legacy curve-blend factor (superseded by PADDLE_MAX_DEFLECT contact steering).
export const PADDLE_CURVE_RESPONSE = 0.72;
// Contact-point paddle steering: a hit at the wing (offset ±1) deflects the exit
// this many radians off pure-inward; centre hits (offset 0) go straight back.
export const PADDLE_MAX_DEFLECT = 1.05;
// Floor on the exit's inward component (fraction of speed) so a clean paddle hit
// can never graze parallel to the goal line and self-score.
export const PADDLE_MIN_INWARD = 0.35;
export const PADDLE_RELEASE_GAP = 2.5;
export const PADDLE_CONCAVITY = 0.48;
export const PADDLE_WING_LENGTH_MIN = 16;
export const PADDLE_WING_LENGTH_RATIO = 0.045;
// Paddle hits needed before a player can grab/launch the ball (the "super").
// addCharge() runs once per hit before the catch check, so this many hits = the
// grab fires on the Nth hit. Player feedback: 4 charged too fast → 7 hits.
export const MAX_CHARGE = 7;
// Per-rally consecutive-hit acceleration. Player feedback ("ball a lil too fast")
// → gentled 1.08 → 1.05 so rallies ramp more slowly.
export const REPEAT_HIT_BOOST = 1.05;
export const CATCH_DURATION = 3000;
export const CATCH_LAUNCH_BOOST = 2;
export const SPAWN_DELAY = 850;
export const BASE_BALL_SPEED = 380;
export const MENU_BALL_SPEED = 180;
export const BASE_PADDLE_SPEED = 2.3625;
export const PADDLE_SPEED_RAMP = 0.045;
export const MAX_PADDLE_SPEED_MULTIPLIER = 1.36;
export const PADDLE_MOVE_ASSIST = 0.1;
export const PADDLE_ASSIST_ACCELERATION = 6.5;
export const PADDLE_ASSIST_DECELERATION = 9.5;
export const ROTATING_VARIANT_PADDLE_SPEED_BOOST = 1.05;
export const ARENA_ROTATION_SPEED = 0.18;
// Rally speed cap. Feedback: "ball a lil too fast" → 840 → 700. MAX_CHARGED must
// stay strictly above this so a charged launch still out-runs a capped rally.
export const MAX_BALL_SPEED = 700;
export const MAX_CHARGED_BALL_SPEED = 820;
export const ARC_BARRIER_HALF_ANGLE = 0.04125;
export const ARC_BARRIER_INSET = 6;
export const ARC_BARRIER_THICKNESS = 15;

// "Hollow Trinity" center shape (host-selectable alongside the solid triangle):
// 3 shortened segments forming a hollow core with 3 corner-gap openings. For the
// ball to thread a corner the centerline gap must clear BOTH wall capsules AND the
// ball: gap >= 2*(BALL_RADIUS + HALF_THICKNESS) (the walls are HALF_THICKNESS-radius
// capsules). The per-corner gap is (1-FRACTION)/2 * edgeLen = (1-FRACTION)/2 *
// chamberRadius * sqrt(3); at R=82, FRACTION=0.44 that's ~40px vs the ~30px needed
// (BALL_RADIUS 10 + HALF_THICKNESS 5) — comfortable passage, still tight enough to
// rattle. Collision band is BALL_RADIUS + HALF_THICKNESS; drawn width is 2*HALF_THICKNESS.
export const TRINITY_MIN_CHAMBER_RADIUS = 82;
export const TRINITY_SEGMENT_FRACTION = 0.44;
export const TRINITY_SEGMENT_HALF_THICKNESS = 5;

export const BOT_DIFFICULTY_SPEED: Record<BotDifficulty, number> = {
  easy: 0.42,
  medium: 0.68,
  hard: 0.94
};
