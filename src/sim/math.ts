/**
 * Pure 2D vector + angle math for the simulation. Zero Phaser imports.
 *
 * Phaser.Math.Vector2 instances satisfy Vec2 structurally ({ x, y }), so the
 * scene can hand its existing vectors straight into sim functions. Helpers
 * mirror the exact floating-point behavior of the Phaser statics they replace
 * (Clamp, Linear, Wrap, Angle.Wrap, Vector2.normalize's 1/sqrt form) so the
 * refactor does not change gameplay.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export function vec(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function cloneVec(source: Vec2): Vec2 {
  return { x: source.x, y: source.y };
}

export function copyVec(target: Vec2, source: Vec2): Vec2 {
  target.x = source.x;
  target.y = source.y;
  return target;
}

export function setVec(target: Vec2, x: number, y: number): Vec2 {
  target.x = x;
  target.y = y;
  return target;
}

export function addVec(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subVec(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scaleVec(source: Vec2, scalar: number): Vec2 {
  return { x: source.x * scalar, y: source.y * scalar };
}

export function dotVec(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function lengthVec(source: Vec2): number {
  return Math.sqrt(source.x * source.x + source.y * source.y);
}

export function lengthSqVec(source: Vec2): number {
  return source.x * source.x + source.y * source.y;
}

export function distanceVec(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Matches Phaser.Math.Vector2#normalize: multiplies by 1/sqrt(lenSq), no-op on zero vectors. */
export function normalizeVecInPlace(target: Vec2): Vec2 {
  const lengthSq = target.x * target.x + target.y * target.y;
  if (lengthSq > 0) {
    const inverse = 1 / Math.sqrt(lengthSq);
    target.x *= inverse;
    target.y *= inverse;
  }
  return target;
}

export function normalizeVec(source: Vec2): Vec2 {
  return normalizeVecInPlace(cloneVec(source));
}

/** Matches Phaser.Math.Clamp. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Matches Phaser.Math.Linear. */
export function lerp(p0: number, p1: number, t: number): number {
  return (p1 - p0) * t + p0;
}

/** Matches Phaser.Math.Wrap. */
export function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  return min + ((((value - min) % range) + range) % range);
}

/** Matches Phaser.Math.Angle.Wrap (wraps to [-PI, PI)). */
export function wrapAngle(angle: number): number {
  return wrap(angle, -Math.PI, Math.PI);
}

export function normalizeAngle(angle: number): number {
  return wrap(angle, 0, TAU);
}

export function angleInArc(angle: number, start: number, end: number): boolean {
  const normalized = normalizeAngle(angle);
  const normalizedStart = normalizeAngle(start);
  const span = end - start;
  const relative = normalizeAngle(normalized - normalizedStart);
  return relative <= span;
}

export function clampAngleToArc(angle: number, start: number, end: number, margin: number): number {
  const normalizedStart = normalizeAngle(start);
  const span = end - start;
  const relative = normalizeAngle(normalizeAngle(angle) - normalizedStart);
  const clamped = clamp(relative, margin, Math.max(margin, span - margin));
  return normalizeAngle(normalizedStart + clamped);
}

export function shortestAngleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function pointOnCircle(center: Vec2, angle: number, radius: number): Vec2 {
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius
  };
}

export function closestPointOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segment = subVec(end, start);
  const lengthSq = lengthSqVec(segment);
  if (lengthSq === 0) {
    return cloneVec(start);
  }

  const t = clamp(dotVec(subVec(point, start), segment) / lengthSq, 0, 1);
  return { x: start.x + segment.x * t, y: start.y + segment.y * t };
}

export function closestPointsBetweenSegments(
  aStart: Vec2,
  aEnd: Vec2,
  bStart: Vec2,
  bEnd: Vec2
): { a: Vec2; b: Vec2; distance: number } {
  let bestA = cloneVec(aStart);
  let bestB = cloneVec(bStart);
  let bestDistance = Infinity;

  const candidates = [
    { a: aStart, b: closestPointOnSegment(aStart, bStart, bEnd) },
    { a: aEnd, b: closestPointOnSegment(aEnd, bStart, bEnd) },
    { a: closestPointOnSegment(bStart, aStart, aEnd), b: bStart },
    { a: closestPointOnSegment(bEnd, aStart, aEnd), b: bEnd }
  ];

  for (const candidate of candidates) {
    const distance = distanceVec(candidate.a, candidate.b);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestA = cloneVec(candidate.a);
      bestB = cloneVec(candidate.b);
    }
  }

  return { a: bestA, b: bestB, distance: bestDistance };
}

export function pointInTriangle(point: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const area = triangleSign(point, a, b);
  const sideB = triangleSign(point, b, c);
  const sideC = triangleSign(point, c, a);
  const hasNegative = area < 0 || sideB < 0 || sideC < 0;
  const hasPositive = area > 0 || sideB > 0 || sideC > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(p1: Vec2, p2: Vec2, p3: Vec2): number {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}
