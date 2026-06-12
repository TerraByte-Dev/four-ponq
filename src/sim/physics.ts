/**
 * Pure ball/paddle/triangle physics. Zero Phaser imports.
 *
 * Verbatim ports of the former FourPongScene simulation methods. Functions
 * mutate the passed SimState in place (ball/velocity/players are shared by
 * reference with the caller) and return SimEvents describing the side effects
 * the caller should render (sound, particles, HUD, messages, scheduling).
 * No rendering, no audio, no DOM, no timers in here.
 */

import {
  TAU,
  Vec2,
  clamp,
  cloneVec,
  closestPointOnSegment,
  closestPointsBetweenSegments,
  copyVec,
  distanceVec,
  dotVec,
  lengthSqVec,
  lengthVec,
  lerp,
  normalizeAngle,
  normalizeVec,
  normalizeVecInPlace,
  pointInTriangle,
  pointOnCircle,
  shortestAngleDelta,
  subVec
} from "./math";
import type {
  ArenaGeometry,
  GameVariant,
  PaddleSegment,
  PlayerInput,
  Rng,
  SimEvent,
  SimPlayer,
  SimState
} from "./types";
import {
  ARC_BARRIER_HALF_ANGLE,
  ARC_BARRIER_INSET,
  ARC_BARRIER_THICKNESS,
  ARENA_ROTATION_SPEED,
  BALL_RADIUS,
  BASE_BALL_SPEED,
  BASE_PADDLE_SPEED,
  BOT_DIFFICULTY_SPEED,
  CATCH_DURATION,
  CATCH_LAUNCH_BOOST,
  MAX_BALL_SPEED,
  MAX_CHARGE,
  MAX_CHARGED_BALL_SPEED,
  MAX_PADDLE_SPEED_MULTIPLIER,
  MENU_BALL_SPEED,
  PADDLE_ASSIST_ACCELERATION,
  PADDLE_ASSIST_DECELERATION,
  PADDLE_CURVE_RESPONSE,
  PADDLE_MOVE_ASSIST,
  PADDLE_RELEASE_GAP,
  PADDLE_SPEED_RAMP,
  REPEAT_HIT_BOOST,
  ROTATING_VARIANT_PADDLE_SPEED_BOOST,
  SPAWN_DELAY,
  TRIANGLE_GRAVITY,
  TRIANGLE_PHASE_DELAY,
  TRIANGLE_REACTIVE_DAMPING,
  TRIANGLE_REACTIVE_MAX_SPEED,
  TRIANGLE_REACTIVE_MIN_SPEED,
  TRIANGLE_ROTATION_SPEED
} from "./constants";
import {
  activePlayers,
  arcBarrierAngles,
  clampPaddleToArc,
  paddleCatchPoint,
  paddleCenter,
  paddleCollisionSegments,
  paddleConcaveHalfWidth,
  paddleHalfHeight,
  paddleInnerSlope,
  playerForAngle,
  rebuildArcs,
  triangleVertices
} from "./geometry";
import { stepBotPaddle } from "./bot";

interface PaddleCollisionHit {
  contact: Vec2;
  normal: Vec2;
  radial: Vec2;
  offset: number;
  penetration: number;
  crossed: boolean;
}

export function createSimState(init?: {
  players?: SimPlayer[];
  ball?: Vec2;
  velocity?: Vec2;
}): SimState {
  return {
    players: init?.players ?? [],
    ball: init?.ball ?? { x: 0, y: 0 },
    velocity: init?.velocity ?? { x: 0, y: 0 },
    mode: "menu",
    botFill: true,
    botDifficulty: "medium",
    gameVariant: "classic",
    triangleMotionMode: "steady",
    triangleRotation: -Math.PI / 2,
    triangleAngularVelocity: TRIANGLE_ROTATION_SPEED,
    elapsed: 0,
    lastScoreAt: 0,
    triangleCollisionDisabledUntil: 0,
    roundNumber: 0,
    roundResolving: false,
    lastTouchType: "none",
    lastTouchPlayerId: undefined,
    caughtByPlayerId: undefined,
    caughtAt: 0,
    caughtLaunchSpeed: 0,
    roundReadyAt: 0
  };
}

export function clearTouchState(state: SimState): void {
  state.lastTouchType = "none";
  state.lastTouchPlayerId = undefined;
}

export function clearCatchState(state: SimState): void {
  state.caughtByPlayerId = undefined;
  state.caughtAt = 0;
  state.caughtLaunchSpeed = 0;
}

export function paddleSpeedMultiplier(roundNumber: number): number {
  const completedRounds = Math.max(0, roundNumber - 1);
  return Math.min(MAX_PADDLE_SPEED_MULTIPLIER, 1 + completedRounds * PADDLE_SPEED_RAMP);
}

export function variantPaddleSpeedMultiplier(variant: GameVariant): number {
  return variant === "rotating" ? ROTATING_VARIANT_PADDLE_SPEED_BOOST : 1;
}

/** Human paddle movement + assist, then bot fill. Port of updatePaddles. */
export function stepPaddles(state: SimState, arena: ArenaGeometry, input: PlayerInput, dt: number): void {
  const human = state.players.find((player) => player.humanControlled && !player.eliminated);
  const speed = BASE_PADDLE_SPEED * paddleSpeedMultiplier(state.roundNumber) * variantPaddleSpeedMultiplier(state.gameVariant);
  const humanMoving = input.counterclockwise || input.clockwise;

  if (human) {
    updatePaddleAssist(state, arena, human, dt, humanMoving);
  }

  if (human && humanMoving) {
    const direction = (input.clockwise ? 1 : 0) - (input.counterclockwise ? 1 : 0);
    human.paddleAngle += direction * speed * human.paddleAssistMultiplier * dt;
    human.lastHumanInputAt = state.elapsed;
    clampPaddleToArc(arena, human);
  }

  if (!state.botFill) {
    return;
  }

  const botSpeed = speed * BOT_DIFFICULTY_SPEED[state.botDifficulty];
  for (const player of state.players) {
    if (player.eliminated || player.humanControlled) {
      continue;
    }

    player.paddleAngle = stepBotPaddle(player, state.ball, arena, botSpeed, dt);
    clampPaddleToArc(arena, player);
  }
}

function updatePaddleAssist(state: SimState, arena: ArenaGeometry, player: SimPlayer, dt: number, moving: boolean): void {
  const distanceToPaddle = distanceVec(state.ball, paddleCenter(arena, player));
  const closeDistance = arena.radius * 0.42;
  const farDistance = arena.radius;
  const farFactor = clamp((distanceToPaddle - closeDistance) / Math.max(farDistance - closeDistance, 1), 0, 1);
  const target = moving ? 1 + PADDLE_MOVE_ASSIST * farFactor : 1;
  const rate = target > player.paddleAssistMultiplier ? PADDLE_ASSIST_ACCELERATION : PADDLE_ASSIST_DECELERATION;
  const smoothing = 1 - Math.exp(-rate * dt);
  player.paddleAssistMultiplier = lerp(player.paddleAssistMultiplier, target, smoothing);
}

/** Port of updateTriangleMotion — runs every frame regardless of mode. */
export function stepTriangleMotion(state: SimState, dt: number): void {
  if (state.triangleMotionMode === "steady") {
    state.triangleAngularVelocity = TRIANGLE_ROTATION_SPEED;
  } else {
    const sign = state.triangleAngularVelocity < 0 ? -1 : 1;
    const damped = state.triangleAngularVelocity * Math.pow(TRIANGLE_REACTIVE_DAMPING, dt * 60);
    state.triangleAngularVelocity = Math.abs(damped) < TRIANGLE_REACTIVE_MIN_SPEED
      ? sign * TRIANGLE_REACTIVE_MIN_SPEED
      : clamp(damped, -TRIANGLE_REACTIVE_MAX_SPEED, TRIANGLE_REACTIVE_MAX_SPEED);
  }

  state.triangleRotation += state.triangleAngularVelocity * dt;
}

/** Orbit variant: rotates every surviving player's arc + paddle. */
export function updateArenaRotation(state: SimState, arena: ArenaGeometry, dt: number): void {
  if (state.gameVariant !== "rotating") {
    return;
  }

  const rotation = ARENA_ROTATION_SPEED * dt;
  for (const player of activePlayers(state.players)) {
    player.arcStart += rotation;
    player.arcEnd += rotation;
    player.paddleAngle = normalizeAngle(player.paddleAngle + rotation);
    clampPaddleToArc(arena, player);
  }
}

export function applyTriangleGravity(state: SimState, arena: ArenaGeometry, dt: number, minSpeed: number, maxSpeed: number): void {
  const towardTriangle = subVec(arena.center, state.ball);
  const distanceSq = Math.max(lengthSqVec(towardTriangle), 1600);
  const force = Math.min(48, TRIANGLE_GRAVITY / distanceSq);
  const impulse = force * dt;
  normalizeVecInPlace(towardTriangle);
  state.velocity.x += towardTriangle.x * impulse;
  state.velocity.y += towardTriangle.y * impulse;

  const speed = lengthVec(state.velocity);
  if (speed > 0) {
    const clampedSpeed = clamp(speed, minSpeed, maxSpeed);
    normalizeVecInPlace(state.velocity);
    state.velocity.x *= clampedSpeed;
    state.velocity.y *= clampedSpeed;
  }
}

export function reflectBall(state: SimState, normal: Vec2): void {
  const speed = Math.min(lengthVec(state.velocity) * 1.02, MAX_BALL_SPEED);
  const scale = 2 * dotVec(state.velocity, normal);
  const reflected = { x: state.velocity.x - normal.x * scale, y: state.velocity.y - normal.y * scale };
  normalizeVecInPlace(reflected);
  state.velocity.x = reflected.x * speed;
  state.velocity.y = reflected.y * speed;
}

export function boostBallSpeed(state: SimState, multiplier: number): void {
  const speed = lengthVec(state.velocity);
  if (speed > 0) {
    const boosted = Math.min(speed * multiplier, MAX_BALL_SPEED);
    normalizeVecInPlace(state.velocity);
    state.velocity.x *= boosted;
    state.velocity.y *= boosted;
  }
}

function addCharge(player: SimPlayer): void {
  player.charge = Math.min(MAX_CHARGE, player.charge + 1);
}

function canCatchBall(player: SimPlayer, catchHeld: boolean): boolean {
  return player.humanControlled && player.charge >= MAX_CHARGE && catchHeld;
}

function startCatch(state: SimState, arena: ArenaGeometry, player: SimPlayer, events: SimEvent[]): void {
  state.caughtByPlayerId = player.id;
  state.caughtAt = state.elapsed;
  state.caughtLaunchSpeed = Math.max(lengthVec(state.velocity), 360);
  state.velocity.x = 0;
  state.velocity.y = 0;
  updateCaughtBall(state, arena);
  state.lastTouchType = "player";
  state.lastTouchPlayerId = player.id;
  events.push({ kind: "catchStart", playerId: player.id });
}

/** Pins the caught ball to its captor's paddle (or clears the catch if they're gone). */
export function updateCaughtBall(state: SimState, arena: ArenaGeometry): void {
  const player = state.players.find((entry) => entry.id === state.caughtByPlayerId && !entry.eliminated);
  if (!player) {
    clearCatchState(state);
    return;
  }

  copyVec(state.ball, paddleCatchPoint(arena, player));
}

function launchCaughtBall(state: SimState, arena: ArenaGeometry, events: SimEvent[]): void {
  const player = state.players.find((entry) => entry.id === state.caughtByPlayerId && !entry.eliminated);
  if (!player) {
    clearCatchState(state);
    return;
  }

  const radial = normalizeVecInPlace(subVec(paddleCenter(arena, player), arena.center));
  const launchSpeed = Math.min(Math.max(BASE_BALL_SPEED, state.caughtLaunchSpeed) * CATCH_LAUNCH_BOOST, MAX_CHARGED_BALL_SPEED);
  copyVec(state.ball, paddleCatchPoint(arena, player));
  state.velocity.x = radial.x * -launchSpeed;
  state.velocity.y = radial.y * -launchSpeed;
  player.charge = 0;
  state.lastTouchType = "player";
  state.lastTouchPlayerId = player.id;
  clearCatchState(state);
  events.push({ kind: "catchLaunch", playerId: player.id });
}

/** Per-frame caught-ball update: hold it on the paddle, fire on release/timeout. */
export function stepCaughtBall(state: SimState, arena: ArenaGeometry, catchHeld: boolean): SimEvent[] {
  const events: SimEvent[] = [];
  updateCaughtBall(state, arena);
  if (!catchHeld || state.elapsed - state.caughtAt >= CATCH_DURATION) {
    launchCaughtBall(state, arena, events);
  }
  return events;
}

/**
 * Serve: recenters the ball and fires it in a (jittered) direction.
 * rng is injected so a server/replay can be deterministic.
 */
export function resetRound(state: SimState, arena: ArenaGeometry, rng: Rng, targetAngle?: number, countRound = true): SimEvent[] {
  const events: SimEvent[] = [];
  resetRoundInternal(state, arena, rng, events, targetAngle, countRound);
  return events;
}

function floatBetween(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

function resetRoundInternal(state: SimState, arena: ArenaGeometry, rng: Rng, events: SimEvent[], targetAngle?: number, countRound = true): void {
  const angle = normalizeAngle((targetAngle ?? floatBetween(rng, 0, TAU)) + floatBetween(rng, -0.32, 0.32));
  const speed = state.mode === "menu" ? MENU_BALL_SPEED : BASE_BALL_SPEED;

  if (countRound && state.mode === "playing") {
    state.roundNumber += 1;
  }

  copyVec(state.ball, arena.center);
  state.velocity.x = Math.cos(angle) * speed;
  state.velocity.y = Math.sin(angle) * speed;
  state.triangleCollisionDisabledUntil = state.elapsed + TRIANGLE_PHASE_DELAY;
  state.roundReadyAt = state.mode === "playing" ? state.elapsed + SPAWN_DELAY : 0;
  state.roundResolving = false;
  clearTouchState(state);
  clearCatchState(state);
  events.push({ kind: "serve", direction: normalizeVec(state.velocity) });
}

/**
 * Substepped ball advance: integrates position and runs triangle, barrier,
 * paddle, and goal handling per substep. Port of advanceBall.
 */
export function advanceBall(state: SimState, arena: ArenaGeometry, dt: number, catchHeld: boolean, rng: Rng): SimEvent[] {
  const events: SimEvent[] = [];
  const distance = lengthVec(state.velocity) * dt;
  const steps = Math.max(1, Math.ceil(distance / (BALL_RADIUS * 0.5)));
  const stepDt = dt / steps;

  for (let index = 0; index < steps; index += 1) {
    const previousBall = cloneVec(state.ball);
    state.ball.x += state.velocity.x * stepDt;
    state.ball.y += state.velocity.y * stepDt;
    handleTriangleCollision(state, arena, events);
    handleArcBarrierCollisions(state, arena, events, previousBall);
    handlePaddleCollisions(state, arena, events, catchHeld, previousBall);
    handleGoals(state, arena, events, rng);

    if (state.roundResolving || state.caughtByPlayerId !== undefined || state.mode !== "playing") {
      return events;
    }
  }

  return events;
}

/** Menu-screen attract motion: gravity well + triangle bounces inside a soft ring. */
export function stepMenuPreview(state: SimState, arena: ArenaGeometry, dt: number): SimEvent[] {
  const events: SimEvent[] = [];
  applyTriangleGravity(state, arena, dt, 150, 260);
  state.ball.x += state.velocity.x * dt;
  state.ball.y += state.velocity.y * dt;
  handleTriangleCollision(state, arena, events);

  const fromCenter = subVec(state.ball, arena.center);
  if (lengthVec(fromCenter) > arena.radius * 0.72) {
    const normal = normalizeVecInPlace(fromCenter);
    reflectBall(state, normal);
    state.ball.x = arena.center.x + normal.x * (arena.radius * 0.72);
    state.ball.y = arena.center.y + normal.y * (arena.radius * 0.72);
  }

  return events;
}

function handleTriangleCollision(state: SimState, arena: ArenaGeometry, events: SimEvent[]): void {
  // During the intentional post-serve phase window the ball flies out from the
  // arena center straight through the triangle — no collision at all.
  if (state.elapsed < state.triangleCollisionDisabledUntil) {
    return;
  }

  const vertices = triangleVertices(arena, state.triangleRotation);

  // The ball center has penetrated the triangle interior — usually because a
  // fast (reactive) spin swept an edge across it between ticks, or a high-speed
  // substep landed inside. Eject it out the NEAREST edge and bounce instead of
  // letting it phase through (the old behaviour, which read as "the ball passed
  // through the center piece").
  if (pointInTriangle(state.ball, vertices[0], vertices[1], vertices[2])) {
    let nearest: { closest: Vec2; distance: number } | undefined;
    for (let index = 0; index < vertices.length; index += 1) {
      const start = vertices[index];
      const end = vertices[(index + 1) % vertices.length];
      const closest = closestPointOnSegment(state.ball, start, end);
      const distance = distanceVec(closest, state.ball);
      if (!nearest || distance < nearest.distance) {
        nearest = { closest, distance };
      }
    }

    if (nearest) {
      // Outward normal points from the interior ball toward the nearest edge.
      const outward = subVec(nearest.closest, state.ball);
      const normal = lengthSqVec(outward) > 0.0001
        ? normalizeVecInPlace(outward)
        : normalizeVecInPlace(subVec(state.ball, arena.center));
      applyTriangleReactiveImpulse(state, arena, nearest.closest);
      if (dotVec(state.velocity, normal) < 0) {
        reflectBall(state, normal);
      }
      state.ball.x = nearest.closest.x + normal.x * (BALL_RADIUS + 0.5);
      state.ball.y = nearest.closest.y + normal.y * (BALL_RADIUS + 0.5);
      clearTouchState(state);
      state.lastTouchType = "triangle";
      events.push({ kind: "triangleHit" });
    }
    return;
  }

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const closest = closestPointOnSegment(state.ball, start, end);
    const delta = subVec(state.ball, closest);
    const distance = lengthVec(delta);

    if (distance >= BALL_RADIUS || distance === 0) {
      continue;
    }

    const normal = normalizeVecInPlace(delta);
    applyTriangleReactiveImpulse(state, arena, closest);
    reflectBall(state, normal);
    state.ball.x = closest.x + normal.x * (BALL_RADIUS + 0.5);
    state.ball.y = closest.y + normal.y * (BALL_RADIUS + 0.5);
    clearTouchState(state);
    state.lastTouchType = "triangle";
    events.push({ kind: "triangleHit" });
    return;
  }
}

function handleArcBarrierCollisions(state: SimState, arena: ArenaGeometry, events: SimEvent[], previousBall?: Vec2): void {
  const fromCenter = subVec(state.ball, arena.center);
  const distance = lengthVec(fromCenter);
  const barrierRadius = arena.radius - ARC_BARRIER_INSET;
  const barrierHalfThickness = ARC_BARRIER_THICKNESS / 2;

  if (distance < barrierRadius - barrierHalfThickness - BALL_RADIUS || distance > barrierRadius + barrierHalfThickness + BALL_RADIUS) {
    return;
  }

  const angle = normalizeAngle(Math.atan2(fromCenter.y, fromCenter.x));
  for (const barrierAngle of arcBarrierAngles(state.players)) {
    if (Math.abs(shortestAngleDelta(barrierAngle, angle)) > ARC_BARRIER_HALF_ANGLE) {
      continue;
    }

    const contact = pointOnCircle(arena.center, barrierAngle, barrierRadius);
    const normal = lengthSqVec(fromCenter) > 0
      ? normalizeVec(fromCenter)
      : normalizeVecInPlace(subVec(contact, arena.center));
    const movingAcross = previousBall ? distanceVec(previousBall, state.ball) > 0 : false;
    if (dotVec(state.velocity, normal) > 0 && !movingAcross) {
      continue;
    }

    reflectBall(state, normal);
    state.ball.x = contact.x + normal.x * (BALL_RADIUS + barrierHalfThickness + 0.5);
    state.ball.y = contact.y + normal.y * (BALL_RADIUS + barrierHalfThickness + 0.5);
    events.push({ kind: "barrierHit" });
    return;
  }
}

function applyTriangleReactiveImpulse(state: SimState, arena: ArenaGeometry, contact: Vec2): void {
  if (state.triangleMotionMode !== "reactive") {
    return;
  }

  const lever = subVec(contact, arena.center);
  const incoming = state.velocity;
  const tangentPush = lever.x * incoming.y - lever.y * incoming.x;
  const speedFactor = clamp(lengthVec(incoming) / MAX_BALL_SPEED, 0.28, 1.6);
  const direction = Math.sign(tangentPush) || Math.sign(state.triangleAngularVelocity) || 1;
  const impulse = direction * clamp(Math.abs(tangentPush) / Math.max(arena.triangleRadius * MAX_BALL_SPEED, 1), 0.3, 1.6) * speedFactor * 3.4;
  state.triangleAngularVelocity = clamp(
    state.triangleAngularVelocity + impulse,
    -TRIANGLE_REACTIVE_MAX_SPEED,
    TRIANGLE_REACTIVE_MAX_SPEED
  );
}

function handlePaddleCollisions(state: SimState, arena: ArenaGeometry, events: SimEvent[], catchHeld: boolean, previousBall?: Vec2): void {
  for (const player of activePlayers(state.players)) {
    const hit = paddleHitTest(state, arena, player, previousBall);
    if (!hit) {
      continue;
    }

    if (dotVec(state.velocity, hit.normal) >= 0 && !hit.crossed && hit.penetration <= 0) {
      continue;
    }

    const tangent = { x: -hit.radial.y, y: hit.radial.x };
    const roundedNormal = normalizeVecInPlace({
      x: hit.normal.x + tangent.x * (hit.offset * PADDLE_CURVE_RESPONSE),
      y: hit.normal.y + tangent.y * (hit.offset * PADDLE_CURVE_RESPONSE)
    });
    const repeatHit = state.lastTouchType === "player" && state.lastTouchPlayerId === player.id;

    addCharge(player);
    // Burst direction must come from the pre-reflection velocity, so capture it now.
    const tangentDrift = dotVec(state.velocity, tangent);
    const hitEvent: SimEvent = {
      kind: "paddleHit",
      playerId: player.id,
      contact: cloneVec(hit.contact),
      radial: cloneVec(hit.radial),
      tangent: cloneVec(tangent),
      tangentSign: tangentDrift === 0 ? 1 : -Math.sign(tangentDrift),
      repeatHit,
      caught: false
    };
    events.push(hitEvent);

    if (canCatchBall(player, catchHeld)) {
      hitEvent.caught = true;
      startCatch(state, arena, player, events);
      return;
    }

    // Reflect when the ball is heading into the paddle face, when it tunnelled
    // across it this substep, OR whenever it is travelling outward toward the
    // goal — a keeper paddle must turn back anything moving past it, even a
    // glancing/tangential touch that would otherwise slip through the edges.
    if (dotVec(state.velocity, roundedNormal) < 0 || hit.crossed || dotVec(state.velocity, hit.radial) > 0) {
      reflectBall(state, roundedNormal);
    }

    if (repeatHit) {
      boostBallSpeed(state, REPEAT_HIT_BOOST);
    }
    state.lastTouchType = "player";
    state.lastTouchPlayerId = player.id;
    // Always settle the ball on the centre-facing side of the paddle. If the
    // curve-adjusted normal points outward (a wing/edge contact), push along the
    // inward radial instead so the ball can never be nudged into the goal.
    const releaseNormal = dotVec(roundedNormal, hit.radial) > 0
      ? { x: -hit.radial.x, y: -hit.radial.y }
      : roundedNormal;
    state.ball.x = hit.contact.x + releaseNormal.x * (BALL_RADIUS + PADDLE_RELEASE_GAP);
    state.ball.y = hit.contact.y + releaseNormal.y * (BALL_RADIUS + PADDLE_RELEASE_GAP);
    return;
  }
}

function paddleHitTest(state: SimState, arena: ArenaGeometry, player: SimPlayer, previousBall?: Vec2): PaddleCollisionHit | undefined {
  const center = paddleCenter(arena, player);
  const radial = normalizeVecInPlace(subVec(center, arena.center));
  const tangent = { x: -radial.y, y: radial.x };
  const segments = paddleCollisionSegments(arena, player);
  let best:
    | {
      contact: Vec2;
      distance: number;
      offset: number;
    }
    | undefined;

  for (const segment of segments) {
    const contact = closestPointOnSegment(state.ball, segment.start, segment.end);
    const distance = distanceVec(contact, state.ball);
    if (!best || distance < best.distance) {
      best = { contact, distance, offset: segment.offset };
    }
  }

  if (best && best.distance <= BALL_RADIUS) {
    const normal = paddleHitNormal(arena, best.contact, best.offset, center, tangent, radial);
    const separation = subVec(state.ball, best.contact);
    return {
      contact: best.contact,
      normal: lengthSqVec(separation) > 0.0001 ? normalizeVecInPlace(separation) : normal,
      radial,
      offset: best.offset,
      penetration: BALL_RADIUS - best.distance,
      crossed: false
    };
  }

  if (!previousBall) {
    return undefined;
  }

  return paddleSweptHitTest(state, previousBall, arena, center, radial, tangent, segments);
}

function paddleSweptHitTest(
  state: SimState,
  previousBall: Vec2,
  arena: ArenaGeometry,
  center: Vec2,
  radial: Vec2,
  tangent: Vec2,
  segments: PaddleSegment[]
): PaddleCollisionHit | undefined {
  const travel = subVec(state.ball, previousBall);
  if (lengthSqVec(travel) === 0) {
    return undefined;
  }

  let best:
    | {
      contact: Vec2;
      distance: number;
      offset: number;
    }
    | undefined;

  for (const segment of segments) {
    const closest = closestPointsBetweenSegments(previousBall, state.ball, segment.start, segment.end);
    if (closest.distance > BALL_RADIUS) {
      continue;
    }

    if (!best || closest.distance < best.distance) {
      best = {
        contact: closest.b,
        distance: closest.distance,
        offset: segment.offset
      };
    }
  }

  if (!best) {
    return undefined;
  }

  const separation = subVec(state.ball, best.contact);
  const normal = paddleHitNormal(arena, best.contact, best.offset, center, tangent, radial);

  return {
    contact: best.contact,
    normal: lengthSqVec(separation) > 0.0001 ? normalizeVecInPlace(separation) : normal,
    radial,
    offset: best.offset,
    penetration: BALL_RADIUS - best.distance,
    crossed: true
  };
}

function paddleHitNormal(
  arena: ArenaGeometry,
  contact: Vec2,
  offset: number,
  center: Vec2,
  tangent: Vec2,
  radial: Vec2
): Vec2 {
  const halfHeight = paddleHalfHeight(arena);
  const concaveHalfWidth = paddleConcaveHalfWidth(arena);
  const local = subVec(contact, center);
  const localY = dotVec(local, radial);

  if (localY > halfHeight * 0.5) {
    return cloneVec(radial);
  }

  const slope = paddleInnerSlope(clamp(offset, -1, 1), concaveHalfWidth, halfHeight);
  return normalizeVecInPlace({
    x: tangent.x * slope - radial.x,
    y: tangent.y * slope - radial.y
  });
}

function handleGoals(state: SimState, arena: ArenaGeometry, events: SimEvent[], rng: Rng): void {
  if (state.roundResolving) {
    return;
  }

  const fromCenter = subVec(state.ball, arena.center);

  if (lengthVec(fromCenter) <= arena.radius + BALL_RADIUS || state.elapsed - state.lastScoreAt < 350) {
    return;
  }

  state.roundResolving = true;
  clearTouchState(state);
  clearCatchState(state);

  const scorer = playerForAngle(state.players, normalizeAngle(Math.atan2(fromCenter.y, fromCenter.x)));
  if (!scorer) {
    resetRoundInternal(state, arena, rng, events);
    return;
  }

  state.lastScoreAt = state.elapsed;
  scorer.shields -= 1;
  scorer.eliminated = scorer.shields <= 0;

  if (scorer.eliminated) {
    rebuildArcs(arena, state.players);
  }

  events.push({ kind: "goal", scorerId: scorer.id, shieldsRemaining: scorer.shields, eliminated: scorer.eliminated });

  const remaining = activePlayers(state.players);
  if (remaining.length <= 1) {
    state.mode = "matchOver";
    events.push({ kind: "matchOver", winnerId: remaining[0]?.id });
  }
  // remaining > 1: the caller owns scheduling — it sees the "goal" event with
  // state.mode still "playing" and schedules the delayed re-serve itself
  // (the scene uses Phaser's clock; a server will use its tick loop).
}
