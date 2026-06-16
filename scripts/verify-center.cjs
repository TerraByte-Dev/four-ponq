/*
 * Headless "Hollow Trinity" centre-shape regression test (no Phaser, no ws).
 * Runs the pure sim from dist-server/ — the EXACT code the authoritative server
 * ships. Build first:  npm run build:server
 * Then:  node scripts/verify-center.cjs
 *
 * Guards the new host-selectable hollow centre shape (feedback: "3 spaced
 * segments forming a hollow centre with clean openings, but a chance the ball
 * bounces multiple times inside before popping out"):
 *   1. GEOMETRY — every corner gap is >= the ball diameter at every arena size,
 *      so the ball can always escape (no permanent trap by construction).
 *   2. RATTLE — a ball fired into the chamber bounces off the walls (>= 2 hits in
 *      at least one direction), i.e. the multi-bounce "rattle" actually happens.
 *   3. NO TRAP — from every direction the ball escapes the chamber within a bound
 *      (the in-chamber gravity cutoff means the well can't pin it at dead-centre).
 */
const { createSimState, advanceBall, stepTriangleMotion, applyTriangleGravity } = require("../dist-server/src/sim/physics.js");
const { computeArena, rebuildArcs, centerArcs, centerChamberRadius } = require("../dist-server/src/sim/geometry.js");
const { MAX_SHIELDS, BALL_RADIUS, BASE_BALL_SPEED, MAX_BALL_SPEED, TRINITY_SEGMENT_HALF_THICKNESS } = require("../dist-server/src/sim/constants.js");

// The design ask: each gap should clear ~2 balls. The clear tangential opening
// between two arc-end caps (radius HALF_THICKNESS) is the chord between the
// endpoints minus 2*HALF_THICKNESS; require it to fit 2 ball diameters.
const REQUIRED_CLEAR = 4 * BALL_RADIUS;

const DT = 1 / 60;

function buildPlayers(arena) {
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

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Clear opening of the tightest gap: the chord between adjacent arc endpoints on
// the ring, minus the two end-cap radii (HALF_THICKNESS each).
function minGapClear(arena) {
  const R = centerChamberRadius(arena);
  const c = arena.center;
  const onRing = (a) => ({ x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R });
  const arcs = centerArcs(arena, -Math.PI / 2);
  let min = Infinity;
  for (let i = 0; i < arcs.length; i += 1) {
    const next = arcs[(i + 1) % arcs.length];
    const chord = dist(onRing(arcs[i].a1), onRing(next.a0));
    min = Math.min(min, chord - 2 * TRINITY_SEGMENT_HALF_THICKNESS);
  }
  return min;
}

console.log("four-ponq Hollow Trinity centre shape\n");

// --- Test 1: each gap clears ~2 balls at every arena size --------------------
{
  console.log(`Test 1 — every gap clears 2 ball diameters (>= ${REQUIRED_CLEAR}) at every arena size`);
  const viewports = [[320, 480], [960, 640], [1600, 1000]];
  let worst = Infinity;
  for (const [w, h] of viewports) {
    const arena = computeArena(w, h);
    const clear = minGapClear(arena);
    worst = Math.min(worst, clear);
    check(
      `${w}x${h} (r=${arena.radius.toFixed(0)}, ring=${centerChamberRadius(arena).toFixed(0)}): gap clear ${clear.toFixed(1)} >= ${REQUIRED_CLEAR}`,
      clear >= REQUIRED_CLEAR - 1e-6
    );
  }
  check(`tightest gap across all sizes fits 2 balls`, worst >= REQUIRED_CLEAR - 1e-6, `worst=${worst.toFixed(1)}`);
}

// --- Tests 2 & 3: the ball rattles inside, and always escapes (no trap) ------
// Dead-centre launches in every direction are the WORST case for trapping (they
// maximise the chance of a symmetric periodic billiard orbit). The asymmetric wall
// tilt must let the ball out of all of them, in both spin modes. Real play enters
// from outside through a gap and escapes much faster, so this is a strict bound.
{
  const arena = computeArena(960, 640);
  const chamber = centerChamberRadius(arena);
  const escapeRadius = chamber + BALL_RADIUS;
  const BUDGET = 480; // frames (~8s) — generous worst-case ceiling for the rattle

  function run(angle, motion) {
    const players = buildPlayers(arena);
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const state = createSimState({
      players,
      ball: { x: arena.center.x, y: arena.center.y },
      velocity: { x: dir.x * BASE_BALL_SPEED, y: dir.y * BASE_BALL_SPEED }
    });
    state.mode = "playing";
    state.elapsed = 0;
    state.lastScoreAt = -10000;
    state.centerShape = "trinity";
    state.triangleMotionMode = motion;
    state.triangleCollisionDisabledUntil = -1; // centre collisions ACTIVE from frame 0
    state.roundReadyAt = 0;
    state.roundResolving = false;
    state.botFill = false;

    let hits = 0;
    let escaped = false;
    let frames = 0;
    for (frames = 0; frames < BUDGET; frames += 1) {
      stepTriangleMotion(state, DT);
      applyTriangleGravity(state, arena, DT, 275, MAX_BALL_SPEED);
      const batch = advanceBall(state, arena, DT, false, () => 0.5);
      for (const ev of batch) if (ev.kind === "triangleHit") hits += 1;
      state.elapsed += DT * 1000;
      if (dist(state.ball, arena.center) > escapeRadius) { escaped = true; break; }
      // A goal can't fire before the ball leaves the chamber (escape is detected
      // first), but re-arm defensively so a stray resolve never wedges the loop.
      if (state.roundResolving || state.mode !== "playing") {
        state.mode = "playing";
        state.roundResolving = false;
      }
    }
    return { hits, escaped, frames };
  }

  const DIRECTIONS = 24;
  let maxHits = 0;
  console.log("\nTest 2 — the ball rattles inside the hollow chamber");
  console.log("\nTest 3 — the ball always escapes (no trap), both spin modes");
  for (const motion of ["steady", "reactive"]) {
    const runs = [];
    for (let i = 0; i < DIRECTIONS; i += 1) runs.push(run((i / DIRECTIONS) * Math.PI * 2, motion));
    maxHits = Math.max(maxHits, ...runs.map((r) => r.hits));
    const allEscaped = runs.every((r) => r.escaped);
    const slowest = Math.max(...runs.map((r) => r.frames));
    check(`[${motion}] every one of ${DIRECTIONS} directions escapes within ${BUDGET} frames`, allEscaped, `slowestEscape=${slowest} frames`);
  }
  check("at least one launch bounces >= 2 times before escaping (rattle is real)", maxHits >= 2, `maxHits=${maxHits}`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
