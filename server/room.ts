/**
 * Four Ponq — authoritative single-room game server (Stage 1).
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
 */

import {
  SIM_HZ,
  SNAP_HZ,
  MAX_PLAYERS,
  type PlayerView,
  type ServerMsg
} from "../shared/protocol";
import type {
  ArenaGeometry,
  PlayerInput,
  SimEvent,
  SimPlayer,
  SimState
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
  /** Latest sticky input from the human (ignored while empty). */
  input: StickyInput;
  /** sim-elapsed ms of the last human input (for parity with lastHumanInputAt). */
  lastHumanInputAt: number;
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
 * of live Connections and forwards lifecycle calls (join/input/start/setBots/
 * leave) here; the Room owns ALL game state and the tick loop.
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
      input: freshInput(),
      lastHumanInputAt: -9999
    }));

    this.sim = createSimState({
      players: this.players,
      ball: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 }
    });
    // botFill defaults true (createSimState sets it); keep the lobby idle until a
    // human starts a match. Mirror main.ts setup: split arcs, then a menu serve.
    this.sim.mode = "lobby" as SimState["mode"];
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
   * Register a connection and assign the lowest free human slot. Returns the
   * assigned slot (0..3) or -1 (spectator: all 4 slots are humans). Sends the
   * {welcome} + {room} to this connection and broadcasts {room} to everyone.
   */
  join(conn: Connection, name: string): number {
    this.conns.set(conn.clientId, conn);

    const slot = this.lowestFreeSlot();
    if (slot >= 0) {
      const s = this.slots[slot];
      s.clientId = conn.clientId;
      s.name = sanitizeName(name) || `P${slot + 1}`;
      s.input = freshInput();
      s.lastHumanInputAt = this.sim.elapsed;
      this.players[slot].humanControlled = true;
      this.players[slot].lastHumanInputAt = this.sim.elapsed;
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

  /** Drop a connection; frees its slot (a bot takes over if botFill is on). */
  leave(clientId: string): void {
    this.conns.delete(clientId);
    const slot = this.slots.findIndex((s) => s.clientId === clientId);
    if (slot >= 0) {
      const s = this.slots[slot];
      s.clientId = null;
      s.name = `P${slot + 1}`;
      s.input = freshInput();
      this.players[slot].humanControlled = false;
    }
    this.broadcastRoom();
    this.maybeIdle();
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

  /** Start/restart a match from lobby or matchOver (ignored mid-match). */
  start(): void {
    if (this.sim.mode === "playing") {
      return;
    }
    // Full reset to a fresh match, mirroring main.ts restartMatch().
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
    this.sim.mode = "playing";
    rebuildArcs(this.arena, this.players);
    // Serve immediately; resetRound() with mode "playing" bumps roundNumber and
    // emits a "serve" event we forward to clients.
    this.dispatch(resetRound(this.sim, this.arena, this.rng));
    this.broadcastRoom();
    this.ensureLoop();
  }

  /** Toggle bot-fill for empty slots; echoes the new state via {room}. */
  setBots(on: boolean): void {
    this.sim.botFill = !!on;
    this.broadcastRoom();
  }

  // --- tick loop -----------------------------------------------------------

  /** Start the fixed-step loop if a human is present and a match is playing. */
  private ensureLoop(): void {
    if (this.timer) {
      return;
    }
    if (!this.hasHuman() || this.sim.mode !== "playing") {
      return;
    }
    this.timer = setInterval(() => this.step(), Math.round(1000 / SIM_HZ));
  }

  /** Stop the loop when nobody's connected (save CPU on the 2-core host). */
  private maybeIdle(): void {
    if (!this.hasHuman() && this.timer) {
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
      // Fire a pending post-goal re-serve once its delay elapses.
      if (this.reserveAt !== null && this.sim.elapsed >= this.reserveAt) {
        const angle = this.reserveAngle;
        this.reserveAt = null;
        this.reserveAngle = undefined;
        this.dispatch(resetRound(this.sim, this.arena, this.rng, angle));
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
        case "matchOver":
          this.broadcastEvent("matchOver", { winnerId: event.winnerId });
          // Sim already set mode = "matchOver". Cancel any pending re-serve.
          this.reserveAt = null;
          this.reserveAngle = undefined;
          break;
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
      eliminated
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
      connected: s.clientId !== null
    }));
    return {
      t: "room",
      players,
      mode: this.sim.mode === "playing"
        ? "playing"
        : this.sim.mode === "matchOver"
        ? "matchOver"
        : "lobby",
      botFill: this.sim.botFill
    };
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

  private lowestFreeSlot(): number {
    for (let i = 0; i < this.slots.length; i += 1) {
      if (this.slots[i].clientId === null) {
        return i;
      }
    }
    return -1;
  }

  private hasHuman(): boolean {
    return this.slots.some((s) => s.clientId !== null);
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
