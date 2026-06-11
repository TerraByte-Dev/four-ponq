/**
 * Pure arena/paddle/triangle geometry. Zero Phaser imports.
 * Verbatim ports of the former FourPongScene geometry helpers — state in,
 * values out — so the same math can run headless on a server.
 */

import {
  TAU,
  Vec2,
  angleInArc,
  normalizeAngle,
  clampAngleToArc,
  shortestAngleDelta,
  pointOnCircle,
  normalizeVecInPlace,
  subVec
} from "./math";
import type { ArenaGeometry, PaddleSegment, SimPlayer } from "./types";
import {
  BALL_RADIUS,
  PADDLE_CONCAVITY,
  PADDLE_RELEASE_GAP,
  PADDLE_WING_LENGTH_MIN,
  PADDLE_WING_LENGTH_RATIO
} from "./constants";

export interface PaddleOutlinePoint {
  position: Vec2;
  offset: number;
}

/**
 * Derives the play circle from a viewport size. Deterministic — the scene and
 * a future server can both call it for arbitrary dimensions.
 */
export function computeArena(width: number, height: number): ArenaGeometry {
  const hudSafeTop = width < 760 ? 142 : 92;
  const controlsSafeBottom = width < 760 ? 118 : 70;
  const centerY = hudSafeTop + (height - hudSafeTop - controlsSafeBottom) / 2;
  const radius = Math.max(126, Math.min(width * 0.43, (height - hudSafeTop - controlsSafeBottom) * 0.48));

  return {
    center: { x: width / 2, y: centerY },
    radius,
    paddleThickness: Math.max(16, Math.min(24, radius * 0.085)),
    paddleAngleSpan: Math.max(0.252, Math.min(0.468, 68.4 / radius)),
    triangleRadius: Math.max(32, Math.min(56, radius * 0.18))
  };
}

export function paddleConcaveHalfWidth(arena: ArenaGeometry): number {
  return Math.max(37, arena.radius * arena.paddleAngleSpan * 0.54);
}

export function paddleWingLength(arena: ArenaGeometry): number {
  return Math.max(PADDLE_WING_LENGTH_MIN, arena.radius * PADDLE_WING_LENGTH_RATIO);
}

export function paddleHalfWidth(arena: ArenaGeometry): number {
  return paddleConcaveHalfWidth(arena) + paddleWingLength(arena);
}

export function paddleHalfHeight(arena: ArenaGeometry): number {
  return Math.max(14, arena.paddleThickness * 0.74);
}

export function paddleInnerY(offset: number, halfHeight: number): number {
  const endDip = halfHeight * 0.12;
  return -halfHeight + halfHeight * PADDLE_CONCAVITY * (1 - offset * offset) - endDip * offset * offset;
}

export function paddleInnerSlope(offset: number, halfWidth: number, halfHeight: number): number {
  return (-2 * halfHeight * (PADDLE_CONCAVITY + 0.12) * offset) / halfWidth;
}

export function paddleLocalPoint(center: Vec2, tangent: Vec2, radial: Vec2, x: number, y: number): Vec2 {
  return {
    x: center.x + tangent.x * x + radial.x * y,
    y: center.y + tangent.y * x + radial.y * y
  };
}

export function paddleOuterPoint(arena: ArenaGeometry, player: SimPlayer, localX: number): Vec2 {
  return pointOnCircle(arena.center, player.paddleAngle + localX / arena.radius, arena.radius);
}

export function paddleCenter(arena: ArenaGeometry, player: SimPlayer): Vec2 {
  return pointOnCircle(arena.center, player.paddleAngle, arena.radius - paddleHalfHeight(arena));
}

export function paddleCatchPoint(arena: ArenaGeometry, player: SimPlayer): Vec2 {
  const center = paddleCenter(arena, player);
  const radial = normalizeVecInPlace(subVec(center, arena.center));
  const tangent = { x: -radial.y, y: radial.x };
  const innerY = paddleInnerY(0, paddleHalfHeight(arena));
  return paddleLocalPoint(center, tangent, radial, 0, innerY - BALL_RADIUS - PADDLE_RELEASE_GAP);
}

export function paddleOutlinePoints(arena: ArenaGeometry, player: SimPlayer): PaddleOutlinePoint[] {
  const center = paddleCenter(arena, player);
  const radial = normalizeVecInPlace(subVec(center, arena.center));
  const tangent = { x: -radial.y, y: radial.x };
  const concaveHalfWidth = paddleConcaveHalfWidth(arena);
  const halfWidth = paddleHalfWidth(arena);
  const halfHeight = paddleHalfHeight(arena);
  const steps = 18;
  const points: PaddleOutlinePoint[] = [];

  points.push({
    position: paddleOuterPoint(arena, player, -halfWidth),
    offset: -1
  });

  for (let index = 0; index <= steps; index += 1) {
    const offset = -1 + index / steps * 2;
    points.push({
      position: paddleOuterPoint(arena, player, offset * concaveHalfWidth),
      offset
    });
  }

  points.push({
    position: paddleOuterPoint(arena, player, halfWidth),
    offset: 1
  });
  points.push({
    position: paddleLocalPoint(center, tangent, radial, halfWidth, paddleInnerY(1, halfHeight)),
    offset: 1
  });

  for (let index = steps; index >= 0; index -= 1) {
    const offset = -1 + index / steps * 2;
    points.push({
      position: paddleLocalPoint(center, tangent, radial, offset * concaveHalfWidth, paddleInnerY(offset, halfHeight)),
      offset
    });
  }

  points.push({
    position: paddleLocalPoint(center, tangent, radial, -halfWidth, paddleInnerY(-1, halfHeight)),
    offset: -1
  });

  return points;
}

export function paddleCollisionSegments(arena: ArenaGeometry, player: SimPlayer): PaddleSegment[] {
  const outline = paddleOutlinePoints(arena, player);
  return outline.map((point, index) => {
    const next = outline[(index + 1) % outline.length];
    return {
      start: point.position,
      end: next.position,
      offset: (point.offset + next.offset) / 2
    };
  });
}

export function triangleVertices(arena: ArenaGeometry, rotation: number): Vec2[] {
  return [0, 1, 2].map((index) => pointOnCircle(arena.center, rotation + index * TAU / 3, arena.triangleRadius));
}

export function activePlayers<T extends SimPlayer>(players: T[]): T[] {
  return players.filter((player) => !player.eliminated);
}

export function playerForAngle<T extends SimPlayer>(players: T[], angle: number): T | undefined {
  return activePlayers(players).find((player) => angleInArc(angle, player.arcStart, player.arcEnd));
}

export function arcBarrierAngles(players: SimPlayer[]): number[] {
  const active = activePlayers(players);
  const angles: number[] = [];
  for (const player of active) {
    if (!angles.some((angle) => Math.abs(shortestAngleDelta(angle, player.arcStart)) < 0.001)) {
      angles.push(normalizeAngle(player.arcStart));
    }
  }
  return angles;
}

export function paddleSafetyMargin(arena: ArenaGeometry, player: SimPlayer): number {
  const span = player.arcEnd - player.arcStart;
  const halfPaddleAngle = paddleHalfWidth(arena) / arena.radius + 0.01;
  return Math.min(span * 0.46, Math.max(0.04, halfPaddleAngle));
}

export function clampPaddleToArc(arena: ArenaGeometry, player: SimPlayer): void {
  player.paddleAngle = clampAngleToArc(player.paddleAngle, player.arcStart, player.arcEnd, paddleSafetyMargin(arena, player));
}

/** Re-splits the circle between the surviving players and recenters their paddles. */
export function rebuildArcs(arena: ArenaGeometry, players: SimPlayer[]): void {
  const active = activePlayers(players);
  const span = TAU / Math.max(active.length, 1);
  const startOffset = -Math.PI / 2 - span / 2;

  active.forEach((player, index) => {
    player.arcStart = normalizeAngle(startOffset + index * span);
    player.arcEnd = player.arcStart + span;
    player.paddleAngle = normalizeAngle(player.arcStart + span / 2);
    clampPaddleToArc(arena, player);
  });
}
