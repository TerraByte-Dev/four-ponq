/**
 * Four Ponq — authoritative single-room game server (Stage 2: session layer).
 *
 * ONE shared Room for v1: a single SimState built in the canonical net arena
 * (computeArena(960, 640)) so snap.ball.{x,y} land in the fixed coordinate frame
 * the client (src/net/client.ts → NET_ARENA_WIDTH/HEIGHT) remaps from. Paddle
 * angles are frame-independent and stream straight through.
 *
 * The per-tick simulation sequence is a 1:1 port of the OFFLINE update() path in
 * src/main.ts (mode === "playing"): stepTriangleMotion → updateArenaRotation →
 * paddles → caught-ball/spawn-beat/gravity+advanceBall, with the same goal/
 * matchOver handling (a ~420ms re-serve scheduled on a "goal" event, mode set to
 * "matchOver" by the sim itself). The ONLY difference vs. offline is that the
 * server drives up to 4 INDEPENDENT human paddles (offline has exactly one), so
 * paddle movement is stepped per-slot here instead of via stepPaddles(), using
 * the identical movement/assist/clamp math.
 *
 * Pure sim modules (src/sim/*) are imported verbatim; no Phaser, no DOM.
 *
 * SESSION LAYER (Stage 2) — see shared/protocol.ts for the full flow. The Room
 * tracks its own RoomMode ("lobby" | "countdown" | "playing" | "matchOver")
 * ALONGSIDE the sim's GameMode: the sim only knows "menu"/"playing"/"matchOver";
 * the ready screens and the 3-2-1 countdown are session-level states that the
 * sim never sees. Connecting mid-match makes you a spectator (slot -1, still
 * broadcast to); {t:"join"} seats you now (ready screen) or at the next serve
 * (live match, FIFO queue, replacing a bot); matches start only when every
 * seated human is ready, via a 3-2-1 countdown that any un-ready/disconnect
 * cancels.
 */

import {
  COUNTDOWN_SECONDS,
  SIM_HZ,
  SNAP_HZ,
  MAX_PLAYERS,
  type PlayerView,
  type PresenceInfo,
  type RoomMode,
  type ServerMsg
} from "../shared/protocol";
import type {
  ArenaGeometry,
  BotDifficulty,
  GameVariant,
  PlayerInput,
  SimEvent,
  SimPlayer,
  SimState,
  TriangleMotionMode
} from "../src/sim/types";
import {
  BASE_PADDLE_SPEED,
  BOT_DIFFICULTY_SPEED,
  MAX_BALL_SPEED,
  MAX_SHIELDS,
  PADDLE_ASSIST_ACCELERATION,
  PADDLE_ASSIST_DECELERATION,
  PADDLE_MOVE_ASSIST
} from "../src/sim/constants";
import { TAU, clamp, distanceVec, lerp } from "../src/sim/math";
import {
  computeArena,
  clampPaddleToArc,
  paddleCenter,
  rebuildArcs
} from "../src/sim/geometry";
import { stepBotPaddle } from "../src/sim/bot";
import {
  advanceBall,
  applyTriangleGravity,
  createSimState,
  paddleSpeedMultiplier,
  resetRound,
  stepCaughtBall,
  stepTriangleMotion,
  updateArenaRotation,
  variantPaddleSpeedMultiplier
} from "../src/sim/physics";

/** Canonical server arena — MUST match the client's NET_ARENA_WIDTH/HEIGHT. */
export const NET_ARENA_WIDTH = 960;
export const NET_ARENA_HEIGHT = 640;

/** Fixed simulation timestep (seconds). */
const TICK_DT = 1 / SIM_HZ;
/** Broadcast a snapshot every Nth sim tick (60 / 30 = 2). */
const SNAP_EVERY = Math.max(1, Math.round(SIM_HZ / SNAP_HZ));
/** Delay before the ball re-serves after a goal — matches offline's delayedCall. */
const RESERVE_DELAY_MS = 420;

/** A client's sticky input, applied every tick until the next {t:"input"}. */
interface StickyInput {
  ccw: boolean;
  cw: boolean;
  charge: boolean;
}

/** One paddle slot (0..3): a connected human, or bot/idle. */
interface Slot {
  /** Connected human client id, or null when empty. */
  clientId: string | null;
  /** Display name (human's hello name, or a bot label). */
  name: string;
  /** Arcade-hub profile public id (for the doodle avatar); "" if none. */
  publicId: string;
  /** Latest sticky input from the human (ignored while empty). */
  input: StickyInput;
  /** sim-elapsed ms of the last human input (for parity with lastHumanInputAt). */
  lastHumanInputAt: number;
  /** Ready-screen flag (lobby/matchOver/countdown). Always false for bots. */
  ready: boolean;
}

/** What the WS layer needs to deliver a message to one connection. */
export interface Connection {
  clientId: string;
  send(msg: ServerMsg): void;
}

function freshInput(): StickyInput {
  return { ccw: false, cw: false, charge: false };
}

/**
 * The single authoritative room. The WS server (server/index.ts) owns the set
 * of live Connections and forwards lifecycle calls (connect/input/requestSeat/
 * ready/setBots/leave) here; the Room owns ALL game state and the tick loop.
 */
export class Room {
  private readonly arena: ArenaGeometry;
  private readonly sim: SimState;
  private readonly players: SimPlayer[];
  private readonly slots: Slot[];

  /** Live connections keyed by clientId (for broadcast). */
  private readonly conns = new Map<string, Connection>();

  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** sim.elapsed (ms) at which a pending post-goal re-serve fires; null = none. */
  private reserveAt: number | null = null;
  /** Paddle angle to aim the pending re-serve toward (the scorer's angle). */
  private reserveAngle: number | undefined = undefined;

  /**
   * Session-layer mode (protocol RoomMode). Runs ALONGSIDE sim.mode, which
   * stays a plain GameMode: "menu" while idling on a ready screen (so the sim
   * never simulates a lobby), "playing"/"matchOver" while a match runs.
   */
  private roomMode: RoomMode = "lobby";
  /** Which ready screen the running countdown started from (cancel target). */
  private countdownFrom: "lobby" | "matchOver" = "lobby";
  /** Seconds left in the countdown; only meaningful while mode "countdown". */
  private countdownLeft = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Spectators who asked to join mid-match (FIFO); seated at the next serve. */
  private readonly pendingJoins: string[] = [];
  /** hello names for ALL connections, so a spectator's name survives to seating. */
  private readonly helloNames = new Map<string, string>();
  /** hub profile public ids for ALL connections (parallel to helloNames). */
  private readonly helloProfiles = new Map<string, string>();

  constructor() {
    this.arena = computeArena(NET_ARENA_WIDTH, NET_ARENA_HEIGHT);

    // Build the 4 sim players exactly like main.ts createPlayer() does (ids 1..4,
    // full shields). humanControlled is toggled per-slot as humans join/leave so
    // the catch/charge mechanic (canCatchBall checks humanControlled) works for
    // any human slot, not just slot 0.
    this.players = [1, 2, 3, 4].map((id) => ({
      id,
      shields: MAX_SHIELDS,
      eliminated: false,
      paddleAngle: 0,
      arcStart: 0,
      arcEnd: TAU,
      humanControlled: false,
      lastHumanInputAt: -9999,
      charge: 0,
      paddleAssistMultiplier: 1
    }));

    this.slots = this.players.map((_, i) => ({
      clientId: null,
      name: `P${i + 1}`,
      publicId: "",
      input: freshInput(),
      lastHumanInputAt: -9999,
      ready: false
    }));

    this.sim = createSimState({
      players: this.players,
      ball: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 }
    });
    // botFill defaults true (createSimState sets it); keep the lobby idle until
    // a match starts. The sim idles in "menu"; the session mode is "lobby".
    this.sim.mode = "menu";
    rebuildArcs(this.arena, this.players);
    // Seed a still ball at center so early snaps are finite before the first
    // start (no menu attract loop on the server — it would burn CPU for nobody).
    this.sim.ball.x = this.arena.center.x;
    this.sim.ball.y = this.arena.center.y;
    this.sim.velocity.x = 0;
    this.sim.velocity.y = 0;
  }

  // --- connection lifecycle ------------------------------------------------

  /**
   * Register a connection ({t:"hello"}). On a ready screen (lobby/matchOver)
   * the client is seated immediately in the lowest free slot; while a match is
   * live (playing/countdown) — or when all 4 seats are taken — they become a
   * SPECTATOR (slot -1): they stay in `conns` so they receive every room/snap
   * broadcast, and can ask for a seat with {t:"join"}. Returns the slot.
   */
  connect(conn: Connection, name: string, publicId = ""): number {
    this.conns.set(conn.clientId, conn);
    this.helloNames.set(conn.clientId, sanitizeName(name));
    this.helloProfiles.set(conn.clientId, sanitizePublicId(publicId));

    let slot = -1;
    if (this.roomMode === "lobby" || this.roomMode === "matchOver") {
      slot = this.lowestFreeSlot();
      if (slot >= 0) {
        this.seat(conn.clientId, slot);
      }
    }

    conn.send({
      t: "welcome",
      clientId: conn.clientId,
      slot,
      snapHz: SNAP_HZ
    });
    conn.send(this.roomMsg());
    this.broadcastRoom();
    this.ensureLoop();
    return slot;
  }

  /** Put a connected client into a slot (shared by connect/join/next-serve). */
  private seat(clientId: string, slot: number): void {
    const s = this.slots[slot];
    s.clientId = clientId;
    s.name = this.helloNames.get(clientId) || `P${slot + 1}`;
    s.publicId = this.helloProfiles.get(clientId) || "";
    s.input = freshInput();
    s.ready = false;
    s.lastHumanInputAt = this.sim.elapsed;
    this.players[slot].humanControlled = true;
    this.players[slot].lastHumanInputAt = this.sim.elapsed;
  }

  /** Drop a connection; frees its seat (a bot takes over if botFill is on). */
  leave(clientId: string): void {
    this.conns.delete(clientId);
    this.helloNames.delete(clientId);
    this.helloProfiles.delete(clientId);
    const queued = this.pendingJoins.indexOf(clientId);
    if (queued >= 0) {
      this.pendingJoins.splice(queued, 1);
    }

    const slot = this.slots.findIndex((s) => s.clientId === clientId);
    if (slot >= 0) {
      const s = this.slots[slot];
      s.clientId = null;
      s.name = `P${slot + 1}`;
      s.publicId = "";
      s.input = freshInput();
      s.ready = false;
      this.players[slot].humanControlled = false;

      // A seated human vanishing mid-countdown cancels it. If everyone still
      // seated is ready, a FRESH 3-2-1 starts right away (no silent deadlock).
      if (this.roomMode === "countdown") {
        this.cancelCountdown();
        this.maybeStartCountdown();
      }
    }

    if (this.conns.size === 0) {
      this.resetToEmptyLobby();
    }
    this.broadcastRoom(); // no-op when the room just emptied
    this.maybeIdle();
  }

  /**
   * {t:"join"} — a spectator asks for a paddle ("Jump in?"). Ready screen:
   * seated on the spot ({t:"seated"}). Live match (playing/countdown): queued
   * FIFO and seated at the next serve boundary ({t:"joinPending"} now,
   * {t:"seated"} then). Room already full (4 humans seated or promised a
   * seat): {t:"error" roomFull}.
   */
  requestSeat(clientId: string): void {
    const conn = this.conns.get(clientId);
    if (!conn) {
      return;
    }
    if (this.slots.some((s) => s.clientId === clientId)) {
      conn.send({ t: "error", code: "notSpectator", message: "you already have a paddle" });
      return;
    }
    if (this.seatedHumans() + this.pendingJoins.length >= MAX_PLAYERS) {
      conn.send({ t: "error", code: "roomFull", message: "all four paddles are taken" });
      return;
    }

    if (this.roomMode === "lobby" || this.roomMode === "matchOver") {
      // The capacity check above guarantees a free slot here.
      const slot = this.lowestFreeSlot();
      this.seat(clientId, slot);
      conn.send({ t: "seated", slot });
      this.broadcastRoom();
      return;
    }

    // playing / countdown — defer to the next serve (the resetRound boundary).
    if (!this.pendingJoins.includes(clientId)) {
      this.pendingJoins.push(clientId);
    }
    conn.send({ t: "joinPending", reason: "nextServe" });
  }

  /**
   * Seat queued spectators (FIFO) into free slots, lowest slot first. Mid-match
   * the slot must also be alive — an eliminated bot's seat can't be played, so
   * those clients stay queued (the matchOver flush seats them). Each newly
   * seated client gets {t:"seated"}; broadcasting {room} is the caller's job.
   * Returns how many were seated.
   */
  private seatPendingJoins(): number {
    const requireAlive = this.roomMode === "playing";
    let seated = 0;
    while (this.pendingJoins.length > 0) {
      const slot = this.lowestFreeSlot(requireAlive);
      if (slot < 0) {
        break;
      }
      const clientId = this.pendingJoins.shift()!;
      const conn = this.conns.get(clientId);
      if (!conn) {
        continue; // disconnected while queued (leave() should have removed it)
      }
      this.seat(clientId, slot);
      conn.send({ t: "seated", slot });
      seated += 1;
    }
    return seated;
  }

  /**
   * Live rename. Updates the stored hello name (so it survives a later seating)
   * and, if the client is seated, the slot's display name, then rebroadcasts the
   * roster. An empty/blank name after sanitizing is ignored (keeps the current).
   */
  setName(clientId: string, name: string): void {
    if (!this.conns.has(clientId)) {
      return;
    }
    const clean = sanitizeName(name);
    if (!clean) {
      return;
    }
    this.helloNames.set(clientId, clean);
    const slot = this.slots.findIndex((s) => s.clientId === clientId);
    if (slot >= 0) {
      this.slots[slot].name = clean;
      this.broadcastRoom();
    }
  }

  /**
   * Record a connection's arcade-hub profile public id (the async /api/profile
   * resolved after hello). Relays it in {t:"room"} so every client can fetch +
   * render this player's doodle avatar. Empty ids are ignored (keeps current).
   */
  setProfile(clientId: string, publicId: string): void {
    if (!this.conns.has(clientId)) {
      return;
    }
    const clean = sanitizePublicId(publicId);
    if (!clean) {
      return;
    }
    this.helloProfiles.set(clientId, clean);
    const slot = this.slots.findIndex((s) => s.clientId === clientId);
    if (slot >= 0) {
      this.slots[slot].publicId = clean;
      this.broadcastRoom();
    }
  }

  /** Apply a human's sticky input to their slot. */
  setInput(clientId: string, ccw: boolean, cw: boolean, charge: boolean): void {
    const slot = this.slots.findIndex((s) => s.clientId === clientId);
    if (slot < 0) {
      return; // spectator or unknown — ignore
    }
    const s = this.slots[slot];
    s.input = { ccw: !!ccw, cw: !!cw, charge: !!charge };
    s.lastHumanInputAt = this.sim.elapsed;
  }

  // --- ready system / countdown ---------------------------------------------

  /**
   * {t:"ready",on} on a ready screen ({t:"start"} is the legacy ready(true)).
   * When EVERY seated human is ready (and there's at least one), the 3-2-1
   * countdown runs; any un-ready during it cancels back to the screen it
   * started from. Spectators and mid-match toggles are ignored — spectators
   * never gate readiness.
   */
  ready(clientId: string, on: boolean): void {
    const slot = this.slots.findIndex((s) => s.clientId === clientId);
    if (slot < 0 || this.roomMode === "playing") {
      return;
    }
    this.slots[slot].ready = !!on;
    if (!on) {
      this.cancelCountdown();
    }
    this.broadcastRoom();
    if (on) {
      this.maybeStartCountdown();
    }
  }

  /** Begin the 3-2-1 when ALL seated humans (>= 1) are ready on a ready screen. */
  private maybeStartCountdown(): void {
    if (this.roomMode !== "lobby" && this.roomMode !== "matchOver") {
      return;
    }
    const seated = this.slots.filter((s) => s.clientId !== null);
    if (seated.length === 0 || !seated.every((s) => s.ready)) {
      return;
    }
    this.countdownFrom = this.roomMode;
    this.roomMode = "countdown";
    this.countdownLeft = COUNTDOWN_SECONDS;
    this.broadcastRoom();
    this.broadcastEvent("countdownTick", { n: this.countdownLeft });
    this.countdownTimer = setInterval(() => this.stepCountdown(), 1000);
  }

  /** One 1s countdown beat: 3 → 2 → 1 → match start. */
  private stepCountdown(): void {
    this.countdownLeft -= 1;
    if (this.countdownLeft <= 0) {
      this.clearCountdownTimer();
      this.beginMatch();
      return;
    }
    this.broadcastRoom();
    this.broadcastEvent("countdownTick", { n: this.countdownLeft });
  }

  /** Stop a running countdown and fall back to the ready screen it came from. */
  private cancelCountdown(): void {
    if (this.roomMode !== "countdown") {
      return;
    }
    this.clearCountdownTimer();
    this.roomMode = this.countdownFrom;
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /**
   * Countdown finished — full reset to a fresh match, mirroring main.ts
   * restartMatch(). Match start IS a serve boundary, so spectators queued
   * during the countdown are seated before the opening serve.
   */
  private beginMatch(): void {
    for (const s of this.slots) {
      s.ready = false;
    }
    this.resetMatchState();
    this.sim.mode = "playing";
    this.roomMode = "playing";
    this.seatPendingJoins();
    // Serve immediately; resetRound() with mode "playing" bumps roundNumber and
    // emits a "serve" event we forward to clients.
    this.dispatch(resetRound(this.sim, this.arena, this.rng));
    this.broadcastRoom();
    this.ensureLoop();
  }

  /** Reset players + per-round sim fields to a fresh-match baseline. */
  private resetMatchState(): void {
    for (const p of this.players) {
      p.shields = MAX_SHIELDS;
      p.eliminated = false;
      p.lastHumanInputAt = -9999;
      p.charge = 0;
      p.paddleAssistMultiplier = 1;
    }
    this.sim.roundNumber = 0;
    this.sim.roundResolving = false;
    this.sim.lastTouchType = "none";
    this.sim.lastTouchPlayerId = undefined;
    this.sim.caughtByPlayerId = undefined;
    this.reserveAt = null;
    this.reserveAngle = undefined;
    rebuildArcs(this.arena, this.players);
  }

  /**
   * Everyone disconnected. Park the room as a fresh idle lobby so the next
   * visitor gets a clean ready screen instead of spectating an abandoned
   * bots-only match (and no timer burns CPU for nobody — Stage 1's idle
   * guarantee, now keyed on connections instead of seats).
   */
  private resetToEmptyLobby(): void {
    this.clearCountdownTimer();
    this.pendingJoins.length = 0;
    this.roomMode = "lobby";
    this.sim.mode = "menu";
    this.resetMatchState();
    this.sim.ball.x = this.arena.center.x;
    this.sim.ball.y = this.arena.center.y;
    this.sim.velocity.x = 0;
    this.sim.velocity.y = 0;
  }

  // --- host-controlled settings ---------------------------------------------

  /** Slot of the current host = lowest-slot connected human (-1 if none). Derived,
   *  never cached, so it auto-reassigns when the host leaves or a lower slot fills. */
  private hostSlot(): number {
    return this.slots.findIndex((s) => s.clientId !== null);
  }

  /** True when this client is the current host. */
  private isHost(clientId: string): boolean {
    const h = this.hostSlot();
    return h >= 0 && this.slots[h].clientId === clientId;
  }

  /** Accept a host-only setting change only on a ready screen (lobby/matchOver). */
  private canChangeSettings(clientId: string): boolean {
    return (this.roomMode === "lobby" || this.roomMode === "matchOver") && this.isHost(clientId);
  }

  /** Toggle bot-fill for empty slots; host-only + ready-screen-only. Echoes via {room}. */
  setBots(clientId: string, on: boolean): void {
    if (!this.canChangeSettings(clientId)) {
      return;
    }
    this.sim.botFill = !!on;
    this.broadcastRoom();
  }

  /**
   * Host changes a shared gameplay setting on the ready screen. Applied to the
   * authoritative sim immediately (beginMatch reads it live at the next start)
   * and echoed to every client via {room}. Non-hosts / mid-match are ignored.
   */
  setSetting(clientId: string, key: string, value: string): void {
    if (!this.canChangeSettings(clientId)) {
      return;
    }
    if (key === "difficulty" && (value === "easy" || value === "medium" || value === "hard")) {
      this.sim.botDifficulty = value;
    } else if (key === "gameVariant" && (value === "classic" || value === "rotating")) {
      this.sim.gameVariant = value;
    } else if (key === "triangleMotion" && (value === "steady" || value === "reactive")) {
      this.sim.triangleMotionMode = value;
    } else {
      return; // unknown key/value — ignore, don't broadcast
    }
    this.broadcastRoom();
  }

  /** Snapshot for GET /presence (the hub channel badge). Spectators are NOT
   *  counted as humans; bots only count while they're actually driving paddles
   *  in a live match. joinable = a seat is free now, or a bot seat exists that
   *  a newcomer could take at the next serve (i.e. not 4 humans/promises). */
  presence(): PresenceInfo {
    const humans = this.seatedHumans();
    return {
      id: "four-ponq",
      humans,
      bots:
        this.roomMode === "playing" && this.sim.botFill
          ? MAX_PLAYERS - humans
          : 0,
      mode: this.roomMode,
      joinable: humans + this.pendingJoins.length < MAX_PLAYERS
    };
  }

  // --- tick loop -----------------------------------------------------------

  /**
   * Start the fixed-step loop while a match is playing and ANYONE (seated
   * human or spectator) is connected — spectators need live snapshots, and a
   * bots-only match must keep advancing so queued joiners reach a serve.
   */
  private ensureLoop(): void {
    if (this.timer) {
      return;
    }
    if (this.conns.size === 0 || this.sim.mode !== "playing") {
      return;
    }
    this.timer = setInterval(() => this.step(), Math.round(1000 / SIM_HZ));
  }

  /** Stop the loop when nobody's connected (save CPU on the 2-core host). */
  private maybeIdle(): void {
    if (this.conns.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One authoritative sim tick. Mirrors main.ts update() (mode "playing") step
   * for step, then broadcasts a snapshot every SNAP_EVERY ticks.
   */
  private step(): void {
    const dt = TICK_DT;
    this.sim.elapsed += dt * 1000;

    // Triangle spin runs every tick regardless of mode (offline parity).
    stepTriangleMotion(this.sim, dt);

    if (this.sim.mode === "playing") {
      // Fire a pending post-goal re-serve once its delay elapses. This is THE
      // serve boundary: queued spectators take over bot slots just before it.
      if (this.reserveAt !== null && this.sim.elapsed >= this.reserveAt) {
        const angle = this.reserveAngle;
        this.reserveAt = null;
        this.reserveAngle = undefined;
        const seated = this.seatPendingJoins();
        this.dispatch(resetRound(this.sim, this.arena, this.rng, angle));
        if (seated > 0) {
          this.broadcastRoom();
        }
      }

      const input = this.aggregateCatch();
      updateArenaRotation(this.sim, this.arena, dt);
      this.stepAllPaddles(dt);

      if (this.sim.caughtByPlayerId !== undefined) {
        this.dispatch(stepCaughtBall(this.sim, this.arena, input.catchHeld));
      } else if (this.sim.elapsed < this.sim.roundReadyAt) {
        // Spawn-delay beat: ball holds before it starts moving.
      } else {
        applyTriangleGravity(this.sim, this.arena, dt, 275, MAX_BALL_SPEED);
        this.dispatch(
          advanceBall(this.sim, this.arena, dt, input.catchHeld, this.rng)
        );
      }
    }

    this.tick += 1;
    if (this.tick % SNAP_EVERY === 0) {
      this.broadcastSnap();
    }

    // If the match ended this tick, stop ticking until the next start (the loop
    // only runs while playing). Keep the room alive for the {room} broadcast.
    if (this.sim.mode !== "playing" && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Step every paddle for this tick. Humans move from their sticky input; empty
   * slots are bot-driven when botFill is on, else hold still. This is the exact
   * movement/assist/clamp math from physics.stepPaddles(), but applied PER SLOT
   * so all four humans move independently (offline only ever has one human).
   */
  private stepAllPaddles(dt: number): void {
    const speed =
      BASE_PADDLE_SPEED *
      paddleSpeedMultiplier(this.sim.roundNumber) *
      variantPaddleSpeedMultiplier(this.sim.gameVariant);
    const botSpeed = speed * BOT_DIFFICULTY_SPEED[this.sim.botDifficulty];

    this.players.forEach((player, slot) => {
      if (player.eliminated) {
        return;
      }
      const s = this.slots[slot];
      const human = s.clientId !== null;

      if (human) {
        const moving = s.input.ccw || s.input.cw;
        this.applyPaddleAssist(player, dt, moving);
        if (moving) {
          const direction = (s.input.cw ? 1 : 0) - (s.input.ccw ? 1 : 0);
          player.paddleAngle +=
            direction * speed * player.paddleAssistMultiplier * dt;
          player.lastHumanInputAt = this.sim.elapsed;
          clampPaddleToArc(this.arena, player);
        }
      } else if (this.sim.botFill) {
        player.paddleAngle = stepBotPaddle(
          player,
          this.sim.ball,
          this.arena,
          botSpeed,
          dt
        );
        clampPaddleToArc(this.arena, player);
      }
      // botFill off + empty slot → paddle holds still (no movement).
    });
  }

  /**
   * Verbatim port of physics.updatePaddleAssist() (not exported). Eases the
   * per-player assist multiplier toward 1 (idle) or 1+assist (moving, scaled by
   * how far the ball is) so server paddle feel matches offline exactly.
   */
  private applyPaddleAssist(player: SimPlayer, dt: number, moving: boolean): void {
    const distanceToPaddle = distanceVec(this.sim.ball, paddleCenter(this.arena, player));
    const closeDistance = this.arena.radius * 0.42;
    const farDistance = this.arena.radius;
    const farFactor = clamp(
      (distanceToPaddle - closeDistance) / Math.max(farDistance - closeDistance, 1),
      0,
      1
    );
    const target = moving ? 1 + PADDLE_MOVE_ASSIST * farFactor : 1;
    const rate =
      target > player.paddleAssistMultiplier
        ? PADDLE_ASSIST_ACCELERATION
        : PADDLE_ASSIST_DECELERATION;
    const smoothing = 1 - Math.exp(-rate * dt);
    player.paddleAssistMultiplier = lerp(player.paddleAssistMultiplier, target, smoothing);
  }

  /**
   * advanceBall/stepCaughtBall take a single catchHeld. With up to 4 humans we
   * pass true if ANY human slot is holding charge — the sim's canCatchBall still
   * gates on that player's humanControlled + full charge, so only an eligible
   * paddle actually catches. Returned as a PlayerInput for shape compatibility.
   */
  private aggregateCatch(): PlayerInput {
    let catchHeld = false;
    for (let i = 0; i < this.slots.length; i += 1) {
      if (this.slots[i].clientId !== null && this.slots[i].input.charge) {
        catchHeld = true;
        break;
      }
    }
    return { counterclockwise: false, clockwise: false, catchHeld };
  }

  // --- sim event → network -------------------------------------------------

  /**
   * Map SimEvents to client {t:"event"} sound/fx messages and own the post-goal
   * re-serve scheduling (offline used Phaser's delayedCall; we use sim.elapsed).
   * Mirrors main.ts applySimEvents()/handleNetEvent() event kinds.
   */
  private dispatch(events: SimEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "paddleHit":
          this.broadcastEvent("ballHit");
          break;
        case "triangleHit":
        case "barrierHit":
          // Cosmetic-only on the client; no sound event is emitted offline.
          break;
        case "goal": {
          this.broadcastEvent("goal", {
            scorerId: event.scorerId,
            shieldsRemaining: event.shieldsRemaining,
            eliminated: event.eliminated
          });
          if (event.eliminated) {
            this.broadcastEvent("eliminated", { playerId: event.scorerId });
          }
          // Schedule the delayed re-serve toward the scorer (offline: 420ms),
          // but only while the match is still playing (matchOver is terminal).
          if (this.sim.mode === "playing") {
            const scorer = this.players.find((p) => p.id === event.scorerId);
            this.reserveAngle = scorer ? scorer.paddleAngle : undefined;
            this.reserveAt = this.sim.elapsed + RESERVE_DELAY_MS;
          }
          break;
        }
        case "matchOver": {
          this.broadcastEvent("matchOver", { winnerId: event.winnerId });
          // Sim already set mode = "matchOver". Cancel any pending re-serve.
          this.reserveAt = null;
          this.reserveAngle = undefined;
          // Session layer: land everyone on the post-match ready screen. The
          // eliminated/shields state stays visible until the next countdown
          // ends (beginMatch rebuilds it); ready flags reset; spectators still
          // queued for "next serve" can be seated right now instead.
          this.roomMode = "matchOver";
          for (const s of this.slots) {
            s.ready = false;
          }
          this.seatPendingJoins();
          this.broadcastRoom();
          break;
        }
        case "serve":
          this.broadcastEvent("serve");
          break;
        // catchStart / catchLaunch have no dedicated offline sound; skip.
      }
    }
  }

  // --- snapshots / roster --------------------------------------------------

  private broadcastSnap(): void {
    const paddles: number[] = [];
    const charges: number[] = [];
    const shields: number[] = [];
    const eliminated: boolean[] = [];
    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      const p = this.players[i];
      paddles[i] = p.paddleAngle;
      charges[i] = p.charge;
      shields[i] = p.shields;
      eliminated[i] = p.eliminated;
    }

    const msg: ServerMsg = {
      t: "snap",
      tick: this.tick,
      ball: { x: this.sim.ball.x, y: this.sim.ball.y },
      paddles,
      charges,
      shields,
      eliminated,
      // The authoritative reactive-triangle pose the ball actually bounces off.
      triangleRotation: this.sim.triangleRotation
    };
    this.broadcast(msg);
  }

  private roomMsg(): ServerMsg {
    const players: PlayerView[] = this.slots.map((s, i) => ({
      slot: i,
      name: s.name,
      // A slot is a "bot" when it's empty AND bot-fill is on; an empty slot with
      // bot-fill off is just idle (still not a human, but not actively a bot).
      isBot: s.clientId === null && this.sim.botFill,
      connected: s.clientId !== null,
      // Ready is a ready-screen/countdown thing — always false for bots and
      // while a match is playing (protocol contract for PlayerView.ready).
      ready: s.clientId !== null && this.roomMode !== "playing" && s.ready,
      // Relay the human's hub profile id so clients can show their doodle avatar.
      publicId: s.clientId !== null ? s.publicId : ""
    }));
    const msg: Extract<ServerMsg, { t: "room" }> = {
      t: "room",
      players,
      mode: this.roomMode,
      botFill: this.sim.botFill,
      hostSlot: this.hostSlot(),
      difficulty: this.sim.botDifficulty,
      gameVariant: this.sim.gameVariant,
      triangleMotion: this.sim.triangleMotionMode
    };
    if (this.roomMode === "countdown") {
      msg.countdown = this.countdownLeft;
    }
    return msg;
  }

  private broadcastRoom(): void {
    this.broadcast(this.roomMsg());
  }

  private broadcastEvent(kind: string, data?: unknown): void {
    this.broadcast({ t: "event", kind, data });
  }

  private broadcast(msg: ServerMsg): void {
    for (const conn of this.conns.values()) {
      conn.send(msg);
    }
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Lowest unoccupied slot, or -1. With requireAlive, eliminated slots are
   * skipped too (used when seating mid-match — a dead paddle can't be played).
   */
  private lowestFreeSlot(requireAlive = false): number {
    for (let i = 0; i < this.slots.length; i += 1) {
      if (
        this.slots[i].clientId === null &&
        (!requireAlive || !this.players[i].eliminated)
      ) {
        return i;
      }
    }
    return -1;
  }

  /** Connected SEATED humans (spectators are not counted anywhere). */
  private seatedHumans(): number {
    return this.slots.reduce((n, s) => (s.clientId !== null ? n + 1 : n), 0);
  }

  /** Server RNG — Math.random is fine for v1 (no replay determinism needed). */
  private readonly rng = () => Math.random();
}

/** Trim/limit a hello name to a safe 1-12 char display string. */
function sanitizeName(name: unknown): string {
  if (typeof name !== "string") {
    return "";
  }
  // Strip ASCII control characters, then trim and cap at 12 chars.
  return name.replace(/[^ -~]/g, "").trim().slice(0, 12);
}

/**
 * Validate an arcade-hub profile public id. publicIdFor() in arcade-api is a
 * 16-char lowercase hex sha256 slice, so we accept only [0-9a-f], cap at 16 —
 * the server is a dumb relay and never trusts arbitrary client strings.
 */
function sanitizePublicId(id: unknown): string {
  if (typeof id !== "string") {
    return "";
  }
  return id.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 16);
}
