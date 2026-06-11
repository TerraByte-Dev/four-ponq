/**
 * Four Ponq — Stage 1 networked-multiplayer CLIENT (browser side).
 *
 * Opens a WebSocket to the same-origin /ws endpoint, joins the single shared
 * room, and turns the server's authoritative {t:"snap"} stream into a smooth,
 * render-ready read of the game state. It does NOT simulate the ball or the
 * other paddles — the server owns that. It only:
 *
 *   1. Buffers the last few snapshots and interpolates between them, rendering
 *      ~100ms behind the newest snapshot (the design doc's interpolation
 *      section). This trades 100ms of visual latency for jitter-free motion.
 *   2. Predicts the LOCAL player's own paddle from local input immediately
 *      (client-side prediction) and gently reconciles toward the server's
 *      authoritative angle on each snap, so your own paddle feels instant.
 *
 * Coordinate convention (see shared/protocol.ts): snap.ball.{x,y} is in the
 * server's SIM space; snap.paddles[] are paddleAngle radians. Paddle angles are
 * viewport-independent, so they map straight through. Ball x/y must be remapped
 * from the server's arena into the client's render arena — main.ts does that
 * remap via NetClient.ballRenderPos() using the shared canonical arena below.
 */

import type { ClientMsg, ServerMsg, PlayerView } from "../../shared/protocol";
import { SNAP_HZ, MAX_PLAYERS } from "../../shared/protocol";
import { TAU } from "../sim/math";

/**
 * Canonical server arena size. The SERVER must run its authoritative sim with
 * computeArena(NET_ARENA_WIDTH, NET_ARENA_HEIGHT) so that snap.ball.{x,y} lands
 * in a known, fixed coordinate frame. The client then remaps that frame into
 * whatever its own viewport is (see ballRenderPos). Paddle ANGLES are
 * frame-independent and need no remap.
 *
 * If the server agent picks a different canonical size, change it HERE in one
 * place — nothing else in the client hard-codes it.
 */
export const NET_ARENA_WIDTH = 960;
export const NET_ARENA_HEIGHT = 640;

/** Render this many ms behind the newest snapshot for smooth interpolation. */
const INTERP_DELAY_MS = 100;

/** Drop buffered snapshots older than this (keeps the buffer tiny). */
const SNAP_BUFFER_MS = 1000;

/** Per-snap fraction to ease the predicted local paddle toward the server. */
const RECONCILE_RATE = 0.25;

/** Below this angular error (rad) we just snap the prediction to the server. */
const RECONCILE_SNAP_EPSILON = 0.0008;

export type ConnState = "connecting" | "open" | "closed" | "error";

export type RoomMode = "lobby" | "playing" | "matchOver";

/** One buffered snapshot, timestamped on arrival (client clock). */
interface BufferedSnap {
  /** performance.now() at receipt — the client interpolation clock. */
  clientTime: number;
  tick: number;
  ball: { x: number; y: number };
  paddles: number[];
  charges: number[];
  shields: number[];
  eliminated: boolean[];
}

/** What main.ts reads each frame to drive sprites/HUD. */
export interface NetRenderState {
  /** Ball position already remapped into the caller's render arena. */
  ball: { x: number; y: number };
  /** paddleAngle per slot 0..3 (own slot is the locally predicted value). */
  paddles: number[];
  charges: number[];
  shields: number[];
  eliminated: boolean[];
}

export interface NetClientOptions {
  /** Display name sent in the hello. 1-12 chars recommended. */
  name: string;
  /** Fired for every {t:"event"} from the server (sound/fx hooks). */
  onEvent?: (kind: string, data?: unknown) => void;
  /** Fired whenever connection state, slot, roster, or mode changes. */
  onChange?: () => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private opts: NetClientOptions;

  private _state: ConnState = "connecting";
  private _slot = -1;
  private _clientId = "";
  private _players: PlayerView[] = [];
  private _mode: RoomMode = "lobby";
  private _botFill = true;

  /** Most-recent-last ring of snapshots, used for interpolation. */
  private snaps: BufferedSnap[] = [];

  /** Last input we sent, so we only send on change (protocol contract). */
  private lastSentInput: { ccw: boolean; cw: boolean; charge: boolean } | null = null;

  /** Locally predicted angle for our own paddle (slot === _slot). */
  private predictedAngle = 0;
  private hasPrediction = false;

  /** Sticky local input, applied to the prediction every frame. */
  private localInput = { ccw: false, cw: false, charge: false };

  /**
   * Local prediction paddle speed (rad/s). Mirrors the sim's BASE_PADDLE_SPEED
   * closely enough to feel right between snaps; the per-snap reconcile corrects
   * any drift, so it does not need to match the server exactly. Intentionally a
   * touch conservative so prediction never badly overshoots the server.
   */
  private static readonly PREDICT_PADDLE_SPEED = 2.3625;

  constructor(opts: NetClientOptions) {
    this.opts = opts;
  }

  // --- lifecycle -----------------------------------------------------------

  /** Open the socket. Safe to call once; reconnect is best-effort manual. */
  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    this.setState("connecting");
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.setState("error");
      return;
    }

    this.ws.addEventListener("open", () => {
      this.setState("open");
      this.send({ t: "hello", name: this.opts.name });
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev));
    this.ws.addEventListener("close", () => this.setState("closed"));
    this.ws.addEventListener("error", () => this.setState("error"));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  // --- outbound ------------------------------------------------------------

  /**
   * Update local sticky input. Sends an {t:"input"} ONLY when a field changed
   * (protocol: change-only). Drives client-side prediction immediately.
   */
  sendInput(ccw: boolean, cw: boolean, charge: boolean): void {
    this.localInput = { ccw, cw, charge };
    const last = this.lastSentInput;
    if (last && last.ccw === ccw && last.cw === cw && last.charge === charge) {
      return; // no change → no message
    }
    this.lastSentInput = { ccw, cw, charge };
    this.send({ t: "input", ccw, cw, charge });
  }

  sendStart(): void {
    this.send({ t: "start" });
  }

  sendSetBots(on: boolean): void {
    this.send({ t: "setBots", on });
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // --- inbound -------------------------------------------------------------

  private onMessage(ev: MessageEvent): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMsg;
    } catch {
      return;
    }

    switch (msg.t) {
      case "welcome": {
        this._clientId = msg.clientId;
        this._slot = msg.slot;
        // Reset prediction whenever our slot identity changes.
        this.hasPrediction = false;
        this.lastSentInput = null;
        this.opts.onChange?.();
        break;
      }
      case "room": {
        this._players = msg.players;
        this._mode = msg.mode;
        this._botFill = msg.botFill;
        this.opts.onChange?.();
        break;
      }
      case "snap": {
        this.ingestSnap(msg);
        break;
      }
      case "event": {
        this.opts.onEvent?.(msg.kind, msg.data);
        break;
      }
      case "error": {
        // Surface via onEvent so callers can log/toast without a separate hook.
        this.opts.onEvent?.("error", { code: msg.code, message: msg.message });
        break;
      }
    }
  }

  private ingestSnap(msg: Extract<ServerMsg, { t: "snap" }>): void {
    const now = this.now();
    this.snaps.push({
      clientTime: now,
      tick: msg.tick,
      ball: { x: msg.ball.x, y: msg.ball.y },
      paddles: msg.paddles.slice(),
      charges: msg.charges.slice(),
      shields: msg.shields.slice(),
      eliminated: msg.eliminated.slice()
    });

    // Trim old snaps; keep at least the last 2 for interpolation endpoints.
    const cutoff = now - SNAP_BUFFER_MS;
    while (this.snaps.length > 2 && this.snaps[0].clientTime < cutoff) {
      this.snaps.shift();
    }

    // Reconcile our predicted own-paddle toward the server's authoritative
    // value from the newest snap (client-side prediction correction).
    if (this._slot >= 0 && this._slot < MAX_PLAYERS) {
      const serverAngle = msg.paddles[this._slot];
      if (typeof serverAngle === "number") {
        if (!this.hasPrediction) {
          this.predictedAngle = serverAngle;
          this.hasPrediction = true;
        } else {
          const err = shortestAngle(this.predictedAngle, serverAngle);
          if (Math.abs(err) < RECONCILE_SNAP_EPSILON) {
            this.predictedAngle = serverAngle;
          } else {
            this.predictedAngle = normalize(this.predictedAngle + err * RECONCILE_RATE);
          }
        }
      }
    }
  }

  // --- prediction tick -----------------------------------------------------

  /**
   * Advance the locally predicted own-paddle by dt seconds using sticky local
   * input. main.ts calls this once per frame (only meaningful while playing).
   * Does nothing if we are a spectator (slot -1) or have no baseline yet.
   */
  predict(dt: number): void {
    if (this._slot < 0 || !this.hasPrediction) {
      return;
    }
    let dir = 0;
    if (this.localInput.ccw) dir -= 1;
    if (this.localInput.cw) dir += 1;
    if (dir !== 0) {
      this.predictedAngle = normalize(
        this.predictedAngle + dir * NetClient.PREDICT_PADDLE_SPEED * dt
      );
    }
  }

  // --- interpolated read ---------------------------------------------------

  /**
   * Build the render state for "now − INTERP_DELAY_MS": interpolate ball +
   * other paddles between the two bracketing snapshots, and substitute our own
   * predicted paddle for our slot. Returns null until at least one snap exists.
   *
   * `mapBall` maps a server-sim-space point into the caller's render arena.
   */
  read(mapBall: (x: number, y: number) => { x: number; y: number }): NetRenderState | null {
    if (this.snaps.length === 0) {
      return null;
    }

    const renderTime = this.now() - INTERP_DELAY_MS;
    const { a, b, t } = this.bracket(renderTime);

    const ballSim = lerpBall(a.ball, b.ball, t);
    const ball = mapBall(ballSim.x, ballSim.y);

    const slots = Math.max(a.paddles.length, b.paddles.length, MAX_PLAYERS);
    const paddles: number[] = [];
    const charges: number[] = [];
    const shields: number[] = [];
    const eliminated: boolean[] = [];

    for (let i = 0; i < slots; i += 1) {
      const pa = a.paddles[i] ?? 0;
      const pb = b.paddles[i] ?? pa;
      // Own paddle: use the locally predicted angle for zero-latency feel.
      if (i === this._slot && this.hasPrediction) {
        paddles[i] = this.predictedAngle;
      } else {
        paddles[i] = lerpAngle(pa, pb, t);
      }
      // Charges interpolate linearly; shields/eliminated are discrete — take
      // the newer endpoint so the HUD reacts promptly.
      charges[i] = lerp(a.charges[i] ?? 0, b.charges[i] ?? a.charges[i] ?? 0, t);
      shields[i] = b.shields[i] ?? a.shields[i] ?? 0;
      eliminated[i] = b.eliminated[i] ?? a.eliminated[i] ?? false;
    }

    return { ball, paddles, charges, shields, eliminated };
  }

  /**
   * Find the two buffered snaps that bracket `targetTime` and the 0..1 blend
   * factor between them. Clamps to the ends when extrapolation would be needed.
   */
  private bracket(targetTime: number): { a: BufferedSnap; b: BufferedSnap; t: number } {
    const snaps = this.snaps;
    if (snaps.length === 1) {
      return { a: snaps[0], b: snaps[0], t: 0 };
    }

    // Newest snap older-or-equal to targetTime → `a`; the one after → `b`.
    if (targetTime <= snaps[0].clientTime) {
      return { a: snaps[0], b: snaps[1], t: 0 };
    }
    const last = snaps[snaps.length - 1];
    if (targetTime >= last.clientTime) {
      const prev = snaps[snaps.length - 2];
      return { a: prev, b: last, t: 1 };
    }

    for (let i = 0; i < snaps.length - 1; i += 1) {
      const a = snaps[i];
      const b = snaps[i + 1];
      if (targetTime >= a.clientTime && targetTime <= b.clientTime) {
        const span = b.clientTime - a.clientTime || 1;
        return { a, b, t: clamp01((targetTime - a.clientTime) / span) };
      }
    }
    // Fallback (shouldn't hit): newest pair.
    const a = snaps[snaps.length - 2];
    return { a, b: last, t: 1 };
  }

  // --- accessors -----------------------------------------------------------

  get state(): ConnState {
    return this._state;
  }
  get slot(): number {
    return this._slot;
  }
  get clientId(): string {
    return this._clientId;
  }
  get players(): PlayerView[] {
    return this._players;
  }
  get mode(): RoomMode {
    return this._mode;
  }
  get botFill(): boolean {
    return this._botFill;
  }
  get snapHz(): number {
    return SNAP_HZ;
  }
  /** True once we are connected with a playable slot and have a baseline snap. */
  get ready(): boolean {
    return this._state === "open" && this.snaps.length > 0;
  }

  private setState(s: ConnState): void {
    if (this._state === s) return;
    this._state = s;
    this.opts.onChange?.();
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
}

// --- small math helpers (kept local; sim/math is sim-space, this is net glue) -

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpBall(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

/** Signed shortest delta from `from` to `to`, in (-PI, PI]. */
function shortestAngle(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Interpolate angles the short way around the circle. */
function lerpAngle(a: number, b: number, t: number): number {
  return normalize(a + shortestAngle(a, b) * t);
}

function normalize(angle: number): number {
  const m = angle % TAU;
  return m < 0 ? m + TAU : m;
}
