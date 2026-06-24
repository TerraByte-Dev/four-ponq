/*
 * Headless reactive-triangle regression test (no Phaser, no ws).
 * Runs the pure sim from dist-server/ — the EXACT code the authoritative server
 * ships. Build first:  npm run build:server
 * Then:  node scripts/verify-triangle.cjs
 *
 * Guards the live-feedback fix "the reactive triangle should swivel based on
 * where/how fast the ball hits it" — which only became visible once the snapshot
 * started carrying triangleRotation. The wire just transports the value; these
 * tests assert the SIM invariants that value depends on:
 *   1. a ball impact actually torques the triangle's spin (the reaction fires),
 *   2. the rotation the snapshot reads is live + finite, and
 *   3. the spin can never advance more than PI between two snapshots — so the
 *      client's wrap-safe lerpAngle interpolation can never spin it backwards.
 */
const { createSimState, advanceBall, stepTriangleMotion, applyTriangleGravity } = require("../dist-server/src/sim/physics.js");
const { computeArena, rebuildArcs } = require("../dist-server/src/sim/geometry.js");
const {
  MAX_SHIELDS,
  MAX_BALL_SPEED,
  BASE_BALL_SPEED,
  TRIANGLE_ROTATION_SPEED,
  TRIANGLE_REACTIVE_MAX_SPEED
} = require("../dist-server/src/sim/constants.js");
const { SIM_HZ, SNAP_HZ } = require("../dist-server/shared/protocol.js");

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

let failures = 0;
function check(name, ok, detail) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`  [${tag}] ${name}${detail ? "  — " + detail : ""}`);
}

console.log(`four-ponq reactive triangle — arena r=${arena.radius.toFixed(0)}, triR=${arena.triangleRadius.toFixed(0)}, maxSpin=${TRIANGLE_REACTIVE_MAX_SPEED}\n`);

// --- Tests 1 & 2: impacts torque the spin; the pose is live + finite ---------
{
  const players = buildPlayers();
  // Start the ball just left of the triangle, offset in Y so the impact has a
  // lever arm (a dead-centre hit produces zero torque by design).
  const r = arena.triangleRadius;
  const state = createSimState({
    players,
    ball: { x: arena.center.x - (r + 26), y: arena.center.y + 16 },
    velocity: { x: BASE_BALL_SPEED, y: 0 }
  });
  state.mode = "playing";
  state.elapsed = 0;
  state.lastScoreAt = -10000;
  state.triangleCollisionDisabledUntil = -1; // triangle collisions ACTIVE
  state.roundReadyAt = 0;
  state.roundResolving = false;
  state.botFill = false;
  state.triangleMotionMode = "reactive";

  const rotStart = state.triangleRotation;
  let triangleHits = 0;
  let maxAbsSpin = Math.abs(state.triangleAngularVelocity);
  let rotationFinite = true;

  // Mirror the server tick order: spin → gravity → integrate.
  for (let frame = 0; frame < 500; frame += 1) {
    stepTriangleMotion(state, DT);
    applyTriangleGravity(state, arena, DT, 275, MAX_BALL_SPEED);
    const batch = advanceBall(state, arena, DT, false, () => 0.5);
    state.elapsed += DT * 1000;
    for (const ev of batch) if (ev.kind === "triangleHit") triangleHits += 1;
    maxAbsSpin = Math.max(maxAbsSpin, Math.abs(state.triangleAngularVelocity));
    if (!Number.isFinite(state.triangleRotation) || !Number.isFinite(state.triangleAngularVelocity)) {
      rotationFinite = false;
    }
    if (state.roundResolving || state.mode !== "playing") {
      // a goal slipped through — re-arm so the ball keeps engaging the triangle
      state.mode = "playing";
      state.roundResolving = false;
      state.ball.x = arena.center.x - (r + 26);
      state.ball.y = arena.center.y + 16;
      state.velocity.x = BASE_BALL_SPEED;
      state.velocity.y = 0;
    }
  }

  console.log("Test 1 — a ball impact torques the reactive spin");
  check("the ball actually struck the triangle", triangleHits > 0, `${triangleHits} hits`);
  check(
    `spin kicked well past the steady baseline (${TRIANGLE_ROTATION_SPEED})`,
    maxAbsSpin > TRIANGLE_ROTATION_SPEED + 0.25,
    `maxSpin=${maxAbsSpin.toFixed(2)}`
  );

  console.log("\nTest 2 — the snapshotted pose stays live + finite");
  check("triangleRotation/AngularVelocity stay finite", rotationFinite);
  check("the rotation actually advanced", Math.abs(state.triangleRotation - rotStart) > 1e-3);
}

// --- Test 3: wire-interp safety — spin can't cross PI between snapshots -------
{
  console.log("\nWire interp — per-snapshot rotation delta is wrap-safe");
  const ticksPerSnap = Math.max(1, Math.round(SIM_HZ / SNAP_HZ));
  const worstDelta = TRIANGLE_REACTIVE_MAX_SPEED * (ticksPerSnap / SIM_HZ);
  check(
    "max |Δrotation| between snaps < PI (lerpAngle never reverses)",
    worstDelta < Math.PI,
    `worst=${worstDelta.toFixed(3)} rad over ${ticksPerSnap} ticks`
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
