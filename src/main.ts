import Phaser from "phaser";
import "./styles.css";
import { TAU, shortestAngleDelta, type Vec2 } from "./sim/math";
import type {
  ArenaGeometry,
  BotDifficulty,
  GameMode,
  GameVariant,
  PlayerInput,
  SimEvent,
  SimPlayer,
  SimState,
  TriangleMotionMode
} from "./sim/types";
import {
  BALL_RADIUS,
  MAX_BALL_SPEED,
  MAX_CHARGE,
  MAX_SHIELDS,
  TRIANGLE_ROTATION_SPEED
} from "./sim/constants";
import { computeArena, paddleCenter, paddleOutlinePoints, rebuildArcs, triangleVertices } from "./sim/geometry";
import {
  advanceBall,
  applyTriangleGravity,
  clearCatchState,
  clearTouchState,
  createSimState,
  resetRound as simResetRound,
  stepCaughtBall,
  stepMenuPreview,
  stepPaddles,
  stepTriangleMotion,
  updateArenaRotation,
  updateCaughtBall
} from "./sim/physics";
import {
  NetClient,
  NET_ARENA_WIDTH,
  NET_ARENA_HEIGHT,
  COUNTDOWN_SECONDS,
  type NetRenderState
} from "./net/client";

type ThemeId = "neon" | "solar" | "deepSea" | "candy" | "mono";
type VolumeTarget = "music" | "sfx";

/** Scene-side player: the pure sim fields (SimPlayer) plus render-only identity. */
interface PlayerState extends SimPlayer {
  name: string;
  color: number;
  cssColor: string;
}

interface HudPlayerState {
  name: string;
  cssColor: string;
  shields: number;
  eliminated: boolean;
  charge: number;
}

interface HudState {
  players: HudPlayerState[];
  message: string;
  mode: GameMode;
  botFill: boolean;
  botDifficulty: BotDifficulty;
  gameVariant: GameVariant;
  themeId: ThemeId;
  triangleMotionMode: TriangleMotionMode;
  musicVolume: number;
  sfxVolume: number;
  /** The local player's chosen display name (sent to the server as our name). */
  playerName: string;
  /**
   * True while the ONLINE session screens (spectator banner / ready panel /
   * countdown) own the overlay layer — the legacy offline menu card stays
   * hidden so the two never stack. The local pause card (Esc) wins over it.
   */
  netSession: boolean;
}

/** One roster row on the online ready screen. */
interface SessionRowState {
  slot: number;
  name: string;
  isBot: boolean;
  connected: boolean;
  ready: boolean;
  isSelf: boolean;
  cssColor: string;
}

/**
 * Everything the DOM session layer (spectator banner / ready panel / 3-2-1)
 * renders. Emitted by the scene as "four-pong:session" on every HUD refresh;
 * the DOM side memoizes so unchanged states cost nothing.
 */
interface SessionUiState {
  /** Slim top banner: watching = "press Space to jump in", pending = "joining at next serve…". */
  banner: "none" | "watching" | "pending";
  /** Ready panel (lobby / matchOver ready screen, seated players only). */
  showReady: boolean;
  matchOver: boolean;
  resultLine: string;
  rows: SessionRowState[];
  selfReady: boolean;
  /** Connected humans not yet ready (self included while un-ready). */
  waitingFor: number;
  /** Seconds left in the 3-2-1, or null when no countdown is running. */
  countdown: number | null;
  /** Seated players get the "Space — cancel" hint under the countdown. */
  seated: boolean;
}

interface PaddleImpactBurst {
  position: Phaser.Math.Vector2;
  radial: Phaser.Math.Vector2;
  tangent: Phaser.Math.Vector2;
  tangentSign: number;
  createdAt: number;
}

interface BallTrailPoint {
  position: Phaser.Math.Vector2;
  createdAt: number;
  color: number;
}

interface ConfettiParticle {
  position: Phaser.Math.Vector2;
  velocity: Phaser.Math.Vector2;
  color: number;
  rotation: number;
  angularVelocity: number;
  size: number;
  createdAt: number;
  lifetime: number;
}

interface ThemeDefinition {
  id: ThemeId;
  name: string;
  shellTheme: string;
  background: number;
  ringDim: number;
  ringBright: number;
  triangleFill: number;
  triangleStroke: number;
  triangleSpoke: number;
  ball: number;
  ballGlow: number;
  paddleStroke: number;
  playerColors: Array<{ color: number; cssColor: string }>;
}

// Gameplay/tuning constants live in src/sim/constants.ts now — only
// render/audio-facing constants remain here.
const SERVE_INDICATOR_LIFETIME = 1700;
const SERVE_INDICATOR_LENGTH = 62;
const BALL_TRAIL_LIFETIME = 360;
const BALL_TRAIL_SAMPLE_DISTANCE = 10;
const CONFETTI_LIFETIME = 1500;
const PADDLE_HIT_INDICATOR_LIFETIME = 170;
const PADDLE_HIT_INDICATOR_LENGTH = 34;
const PADDLE_HIT_INDICATOR_GAP = 4;
const PADDLE_HIT_INDICATOR_FAN_ANGLE = 0.48;
const PADDLE_HIT_SOUND_COOLDOWN = 500;
const PADDLE_HIT_SOUND_VOLUME = 0.56;
/** How long the "that's YOUR paddle" pulse runs after the server seats us (ms). */
const SEAT_FLASH_DURATION = 2600;
const COUNTDOWN_TICK_VOLUME = 0.5;
const PADDLE_HIT_SOUND_KEYS = [
  "paddle-clonk-01",
  "paddle-clonk-02",
  "paddle-clonk-03",
  "paddle-clonk-04",
  "paddle-clonk-05",
  "paddle-clonk-06"
] as const;
const WIN_FANFARE_VOLUME = 0.62;
const WIN_FANFARE_KEYS = [
  "win-fanfare-01",
  "win-fanfare-02",
  "win-fanfare-03"
] as const;
const MUSIC_TRACKS = [
  {
    key: "music-round-01",
    file: "01-round-one-subtle-melody.wav"
  },
  {
    key: "music-round-02",
    file: "02-round-two-wooden-neon-theme.wav"
  },
  {
    key: "music-round-03",
    file: "03-round-three-fuller-tension.wav"
  },
  {
    key: "music-round-final",
    file: "04-round-four-home-stretch-chill-drums-half-bell.wav"
  }
] as const;

const THEMES: Record<ThemeId, ThemeDefinition> = {
  neon: {
    id: "neon",
    name: "Neon Classic",
    shellTheme: "neon",
    background: 0x061016,
    ringDim: 0x203240,
    ringBright: 0x29485a,
    triangleFill: 0x102431,
    triangleStroke: 0x9ddcff,
    triangleSpoke: 0xf4fbff,
    ball: 0xf4fbff,
    ballGlow: 0x9ddcff,
    paddleStroke: 0xf4fbff,
    playerColors: [
      { color: 0x62e6ff, cssColor: "#62e6ff" },
      { color: 0xff6f91, cssColor: "#ff6f91" },
      { color: 0xf8d66d, cssColor: "#f8d66d" },
      { color: 0x69db7c, cssColor: "#69db7c" }
    ]
  },
  solar: {
    id: "solar",
    name: "Solar Flare",
    shellTheme: "solar",
    background: 0x140c07,
    ringDim: 0x4a2e22,
    ringBright: 0x805338,
    triangleFill: 0x2a160d,
    triangleStroke: 0xffc857,
    triangleSpoke: 0xfff0c2,
    ball: 0xfff2c2,
    ballGlow: 0xff8c42,
    paddleStroke: 0xfff0c2,
    playerColors: [
      { color: 0xffc857, cssColor: "#ffc857" },
      { color: 0xff5a3d, cssColor: "#ff5a3d" },
      { color: 0xff8c42, cssColor: "#ff8c42" },
      { color: 0x56e39f, cssColor: "#56e39f" }
    ]
  },
  deepSea: {
    id: "deepSea",
    name: "Deep Sea",
    shellTheme: "deep-sea",
    background: 0x03151c,
    ringDim: 0x164252,
    ringBright: 0x1f6f8b,
    triangleFill: 0x062936,
    triangleStroke: 0x74f2ce,
    triangleSpoke: 0xcffcf1,
    ball: 0xe6fffb,
    ballGlow: 0x74f2ce,
    paddleStroke: 0xe6fffb,
    playerColors: [
      { color: 0x74f2ce, cssColor: "#74f2ce" },
      { color: 0x4cc9f0, cssColor: "#4cc9f0" },
      { color: 0xb8f35b, cssColor: "#b8f35b" },
      { color: 0xf72585, cssColor: "#f72585" }
    ]
  },
  candy: {
    id: "candy",
    name: "Arcade Candy",
    shellTheme: "candy",
    background: 0x16071f,
    ringDim: 0x4c2a68,
    ringBright: 0x7b3db2,
    triangleFill: 0x2c0f3b,
    triangleStroke: 0xff7ad9,
    triangleSpoke: 0xffeffa,
    ball: 0xffffff,
    ballGlow: 0xff7ad9,
    paddleStroke: 0xffffff,
    playerColors: [
      { color: 0xff7ad9, cssColor: "#ff7ad9" },
      { color: 0x7bf1ff, cssColor: "#7bf1ff" },
      { color: 0xffee65, cssColor: "#ffee65" },
      { color: 0xb6ff6f, cssColor: "#b6ff6f" }
    ]
  },
  mono: {
    id: "mono",
    name: "Mono Grid",
    shellTheme: "mono",
    background: 0x08090a,
    ringDim: 0x2e3438,
    ringBright: 0x5f6b72,
    triangleFill: 0x151719,
    triangleStroke: 0xe8f1f2,
    triangleSpoke: 0xffffff,
    ball: 0xffffff,
    ballGlow: 0xb8c3c7,
    paddleStroke: 0xffffff,
    playerColors: [
      { color: 0xf8f9fa, cssColor: "#f8f9fa" },
      { color: 0xb8c3c7, cssColor: "#b8c3c7" },
      { color: 0x89949a, cssColor: "#89949a" },
      { color: 0x69757c, cssColor: "#69757c" }
    ]
  }
};

class FourPongScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private players: PlayerState[] = [];
  private ball = new Phaser.Math.Vector2(0, 0);
  private velocity = new Phaser.Math.Vector2(0, 0);
  // All gameplay state lives in the pure SimState (src/sim/physics.ts steps
  // it). ball/velocity/players above are shared into it BY REFERENCE — Phaser
  // Vector2 satisfies Vec2 structurally — so render code and the sim always
  // see the same objects. Built in create() once the players exist.
  private sim!: SimState;
  private rng: () => number = Math.random;
  private message = "Circular 4 Player is ready.";
  private themeId: ThemeId = "neon";
  private musicVolume = 0.02;
  private sfxVolume = 0.05;
  /** Persisted, player-editable display name (defaults to a random one). */
  private playerName = loadOrCreatePlayerName();
  /** Eased camera spin that keeps the local player's side at screen-top. */
  private currentViewRotation = 0;
  private paddleImpactBursts: PaddleImpactBurst[] = [];
  private ballTrail: BallTrailPoint[] = [];
  private confettiParticles: ConfettiParticle[] = [];
  private serveIndicatorUntil = 0;
  private serveIndicatorDirection = new Phaser.Math.Vector2(1, 0);
  private lastPaddleHitSoundAt = -Infinity;
  private activeMusic?: Phaser.Sound.BaseSound;
  private activeMusicKey?: string;
  private homeOverlayOpen = false;
  private pausedByHomeOverlay = false;
  private prevSoundMute = false;

  // --- networked multiplayer (Stage 1) ------------------------------------
  // When `net` is connected with snapshots, update() renders SERVER state
  // instead of running the local authoritative sim. When it's null/offline,
  // everything below behaves exactly like the original hot-seat game.
  private net?: NetClient;
  /** True once the net client is open — seated player OR spectator. */
  private networked = false;
  /** Server-driven status line for the lobby/HUD while networked. */
  private netStatus = "Connecting to the arcade server…";
  /** Sim-elapsed deadline for the "this is your paddle" highlight pulse. */
  private seatFlashUntil = -Infinity;
  /** Winner line captured at the matchOver event, shown on the ready screen. */
  private lastResultLine = "";

  constructor() {
    super("four-pong");
  }

  // Thin accessors over sim-owned state so scene/render/UI code keeps reading
  // a single source of truth without sprinkling `this.sim.` everywhere.
  private get mode(): GameMode {
    return this.sim.mode;
  }

  private set mode(value: GameMode) {
    this.sim.mode = value;
  }

  private get elapsed(): number {
    return this.sim.elapsed;
  }

  private get botFill(): boolean {
    return this.sim.botFill;
  }

  private set botFill(value: boolean) {
    this.sim.botFill = value;
  }

  private get botDifficulty(): BotDifficulty {
    return this.sim.botDifficulty;
  }

  private set botDifficulty(value: BotDifficulty) {
    this.sim.botDifficulty = value;
  }

  private get gameVariant(): GameVariant {
    return this.sim.gameVariant;
  }

  private set gameVariant(value: GameVariant) {
    this.sim.gameVariant = value;
  }

  private get triangleMotionMode(): TriangleMotionMode {
    return this.sim.triangleMotionMode;
  }

  private set triangleMotionMode(value: TriangleMotionMode) {
    this.sim.triangleMotionMode = value;
  }

  preload() {
    const clonkFiles = [
      "01-hollow-clonk-pitch-0.920.wav",
      "02-hollow-clonk-pitch-0.960.wav",
      "03-hollow-clonk-pitch-0.985.wav",
      "04-hollow-clonk-pitch-1.015.wav",
      "05-hollow-clonk-pitch-1.050.wav",
      "06-hollow-clonk-pitch-1.095.wav"
    ];

    PADDLE_HIT_SOUND_KEYS.forEach((key, index) => {
      this.load.audio(key, `/audio/paddle/${clonkFiles[index]}`);
    });

    const winFanfareFiles = [
      "01-long-final-flourish-bright.wav",
      "02-long-final-flourish-grand.wav",
      "03-long-final-flourish-sparkle.wav"
    ];

    WIN_FANFARE_KEYS.forEach((key, index) => {
      this.load.audio(key, `/audio/win/${winFanfareFiles[index]}`);
    });

    MUSIC_TRACKS.forEach((track) => {
      this.load.audio(track.key, `/audio/music/${track.file}`);
    });
  }

  create() {
    this.gfx = this.add.graphics();
    window.addEventListener("four-pong:start", this.handleStartEvent);
    window.addEventListener("four-pong:toggle-pause", this.handlePauseEvent);
    window.addEventListener("four-pong:toggle-bots", this.handleBotEvent);
    window.addEventListener("four-pong:set-difficulty", this.handleDifficultyEvent);
    window.addEventListener("four-pong:set-game-variant", this.handleGameVariantEvent);
    window.addEventListener("four-pong:set-theme", this.handleThemeEvent);
    window.addEventListener("four-pong:set-triangle-motion", this.handleTriangleMotionEvent);
    window.addEventListener("four-pong:set-volume", this.handleVolumeEvent);
    window.addEventListener("four-pong:set-name", this.handleSetNameEvent);
    window.addEventListener("four-pong:join", this.handleJoinEvent);
    window.addEventListener("four-pong:ready-toggle", this.handleReadyToggleEvent);
    window.addEventListener("keydown", this.handleWindowKeyDown);
    window.addEventListener("arcade:home-open", this.handleHomeOpen);
    window.addEventListener("arcade:home-close", this.handleHomeClose);

    this.keys = this.input.keyboard!.addKeys({
      counterclockwise: Phaser.Input.Keyboard.KeyCodes.A,
      clockwise: Phaser.Input.Keyboard.KeyCodes.D,
      reset: Phaser.Input.Keyboard.KeyCodes.R,
      pause: Phaser.Input.Keyboard.KeyCodes.SPACE,
      escape: Phaser.Input.Keyboard.KeyCodes.ESC,
      bot: Phaser.Input.Keyboard.KeyCodes.B
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.players = [
      // Slot 0 is the local player offline; show their chosen name. Networked
      // play overwrites all four names from the server roster via handleNetChange.
      this.createPlayer(1, this.playerName, 0x62e6ff, "#62e6ff"),
      this.createPlayer(2, "P2", 0xff6f91, "#ff6f91"),
      this.createPlayer(3, "P3", 0xf8d66d, "#f8d66d"),
      this.createPlayer(4, "P4", 0x69db7c, "#69db7c")
    ];
    this.sim = createSimState({ players: this.players, ball: this.ball, velocity: this.velocity });
    this.applyPlayerTheme();

    this.scale.on("resize", this.handleResize, this);
    rebuildArcs(this.arena(), this.players);
    this.resetRound(undefined, false);
    this.emitHud();

    this.connectNet();
    void this.adoptArcadeProfileName();
  }

  /**
   * Pull the player's hub profile name from the arcade backend (same-origin
   * /api/profile, routed to arcade-api by Caddy on every game subdomain) and
   * adopt it as our display name. The hub stores the chosen name keyed by the
   * verified Access email; this is how a per-browser game shows the SAME name
   * the player set in the arcade hub. Best-effort: a 404 (local dev), a network
   * error, or an empty name all leave the local random/persisted name in place.
   */
  private async adoptArcadeProfileName() {
    try {
      const res = await fetch("/api/profile", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { displayName?: unknown };
      const name = typeof data.displayName === "string" ? sanitizePlayerName(data.displayName) : "";
      if (name && name !== this.playerName) {
        this.setPlayerName(name);
      }
    } catch {
      // No arcade backend reachable — keep the local name.
    }
  }

  /**
   * Try to join the shared server room. Best-effort: if the socket never opens
   * (offline dev, server down), `networked` stays false and update() keeps
   * running the local hot-seat sim — the game is fully playable offline.
   */
  private connectNet() {
    this.net = new NetClient({
      name: this.playerName,
      onEvent: (kind, data) => this.handleNetEvent(kind, data),
      onChange: () => this.handleNetChange(),
      onSeated: (slot) => this.handleSeated(slot)
    });
    this.net.connect();
  }

  /**
   * {t:"seated"} landed — we just got a paddle (immediate join from the ready
   * screen, or the deferred next-serve seat replacing a bot). Pulse a highlight
   * around OUR paddle so a fresh joiner instantly knows which arc is theirs.
   */
  private handleSeated(slot: number) {
    this.seatFlashUntil = this.elapsed + SEAT_FLASH_DURATION;
    this.message = `You're in — P${slot + 1} is your paddle.`;
    this.emitHud();
  }

  /**
   * Connection/roster/mode changed. Flips us into (or out of) networked render
   * mode, mirrors the server's match mode onto the local `mode` so the existing
   * menu-overlay show/hide logic keeps working, and refreshes the lobby status.
   */
  private handleNetChange() {
    const net = this.net;
    if (!net) return;

    // Stage 2: ANY open connection is networked — spectators (slot -1) watch
    // the live server match too; they just render pure interpolation (no
    // prediction) and get the "jump in" banner instead of inputs.
    const open = net.state === "open";

    if (open && !this.networked) {
      // Entering networked mode: stop the local sim's authority. The local
      // `mode` now just mirrors the server's so the overlay/HUD behave.
      this.networked = true;
    } else if (!open && this.networked) {
      // Lost the server (closed/errored): fall back to the offline sim. Re-serve
      // so the frozen ball starts moving locally again.
      this.networked = false;
      this.mode = "playing";
      this.resumeRoundIfStalled();
    }

    if (this.networked) {
      // Mirror the server roster names onto the render players so the HUD and
      // ready-screen roster agree on who is who.
      for (const pv of net.players) {
        const local = this.players[pv.slot];
        if (local && pv.name) {
          local.name = pv.name;
        }
      }
      // Mirror server match mode onto the local enum the renderer/overlay read.
      // lobby → "menu", countdown/playing → "playing" (arena live; the 3-2-1 is
      // session DOM), matchOver → "matchOver". Local pause stays local.
      if (this.mode !== "paused") {
        this.mode =
          net.mode === "playing" || net.mode === "countdown"
            ? "playing"
            : net.mode === "matchOver"
              ? "matchOver"
              : "menu";
      }
      if (net.mode === "playing") {
        this.lastResultLine = ""; // stale winner line must not leak into the next matchOver
      }
      this.netStatus = this.describeRoom(net);
      this.message = this.netStatus;
      this.botFill = net.botFill;
    }

    this.emitHud();
  }

  /** Human-readable lobby line: "Connected as P2 · 3 players · waiting". */
  private describeRoom(net: NetClient): string {
    if (net.state !== "open") {
      return "Connecting to the arcade server…";
    }
    if (net.slot < 0) {
      return net.joinPending
        ? "Joining at the next serve…"
        : "Watching live — press Space to jump in.";
    }
    const humans = net.players.filter((p) => !p.isBot && p.connected).length;
    const roster = net.players
      .map((p) => `P${p.slot + 1}${p.isBot ? " (bot)" : ""}`)
      .join(", ");
    const phase =
      net.mode === "playing"
        ? "in play"
        : net.mode === "countdown"
          ? "starting"
          : net.mode === "matchOver"
            ? "match over"
            : "in lobby";
    return `Connected as P${net.slot + 1} · ${humans} human${humans === 1 ? "" : "s"} · ${roster} · ${phase}`;
  }

  /**
   * Server gameplay events → client sound/fx. Authoritative sound: every client
   * plays the hit/goal/win on receipt so audio matches the server state.
   */
  private handleNetEvent(kind: string, _data?: unknown) {
    switch (kind) {
      case "ballHit":
        this.playPaddleHitSound();
        this.trimBallTrail();
        break;
      case "goal":
      case "eliminated":
        // Snap the trail so the re-serve reads cleanly; the snapshot drives the
        // actual ball reset.
        this.trimBallTrail();
        break;
      case "matchOver": {
        this.playWinFanfare();
        const winner = this.players.find((p) => !p.eliminated);
        // Capture the winner line NOW (from the final snapshot) — by the time
        // the matchOver ready screen renders, shields/eliminated may reset.
        this.lastResultLine = winner ? `${winner.name} takes the match!` : "Match over.";
        this.spawnWinConfetti(winner);
        this.emitHud();
        break;
      }
      case "countdownTick":
        this.playCountdownTick();
        break;
      case "serve":
        this.paddleImpactBursts = [];
        this.ballTrail = [];
        break;
      // "error" and any unknown kinds are intentionally ignored for sound.
    }
  }

  shutdown() {
    window.removeEventListener("four-pong:start", this.handleStartEvent);
    window.removeEventListener("four-pong:toggle-pause", this.handlePauseEvent);
    window.removeEventListener("four-pong:toggle-bots", this.handleBotEvent);
    window.removeEventListener("four-pong:set-difficulty", this.handleDifficultyEvent);
    window.removeEventListener("four-pong:set-game-variant", this.handleGameVariantEvent);
    window.removeEventListener("four-pong:set-theme", this.handleThemeEvent);
    window.removeEventListener("four-pong:set-triangle-motion", this.handleTriangleMotionEvent);
    window.removeEventListener("four-pong:set-volume", this.handleVolumeEvent);
    window.removeEventListener("four-pong:set-name", this.handleSetNameEvent);
    window.removeEventListener("four-pong:join", this.handleJoinEvent);
    window.removeEventListener("four-pong:ready-toggle", this.handleReadyToggleEvent);
    window.removeEventListener("keydown", this.handleWindowKeyDown);
    window.removeEventListener("arcade:home-open", this.handleHomeOpen);
    window.removeEventListener("arcade:home-close", this.handleHomeClose);
    this.net?.close();
    this.net = undefined;
    this.networked = false;
    this.stopMusic();
  }

  update(_time: number, delta: number) {
    const dt = Math.min(delta / 1000, 0.034);
    this.sim.elapsed += delta;

    // NETWORKED PATH: when the server is driving, we do NOT run the local
    // authoritative sim. We read interpolated server state and render it.
    if (this.networked) {
      this.updateNetworked(dt);
      return;
    }

    // OFFLINE PATH: unchanged original hot-seat sim.
    if (Phaser.Input.Keyboard.JustDown(this.keys.reset)) {
      this.restartMatch();
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.bot)) {
      this.toggleBotFill();
    }

    stepTriangleMotion(this.sim, dt);
    this.updateBallTrail();
    this.updateConfetti(dt);
    this.updateMusic();

    if (this.mode === "playing") {
      const arena = this.arena();
      const input = this.readLocalInput();
      updateArenaRotation(this.sim, arena, dt);
      stepPaddles(this.sim, arena, input, dt);
      if (this.sim.caughtByPlayerId !== undefined) {
        this.applySimEvents(stepCaughtBall(this.sim, arena, input.catchHeld));
      } else if (this.sim.elapsed < this.sim.roundReadyAt) {
        // Give players a readable beat before the serve starts moving.
      } else {
        applyTriangleGravity(this.sim, arena, dt, 275, MAX_BALL_SPEED);
        this.applySimEvents(advanceBall(this.sim, arena, dt, input.catchHeld, this.rng));
      }
    } else if (this.mode === "menu") {
      this.applySimEvents(stepMenuPreview(this.sim, this.arena(), dt));
    }

    this.renderArena();
  }

  /**
   * The networked render tick. Reads the interpolated server snapshot, writes
   * it onto the render-facing state (this.ball + this.players' sim fields), and
   * draws — but never advances any authoritative physics. Local input is
   * predicted for our own paddle (inside NetClient) and the change is pushed to
   * the server here.
   */
  private updateNetworked(dt: number) {
    const net = this.net;
    if (!net) {
      this.networked = false;
      return;
    }

    // 1. Local input → server (change-only) + drive own-paddle prediction.
    //    Seated players only — spectators (slot -1) send nothing and render
    //    pure interpolation. While the arcade HOME overlay / pause card is up,
    //    or on the ready screen, we send "no input" so a paused/lobbied owner
    //    doesn't keep nudging their paddle on the server. Charge stays scoped
    //    to live play so the ready/countdown Space never fires a catch.
    if (net.slot >= 0) {
      const pausedLocally = this.mode === "paused";
      const live = net.mode === "playing" || net.mode === "countdown";
      const allow = live && !pausedLocally;
      const ccw = allow && this.keys.counterclockwise.isDown;
      const cw = allow && this.keys.clockwise.isDown;
      const charge = allow && net.mode === "playing" && this.keys.pause.isDown;
      net.sendInput(ccw, cw, charge);
      net.predict(dt);
    }

    // 2. Pull the interpolated state and project it onto render-facing fields.
    const render = net.read((x, y) => this.mapServerBall(x, y));
    if (render) {
      this.applyNetRenderState(render);
    }

    // 3. Triangle spin + cosmetic effects are purely visual; keep them lively.
    stepTriangleMotion(this.sim, dt);
    this.updateBallTrail();
    this.updateConfetti(dt);
    this.updateMusic();

    this.renderArena();
  }

  /**
   * Map a server-sim-space ball coordinate (simulated in a fixed canonical
   * arena, NET_ARENA_WIDTH×NET_ARENA_HEIGHT) into THIS client's render arena.
   * Paddle angles need no such remap — they're frame-independent — so only the
   * ball flows through here. Mirrors how handleResize remaps the ball.
   */
  private mapServerBall(x: number, y: number): Vec2 {
    const server = computeArena(NET_ARENA_WIDTH, NET_ARENA_HEIGHT);
    const local = this.arena();
    const scale = local.radius / server.radius;
    return {
      x: local.center.x + (x - server.center.x) * scale,
      y: local.center.y + (y - server.center.y) * scale
    };
  }

  /**
   * Write an interpolated server snapshot onto the render-facing state. Slots
   * map 1:1 to this.players[0..3]. Sets this.ball (drawn directly), each
   * player's paddleAngle / charge / shields / eliminated (read by the HUD and
   * paddle/arc drawing), and rebuilds arcs when the elimination set changed so
   * surviving paddles re-spread like the local sim does.
   */
  private applyNetRenderState(render: NetRenderState) {
    this.ball.set(render.ball.x, render.ball.y);

    let eliminationChanged = false;
    this.players.forEach((player, slot) => {
      if (slot < render.paddles.length) {
        player.paddleAngle = render.paddles[slot];
      }
      if (slot < render.charges.length) {
        player.charge = render.charges[slot];
      }
      if (slot < render.shields.length) {
        player.shields = render.shields[slot];
      }
      if (slot < render.eliminated.length) {
        const next = render.eliminated[slot];
        if (next !== player.eliminated) {
          eliminationChanged = true;
        }
        player.eliminated = next;
      }
    });

    if (eliminationChanged) {
      // Re-split the circle so the survivors' arcs match the server roster.
      // rebuildArcs recenters paddleAngle to each arc's middle, so re-apply the
      // authoritative snapshot angles afterward to avoid a one-frame jump.
      rebuildArcs(this.arena(), this.players);
      this.players.forEach((player, slot) => {
        if (slot < render.paddles.length) {
          player.paddleAngle = render.paddles[slot];
        }
      });
    }

    this.emitHud();
  }

  private createPlayer(id: number, name: string, color: number, cssColor: string): PlayerState {
    return {
      id,
      name,
      color,
      cssColor,
      shields: MAX_SHIELDS,
      eliminated: false,
      paddleAngle: 0,
      arcStart: 0,
      arcEnd: TAU,
      humanControlled: id === 1,
      lastHumanInputAt: -9999,
      charge: 0,
      paddleAssistMultiplier: 1
    };
  }

  private startGame() {
    // Networked: "Start" marks US ready — the SERVER starts the match once all
    // connected humans are ready (3-2-1 countdown). The local pause card
    // (HOME overlay / Esc) is handled purely locally below.
    if (this.networked && this.net) {
      if (this.mode === "paused") {
        this.mode = "playing";
        this.message = "Back in motion.";
        this.emitHud();
        return;
      }
      this.net.sendReady(true);
      return;
    }

    if (this.mode === "paused") {
      this.mode = "playing";
      this.message = "Back in motion.";
      this.resumeRoundIfStalled();
      this.emitHud();
      return;
    }

    this.restartMatch(this.mode === "matchOver" ? "New match. Guard your arc." : "Guard your arc.");
  }

  private restartMatch(message = "Fresh circle. Guard your arc.") {
    for (const player of this.players) {
      player.shields = MAX_SHIELDS;
      player.eliminated = false;
      player.lastHumanInputAt = -9999;
      player.charge = 0;
      player.paddleAssistMultiplier = 1;
    }

    this.sim.roundNumber = 0;
    clearTouchState(this.sim);
    clearCatchState(this.sim);
    this.sim.roundResolving = false;
    this.confettiParticles = [];
    this.mode = "playing";
    this.message = message;
    rebuildArcs(this.arena(), this.players);
    this.resetRound();
    this.emitHud();
  }

  private readLocalInput(): PlayerInput {
    return {
      counterclockwise: this.keys.counterclockwise.isDown,
      clockwise: this.keys.clockwise.isDown,
      catchHeld: this.keys.pause.isDown
    };
  }

  /**
   * Maps SimEvents from the pure simulation (src/sim/physics.ts) onto scene
   * side effects: particles, sound, status messages, HUD refreshes, and the
   * delayed re-serve. Keeps rendering/audio out of the sim so it can run
   * headless on a server later.
   */
  private applySimEvents(events: SimEvent[]) {
    let hudDirty = false;

    for (const event of events) {
      switch (event.kind) {
        case "paddleHit": {
          this.spawnPaddleImpactBurst(event.contact, event.radial, event.tangent, event.tangentSign);
          this.playPaddleHitSound();
          if (!event.caught) {
            if (event.repeatHit) {
              const player = this.playerById(event.playerId);
              if (player) {
                this.message = `${player.name} double-tapped the ball.`;
              }
            }
            this.trimBallTrail();
          }
          hudDirty = true;
          break;
        }
        case "catchStart": {
          const player = this.playerById(event.playerId);
          if (player) {
            this.message = `${player.name} caught the ball. Release Space to fire.`;
          }
          hudDirty = true;
          break;
        }
        case "catchLaunch": {
          const player = this.playerById(event.playerId);
          if (player) {
            this.message = `${player.name} fired the charged shot.`;
          }
          hudDirty = true;
          break;
        }
        case "triangleHit":
        case "barrierHit": {
          this.trimBallTrail();
          break;
        }
        case "goal": {
          const scorer = this.playerById(event.scorerId);
          if (scorer) {
            this.message = event.eliminated
              ? `${scorer.name} is out. The circle closes.`
              : `${scorer.name} cracked. ${event.shieldsRemaining} shields remain.`;
          }
          // Sim left mode === "playing" → match continues; schedule the
          // re-serve (sim itself never owns timers).
          if (this.mode === "playing" && scorer) {
            this.time.delayedCall(420, () => {
              if (this.mode === "playing") {
                this.resetRound(scorer.paddleAngle);
              }
            });
          }
          hudDirty = true;
          break;
        }
        case "matchOver": {
          const winner = event.winnerId === undefined ? undefined : this.playerById(event.winnerId);
          this.message = `${winner?.name ?? "No one"} wins!`;
          this.playWinFanfare();
          this.spawnWinConfetti(winner);
          hudDirty = true;
          break;
        }
        case "serve": {
          this.serveIndicatorDirection.set(event.direction.x, event.direction.y);
          this.serveIndicatorUntil = this.mode === "playing" ? this.elapsed + SERVE_INDICATOR_LIFETIME : 0;
          this.paddleImpactBursts = [];
          this.ballTrail = [];
          break;
        }
      }
    }

    if (hudDirty) {
      this.emitHud();
    }
  }

  private playerById(id: number) {
    return this.players.find((player) => player.id === id);
  }

  /**
   * The view spin that puts the LOCAL player's home arc at screen-top (-PI/2),
   * so that left/right always feel the same no matter which side of the circle
   * you defend. Zero for offline play, spectators, the eliminated, and whoever
   * already sits up top (slot 0) — those keep the default, un-rotated view.
   */
  private targetViewRotation(): number {
    const net = this.net;
    if (!this.networked || !net || net.slot < 0) {
      return 0;
    }
    const me = this.players[net.slot];
    if (!me || me.eliminated) {
      return 0;
    }
    const homeCenter = me.arcStart + (me.arcEnd - me.arcStart) / 2;
    // Rotation R such that homeCenter renders at screen-top: homeCenter + R = -PI/2.
    return shortestAngleDelta(homeCenter, -Math.PI / 2);
  }

  /**
   * Ease the camera toward {@link targetViewRotation} and pivot it about the
   * arena centre (Phaser rotates a camera around its own midpoint, so we park
   * the arena centre there via scroll). Re-orienting on elimination glides
   * instead of snapping.
   */
  private applyViewTransform(arena: ArenaGeometry) {
    const target = this.targetViewRotation();
    const delta = shortestAngleDelta(this.currentViewRotation, target);
    this.currentViewRotation = Math.abs(delta) < 0.0008 ? target : this.currentViewRotation + delta * 0.18;

    const cam = this.cameras.main;
    if (Math.abs(shortestAngleDelta(this.currentViewRotation, 0)) < 0.0008) {
      this.currentViewRotation = 0;
      cam.setRotation(0);
      cam.setScroll(0, 0);
      return;
    }
    cam.setScroll(arena.center.x - this.scale.width / 2, arena.center.y - this.scale.height / 2);
    cam.setRotation(this.currentViewRotation);
  }

  private renderArena() {
    const width = this.scale.width;
    const height = this.scale.height;
    const arena = this.arena();
    const theme = this.activeTheme();

    this.applyViewTransform(arena);

    // Fill behind the (possibly rotated) world so the viewport corners never
    // show through once the camera spins.
    this.cameras.main.setBackgroundColor(theme.background);
    this.gfx.clear();
    this.gfx.fillStyle(theme.background, 1);
    this.gfx.fillRect(0, 0, width, height);

    this.drawBackgroundRings(arena, theme);
    this.drawPlayerArcs(arena);
    this.drawTriangle(arena, theme);
    this.drawPaddles(arena);
    this.drawSeatFlash(arena);
    this.drawBallTrail(theme);
    this.drawServeIndicator(theme);
    this.drawPaddleImpactBursts();
    this.drawBall(theme);
    this.drawConfetti();
  }

  private drawBackgroundRings(arena: ArenaGeometry, theme: ThemeDefinition) {
    this.gfx.lineStyle(1, theme.ringDim, 0.55);
    this.gfx.strokeCircle(arena.center.x, arena.center.y, arena.radius * 0.5);
    this.gfx.strokeCircle(arena.center.x, arena.center.y, arena.radius * 0.75);
    this.gfx.lineStyle(2, theme.ringBright, 0.65);
    this.gfx.strokeCircle(arena.center.x, arena.center.y, arena.radius);
  }

  private drawPlayerArcs(arena: ArenaGeometry) {
    for (const player of this.activePlayers()) {
      this.gfx.lineStyle(8, player.color, 0.72);
      this.gfx.beginPath();
      this.gfx.arc(arena.center.x, arena.center.y, arena.radius, player.arcStart, player.arcEnd, false);
      this.gfx.strokePath();
    }
  }

  private drawArcBarriers(_arena: ArenaGeometry, _theme: ThemeDefinition) {
    // Barriers stay in collision only; the player dividers should be invisible.
  }

  private drawTriangle(arena: ArenaGeometry, theme: ThemeDefinition) {
    const vertices = triangleVertices(arena, this.sim.triangleRotation);
    this.gfx.fillStyle(theme.triangleFill, 1);
    this.gfx.lineStyle(2, theme.triangleStroke, 0.62);
    this.gfx.beginPath();
    this.gfx.moveTo(vertices[0].x, vertices[0].y);
    this.gfx.lineTo(vertices[1].x, vertices[1].y);
    this.gfx.lineTo(vertices[2].x, vertices[2].y);
    this.gfx.closePath();
    this.gfx.fillPath();
    this.gfx.strokePath();

    this.gfx.lineStyle(1, theme.triangleSpoke, 0.22);
    this.gfx.beginPath();
    this.gfx.moveTo(arena.center.x, arena.center.y);
    this.gfx.lineTo(vertices[0].x, vertices[0].y);
    this.gfx.moveTo(arena.center.x, arena.center.y);
    this.gfx.lineTo(vertices[1].x, vertices[1].y);
    this.gfx.moveTo(arena.center.x, arena.center.y);
    this.gfx.lineTo(vertices[2].x, vertices[2].y);
    this.gfx.strokePath();
  }

  private drawPaddles(arena: ArenaGeometry) {
    for (const player of this.activePlayers()) {
      this.gfx.fillStyle(player.color, 1);
      this.gfx.lineStyle(2, player.color, 1);
      this.gfx.beginPath();
      this.traceConcavePaddle(arena, player);
      this.gfx.closePath();
      this.gfx.fillPath();
      this.gfx.strokePath();
    }
  }

  /**
   * Brief expanding pulse around OUR OWN paddle right after the server seats
   * us (see handleSeated) — the "which paddle is mine?" answer for someone who
   * just jumped in from spectating.
   */
  private drawSeatFlash(arena: ArenaGeometry) {
    const net = this.net;
    if (!this.networked || !net || net.slot < 0) {
      return;
    }
    const remaining = this.seatFlashUntil - this.elapsed;
    if (remaining <= 0) {
      return;
    }
    const player = this.players[net.slot];
    if (!player || player.eliminated) {
      return;
    }

    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 0.02);
    const fade = Phaser.Math.Clamp(remaining / 600, 0, 1);
    const pos = paddleCenter(arena, player);

    this.gfx.lineStyle(3, 0xffffff, fade * (0.32 + 0.4 * pulse));
    this.gfx.strokeCircle(pos.x, pos.y, 26 + pulse * 8);
    this.gfx.lineStyle(5, player.color, fade * (0.28 + 0.5 * pulse));
    this.gfx.strokeCircle(pos.x, pos.y, 40 + pulse * 10);
  }

  private traceConcavePaddle(arena: ArenaGeometry, player: PlayerState) {
    const outline = paddleOutlinePoints(arena, player);
    outline.forEach((point, index) => {
      if (index === 0) {
        this.gfx.moveTo(point.position.x, point.position.y);
      } else {
        this.gfx.lineTo(point.position.x, point.position.y);
      }
    });
  }

  private drawBall(theme: ThemeDefinition) {
    this.gfx.fillStyle(theme.ball, 1);
    this.gfx.fillCircle(this.ball.x, this.ball.y, BALL_RADIUS);
    this.gfx.lineStyle(2, theme.ballGlow, 0.32);
    this.gfx.strokeCircle(this.ball.x, this.ball.y, BALL_RADIUS + 4);
  }

  private drawBallTrail(theme: ThemeDefinition) {
    for (let index = 0; index < this.ballTrail.length; index += 1) {
      const point = this.ballTrail[index];
      const age = this.elapsed - point.createdAt;
      const progress = Phaser.Math.Clamp(age / BALL_TRAIL_LIFETIME, 0, 1);
      const radius = Phaser.Math.Linear(BALL_RADIUS * 0.9, BALL_RADIUS * 0.22, progress);
      const alpha = Math.pow(1 - progress, 1.7) * 0.55;
      this.gfx.fillStyle(point.color || theme.ballGlow, alpha);
      this.gfx.fillCircle(point.position.x, point.position.y, radius);
    }
  }

  private drawServeIndicator(theme: ThemeDefinition) {
    if (this.mode !== "playing" || this.elapsed >= this.serveIndicatorUntil) {
      return;
    }

    const progress = Phaser.Math.Clamp(1 - (this.serveIndicatorUntil - this.elapsed) / SERVE_INDICATOR_LIFETIME, 0, 1);
    const alpha = Math.pow(1 - progress, 0.9) * 0.82;
    const direction = this.serveIndicatorDirection.clone().normalize();
    const start = this.ball.clone().add(direction.clone().scale(BALL_RADIUS + 8));
    const end = this.ball.clone().add(direction.scale(SERVE_INDICATOR_LENGTH));
    this.gfx.lineStyle(3, theme.ballGlow, alpha);
    this.gfx.lineBetween(start.x, start.y, end.x, end.y);
    this.gfx.fillStyle(theme.ballGlow, alpha);
    this.gfx.fillCircle(end.x, end.y, 3.5);
  }

  private updateBallTrail() {
    this.ballTrail = this.ballTrail.filter((point) => this.elapsed - point.createdAt <= BALL_TRAIL_LIFETIME);
    const last = this.ballTrail[this.ballTrail.length - 1];
    if (last && last.position.distance(this.ball) < BALL_TRAIL_SAMPLE_DISTANCE) {
      return;
    }

    this.ballTrail.push({
      position: this.ball.clone(),
      createdAt: this.elapsed,
      color: this.lastTouchPlayer()?.color ?? this.activeTheme().ballGlow
    });

    if (this.ballTrail.length > 34) {
      this.ballTrail.splice(0, this.ballTrail.length - 34);
    }
  }

  private trimBallTrail() {
    this.ballTrail = [{
      position: this.ball.clone(),
      createdAt: this.elapsed,
      color: this.lastTouchPlayer()?.color ?? this.activeTheme().ballGlow
    }];
  }

  // tangentSign arrives with the SimEvent (it depends on the pre-reflection
  // ball velocity, which is gone by the time the scene processes events).
  private spawnPaddleImpactBurst(contact: Vec2, radial: Vec2, tangent: Vec2, tangentSign: number) {
    this.paddleImpactBursts.push({
      position: new Phaser.Math.Vector2(contact.x, contact.y),
      radial: new Phaser.Math.Vector2(radial.x, radial.y).normalize(),
      tangent: new Phaser.Math.Vector2(tangent.x, tangent.y).normalize(),
      tangentSign,
      createdAt: this.elapsed
    });

    if (this.paddleImpactBursts.length > 16) {
      this.paddleImpactBursts.splice(0, this.paddleImpactBursts.length - 16);
    }
  }

  private drawPaddleImpactBursts() {
    this.paddleImpactBursts = this.paddleImpactBursts.filter((burst) => this.elapsed - burst.createdAt <= PADDLE_HIT_INDICATOR_LIFETIME);

    for (const burst of this.paddleImpactBursts) {
      const progress = Phaser.Math.Clamp((this.elapsed - burst.createdAt) / PADDLE_HIT_INDICATOR_LIFETIME, 0, 1);
      const alpha = Math.pow(1 - progress, 1.55);
      const length = Phaser.Math.Linear(PADDLE_HIT_INDICATOR_LENGTH, PADDLE_HIT_INDICATOR_LENGTH * 0.42, progress);
      const lineWidth = Phaser.Math.Linear(3, 1.2, progress);
      const inward = burst.radial.clone().scale(-1);
      const fanLeft = rotateVector(inward, -PADDLE_HIT_INDICATOR_FAN_ANGLE);
      const fanRight = rotateVector(inward, PADDLE_HIT_INDICATOR_FAN_ANGLE);
      const tangentTrail = burst.tangent.clone().scale(burst.tangentSign);

      this.gfx.lineStyle(lineWidth, 0xffffff, alpha);
      this.drawBurstStroke(burst.position, inward, length);
      this.drawBurstStroke(burst.position, fanLeft, length * 0.68);
      this.drawBurstStroke(burst.position, fanRight, length * 0.68);
      this.drawBurstStroke(burst.position, tangentTrail, length * 0.52);
    }
  }

  private drawBurstStroke(origin: Phaser.Math.Vector2, direction: Phaser.Math.Vector2, length: number) {
    const start = origin.clone().add(direction.clone().scale(PADDLE_HIT_INDICATOR_GAP));
    const end = origin.clone().add(direction.clone().scale(PADDLE_HIT_INDICATOR_GAP + length));
    this.gfx.lineBetween(start.x, start.y, end.x, end.y);
  }

  private playPaddleHitSound() {
    if (this.elapsed - this.lastPaddleHitSoundAt < PADDLE_HIT_SOUND_COOLDOWN) {
      return;
    }

    const key = PADDLE_HIT_SOUND_KEYS[Phaser.Math.Between(0, PADDLE_HIT_SOUND_KEYS.length - 1)];
    this.sound.play(key, { volume: PADDLE_HIT_SOUND_VOLUME * this.sfxVolume });
    this.lastPaddleHitSoundAt = this.elapsed;
  }

  private playWinFanfare() {
    const key = WIN_FANFARE_KEYS[Phaser.Math.Between(0, WIN_FANFARE_KEYS.length - 1)];
    this.sound.play(key, { volume: WIN_FANFARE_VOLUME * this.sfxVolume });
  }

  /** 3-2-1 tick — a fixed bright clonk so every second sounds identical. */
  private playCountdownTick() {
    this.sound.play("paddle-clonk-06", { volume: COUNTDOWN_TICK_VOLUME * this.sfxVolume });
  }

  private updateMusic() {
    if (this.mode !== "playing") {
      this.pauseMusic();
      return;
    }

    const track = this.currentMusicTrack();
    if (!track) {
      this.pauseMusic();
      return;
    }

    if (this.activeMusicKey !== track.key) {
      this.stopMusic();
      this.activeMusic = this.sound.add(track.key, {
        loop: true,
        volume: this.musicVolume
      });
      this.activeMusicKey = track.key;
    }

    this.setSoundVolume(this.activeMusic, this.musicVolume);
    if (this.activeMusic && !this.activeMusic.isPlaying) {
      this.activeMusic.play();
    }
  }

  private currentMusicTrack() {
    // Networked mode never advances the local sim's roundNumber, so gate music
    // on "server says we're playing" instead (the 3-2-1 countdown mirrors local
    // mode "playing" but should stay music-free). Offline keeps the original gate.
    const roundLive = this.networked ? this.net?.mode === "playing" : this.sim.roundNumber > 0;
    if (!roundLive || this.mode !== "playing") {
      return undefined;
    }

    const playerCount = this.activePlayers().length;
    if (playerCount >= 4) {
      return MUSIC_TRACKS[0];
    }

    if (playerCount === 3) {
      return MUSIC_TRACKS[1];
    }

    if (playerCount === 2) {
      return MUSIC_TRACKS[2];
    }

    return undefined;
  }

  private pauseMusic() {
    if (this.activeMusic?.isPlaying) {
      this.activeMusic.pause();
    }
  }

  private stopMusic() {
    if (this.activeMusic) {
      this.activeMusic.stop();
      this.activeMusic.destroy();
    }
    this.activeMusic = undefined;
    this.activeMusicKey = undefined;
  }

  private setVolume(target: VolumeTarget, volume: number) {
    const normalized = Phaser.Math.Clamp(volume, 0, 1);
    if (target === "music") {
      this.musicVolume = normalized;
      this.setSoundVolume(this.activeMusic, this.musicVolume);
    } else {
      this.sfxVolume = normalized;
    }
    this.emitHud();
  }

  private setSoundVolume(sound: Phaser.Sound.BaseSound | undefined, volume: number) {
    if (!sound) {
      return;
    }

    const adjustable = sound as Phaser.Sound.BaseSound & {
      setVolume?: (value: number) => Phaser.Sound.BaseSound;
      volume?: number;
    };

    if (adjustable.setVolume) {
      adjustable.setVolume(volume);
    } else {
      adjustable.volume = volume;
    }
  }

  private spawnWinConfetti(winner?: PlayerState) {
    const colors = this.activeTheme().playerColors.map((entry) => entry.color);
    if (winner) {
      colors.unshift(winner.color);
    }

    for (let side = 0; side < 2; side += 1) {
      const originX = side === 0 ? -10 : this.scale.width + 10;
      const direction = side === 0 ? 1 : -1;
      for (let index = 0; index < 34; index += 1) {
        this.confettiParticles.push({
          position: new Phaser.Math.Vector2(originX, Phaser.Math.Between(80, Math.max(120, this.scale.height - 80))),
          velocity: new Phaser.Math.Vector2(direction * Phaser.Math.Between(150, 310), Phaser.Math.Between(-190, 80)),
          color: colors[Phaser.Math.Between(0, colors.length - 1)],
          rotation: Phaser.Math.FloatBetween(0, TAU),
          angularVelocity: Phaser.Math.FloatBetween(-7, 7),
          size: Phaser.Math.Between(5, 10),
          createdAt: this.elapsed,
          lifetime: CONFETTI_LIFETIME + Phaser.Math.Between(-260, 360)
        });
      }
    }
  }

  private updateConfetti(dt: number) {
    this.confettiParticles = this.confettiParticles.filter((particle) => this.elapsed - particle.createdAt <= particle.lifetime);
    for (const particle of this.confettiParticles) {
      particle.velocity.y += 460 * dt;
      particle.velocity.x *= Math.pow(0.988, dt * 60);
      particle.position.add(particle.velocity.clone().scale(dt));
      particle.rotation += particle.angularVelocity * dt;
    }
  }

  private drawConfetti() {
    for (const particle of this.confettiParticles) {
      const age = this.elapsed - particle.createdAt;
      const alpha = Math.pow(1 - Phaser.Math.Clamp(age / particle.lifetime, 0, 1), 0.65);
      const half = particle.size / 2;
      const tangent = new Phaser.Math.Vector2(Math.cos(particle.rotation), Math.sin(particle.rotation));
      const normal = new Phaser.Math.Vector2(-tangent.y, tangent.x);
      const a = particle.position.clone().add(tangent.clone().scale(half)).add(normal.clone().scale(half * 0.42));
      const b = particle.position.clone().add(tangent.clone().scale(-half)).add(normal.clone().scale(half * 0.42));
      const c = particle.position.clone().add(tangent.clone().scale(-half)).add(normal.clone().scale(-half * 0.42));
      const d = particle.position.clone().add(tangent.clone().scale(half)).add(normal.clone().scale(-half * 0.42));

      this.gfx.fillStyle(particle.color, alpha);
      this.gfx.beginPath();
      this.gfx.moveTo(a.x, a.y);
      this.gfx.lineTo(b.x, b.y);
      this.gfx.lineTo(c.x, c.y);
      this.gfx.lineTo(d.x, d.y);
      this.gfx.closePath();
      this.gfx.fillPath();
    }
  }

  /**
   * Thin wrapper over the sim's resetRound: runs the pure serve math, then
   * routes the resulting "serve" event through applySimEvents (which sets the
   * serve indicator and clears trails/bursts, like the old method did).
   */
  private resetRound(targetAngle?: number, countRound = true) {
    this.applySimEvents(simResetRound(this.sim, this.arena(), this.rng, targetAngle, countRound));
  }

  public togglePause() {
    if (this.mode === "menu" || this.mode === "matchOver") {
      return;
    }

    this.mode = this.mode === "paused" ? "playing" : "paused";
    this.message = this.mode === "paused" ? "Paused. Press Esc, Space, or Resume to continue." : "Back in motion.";
    if (this.mode === "playing") {
      this.resumeRoundIfStalled();
    }
    this.emitHud();
  }

  /**
   * handleGoals() schedules resetRound via delayedCall gated on
   * mode === "playing". Pausing inside that window drops the reset and
   * leaves roundResolving stuck true (frozen ball). Every resume path calls
   * this to re-serve if that happened.
   */
  private resumeRoundIfStalled() {
    if (this.sim.roundResolving) {
      this.resetRound();
    }
  }

  private toggleBotFill() {
    // Networked: bot-fill is a server setting; ask the server to flip it and
    // let the next {t:"room"} echo it back. Don't mutate local sim state.
    if (this.networked && this.net) {
      this.net.sendSetBots(!this.net.botFill);
      return;
    }

    this.botFill = !this.botFill;
    this.message = this.botFill ? "Bot fill on for computer opponents. P1 stays yours." : "Bot fill off. P1 has the circle.";
    this.emitHud();
  }

  private setBotDifficulty(difficulty: BotDifficulty) {
    this.botDifficulty = difficulty;
    this.message = `Computer difficulty set to ${difficulty}.`;
    this.emitHud();
  }

  private setGameVariant(variant: GameVariant) {
    this.gameVariant = variant;
    this.message = variant === "rotating" ? "Orbit mode on. The whole circle rotates clockwise." : "Classic mode on. The arena holds steady.";
    this.emitHud();
  }

  private setTheme(themeId: ThemeId) {
    this.themeId = themeId;
    this.applyPlayerTheme();
    this.message = `Theme set to ${this.activeTheme().name}.`;
    this.emitHud();
  }

  private setTriangleMotionMode(mode: TriangleMotionMode) {
    this.triangleMotionMode = mode;
    if (mode === "steady") {
      this.sim.triangleAngularVelocity = TRIANGLE_ROTATION_SPEED;
    }
    this.message = mode === "steady" ? "Triangle motion set to steady spin." : "Triangle motion set to reactive hits.";
    this.emitHud();
  }

  private applyPlayerTheme() {
    const colors = this.activeTheme().playerColors;
    this.players.forEach((player, index) => {
      const color = colors[index % colors.length];
      player.color = color.color;
      player.cssColor = color.cssColor;
    });
  }

  private activeTheme() {
    return THEMES[this.themeId];
  }

  private arena(): ArenaGeometry {
    return computeArena(this.scale.width || 960, this.scale.height || 640);
  }

  private activePlayers() {
    return this.players.filter((player) => !player.eliminated);
  }

  private lastTouchPlayer() {
    return this.players.find((player) => player.id === this.sim.lastTouchPlayerId);
  }

  private handleResize(
    gameSize: Phaser.Structs.Size,
    _baseSize: Phaser.Structs.Size,
    _displaySize: Phaser.Structs.Size,
    previousWidth: number,
    previousHeight: number
  ) {
    if (this.sim.caughtByPlayerId !== undefined) {
      updateCaughtBall(this.sim, this.arena());
      return;
    }

    // Remap the ball into the new arena instead of re-serving: window drags,
    // devtools, and overlay reflows no longer reset the round mid-rally.
    const old = computeArena(previousWidth || gameSize.width, previousHeight || gameSize.height);
    const next = computeArena(gameSize.width, gameSize.height);
    const scale = next.radius / old.radius;
    this.ball.set(
      next.center.x + (this.ball.x - old.center.x) * scale,
      next.center.y + (this.ball.y - old.center.y) * scale
    );
    // Velocity magnitude is intentionally left unchanged; paddle angles are
    // radians and need no remap. Stale trail points would smear, so drop them.
    this.ballTrail = [];
    this.paddleImpactBursts = [];
  }

  private handleStartEvent = () => {
    this.startGame();
  };

  // Arcade HOME overlay (hub-injected /__arcade/home.js). Safe no-ops if the
  // overlay script never loads: these events simply never fire.
  private handleHomeOpen = () => {
    this.homeOverlayOpen = true;
    this.pausedByHomeOverlay = this.mode === "playing";
    if (this.pausedByHomeOverlay) {
      this.mode = "paused";
      this.message = "Paused for the arcade menu.";
      this.emitHud();
    }
    // While the clean HOME overlay is up, suppress the game's OWN pause-menu
    // card so the owner never sees two stacked menus. The card otherwise shows
    // whenever mode !== "playing" (see the four-pong:hud handler). CSS keys off
    // this body class to force #menu-overlay hidden.
    document.body.classList.add("arcade-home-active");
    // Mute everything (SFX one-shots included); music pauses itself via the
    // mode !== "playing" check in updateMusic().
    this.prevSoundMute = this.sound.mute;
    this.sound.mute = true;
  };

  private handleHomeClose = () => {
    this.sound.mute = this.prevSoundMute;
    // Restore the game's own pause-menu card (Esc / Pause-button pauses show it
    // again as normal).
    document.body.classList.remove("arcade-home-active");
    if (this.pausedByHomeOverlay && this.mode === "paused") {
      this.mode = "playing";
      this.message = "Back in motion.";
      this.resumeRoundIfStalled();
      this.emitHud();
    }
    this.pausedByHomeOverlay = false;
    // Keep the flag set until after this keydown dispatch finishes: the
    // overlay closes on the same Esc press the game's keydown handler will
    // still see, and it must ignore it instead of re-pausing.
    window.setTimeout(() => {
      this.homeOverlayOpen = false;
    }, 0);
  };

  private handlePauseEvent = () => {
    this.togglePause();
  };

  private handleBotEvent = () => {
    this.toggleBotFill();
  };

  private handleDifficultyEvent = (event: Event) => {
    const difficulty = (event as CustomEvent<BotDifficulty>).detail;
    if (difficulty === "easy" || difficulty === "medium" || difficulty === "hard") {
      this.setBotDifficulty(difficulty);
    }
  };

  private handleGameVariantEvent = (event: Event) => {
    const variant = (event as CustomEvent<GameVariant>).detail;
    if (variant === "classic" || variant === "rotating") {
      this.setGameVariant(variant);
    }
  };

  private handleThemeEvent = (event: Event) => {
    const themeId = (event as CustomEvent<ThemeId>).detail;
    if (themeId in THEMES) {
      this.setTheme(themeId);
    }
  };

  private handleTriangleMotionEvent = (event: Event) => {
    const mode = (event as CustomEvent<TriangleMotionMode>).detail;
    if (mode === "steady" || mode === "reactive") {
      this.setTriangleMotionMode(mode);
    }
  };

  private handleVolumeEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ target: VolumeTarget; volume: number }>).detail;
    if ((detail.target === "music" || detail.target === "sfx") && Number.isFinite(detail.volume)) {
      this.setVolume(detail.target, detail.volume);
    }
  };

  private handleSetNameEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ name: string }>).detail;
    if (detail && typeof detail.name === "string") {
      this.setPlayerName(detail.name);
    }
  };

  /**
   * Set the local display name: sanitize, persist, push to the server (live
   * rename if connected), and refresh the HUD. A blank entry falls back to a
   * fresh random name so a player is never left nameless.
   */
  private setPlayerName(raw: string) {
    const clean = sanitizePlayerName(raw) || randomPlayerName();
    this.playerName = clean;
    storePlayerName(clean);
    this.net?.setName(clean);
    // Reflect immediately in our own roster row offline (online the server
    // echoes the new name back via {room}); harmless to set in both.
    const localSlot = this.networked && this.net ? this.net.slot : 0;
    if (localSlot >= 0 && this.players[localSlot]) {
      this.players[localSlot].name = clean;
    }
    this.emitHud();
  }

  private handleWindowKeyDown = (event: KeyboardEvent) => {
    if (this.homeOverlayOpen) {
      return;
    }

    if (event.repeat) {
      return;
    }

    // Esc drives the game's OWN pause menu (Resume + Bot Fill card). The arcade
    // HOME overlay opts out of Esc via data-esc="off" on its <script> tag, so the
    // keystroke reaches us here. The early-return above means that while HOME is
    // open the overlay owns Esc (it closes itself) and we never toggle pause.
    if (event.code === "Escape") {
      event.preventDefault();
      this.togglePause();
      return;
    }

    // ONLINE session screens own Space first: spectator jump-in, ready toggle,
    // countdown cancel. handleSessionSpace returns true only when one of those
    // screens is active, so in live networked play Space falls through and
    // stays the charged-catch key (read via this.keys.pause in updateNetworked).
    if (event.code === "Space" && this.handleSessionSpace()) {
      event.preventDefault();
      return;
    }

    // Space still toggles pause while we're not actively playing (e.g. resume
    // from the pause screen).
    if (event.code === "Space" && this.mode !== "playing") {
      event.preventDefault();
      this.togglePause();
    }
  };

  /**
   * Space, scoped to the online session screens. Returns true when consumed:
   *   - spectator → {t:"join"} ("Jump in?"); ignored while already pending
   *   - seated on the lobby/matchOver ready screen → toggle {t:"ready"}
   *   - seated during the 3-2-1 → ready(false), which cancels the countdown
   * Returns false while offline, locally paused (pause card owns Space), or in
   * live play (Space is the catch key there).
   */
  private handleSessionSpace(): boolean {
    const net = this.net;
    if (!this.networked || !net || net.state !== "open") {
      return false;
    }
    if (this.mode === "paused") {
      return false;
    }
    if (net.slot < 0) {
      if (!net.joinPending) {
        net.sendJoin();
      }
      return true; // consume even while pending — no double-join, no pause leak
    }
    if (net.mode === "lobby" || net.mode === "matchOver") {
      net.sendReady(!(net.self?.ready ?? false));
      return true;
    }
    if (net.mode === "countdown") {
      net.sendReady(false);
      return true;
    }
    return false;
  }

  private handleJoinEvent = () => {
    if (this.networked && this.net && this.net.slot < 0) {
      this.net.sendJoin();
    }
  };

  private handleReadyToggleEvent = () => {
    const net = this.net;
    if (!this.networked || !net || net.slot < 0) {
      return;
    }
    if (net.mode === "lobby" || net.mode === "matchOver") {
      net.sendReady(!(net.self?.ready ?? false));
    } else if (net.mode === "countdown") {
      net.sendReady(false);
    }
  };

  private emitHud() {
    const state: HudState = {
      players: this.players.map(({ name, cssColor, shields, eliminated, charge }) => ({ name, cssColor, shields, eliminated, charge })),
      message: this.message,
      mode: this.mode,
      botFill: this.botFill,
      botDifficulty: this.botDifficulty,
      gameVariant: this.gameVariant,
      themeId: this.themeId,
      triangleMotionMode: this.triangleMotionMode,
      musicVolume: this.musicVolume,
      sfxVolume: this.sfxVolume,
      playerName: this.playerName,
      netSession: this.networked && this.mode !== "paused"
    };

    window.dispatchEvent(new CustomEvent<HudState>("four-pong:hud", { detail: state }));
    this.emitSession();
  }

  /**
   * Project the net-session state into the DOM layer's SessionUiState. All
   * screens collapse to hidden while offline or locally paused (the pause card
   * takes the overlay); the HOME overlay hides everything via the
   * body.arcade-home-active CSS class instead.
   */
  private emitSession() {
    const net = this.net;
    const state: SessionUiState = {
      banner: "none",
      showReady: false,
      matchOver: false,
      resultLine: "",
      rows: [],
      selfReady: false,
      waitingFor: 0,
      countdown: null,
      seated: false
    };

    if (this.networked && net && net.state === "open" && this.mode !== "paused") {
      state.seated = net.slot >= 0;

      if (net.slot < 0) {
        state.banner = net.joinPending ? "pending" : "watching";
      }

      if (net.mode === "countdown") {
        state.countdown = net.countdown ?? COUNTDOWN_SECONDS;
      }

      if (net.slot >= 0 && (net.mode === "lobby" || net.mode === "matchOver")) {
        state.showReady = true;
        state.matchOver = net.mode === "matchOver";
        state.resultLine = state.matchOver ? this.lastResultLine || "Match over." : "";
        state.rows = [...net.players]
          .sort((a, b) => a.slot - b.slot)
          .map((p) => ({
            slot: p.slot,
            name: p.name || `P${p.slot + 1}`,
            isBot: p.isBot,
            connected: p.connected,
            ready: p.ready,
            isSelf: p.slot === net.slot,
            cssColor: this.players[p.slot]?.cssColor ?? "#ffffff"
          }));
        state.selfReady = net.self?.ready ?? false;
        state.waitingFor = net.players.filter((p) => !p.isBot && p.connected && !p.ready).length;
      }
    }

    window.dispatchEvent(new CustomEvent<SessionUiState>("four-pong:session", { detail: state }));
  }
}

// The simulation/geometry helper functions that used to live here moved to
// src/sim/ (math.ts / geometry.ts / physics.ts / bot.ts) as pure modules.
// Only render-side helpers remain below.

function rotateVector(vector: Phaser.Math.Vector2, radians: number) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new Phaser.Math.Vector2(
    vector.x * cos - vector.y * sin,
    vector.x * sin + vector.y * cos
  );
}

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "game-root",
  backgroundColor: "#061016",
  scale: {
    mode: Phaser.Scale.RESIZE,
    parent: "game-root",
    autoRound: true
  },
  scene: FourPongScene,
  render: {
    antialias: true,
    pixelArt: false
  }
});

const scoreStrip = document.querySelector<HTMLDivElement>("#score-strip")!;
const statusChip = document.querySelector<HTMLDivElement>("#status-chip")!;
const pauseButton = document.querySelector<HTMLButtonElement>("#pause-button")!;
const menuOverlay = document.querySelector<HTMLDivElement>("#menu-overlay")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const botToggleButton = document.querySelector<HTMLButtonElement>("#bot-toggle-button")!;
const menuBotState = document.querySelector<HTMLSpanElement>("#menu-bot-state")!;
const menuTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-menu-tab]"));
const menuTabPanels = Array.from(document.querySelectorAll<HTMLDivElement>("[data-menu-panel]"));
const difficultyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-difficulty]"));
const menuDifficultyState = document.querySelector<HTMLSpanElement>("#menu-difficulty-state")!;
const gameVariantButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-game-variant]"));
const menuGameVariantState = document.querySelector<HTMLSpanElement>("#menu-game-variant-state")!;
const themeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"));
const menuThemeState = document.querySelector<HTMLSpanElement>("#menu-theme-state")!;
const triangleMotionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-triangle-motion]"));
const menuTriangleState = document.querySelector<HTMLSpanElement>("#menu-triangle-state")!;
const musicVolumeInput = document.querySelector<HTMLInputElement>("#music-volume")!;
const sfxVolumeInput = document.querySelector<HTMLInputElement>("#sfx-volume")!;
const playerNameInput = document.querySelector<HTMLInputElement>("#player-name-input")!;
const playerNameRandomButton = document.querySelector<HTMLButtonElement>("#player-name-random")!;
const menuMusicVolume = document.querySelector<HTMLElement>("#menu-music-volume")!;
const menuSfxVolume = document.querySelector<HTMLElement>("#menu-sfx-volume")!;
const menuMusicState = document.querySelector<HTMLElement>("#menu-music-state")!;

// --- Online session layer (Stage 2) -----------------------------------------
// Spectator banner + ready panel + 3-2-1 countdown, injected next to the other
// overlays and driven entirely by "four-pong:session" events from the scene.
// Styled with the same dark panel tokens as the rest of the shell (styles.css).
document.querySelector<HTMLElement>("#game-shell")!.insertAdjacentHTML(
  "beforeend",
  `<div id="session-overlay" hidden>
    <div class="session-banner" id="session-banner" hidden>
      <span class="live-dot" aria-hidden="true"></span>
      <span id="session-banner-text">LIVE — watching</span>
      <button id="session-join-button" type="button">Jump In (Space)</button>
    </div>
    <div class="session-panel" id="session-ready-panel" role="dialog" aria-label="Online lobby" hidden>
      <span class="mode-kicker" id="session-kicker">Online lobby</span>
      <h2 id="session-result" hidden></h2>
      <ul id="session-roster"></ul>
      <button id="session-ready-button" type="button">Ready (Space)</button>
      <p id="session-status">Press Space when you're ready.</p>
    </div>
    <div class="session-countdown" id="session-countdown" hidden>
      <span id="session-countdown-number">3</span>
      <span class="session-countdown-hint" id="session-countdown-hint">Space — cancel</span>
    </div>
  </div>`
);

const sessionOverlay = document.querySelector<HTMLDivElement>("#session-overlay")!;
const sessionBanner = document.querySelector<HTMLDivElement>("#session-banner")!;
const sessionBannerText = document.querySelector<HTMLSpanElement>("#session-banner-text")!;
const sessionJoinButton = document.querySelector<HTMLButtonElement>("#session-join-button")!;
const sessionReadyPanel = document.querySelector<HTMLDivElement>("#session-ready-panel")!;
const sessionKicker = document.querySelector<HTMLSpanElement>("#session-kicker")!;
const sessionResult = document.querySelector<HTMLHeadingElement>("#session-result")!;
const sessionRoster = document.querySelector<HTMLUListElement>("#session-roster")!;
const sessionReadyButton = document.querySelector<HTMLButtonElement>("#session-ready-button")!;
const sessionStatus = document.querySelector<HTMLParagraphElement>("#session-status")!;
const sessionCountdown = document.querySelector<HTMLDivElement>("#session-countdown")!;
const sessionCountdownNumber = document.querySelector<HTMLSpanElement>("#session-countdown-number")!;
const sessionCountdownHint = document.querySelector<HTMLSpanElement>("#session-countdown-hint")!;

window.addEventListener("four-pong:hud", (event) => {
  const state = (event as CustomEvent<HudState>).detail;
  scoreStrip.innerHTML = state.players.map((player) => {
    const shields = Array.from({ length: MAX_SHIELDS }, (_, index) => {
      const live = index < player.shields;
      return `<span class="pip ${live ? "live" : ""}" style="--player-color: ${player.cssColor}"></span>`;
    }).join("");
    const charge = Phaser.Math.Clamp(player.charge / MAX_CHARGE, 0, 1);
    return `<article class="score-card ${player.eliminated ? "out" : ""}">
      <span class="name" style="--player-color: ${player.cssColor}">${escapeHtml(player.name)}</span>
      <span class="pips">${shields}</span>
      <span class="charge-meter" aria-label="${player.name} charge ${player.charge} of ${MAX_CHARGE}">
        <span style="--player-color: ${player.cssColor}; --charge: ${charge}"></span>
      </span>
    </article>`;
  }).join("");

  statusChip.textContent = `${state.message} ${state.botFill ? "Bot fill on." : "Bot fill off."}`;
  pauseButton.textContent = state.mode === "paused" ? "Resume" : "Pause";
  pauseButton.disabled = state.mode === "menu" || state.mode === "matchOver";
  // Hide the legacy offline menu card while playing AND while the online
  // session screens own the overlay layer (ready panel/banner/countdown). The
  // local pause card (mode "paused" → netSession false) still shows it.
  menuOverlay.hidden = state.mode === "playing" || state.netSession;
  startButton.textContent = state.mode === "paused" ? "Resume" : state.mode === "matchOver" ? "Start Again" : "Start";
  botToggleButton.textContent = state.botFill ? "Bot Fill: On" : "Bot Fill: Off";
  menuBotState.textContent = state.botFill ? "On" : "Off";
  menuDifficultyState.textContent = titleCase(state.botDifficulty);
  menuGameVariantState.textContent = state.gameVariant === "rotating" ? "Orbit" : "Classic";
  menuThemeState.textContent = THEMES[state.themeId].name;
  menuTriangleState.textContent = titleCase(state.triangleMotionMode);
  const musicPercent = Math.round(state.musicVolume * 100);
  const sfxPercent = Math.round(state.sfxVolume * 100);
  musicVolumeInput.value = String(musicPercent);
  sfxVolumeInput.value = String(sfxPercent);
  menuMusicVolume.textContent = `${musicPercent}%`;
  menuSfxVolume.textContent = `${sfxPercent}%`;
  menuMusicState.textContent = `${musicPercent}%`;
  // Don't clobber the field while the player is mid-edit.
  if (document.activeElement !== playerNameInput) {
    playerNameInput.value = state.playerName;
  }
  document.body.dataset.theme = THEMES[state.themeId].shellTheme;
  difficultyButtons.forEach((button) => {
    const active = button.dataset.difficulty === state.botDifficulty;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  gameVariantButtons.forEach((button) => {
    const active = button.dataset.gameVariant === state.gameVariant;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  themeButtons.forEach((button) => {
    const active = button.dataset.themeChoice === state.themeId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  triangleMotionButtons.forEach((button) => {
    const active = button.dataset.triangleMotion === state.triangleMotionMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
});

// --- Online session renderer -------------------------------------------------
// The scene emits "four-pong:session" on every HUD refresh (which, while
// networked, is every frame) — memoize on the serialized state so the DOM only
// changes when the session actually does.
let lastSessionKey = "";

window.addEventListener("four-pong:session", (event) => {
  const s = (event as CustomEvent<SessionUiState>).detail;
  const key = JSON.stringify(s);
  if (key === lastSessionKey) {
    return;
  }
  lastSessionKey = key;

  sessionOverlay.hidden = s.banner === "none" && !s.showReady && s.countdown === null;
  sessionBanner.hidden = s.banner === "none";
  sessionReadyPanel.hidden = !s.showReady;
  sessionCountdown.hidden = s.countdown === null;

  if (s.banner === "watching") {
    sessionBannerText.textContent = "LIVE — watching · press Space to jump in";
    sessionJoinButton.hidden = false;
  } else if (s.banner === "pending") {
    sessionBannerText.textContent = "Joining at next serve…";
    sessionJoinButton.hidden = true;
  }

  if (s.showReady) {
    sessionKicker.textContent = s.matchOver ? "Match over" : "Online lobby";
    sessionResult.hidden = !s.matchOver;
    sessionResult.textContent = s.resultLine;
    sessionRoster.innerHTML = s.rows
      .map((row) => {
        const tag = row.isBot
          ? `<span class="tag bot">BOT</span>`
          : !row.connected
            ? `<span class="tag offline">OFFLINE</span>`
            : row.ready
              ? `<span class="tag ready">READY</span>`
              : `<span class="tag waiting">&hellip;</span>`;
        return `<li class="${row.isSelf ? "self" : ""}" style="--player-color: ${row.cssColor}">
          <span class="seat">P${row.slot + 1}</span>
          <span class="player-name">${escapeHtml(row.name)}${row.isSelf ? " (you)" : ""}</span>
          ${tag}
        </li>`;
      })
      .join("");
    sessionReadyButton.textContent = s.selfReady ? "Ready ✓ (Space to cancel)" : "Ready (Space)";
    sessionReadyButton.classList.toggle("armed", s.selfReady);
    sessionStatus.textContent = !s.selfReady
      ? "Press Space when you're ready."
      : s.waitingFor > 0
        ? `Waiting for ${s.waitingFor} more player${s.waitingFor === 1 ? "" : "s"}…`
        : "All set — starting…";
  }

  if (s.countdown !== null) {
    sessionCountdownHint.hidden = !s.seated;
    const text = String(Math.max(1, Math.ceil(s.countdown)));
    if (sessionCountdownNumber.textContent !== text) {
      sessionCountdownNumber.textContent = text;
      // Restart the pop animation for each new digit.
      sessionCountdownNumber.classList.remove("pop");
      void sessionCountdownNumber.offsetWidth;
      sessionCountdownNumber.classList.add("pop");
    }
  }
});

sessionJoinButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:join"));
  sessionJoinButton.blur(); // keep a later Space from re-clicking the button
});

sessionReadyButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:ready-toggle"));
  sessionReadyButton.blur(); // Space must hit the window handler, not this button
});

startButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:start"));
});

botToggleButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:toggle-bots"));
});

menuTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.menuTab;
    menuTabs.forEach((entry) => entry.classList.toggle("active", entry === button));
    menuTabPanels.forEach((panel) => {
      panel.hidden = panel.dataset.menuPanel !== target;
    });
  });
});

difficultyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const difficulty = button.dataset.difficulty;
    if (difficulty === "easy" || difficulty === "medium" || difficulty === "hard") {
      window.dispatchEvent(new CustomEvent<BotDifficulty>("four-pong:set-difficulty", { detail: difficulty }));
    }
  });
});

gameVariantButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const variant = button.dataset.gameVariant;
    if (variant === "classic" || variant === "rotating") {
      window.dispatchEvent(new CustomEvent<GameVariant>("four-pong:set-game-variant", { detail: variant }));
    }
  });
});

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const themeId = button.dataset.themeChoice;
    if (themeId && themeId in THEMES) {
      window.dispatchEvent(new CustomEvent<ThemeId>("four-pong:set-theme", { detail: themeId as ThemeId }));
    }
  });
});

triangleMotionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.triangleMotion;
    if (mode === "steady" || mode === "reactive") {
      window.dispatchEvent(new CustomEvent<TriangleMotionMode>("four-pong:set-triangle-motion", { detail: mode }));
    }
  });
});

function bindVolumeInput(input: HTMLInputElement, target: VolumeTarget) {
  input.addEventListener("input", () => {
    window.dispatchEvent(new CustomEvent<{ target: VolumeTarget; volume: number }>("four-pong:set-volume", {
      detail: {
        target,
        volume: Number(input.value) / 100
      }
    }));
  });
}

bindVolumeInput(musicVolumeInput, "music");
bindVolumeInput(sfxVolumeInput, "sfx");

function commitPlayerName(name: string) {
  window.dispatchEvent(new CustomEvent<{ name: string }>("four-pong:set-name", { detail: { name } }));
}
// Commit the typed name when the field loses focus or Enter is pressed (not on
// every keystroke — that would fire a server rename per character).
playerNameInput.addEventListener("change", () => commitPlayerName(playerNameInput.value));
playerNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    playerNameInput.blur();
  }
});
playerNameRandomButton.addEventListener("click", () => {
  const fresh = randomPlayerName();
  playerNameInput.value = fresh;
  commitPlayerName(fresh);
});

pauseButton.addEventListener("click", () => {
  // The on-screen Pause button toggles the GAME's own pause menu (Resume + Bot
  // Fill card). The arcade HOME overlay is reached only from its floating house
  // button (.ah-fab), never from here.
  window.dispatchEvent(new Event("four-pong:toggle-pause"));
});

void game;

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

// --- player name (random default, editable, persisted) ----------------------

const PLAYER_NAME_KEY = "four-ponq:player-name";
const PLAYER_NAME_NOUNS = [
  "Falcon", "Comet", "Pixel", "Volt", "Ember", "Nova", "Quartz", "Zephyr",
  "Onyx", "Cobra", "Lynx", "Drift", "Maple", "Rune", "Glyph", "Vapor",
  "Echo", "Flint", "Bolt", "Wisp", "Jet", "Sage", "Koi", "Pulse"
] as const;

/** Strip control/non-ASCII chars, trim, cap at 12 (mirrors the server's clamp). */
function sanitizePlayerName(raw: string): string {
  return raw.replace(/[^ -~]/g, "").trim().slice(0, 12);
}

/** A short, friendly random handle like "Volt42" (always <= 12 chars). */
function randomPlayerName(): string {
  const noun = PLAYER_NAME_NOUNS[Math.floor(Math.random() * PLAYER_NAME_NOUNS.length)];
  const suffix = 10 + Math.floor(Math.random() * 90);
  return `${noun}${suffix}`.slice(0, 12);
}

/** Read the saved name (sanitized); mint + persist a random one on first run. */
function loadOrCreatePlayerName(): string {
  try {
    const stored = localStorage.getItem(PLAYER_NAME_KEY);
    const clean = stored ? sanitizePlayerName(stored) : "";
    if (clean) {
      return clean;
    }
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to a fresh name.
  }
  const fresh = randomPlayerName();
  storePlayerName(fresh);
  return fresh;
}

function storePlayerName(name: string): void {
  try {
    localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch {
    // Best-effort; a non-persisted name is still fine for the session.
  }
}

/** Server-provided names flow into innerHTML — escape them. */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
