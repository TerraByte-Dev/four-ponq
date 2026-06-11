import Phaser from "phaser";
import "./styles.css";

type GameMode = "menu" | "playing" | "paused" | "matchOver";
type BotDifficulty = "easy" | "medium" | "hard";
type TouchType = "none" | "player" | "triangle";
type ThemeId = "neon" | "solar" | "deepSea" | "candy" | "mono";
type TriangleMotionMode = "steady" | "reactive";
type GameVariant = "classic" | "rotating";
type VolumeTarget = "music" | "sfx";

interface InputAction {
  counterclockwise: boolean;
  clockwise: boolean;
}

interface PlayerState {
  id: number;
  name: string;
  color: number;
  cssColor: string;
  shields: number;
  eliminated: boolean;
  paddleAngle: number;
  arcStart: number;
  arcEnd: number;
  humanControlled: boolean;
  lastHumanInputAt: number;
  charge: number;
  paddleAssistMultiplier: number;
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
}

interface ArenaGeometry {
  center: Phaser.Math.Vector2;
  radius: number;
  paddleThickness: number;
  paddleAngleSpan: number;
  triangleRadius: number;
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

interface PaddleCollisionHit {
  contact: Phaser.Math.Vector2;
  normal: Phaser.Math.Vector2;
  radial: Phaser.Math.Vector2;
  offset: number;
  penetration: number;
  crossed: boolean;
}

interface PaddleSegment {
  start: Phaser.Math.Vector2;
  end: Phaser.Math.Vector2;
  offset: number;
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

const MAX_SHIELDS = 5;
const BALL_RADIUS = 10;
const TAU = Math.PI * 2;
const TRIANGLE_GRAVITY = 21000;
const TRIANGLE_ROTATION_SPEED = 0.34;
const TRIANGLE_REACTIVE_DAMPING = 0.997;
const TRIANGLE_REACTIVE_MIN_SPEED = 0.12;
const TRIANGLE_REACTIVE_MAX_SPEED = 3.05;
const TRIANGLE_PHASE_DELAY = 1000;
const PADDLE_CURVE_RESPONSE = 0.72;
const PADDLE_RELEASE_GAP = 2.5;
const PADDLE_CONCAVITY = 0.48;
const PADDLE_WING_LENGTH_MIN = 16;
const PADDLE_WING_LENGTH_RATIO = 0.045;
const MAX_CHARGE = 10;
const REPEAT_HIT_BOOST = 1.08;
const CATCH_DURATION = 3000;
const CATCH_LAUNCH_BOOST = 2;
const SPAWN_DELAY = 850;
const BASE_BALL_SPEED = 380;
const MENU_BALL_SPEED = 180;
const BASE_PADDLE_SPEED = 2.3625;
const PADDLE_SPEED_RAMP = 0.045;
const MAX_PADDLE_SPEED_MULTIPLIER = 1.36;
const PADDLE_MOVE_ASSIST = 0.1;
const PADDLE_ASSIST_ACCELERATION = 6.5;
const PADDLE_ASSIST_DECELERATION = 9.5;
const ROTATING_VARIANT_PADDLE_SPEED_BOOST = 1.05;
const ARENA_ROTATION_SPEED = 0.18;
const MAX_BALL_SPEED = 840;
const MAX_CHARGED_BALL_SPEED = 980;
const SERVE_INDICATOR_LIFETIME = 1700;
const SERVE_INDICATOR_LENGTH = 62;
const BALL_TRAIL_LIFETIME = 360;
const BALL_TRAIL_SAMPLE_DISTANCE = 10;
const ARC_BARRIER_HALF_ANGLE = 0.04125;
const ARC_BARRIER_INSET = 6;
const ARC_BARRIER_THICKNESS = 15;
const CONFETTI_LIFETIME = 1500;
const PADDLE_HIT_INDICATOR_LIFETIME = 170;
const PADDLE_HIT_INDICATOR_LENGTH = 34;
const PADDLE_HIT_INDICATOR_GAP = 4;
const PADDLE_HIT_INDICATOR_FAN_ANGLE = 0.48;
const PADDLE_HIT_SOUND_COOLDOWN = 500;
const PADDLE_HIT_SOUND_VOLUME = 0.56;
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

const BOT_DIFFICULTY_SPEED: Record<BotDifficulty, number> = {
  easy: 0.42,
  medium: 0.68,
  hard: 0.94
};

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
  private mode: GameMode = "menu";
  private message = "Circular 4 Player is ready.";
  private botFill = true;
  private botDifficulty: BotDifficulty = "medium";
  private gameVariant: GameVariant = "classic";
  private themeId: ThemeId = "neon";
  private triangleMotionMode: TriangleMotionMode = "steady";
  private musicVolume = 0.58;
  private sfxVolume = 0.82;
  private triangleRotation = -Math.PI / 2;
  private triangleAngularVelocity = TRIANGLE_ROTATION_SPEED;
  private elapsed = 0;
  private lastScoreAt = 0;
  private triangleCollisionDisabledUntil = 0;
  private roundNumber = 0;
  private roundResolving = false;
  private lastTouchType: TouchType = "none";
  private lastTouchPlayerId?: number;
  private caughtByPlayerId?: number;
  private caughtAt = 0;
  private caughtLaunchSpeed = 0;
  private roundReadyAt = 0;
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

  constructor() {
    super("four-pong");
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
      this.createPlayer(1, "P1", 0x62e6ff, "#62e6ff"),
      this.createPlayer(2, "P2", 0xff6f91, "#ff6f91"),
      this.createPlayer(3, "P3", 0xf8d66d, "#f8d66d"),
      this.createPlayer(4, "P4", 0x69db7c, "#69db7c")
    ];
    this.applyPlayerTheme();

    this.scale.on("resize", this.handleResize, this);
    this.rebuildArcs();
    this.resetRound(undefined, false);
    this.emitHud();
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
    window.removeEventListener("keydown", this.handleWindowKeyDown);
    window.removeEventListener("arcade:home-open", this.handleHomeOpen);
    window.removeEventListener("arcade:home-close", this.handleHomeClose);
    this.stopMusic();
  }

  update(_time: number, delta: number) {
    const dt = Math.min(delta / 1000, 0.034);
    this.elapsed += delta;

    if (Phaser.Input.Keyboard.JustDown(this.keys.reset)) {
      this.restartMatch();
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.bot)) {
      this.toggleBotFill();
    }

    this.updateTriangleMotion(dt);
    this.updateBallTrail();
    this.updateConfetti(dt);
    this.updateMusic();

    if (this.mode === "playing") {
      this.updateArenaRotation(dt);
      this.updatePaddles(dt);
      if (this.caughtByPlayerId !== undefined) {
        this.updateCaughtBall();
        if (!this.keys.pause.isDown || this.elapsed - this.caughtAt >= CATCH_DURATION) {
          this.launchCaughtBall();
        }
      } else if (this.elapsed < this.roundReadyAt) {
        // Give players a readable beat before the serve starts moving.
      } else {
        this.applyTriangleGravity(dt, 275, MAX_BALL_SPEED);
        this.advanceBall(dt);
      }
    } else if (this.mode === "menu") {
      this.previewMenuMotion(dt);
    }

    this.renderArena();
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

    this.roundNumber = 0;
    this.clearTouchState();
    this.clearCatchState();
    this.roundResolving = false;
    this.confettiParticles = [];
    this.mode = "playing";
    this.message = message;
    this.rebuildArcs();
    this.resetRound();
    this.emitHud();
  }

  private updatePaddles(dt: number) {
    const action = this.readLocalAction();
    const human = this.players.find((player) => player.humanControlled && !player.eliminated);
    const speed = BASE_PADDLE_SPEED * this.paddleSpeedMultiplier() * this.variantPaddleSpeedMultiplier();
    const humanMoving = action.counterclockwise || action.clockwise;

    if (human) {
      this.updatePaddleAssist(human, dt, humanMoving);
    }

    if (human && humanMoving) {
      const direction = (action.clockwise ? 1 : 0) - (action.counterclockwise ? 1 : 0);
      human.paddleAngle += direction * speed * human.paddleAssistMultiplier * dt;
      human.lastHumanInputAt = this.elapsed;
      this.clampPaddleToArc(human);
    }

    if (!this.botFill) {
      return;
    }

    const targetAngle = normalizeAngle(Math.atan2(this.ball.y - this.arena().center.y, this.ball.x - this.arena().center.x));
    const botSpeed = speed * BOT_DIFFICULTY_SPEED[this.botDifficulty];
    for (const player of this.players) {
      if (player.eliminated || player.humanControlled) {
        continue;
      }

      const target = clampAngleToArc(targetAngle, player.arcStart, player.arcEnd, this.paddleSafetyMargin(player));
      const delta = shortestAngleDelta(player.paddleAngle, target);
      player.paddleAngle = normalizeAngle(player.paddleAngle + Phaser.Math.Clamp(delta, -botSpeed * dt, botSpeed * dt));
      this.clampPaddleToArc(player);
    }
  }

  private updatePaddleAssist(player: PlayerState, dt: number, moving: boolean) {
    const arena = this.arena();
    const distanceToPaddle = this.ball.distance(this.paddleCenter(arena, player));
    const closeDistance = arena.radius * 0.42;
    const farDistance = arena.radius;
    const farFactor = Phaser.Math.Clamp((distanceToPaddle - closeDistance) / Math.max(farDistance - closeDistance, 1), 0, 1);
    const target = moving ? 1 + PADDLE_MOVE_ASSIST * farFactor : 1;
    const rate = target > player.paddleAssistMultiplier ? PADDLE_ASSIST_ACCELERATION : PADDLE_ASSIST_DECELERATION;
    const smoothing = 1 - Math.exp(-rate * dt);
    player.paddleAssistMultiplier = Phaser.Math.Linear(player.paddleAssistMultiplier, target, smoothing);
  }

  private readLocalAction(): InputAction {
    return {
      counterclockwise: this.keys.counterclockwise.isDown,
      clockwise: this.keys.clockwise.isDown
    };
  }

  private handlePaddleCollisions(previousBall?: Phaser.Math.Vector2) {
    const arena = this.arena();
    for (const player of this.activePlayers()) {
      const hit = this.paddleHitTest(arena, player, previousBall);
      if (!hit) {
        continue;
      }

      if (this.velocity.dot(hit.normal) >= 0 && !hit.crossed && hit.penetration <= 0) {
        continue;
      }

      const tangent = new Phaser.Math.Vector2(-hit.radial.y, hit.radial.x);
      const roundedNormal = hit.normal.clone().add(tangent.clone().scale(hit.offset * PADDLE_CURVE_RESPONSE)).normalize();
      const repeatHit = this.lastTouchType === "player" && this.lastTouchPlayerId === player.id;

      this.addCharge(player);
      this.spawnPaddleImpactBurst(hit.contact, hit.radial, tangent);
      this.playPaddleHitSound();

      if (this.canCatchBall(player)) {
        this.startCatch(player);
        return;
      }

      if (this.velocity.dot(roundedNormal) < 0 || hit.crossed) {
        this.reflectBall(roundedNormal);
      }

      if (repeatHit) {
        this.boostBallSpeed(REPEAT_HIT_BOOST);
        this.message = `${player.name} double-tapped the ball.`;
      }
      this.lastTouchType = "player";
      this.lastTouchPlayerId = player.id;
      this.ball.copy(hit.contact.add(roundedNormal.scale(BALL_RADIUS + PADDLE_RELEASE_GAP)));
      this.trimBallTrail();
      this.emitHud();
      return;
    }
  }

  private advanceBall(dt: number) {
    const distance = this.velocity.length() * dt;
    const steps = Math.max(1, Math.ceil(distance / (BALL_RADIUS * 0.65)));
    const stepDt = dt / steps;

    for (let index = 0; index < steps; index += 1) {
      const previousBall = this.ball.clone();
      this.ball.add(this.velocity.clone().scale(stepDt));
      this.handleTriangleCollision();
      this.handleArcBarrierCollisions(previousBall);
      this.handlePaddleCollisions(previousBall);
      this.handleGoals();

      if (this.roundResolving || this.caughtByPlayerId !== undefined || this.mode !== "playing") {
        return;
      }
    }
  }

  private paddleHitTest(arena: ArenaGeometry, player: PlayerState, previousBall?: Phaser.Math.Vector2): PaddleCollisionHit | undefined {
    const center = this.paddleCenter(arena, player);
    const radial = center.clone().subtract(arena.center).normalize();
    const tangent = new Phaser.Math.Vector2(-radial.y, radial.x);
    const segments = this.paddleCollisionSegments(arena, player);
    let best:
      | {
        contact: Phaser.Math.Vector2;
        distance: number;
        offset: number;
      }
      | undefined;

    for (const segment of segments) {
      const contact = closestPointOnSegment(this.ball, segment.start, segment.end);
      const distance = contact.distance(this.ball);
      if (!best || distance < best.distance) {
        best = { contact, distance, offset: segment.offset };
      }
    }

    if (best && best.distance <= BALL_RADIUS) {
      const normal = this.paddleHitNormal(arena, best.contact, best.offset, center, tangent, radial);
      const separation = this.ball.clone().subtract(best.contact);
      return {
        contact: best.contact,
        normal: separation.lengthSq() > 0.0001 ? separation.normalize() : normal,
        radial,
        offset: best.offset,
        penetration: BALL_RADIUS - best.distance,
        crossed: false
      };
    }

    if (!previousBall) {
      return undefined;
    }

    return this.paddleSweptHitTest(previousBall, arena, center, radial, tangent, segments);
  }

  private paddleSweptHitTest(
    previousBall: Phaser.Math.Vector2,
    arena: ArenaGeometry,
    center: Phaser.Math.Vector2,
    radial: Phaser.Math.Vector2,
    tangent: Phaser.Math.Vector2,
    segments: PaddleSegment[]
  ): PaddleCollisionHit | undefined {
    const travel = this.ball.clone().subtract(previousBall);
    if (travel.lengthSq() === 0) {
      return undefined;
    }

    let best:
      | {
        contact: Phaser.Math.Vector2;
        distance: number;
        offset: number;
      }
      | undefined;

    for (const segment of segments) {
      const closest = closestPointsBetweenSegments(previousBall, this.ball, segment.start, segment.end);
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

    const separation = this.ball.clone().subtract(best.contact);
    const normal = this.paddleHitNormal(arena, best.contact, best.offset, center, tangent, radial);

    return {
      contact: best.contact,
      normal: separation.lengthSq() > 0.0001 ? separation.normalize() : normal,
      radial,
      offset: best.offset,
      penetration: BALL_RADIUS - best.distance,
      crossed: true
    };
  }

  private paddleHitNormal(
    arena: ArenaGeometry,
    contact: Phaser.Math.Vector2,
    offset: number,
    center: Phaser.Math.Vector2,
    tangent: Phaser.Math.Vector2,
    radial: Phaser.Math.Vector2
  ) {
    const halfHeight = this.paddleHalfHeight(arena);
    const concaveHalfWidth = this.paddleConcaveHalfWidth(arena);
    const local = contact.clone().subtract(center);
    const localY = local.dot(radial);

    if (localY > halfHeight * 0.5) {
      return radial.clone();
    }

    const slope = this.paddleInnerSlope(Phaser.Math.Clamp(offset, -1, 1), concaveHalfWidth, halfHeight);
    const curveNormal = tangent.clone().scale(slope).subtract(radial).normalize();
    return curveNormal;
  }

  private paddleCollisionSegments(arena: ArenaGeometry, player: PlayerState): PaddleSegment[] {
    const outline = this.paddleOutlinePoints(arena, player);
    return outline.map((point, index) => {
      const next = outline[(index + 1) % outline.length];
      return {
        start: point.position,
        end: next.position,
        offset: (point.offset + next.offset) / 2
      };
    });
  }

  private applyTriangleGravity(dt: number, minSpeed: number, maxSpeed: number) {
    const arena = this.arena();
    const towardTriangle = arena.center.clone().subtract(this.ball);
    const distanceSq = Math.max(towardTriangle.lengthSq(), 1600);
    const force = Math.min(48, TRIANGLE_GRAVITY / distanceSq);
    this.velocity.add(towardTriangle.normalize().scale(force * dt));

    const speed = this.velocity.length();
    if (speed > 0) {
      this.velocity.normalize().scale(Phaser.Math.Clamp(speed, minSpeed, maxSpeed));
    }
  }

  private updateTriangleMotion(dt: number) {
    if (this.triangleMotionMode === "steady") {
      this.triangleAngularVelocity = TRIANGLE_ROTATION_SPEED;
    } else {
      const sign = this.triangleAngularVelocity < 0 ? -1 : 1;
      const damped = this.triangleAngularVelocity * Math.pow(TRIANGLE_REACTIVE_DAMPING, dt * 60);
      this.triangleAngularVelocity = Math.abs(damped) < TRIANGLE_REACTIVE_MIN_SPEED
        ? sign * TRIANGLE_REACTIVE_MIN_SPEED
        : Phaser.Math.Clamp(damped, -TRIANGLE_REACTIVE_MAX_SPEED, TRIANGLE_REACTIVE_MAX_SPEED);
    }

    this.triangleRotation += this.triangleAngularVelocity * dt;
  }

  private handleTriangleCollision() {
    const arena = this.arena();
    const vertices = this.triangleVertices(arena);

    if (pointInTriangle(this.ball, vertices[0], vertices[1], vertices[2])) {
      this.triangleCollisionDisabledUntil = this.elapsed + TRIANGLE_PHASE_DELAY;
      this.clearTouchState();
      this.lastTouchType = "triangle";
      return;
    }

    if (this.elapsed < this.triangleCollisionDisabledUntil) {
      return;
    }

    for (let index = 0; index < vertices.length; index += 1) {
      const start = vertices[index];
      const end = vertices[(index + 1) % vertices.length];
      const closest = closestPointOnSegment(this.ball, start, end);
      const delta = this.ball.clone().subtract(closest);
      const distance = delta.length();

      if (distance >= BALL_RADIUS || distance === 0) {
        continue;
      }

      const normal = delta.normalize();
      this.applyTriangleReactiveImpulse(closest);
      this.reflectBall(normal);
      this.ball.copy(closest.add(normal.scale(BALL_RADIUS + 0.5)));
      this.trimBallTrail();
      this.clearTouchState();
      this.lastTouchType = "triangle";
      return;
    }
  }

  private handleArcBarrierCollisions(previousBall?: Phaser.Math.Vector2) {
    const arena = this.arena();
    const fromCenter = this.ball.clone().subtract(arena.center);
    const distance = fromCenter.length();
    const barrierRadius = arena.radius - ARC_BARRIER_INSET;
    const barrierHalfThickness = ARC_BARRIER_THICKNESS / 2;

    if (distance < barrierRadius - barrierHalfThickness - BALL_RADIUS || distance > barrierRadius + barrierHalfThickness + BALL_RADIUS) {
      return;
    }

    const angle = normalizeAngle(Math.atan2(fromCenter.y, fromCenter.x));
    for (const barrierAngle of this.arcBarrierAngles()) {
      if (Math.abs(shortestAngleDelta(barrierAngle, angle)) > ARC_BARRIER_HALF_ANGLE) {
        continue;
      }

      const contact = pointOnCircle(arena.center, barrierAngle, barrierRadius);
      const normal = fromCenter.lengthSq() > 0 ? fromCenter.normalize() : contact.clone().subtract(arena.center).normalize();
      const movingAcross = previousBall ? previousBall.distance(this.ball) > 0 : false;
      if (this.velocity.dot(normal) > 0 && !movingAcross) {
        continue;
      }

      this.reflectBall(normal);
      this.ball.copy(contact.add(normal.scale(BALL_RADIUS + barrierHalfThickness + 0.5)));
      this.trimBallTrail();
      return;
    }
  }

  private applyTriangleReactiveImpulse(contact: Phaser.Math.Vector2) {
    if (this.triangleMotionMode !== "reactive") {
      return;
    }

    const arena = this.arena();
    const lever = contact.clone().subtract(arena.center);
    const incoming = this.velocity.clone();
    const tangentPush = lever.x * incoming.y - lever.y * incoming.x;
    const speedFactor = Phaser.Math.Clamp(incoming.length() / MAX_BALL_SPEED, 0.28, 1.35);
    const direction = Math.sign(tangentPush) || Math.sign(this.triangleAngularVelocity) || 1;
    const impulse = direction * Phaser.Math.Clamp(Math.abs(tangentPush) / Math.max(arena.triangleRadius * MAX_BALL_SPEED, 1), 0.22, 1.18) * speedFactor * 2.2;
    this.triangleAngularVelocity = Phaser.Math.Clamp(
      this.triangleAngularVelocity + impulse,
      -TRIANGLE_REACTIVE_MAX_SPEED,
      TRIANGLE_REACTIVE_MAX_SPEED
    );
  }

  private handleGoals() {
    if (this.roundResolving) {
      return;
    }

    const arena = this.arena();
    const fromCenter = this.ball.clone().subtract(arena.center);

    if (fromCenter.length() <= arena.radius + BALL_RADIUS || this.elapsed - this.lastScoreAt < 350) {
      return;
    }

    this.roundResolving = true;
    this.clearTouchState();
    this.clearCatchState();

    const scorer = this.playerForAngle(normalizeAngle(Math.atan2(fromCenter.y, fromCenter.x)));
    if (!scorer) {
      this.resetRound();
      return;
    }

    this.lastScoreAt = this.elapsed;
    scorer.shields -= 1;
    scorer.eliminated = scorer.shields <= 0;

    if (scorer.eliminated) {
      this.message = `${scorer.name} is out. The circle closes.`;
      this.rebuildArcs();
    } else {
      this.message = `${scorer.name} cracked. ${scorer.shields} shields remain.`;
    }

    const remaining = this.activePlayers();
    if (remaining.length <= 1) {
      const winner = remaining[0];
      this.message = `${winner?.name ?? "No one"} wins!`;
      this.mode = "matchOver";
      this.playWinFanfare();
      this.spawnWinConfetti(winner);
    } else {
      this.time.delayedCall(420, () => {
        if (this.mode === "playing") {
          this.resetRound(scorer.paddleAngle);
        }
      });
    }

    this.emitHud();
  }

  private reflectBall(normal: Phaser.Math.Vector2) {
    const speed = Math.min(this.velocity.length() * 1.02, MAX_BALL_SPEED);
    const reflected = this.velocity.clone().subtract(normal.clone().scale(2 * this.velocity.dot(normal)));
    this.velocity.copy(reflected.normalize().scale(speed));
  }

  private boostBallSpeed(multiplier: number) {
    const speed = this.velocity.length();
    if (speed > 0) {
      this.velocity.normalize().scale(Math.min(speed * multiplier, MAX_BALL_SPEED));
    }
  }

  private addCharge(player: PlayerState) {
    player.charge = Math.min(MAX_CHARGE, player.charge + 1);
  }

  private canCatchBall(player: PlayerState) {
    return player.humanControlled && player.charge >= MAX_CHARGE && this.keys.pause.isDown;
  }

  private startCatch(player: PlayerState) {
    this.caughtByPlayerId = player.id;
    this.caughtAt = this.elapsed;
    this.caughtLaunchSpeed = Math.max(this.velocity.length(), 360);
    this.velocity.set(0, 0);
    this.updateCaughtBall();
    this.lastTouchType = "player";
    this.lastTouchPlayerId = player.id;
    this.message = `${player.name} caught the ball. Release Space to fire.`;
    this.emitHud();
  }

  private updateCaughtBall() {
    const player = this.players.find((entry) => entry.id === this.caughtByPlayerId && !entry.eliminated);
    if (!player) {
      this.clearCatchState();
      return;
    }

    this.ball.copy(this.paddleCatchPoint(this.arena(), player));
  }

  private launchCaughtBall() {
    const player = this.players.find((entry) => entry.id === this.caughtByPlayerId && !entry.eliminated);
    if (!player) {
      this.clearCatchState();
      return;
    }

    const arena = this.arena();
    const radial = this.paddleCenter(arena, player).subtract(arena.center).normalize();
    const launchSpeed = Math.min(Math.max(BASE_BALL_SPEED, this.caughtLaunchSpeed) * CATCH_LAUNCH_BOOST, MAX_CHARGED_BALL_SPEED);
    this.ball.copy(this.paddleCatchPoint(arena, player));
    this.velocity.copy(radial.scale(-launchSpeed));
    player.charge = 0;
    this.lastTouchType = "player";
    this.lastTouchPlayerId = player.id;
    this.clearCatchState();
    this.message = `${player.name} fired the charged shot.`;
    this.emitHud();
  }

  private clearCatchState() {
    this.caughtByPlayerId = undefined;
    this.caughtAt = 0;
    this.caughtLaunchSpeed = 0;
  }

  private clearTouchState() {
    this.lastTouchType = "none";
    this.lastTouchPlayerId = undefined;
  }

  private renderArena() {
    const width = this.scale.width;
    const height = this.scale.height;
    const arena = this.arena();
    const theme = this.activeTheme();

    this.gfx.clear();
    this.gfx.fillStyle(theme.background, 1);
    this.gfx.fillRect(0, 0, width, height);

    this.drawBackgroundRings(arena, theme);
    this.drawPlayerArcs(arena);
    this.drawTriangle(arena, theme);
    this.drawPaddles(arena);
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
    const vertices = this.triangleVertices(arena);
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

  private traceConcavePaddle(arena: ArenaGeometry, player: PlayerState) {
    const outline = this.paddleOutlinePoints(arena, player);
    outline.forEach((point, index) => {
      if (index === 0) {
        this.gfx.moveTo(point.position.x, point.position.y);
      } else {
        this.gfx.lineTo(point.position.x, point.position.y);
      }
    });
  }

  private paddleOutlinePoints(arena: ArenaGeometry, player: PlayerState) {
    const center = this.paddleCenter(arena, player);
    const radial = center.clone().subtract(arena.center).normalize();
    const tangent = new Phaser.Math.Vector2(-radial.y, radial.x);
    const concaveHalfWidth = this.paddleConcaveHalfWidth(arena);
    const halfWidth = this.paddleHalfWidth(arena);
    const halfHeight = this.paddleHalfHeight(arena);
    const steps = 18;
    const points: Array<{ position: Phaser.Math.Vector2; offset: number }> = [];

    points.push({
      position: this.paddleOuterPoint(arena, player, -halfWidth),
      offset: -1
    });

    for (let index = 0; index <= steps; index += 1) {
      const offset = -1 + index / steps * 2;
      points.push({
        position: this.paddleOuterPoint(arena, player, offset * concaveHalfWidth),
        offset
      });
    }

    points.push({
      position: this.paddleOuterPoint(arena, player, halfWidth),
      offset: 1
    });
    points.push({
      position: this.paddleLocalPoint(center, tangent, radial, halfWidth, this.paddleInnerY(1, halfHeight)),
      offset: 1
    });

    for (let index = steps; index >= 0; index -= 1) {
      const offset = -1 + index / steps * 2;
      points.push({
        position: this.paddleLocalPoint(center, tangent, radial, offset * concaveHalfWidth, this.paddleInnerY(offset, halfHeight)),
        offset
      });
    }

    points.push({
      position: this.paddleLocalPoint(center, tangent, radial, -halfWidth, this.paddleInnerY(-1, halfHeight)),
      offset: -1
    });

    return points;
  }

  private paddleOuterPoint(arena: ArenaGeometry, player: PlayerState, localX: number) {
    return pointOnCircle(arena.center, player.paddleAngle + localX / arena.radius, arena.radius);
  }

  private paddleCenter(arena: ArenaGeometry, player: PlayerState) {
    return pointOnCircle(arena.center, player.paddleAngle, arena.radius - this.paddleHalfHeight(arena));
  }

  private paddleCatchPoint(arena: ArenaGeometry, player: PlayerState) {
    const center = this.paddleCenter(arena, player);
    const radial = center.clone().subtract(arena.center).normalize();
    const tangent = new Phaser.Math.Vector2(-radial.y, radial.x);
    const innerY = this.paddleInnerY(0, this.paddleHalfHeight(arena));
    return this.paddleLocalPoint(center, tangent, radial, 0, innerY - BALL_RADIUS - PADDLE_RELEASE_GAP);
  }

  private paddleHalfWidth(arena: ArenaGeometry) {
    return this.paddleConcaveHalfWidth(arena) + this.paddleWingLength(arena);
  }

  private paddleConcaveHalfWidth(arena: ArenaGeometry) {
    return Math.max(37, arena.radius * arena.paddleAngleSpan * 0.54);
  }

  private paddleWingLength(arena: ArenaGeometry) {
    return Math.max(PADDLE_WING_LENGTH_MIN, arena.radius * PADDLE_WING_LENGTH_RATIO);
  }

  private paddleHalfHeight(arena: ArenaGeometry) {
    return Math.max(14, arena.paddleThickness * 0.74);
  }

  private paddleInnerY(offset: number, halfHeight: number) {
    const endDip = halfHeight * 0.12;
    return -halfHeight + halfHeight * PADDLE_CONCAVITY * (1 - offset * offset) - endDip * offset * offset;
  }

  private paddleInnerSlope(offset: number, halfWidth: number, halfHeight: number) {
    return (-2 * halfHeight * (PADDLE_CONCAVITY + 0.12) * offset) / halfWidth;
  }

  private paddleLocalPoint(
    center: Phaser.Math.Vector2,
    tangent: Phaser.Math.Vector2,
    radial: Phaser.Math.Vector2,
    x: number,
    y: number
  ) {
    return center.clone().add(tangent.clone().scale(x)).add(radial.clone().scale(y));
  }

  private paddleSpeedMultiplier() {
    const completedRounds = Math.max(0, this.roundNumber - 1);
    return Math.min(MAX_PADDLE_SPEED_MULTIPLIER, 1 + completedRounds * PADDLE_SPEED_RAMP);
  }

  private variantPaddleSpeedMultiplier() {
    return this.gameVariant === "rotating" ? ROTATING_VARIANT_PADDLE_SPEED_BOOST : 1;
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

  private spawnPaddleImpactBurst(contact: Phaser.Math.Vector2, radial: Phaser.Math.Vector2, tangent: Phaser.Math.Vector2) {
    const tangentDrift = this.velocity.dot(tangent);
    const tangentSign = tangentDrift === 0 ? 1 : -Math.sign(tangentDrift);

    this.paddleImpactBursts.push({
      position: contact.clone(),
      radial: radial.clone().normalize(),
      tangent: tangent.clone().normalize(),
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
    if (this.roundNumber <= 0 || this.mode !== "playing") {
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

  private rebuildArcs() {
    const active = this.activePlayers();
    const span = TAU / Math.max(active.length, 1);
    const startOffset = -Math.PI / 2 - span / 2;

    active.forEach((player, index) => {
      player.arcStart = normalizeAngle(startOffset + index * span);
      player.arcEnd = player.arcStart + span;
      player.paddleAngle = normalizeAngle(player.arcStart + span / 2);
      this.clampPaddleToArc(player);
    });
  }

  private updateArenaRotation(dt: number) {
    if (this.gameVariant !== "rotating") {
      return;
    }

    const rotation = ARENA_ROTATION_SPEED * dt;
    for (const player of this.activePlayers()) {
      player.arcStart += rotation;
      player.arcEnd += rotation;
      player.paddleAngle = normalizeAngle(player.paddleAngle + rotation);
      this.clampPaddleToArc(player);
    }
  }

  private resetRound(targetAngle?: number, countRound = true) {
    const arena = this.arena();
    const angle = normalizeAngle((targetAngle ?? Phaser.Math.FloatBetween(0, TAU)) + Phaser.Math.FloatBetween(-0.32, 0.32));
    const speed = this.mode === "menu" ? MENU_BALL_SPEED : BASE_BALL_SPEED;

    if (countRound && this.mode === "playing") {
      this.roundNumber += 1;
    }

    this.ball.copy(arena.center);
    this.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
    this.serveIndicatorDirection.copy(this.velocity.clone().normalize());
    this.serveIndicatorUntil = this.mode === "playing" ? this.elapsed + SERVE_INDICATOR_LIFETIME : 0;
    this.triangleCollisionDisabledUntil = this.elapsed + TRIANGLE_PHASE_DELAY;
    this.roundReadyAt = this.mode === "playing" ? this.elapsed + SPAWN_DELAY : 0;
    this.roundResolving = false;
    this.clearTouchState();
    this.clearCatchState();
    this.paddleImpactBursts = [];
    this.ballTrail = [];
  }

  private previewMenuMotion(dt: number) {
    this.applyTriangleGravity(dt, 150, 260);
    this.ball.add(this.velocity.clone().scale(dt));
    this.handleTriangleCollision();

    const arena = this.arena();
    const fromCenter = this.ball.clone().subtract(arena.center);
    if (fromCenter.length() > arena.radius * 0.72) {
      const normal = fromCenter.normalize();
      this.reflectBall(normal);
      this.ball.copy(arena.center.clone().add(normal.scale(arena.radius * 0.72)));
    }
  }

  public togglePause() {
    if (this.mode === "menu" || this.mode === "matchOver") {
      return;
    }

    this.mode = this.mode === "paused" ? "playing" : "paused";
    this.message = this.mode === "paused" ? "Paused. Press Esc, Space, or Resume." : "Back in motion.";
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
    if (this.roundResolving) {
      this.resetRound();
    }
  }

  private toggleBotFill() {
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
      this.triangleAngularVelocity = TRIANGLE_ROTATION_SPEED;
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

  private triangleVertices(arena: ArenaGeometry) {
    return [0, 1, 2].map((index) => pointOnCircle(arena.center, this.triangleRotation + index * TAU / 3, arena.triangleRadius));
  }

  private playerForAngle(angle: number) {
    return this.activePlayers().find((player) => angleInArc(angle, player.arcStart, player.arcEnd));
  }

  private activePlayers() {
    return this.players.filter((player) => !player.eliminated);
  }

  private lastTouchPlayer() {
    return this.players.find((player) => player.id === this.lastTouchPlayerId);
  }

  private arcBarrierAngles() {
    const active = this.activePlayers();
    const angles: number[] = [];
    for (const player of active) {
      if (!angles.some((angle) => Math.abs(shortestAngleDelta(angle, player.arcStart)) < 0.001)) {
        angles.push(normalizeAngle(player.arcStart));
      }
    }
    return angles;
  }

  private clampPaddleToArc(player: PlayerState) {
    player.paddleAngle = clampAngleToArc(player.paddleAngle, player.arcStart, player.arcEnd, this.paddleSafetyMargin(player));
  }

  private paddleSafetyMargin(player: PlayerState) {
    const arena = this.arena();
    const span = player.arcEnd - player.arcStart;
    const halfPaddleAngle = this.paddleHalfWidth(arena) / arena.radius + 0.01;
    return Math.min(span * 0.46, Math.max(0.04, halfPaddleAngle));
  }

  private handleResize(
    gameSize: Phaser.Structs.Size,
    _baseSize: Phaser.Structs.Size,
    _displaySize: Phaser.Structs.Size,
    previousWidth: number,
    previousHeight: number
  ) {
    if (this.caughtByPlayerId !== undefined) {
      this.updateCaughtBall();
      return;
    }

    // Remap the ball into the new arena instead of re-serving: window drags,
    // devtools, and overlay reflows no longer reset the round mid-rally.
    const old = computeArena(previousWidth || gameSize.width, previousHeight || gameSize.height);
    const next = computeArena(gameSize.width, gameSize.height);
    const offset = this.ball.clone().subtract(old.center).scale(next.radius / old.radius);
    this.ball.copy(next.center.clone().add(offset));
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
    // Mute everything (SFX one-shots included); music pauses itself via the
    // mode !== "playing" check in updateMusic().
    this.prevSoundMute = this.sound.mute;
    this.sound.mute = true;
  };

  private handleHomeClose = () => {
    this.sound.mute = this.prevSoundMute;
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

  private handleWindowKeyDown = (event: KeyboardEvent) => {
    if (this.homeOverlayOpen) {
      return;
    }

    if (event.repeat) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.togglePause();
      return;
    }

    if (event.code === "Space" && this.mode !== "playing") {
      event.preventDefault();
      this.togglePause();
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
      sfxVolume: this.sfxVolume
    };

    window.dispatchEvent(new CustomEvent<HudState>("four-pong:hud", { detail: state }));
  }
}

/**
 * Pure arena layout: derives the play circle from a viewport size.
 * Kept free of scene state so resize remapping (and future netcode) can
 * compute geometry for arbitrary dimensions.
 */
function computeArena(width: number, height: number): ArenaGeometry {
  const hudSafeTop = width < 760 ? 142 : 92;
  const controlsSafeBottom = width < 760 ? 118 : 70;
  const centerY = hudSafeTop + (height - hudSafeTop - controlsSafeBottom) / 2;
  const radius = Math.max(126, Math.min(width * 0.43, (height - hudSafeTop - controlsSafeBottom) * 0.48));

  return {
    center: new Phaser.Math.Vector2(width / 2, centerY),
    radius,
    paddleThickness: Math.max(16, Math.min(24, radius * 0.085)),
    paddleAngleSpan: Math.max(0.252, Math.min(0.468, 68.4 / radius)),
    triangleRadius: Math.max(32, Math.min(56, radius * 0.18))
  };
}

function normalizeAngle(angle: number) {
  return Phaser.Math.Wrap(angle, 0, TAU);
}

function angleInArc(angle: number, start: number, end: number) {
  const normalized = normalizeAngle(angle);
  const normalizedStart = normalizeAngle(start);
  const span = end - start;
  const relative = normalizeAngle(normalized - normalizedStart);
  return relative <= span;
}

function clampAngleToArc(angle: number, start: number, end: number, margin: number) {
  const normalizedStart = normalizeAngle(start);
  const span = end - start;
  const relative = normalizeAngle(normalizeAngle(angle) - normalizedStart);
  const clamped = Phaser.Math.Clamp(relative, margin, Math.max(margin, span - margin));
  return normalizeAngle(normalizedStart + clamped);
}

function shortestAngleDelta(from: number, to: number) {
  return Phaser.Math.Angle.Wrap(to - from);
}

function pointOnCircle(center: Phaser.Math.Vector2, angle: number, radius: number) {
  return new Phaser.Math.Vector2(
    center.x + Math.cos(angle) * radius,
    center.y + Math.sin(angle) * radius
  );
}

function closestPointOnSegment(point: Phaser.Math.Vector2, start: Phaser.Math.Vector2, end: Phaser.Math.Vector2) {
  const segment = end.clone().subtract(start);
  const lengthSq = segment.lengthSq();
  if (lengthSq === 0) {
    return start.clone();
  }

  const t = Phaser.Math.Clamp(point.clone().subtract(start).dot(segment) / lengthSq, 0, 1);
  return start.clone().add(segment.scale(t));
}

function closestPointsBetweenSegments(
  aStart: Phaser.Math.Vector2,
  aEnd: Phaser.Math.Vector2,
  bStart: Phaser.Math.Vector2,
  bEnd: Phaser.Math.Vector2
) {
  let bestA = aStart.clone();
  let bestB = bStart.clone();
  let bestDistance = Infinity;

  const candidates = [
    { a: aStart, b: closestPointOnSegment(aStart, bStart, bEnd) },
    { a: aEnd, b: closestPointOnSegment(aEnd, bStart, bEnd) },
    { a: closestPointOnSegment(bStart, aStart, aEnd), b: bStart },
    { a: closestPointOnSegment(bEnd, aStart, aEnd), b: bEnd }
  ];

  for (const candidate of candidates) {
    const distance = candidate.a.distance(candidate.b);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestA = candidate.a.clone();
      bestB = candidate.b.clone();
    }
  }

  return { a: bestA, b: bestB, distance: bestDistance };
}

function rotateVector(vector: Phaser.Math.Vector2, radians: number) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new Phaser.Math.Vector2(
    vector.x * cos - vector.y * sin,
    vector.x * sin + vector.y * cos
  );
}

function pointInTriangle(point: Phaser.Math.Vector2, a: Phaser.Math.Vector2, b: Phaser.Math.Vector2, c: Phaser.Math.Vector2) {
  const area = triangleSign(point, a, b);
  const sideB = triangleSign(point, b, c);
  const sideC = triangleSign(point, c, a);
  const hasNegative = area < 0 || sideB < 0 || sideC < 0;
  const hasPositive = area > 0 || sideB > 0 || sideC > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(p1: Phaser.Math.Vector2, p2: Phaser.Math.Vector2, p3: Phaser.Math.Vector2) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
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
const menuMusicVolume = document.querySelector<HTMLElement>("#menu-music-volume")!;
const menuSfxVolume = document.querySelector<HTMLElement>("#menu-sfx-volume")!;
const menuMusicState = document.querySelector<HTMLElement>("#menu-music-state")!;

window.addEventListener("four-pong:hud", (event) => {
  const state = (event as CustomEvent<HudState>).detail;
  scoreStrip.innerHTML = state.players.map((player) => {
    const shields = Array.from({ length: MAX_SHIELDS }, (_, index) => {
      const live = index < player.shields;
      return `<span class="pip ${live ? "live" : ""}" style="--player-color: ${player.cssColor}"></span>`;
    }).join("");
    const charge = Phaser.Math.Clamp(player.charge / MAX_CHARGE, 0, 1);
    return `<article class="score-card ${player.eliminated ? "out" : ""}">
      <span class="name" style="--player-color: ${player.cssColor}">${player.name}</span>
      <span class="pips">${shields}</span>
      <span class="charge-meter" aria-label="${player.name} charge ${player.charge} of ${MAX_CHARGE}">
        <span style="--player-color: ${player.cssColor}; --charge: ${charge}"></span>
      </span>
    </article>`;
  }).join("");

  statusChip.textContent = `${state.message} ${state.botFill ? "Bot fill on." : "Bot fill off."}`;
  pauseButton.textContent = state.mode === "paused" ? "Resume" : "Pause";
  pauseButton.disabled = state.mode === "menu" || state.mode === "matchOver";
  menuOverlay.hidden = state.mode === "playing";
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

pauseButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:toggle-pause"));
});

void game;

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
