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
export const TRIANGLE_PHASE_DELAY = 1000;
export const PADDLE_CURVE_RESPONSE = 0.72;
export const PADDLE_RELEASE_GAP = 2.5;
export const PADDLE_CONCAVITY = 0.48;
export const PADDLE_WING_LENGTH_MIN = 16;
export const PADDLE_WING_LENGTH_RATIO = 0.045;
export const MAX_CHARGE = 10;
export const REPEAT_HIT_BOOST = 1.08;
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
export const MAX_BALL_SPEED = 840;
export const MAX_CHARGED_BALL_SPEED = 980;
export const ARC_BARRIER_HALF_ANGLE = 0.04125;
export const ARC_BARRIER_INSET = 6;
export const ARC_BARRIER_THICKNESS = 15;

export const BOT_DIFFICULTY_SPEED: Record<BotDifficulty, number> = {
  easy: 0.42,
  medium: 0.68,
  hard: 0.94
};
