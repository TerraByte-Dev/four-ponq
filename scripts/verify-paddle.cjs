/*
 * Headless paddle-collision regression test (no Phaser, no ws).
 * Runs the pure sim from dist-server/ — so it tests the EXACT code the
 * authoritative server ships. Build first:  npm run build:server
 * Then:  node scripts/verify-paddle.cjs
 *
 * Guards the three live-feedback symptoms ("paddle physics aren't physicing"):
 *   1. a face-on shot reflects inward and never tunnels through the paddle,
 *   2. a shot aimed BESIDE the paddle (but inside the arc) scores instead of
 *      bouncing off empty space in front of the paddle, and
 *   3. the grab/"super" is reachable at the new MAX_CHARGE.
 */
const { createSimState, advanceBall } = require("../dist-server/src/sim/physics.js");
const { computeArena, rebuildArcs } = require("../dist-server/src/sim/geometry.js");
const { MAX_CHARGE, MAX_SHIELDS, BASE_BALL_SPEED, PADDLE_MIN_INWARD } = require("../dist-server/src/sim/constants.js");

const arena = computeArena(960, 640);
const DT = 1 / 60;

function buildPlayers() {
  const players = [];
  for (let i = 0; i < 4; i += 1) {
    players.push({
      id: i + 1,
      shields: MAX_SHIELDS,
      eliminated: false,
      paddleAngle: 0,
      arcStart: 0,
      arcEnd: 0,
      humanControlled: false,
      lastHumanInputAt: 0,
      charge: 0,
      paddleAssistMultiplier: 1
    });
  }
  rebuildArcs(arena, players);
  return players;
}

/**
 * Fire the ball from arena center toward `angle`, then step advanceBall (the
 * server's moving-phase integrator) until `stopOn(batch)` fires (the decisive
 * moment) or maxFrames elapse. Returns events + the velocity captured AT THE
 * STOP FRAME — so we assert the immediate outcome of the shot, not where the
 * ball drifts after seconds of bouncing off static (non-tracking) paddles.
 */
function fireShot({ angle, charge = 0, humanControlled = false, catchHeld = false, stopOn, maxFrames = 70 }) {
  const players = buildPlayers();
  const target = players[0]; // paddle 0 sits at screen-top (-PI/2)
  target.humanControlled = humanControlled;
  target.charge = charge;

  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const state = createSimState({
    players,
    ball: { x: arena.center.x, y: arena.center.y },
    velocity: { x: dir.x * BASE_BALL_SPEED, y: dir.y * BASE_BALL_SPEED }
  });
  state.mode = "playing";
  state.elapsed = 0;
  state.lastScoreAt = -10000;          // clear the 350ms post-goal cooldown
  state.triangleCollisionDisabledUntil = 1e9; // isolate: no center-triangle interference
  state.roundReadyAt = 0;
  state.roundResolving = false;
  state.botFill = false;

  const events = [];
  for (let frame = 0; frame < maxFrames; frame += 1) {
    const batch = advanceBall(state, arena, DT, catchHeld, () => 0.5);
    for (const ev of batch) events.push(ev);
    state.elapsed += DT * 1000;
    if (stopOn && stopOn(batch)) break;
  }
  return { events, velocity: state.velocity, faceDir: dir };
}

const hitP1 = (b) => b.some((e) => e.kind === "paddleHit" && e.playerId === 1);
const goalAny = (b) => b.some((e) => e.kind === "goal");
const caught = (b) => b.some((e) => e.kind === "catchStart");

const paddleHitEvent = (events) => events.find((e) => e.kind === "paddleHit" && e.playerId === 1);
const unitDot = (v, n) => {
  const sp = Math.hypot(v.x, v.y) || 1;
  return (v.x * n.x + v.y * n.y) / sp;
};
// How strongly the exit heads back toward centre (1 = straight in, 0 = parallel).
const inwardComponent = (v, radial) => -unitDot(v, radial);
// Sideways steer of the exit (sign = which way along the face).
const tangentComponent = (v, tangent) => unitDot(v, tangent);

let failures = 0;
function check(name, ok, detail) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`  [${tag}] ${name}${detail ? "  — " + detail : ""}`);
}

const paddleAngle = buildPlayers()[0].paddleAngle;
console.log(`four-ponq paddle physics — arena r=${arena.radius.toFixed(0)}, paddleAngle=${paddleAngle.toFixed(3)}, MAX_CHARGE=${MAX_CHARGE}\n`);

// --- Test 1: face-on shot reflects inward, no tunnel, no self-goal ----------
{
  const { events, velocity, faceDir } = fireShot({ angle: paddleAngle, stopOn: (b) => hitP1(b) || goalAny(b) });
  const hitEver = events.some((e) => e.kind === "paddleHit" && e.playerId === 1);
  const selfGoal = events.some((e) => e.kind === "goal" && e.scorerId === 1);
  const movingInward = velocity.x * faceDir.x + velocity.y * faceDir.y < 0;
  console.log("Test 1 — face-on shot at paddle center");
  check("hits the paddle face", hitEver);
  check("turns the ball inward instead of tunnelling through", movingInward && !selfGoal);
}

// --- Test 2: shot beside the paddle (inside arc) scores, no empty bounce ----
{
  const { events } = fireShot({ angle: paddleAngle + 0.6, stopOn: (b) => goalAny(b) || hitP1(b) }); // paddle half-width ~0.23 rad, arc half ~0.79
  const hit = events.some((e) => e.kind === "paddleHit" && e.playerId === 1);
  const scored = events.some((e) => e.kind === "goal" && e.scorerId === 1);
  console.log("\nTest 2 — shot aimed 0.6 rad beside the paddle (undefended arc)");
  check("does NOT bounce off empty space (no paddle hit)", !hit);
  check("scores in the undefended part of the arc (positioning still matters)", scored);
}

// --- Test 3: off-center but in-pocket shot still reflects -------------------
{
  const { events, velocity, faceDir } = fireShot({ angle: paddleAngle + 0.12, stopOn: (b) => hitP1(b) || goalAny(b) }); // inside concave half ~0.16 rad
  const hit = events.some((e) => e.kind === "paddleHit" && e.playerId === 1);
  const selfGoal = events.some((e) => e.kind === "goal" && e.scorerId === 1);
  const movingInward = velocity.x * faceDir.x + velocity.y * faceDir.y < 0;
  console.log("\nTest 3 — off-center shot still inside the pocket");
  check("hits the paddle face and reflects inward", hit && movingInward && !selfGoal);
}

// --- Test 4: the grab/super is reachable at MAX_CHARGE, gated below it ------
// NOTE: addCharge() runs BEFORE the catch check, so a hit at charge C grabs
// when C+1 >= MAX_CHARGE — i.e. the effective "ready" charge entering a hit is
// MAX_CHARGE-1. Below that it must reflect, not grab.
{
  const ready = fireShot({ angle: paddleAngle, charge: MAX_CHARGE - 1, humanControlled: true, catchHeld: true, stopOn: (b) => caught(b) || hitP1(b) });
  const grabbed = ready.events.some((e) => e.kind === "catchStart" && e.playerId === 1);
  console.log("\nTest 4 — grab/super availability");
  check(`grabs the ball when ready (charge=${MAX_CHARGE - 1}+1 hit, Space held)`, grabbed);

  const notReady = fireShot({ angle: paddleAngle, charge: MAX_CHARGE - 2, humanControlled: true, catchHeld: true, stopOn: (b) => caught(b) || hitP1(b) });
  const grabbedEarly = notReady.events.some((e) => e.kind === "catchStart" && e.playerId === 1);
  const reflectedEarly = notReady.events.some((e) => e.kind === "paddleHit" && e.playerId === 1 && !e.caught);
  check(`does NOT grab below the threshold (charge=${MAX_CHARGE - 2})`, !grabbedEarly && reflectedEarly);
}

// --- Test 5: every clean paddle hit exits meaningfully inward (no graze) -----
// The new contact-point exit model guarantees a minimum inward component, so a
// clean hit can never skim parallel to the goal and self-score "off some BS".
{
  console.log("\nTest 5 — inward floor across the pocket (no parallel graze)");
  let worst = Infinity;
  let allHit = true;
  for (const d of [-0.14, -0.07, 0, 0.07, 0.14]) {
    const { events, velocity } = fireShot({ angle: paddleAngle + d, stopOn: (b) => hitP1(b) || goalAny(b) });
    const ev = paddleHitEvent(events);
    if (!ev) { allHit = false; continue; }
    worst = Math.min(worst, inwardComponent(velocity, ev.radial));
  }
  check("all five in-pocket shots hit the paddle", allHit);
  check(`exit inward component >= PADDLE_MIN_INWARD (${PADDLE_MIN_INWARD})`, worst >= PADDLE_MIN_INWARD - 1e-6, `worst=${worst.toFixed(3)}`);
}

// --- Test 6: contact point steers the exit predictably (classic paddle feel) -
{
  console.log("\nTest 6 — contact-point steering is monotonic + sign-correct");
  const sample = (d) => {
    const { events, velocity } = fireShot({ angle: paddleAngle + d, stopOn: (b) => hitP1(b) || goalAny(b) });
    const ev = paddleHitEvent(events);
    return ev ? tangentComponent(velocity, ev.tangent) : null;
  };
  const left = sample(-0.14);
  const mid = sample(0);
  const right = sample(0.14);
  check("centre hit goes nearly straight in (little steer)", mid !== null && Math.abs(mid) < 0.2, `mid=${mid?.toFixed(3)}`);
  check("opposite offsets steer opposite ways", left !== null && right !== null && Math.sign(left) === -Math.sign(right) && left !== 0);
  check("more offset → more steer", left !== null && right !== null && Math.abs(right) > Math.abs(mid) && Math.abs(left) > Math.abs(mid));
}

// --- Test 7: the exit model is deterministic (no RNG / clock creep) ----------
{
  console.log("\nTest 7 — deterministic exit (server/headless parity)");
  const a = fireShot({ angle: paddleAngle + 0.1, stopOn: (b) => hitP1(b) || goalAny(b) });
  const b = fireShot({ angle: paddleAngle + 0.1, stopOn: (b) => hitP1(b) || goalAny(b) });
  check("same shot twice → identical exit velocity", a.velocity.x === b.velocity.x && a.velocity.y === b.velocity.y);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
