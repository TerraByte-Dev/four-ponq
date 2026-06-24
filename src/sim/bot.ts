/**
 * Headless bot AI. Zero Phaser imports — pure state in, new paddle angle out,
 * so the same brain can drive bot slots on a future game server.
 *
 * Verbatim port of the bot half of FourPongScene.updatePaddles: aim at the
 * ball's angle from the arena center, clamp the target into the player's arc,
 * and move toward it at the difficulty-scaled speed.
 */

import { Vec2, clamp, clampAngleToArc, normalizeAngle, shortestAngleDelta } from "./math";
import type { ArenaGeometry, SimPlayer } from "./types";
import { paddleSafetyMargin } from "./geometry";

/**
 * @param botSpeed paddle speed already scaled by BOT_DIFFICULTY_SPEED (rad/s)
 * @returns the bot's new paddle angle (caller assigns + arc-clamps it)
 */
export function stepBotPaddle(
  player: SimPlayer,
  ball: Vec2,
  arena: ArenaGeometry,
  botSpeed: number,
  dt: number
): number {
  const targetAngle = normalizeAngle(Math.atan2(ball.y - arena.center.y, ball.x - arena.center.x));
  const target = clampAngleToArc(targetAngle, player.arcStart, player.arcEnd, paddleSafetyMargin(arena, player));
  const delta = shortestAngleDelta(player.paddleAngle, target);
  return normalizeAngle(player.paddleAngle + clamp(delta, -botSpeed * dt, botSpeed * dt));
}
