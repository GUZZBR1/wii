import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { GameHudState } from '../core/hud';
import {
  elapsedSimulationSeconds,
  isBeforeOrAtPauseBoundary,
  mapWallTimestampToSimulationMs,
  MAX_FRAME_DELTA_SECONDS,
} from '../core/fixedStepTiming';
import { RestartGesture } from '../core/restartGesture';
import { createAthlete, createRacket } from './athlete';
import { createTennisEffects } from './effects';
import { buildTennisStadium } from './stadium';
import { advanceBall, createBall, solveOutgoing, timeAtPlane, type BallState } from './ballistics';
import { adjudicateContact, DEFAULT_GEOMETRY, type ContactOutcome } from './contactAdjudicator';
import { adaptOpponentSkill, createOpponentAi, decideReturn, DEFAULT_OPPONENT_AI_CONFIG, type OpponentAiState } from './opponentAi';
import { ballAtPlannedContact, resolveScheduledOpponentReturn, type OpponentHitPlan } from './opponentReturn';
import { crossesNetBelowCord } from './rallyPhysics';
import { BASELINE_Z, COURT_HALF_WIDTH, groundImpact, legalLanding, NET_HEIGHT, serviceSide } from './court';
import { awardPoint, createScore, pointLabels, type PlayerSide, type TennisScoreState } from './tennisScore';

/**
 * Wii-Sports-style tennis: a game of WHEN, not WHERE. The player never aims with the arm —
 * direction comes from swing timing relative to the ball's arrival, adjudicated retroactively
 * against the ball state rewound to the swing's physical peak (docs/design-tenis.md §3).
 * Movement is automatic; the only skills are timing and reading the ball.
 *
 * Time base: performance.now() milliseconds, because peakTimestampMs lives in it.
 */

const OPPONENT_CONTACT_PLANE_Z = -7.2;
const PLAYER_HOME_Z = 8.3;
const OPPONENT_HOME_Z = -8.3;
const PLAYER_MOVE_SPEED = 5.5;
const RACKET_REACH_X = 0.6;
const TAPE_WINDOW_MS = 1200;
const POINT_PAUSE_S = 1.2;
const SURE_RETURNS = 3;
const SWING_ANIM_START = 0.2;
/** An opponent to rally with: it misses now and then, more under pressure. */
const RALLY_AI = { ...DEFAULT_OPPONENT_AI_CONFIG, generosity: 0.45, qualityPressure: 0.2 };
const TOSS_VY = 5.4; // apex ≈ 1.49 m above the release
const SERVE_CONTACT_X_OFFSET = 0.35;
const SERVE_HOLD_HEIGHT = 1.15;
const SERVE_HOLD_MS = 500;
const OPPONENT_TOSS_MS = 800;
const FAST_SERVE_MS = 130;
const SERVE_CONTACT_HEIGHT = 2.4;
/** Beyond this, a mistimed serve would leave the service box. */
const SERVE_TIMING_SPREAD_MS = 150;

type Phase =
  | { kind: 'player-serve'; idealHitMs: number }
  | { kind: 'opponent-serve'; hitAtMs: number }
  | { kind: 'rally' }
  | { kind: 'point-over'; resumeAtMs: number }
  | { kind: 'match-over' };

interface TapeEntry {
  tMs: number;
  ball: BallState;
  playerX?: number;
  playerSpeed?: number;
}

const nowMs = () => performance.now();

export class TennisGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
  private readonly ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xd8ff54, emissive: 0x4d7020, emissiveIntensity: 0.45 }),
  );
  private readonly player = createAthlete(0xf79432, 0);
  private readonly opponent = createAthlete(0x49b5dd, Math.PI);
  private readonly ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), new THREE.MeshBasicMaterial({ color: 0x163529, transparent: true, opacity: 0.38 }));
  private readonly bounceRing = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 28), new THREE.MeshBasicMaterial({ color: 0xe7f8a4, transparent: true, depthWrite: false }));
  private bounceAge = 1;
  private playerStride = 0;
  private opponentStride = 0;
  private playerMotion = 0;
  private opponentMotion = 0;
  private swingDirection = 1;
  private serveStroke = false;
  private fastServe = false;
  private opponentReturns = 0;
  private opponentBeaten = false;
  private opponentServed = false;
  private readySide: -1 | 0 | 1 = 0;
  private tossAtMs = 0;
  private readonly loop: GameLoop;
  private readonly effects: ReturnType<typeof createTennisEffects>;
  private readonly crowd: THREE.Object3D[];
  private cheerS = 0;
  private renderedAtMs = 0;
  private readonly hudTimer: number;

  private ball: BallState | null = null;
  private tape: TapeEntry[] = [];
  private phase: Phase = { kind: 'point-over', resumeAtMs: 0 };
  private score: TennisScoreState = createScore('player');
  private playerX = 0;
  private opponentX = 0;
  private playerLateralSpeed = 0;
  private swingAnimT = 1;
  private opponentSwingT = 1;
  private opponentHitPlan: OpponentHitPlan | null = null;
  private wallToSimulationOffsetMs = 0;
  private lastSimulationTimeMs = Number.NEGATIVE_INFINITY;
  private lastWallTimeMs = Number.NEGATIVE_INFINITY;
  private pauseBoundaryWallTimeMs = Number.NEGATIVE_INFINITY;
  private opponentAi: OpponentAiState = createOpponentAi();
  private status = 'Faça uma raquetada para sacar';
  private feedback: { id: number; text: string; tone: 'good' | 'bad' | 'neutral' } | undefined;
  private feedbackCounter = 0;
  private faults = 0;
  private servingFlight = false;
  private pendingPoint?: { deadAt: number; winner: PlayerSide; label: string };
  private readonly restart = new RestartGesture();

  private get serveX(): number {
    return serviceSide(this.score.points) * (this.score.server === 'player' ? 1.65 : -1.65);
  }

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: GameHudState) => void,
    private readonly audio?: ProceduralAudio,
  ) {
    this.crowd = buildTennisStadium(this.scene).crowd;
    this.effects = createTennisEffects(this.scene);
    this.player.grip.add(createRacket(0x2563c9));
    this.opponent.grip.add(createRacket(0xcf3d3d));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.bounceRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.player.root, this.opponent.root, this.ballMesh, this.ballShadow, this.bounceRing);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, simulationTimeMs, wallTimeMs) => (
      this.update(dt, simulationTimeMs, wallTimeMs)
    ));
    // Lower the resolution if frames get slow; the pose worker shares the same machine.
    this.loop.onQualityChange = () => {};
    this.hudTimer = window.setInterval(() => this.publishHud(), 200);
  }

  // ---------------------------------------------------------------- input

  onAction(event: SportActionEvent): void {
    if (event.type === 'swing-start') {
      // A right-hander's forehand starts on the right, the backhand across the body; mirrored for the left.
      this.swingDirection = (event.hand === 'right') === (event.side === 'forehand') ? 1 : -1;
      // By the time the stroke is recognised the arm is well on its way; so is the racket.
      this.swingAnimT = SWING_ANIM_START;
      this.serveStroke = this.phase.kind === 'player-serve';
      return;
    }
    if (event.type !== 'swing') return;
    this.resolveSwing({
      side: event.side,
      power01: event.power01,
      verticalSpeed: event.verticalSpeed ?? 0,
      contactY: event.contactY ?? 0,
      peakTimestampMs: event.peakTimestampMs ?? event.timestampMs,
    });
  }

  /** Played with the body only. */
  onKey(): void {}

  setHandsRaised(raised: boolean): void { this.restart.setHandsRaised(raised); }

  // ---------------------------------------------------------------- swing resolution

  private resolveSwing(swing: { side: 'forehand' | 'backhand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number }): void {
    const wallNow = nowMs();
    this.notePauseBoundary(wallNow);
    if (isBeforeOrAtPauseBoundary(swing.peakTimestampMs, this.pauseBoundaryWallTimeMs)) return;
    const now = Math.max(this.lastSimulationTimeMs, this.simulationTimestampAt(wallNow, wallNow));
    const simulationSwing = {
      ...swing,
      peakTimestampMs: Math.min(now, this.simulationTimestampAt(swing.peakTimestampMs, wallNow)),
    };

    if (this.phase.kind === 'player-serve') {
      this.resolveServe(simulationSwing, now, wallNow);
      return;
    }
    if (this.phase.kind !== 'rally' || !this.ball) return;

    const ballAtPeak = this.rewind(simulationSwing.peakTimestampMs);
    if (!ballAtPeak || (this.servingFlight && ballAtPeak.bounces === 0)) return;

    if (this.pendingPoint && (simulationSwing.peakTimestampMs >= this.pendingPoint.deadAt || now >= this.pendingPoint.deadAt + 650)) return;
    const anchor = this.tapeAt(simulationSwing.peakTimestampMs);
    const outcome = adjudicateContact({
      ballAtPeak,
      playerX: anchor?.playerX ?? this.playerX,
      movementPenalty01: Math.min(1, (anchor?.playerSpeed ?? this.playerLateralSpeed) / PLAYER_MOVE_SPEED),
      swing: simulationSwing,
    });
    if (outcome.kind === 'contact') this.setFeedback(swing.side === 'forehand' ? 'FOREHAND' : 'BACKHAND', 'good');
    this.applyPlayerOutcome(outcome, ballAtPeak, simulationSwing.peakTimestampMs, now, false, wallNow);
  }

  /**
   * Serving cannot be missed, as in the console game: any stroke during the toss strikes the ball
   * from the top and lands in the right box. Timing against the apex only changes pace and angle.
   */
  private resolveServe(
    swing: { side: 'forehand' | 'backhand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number },
    now: number,
    wallNow: number,
  ): void {
    if (this.phase.kind !== 'player-serve') return;
    const contact = createBall({ x: this.playerX + SERVE_CONTACT_X_OFFSET, y: SERVE_CONTACT_HEIGHT, z: BASELINE_Z + 0.35 }, { x: 0, y: -1, z: 0 }, 'player');
    const outcome = adjudicateContact({
      ballAtPeak: contact,
      playerX: contact.position.x,
      movementPenalty01: 0,
      swing,
      timingErrorOverrideMs: Math.max(-SERVE_TIMING_SPREAD_MS, Math.min(SERVE_TIMING_SPREAD_MS, swing.peakTimestampMs - this.phase.idealHitMs)),
      geometry: { playerZ: BASELINE_Z + 1 },
    });
    this.applyPlayerOutcome(outcome, contact, now, now, true, wallNow, swing.peakTimestampMs);
  }

  private applyPlayerOutcome(
    outcome: ContactOutcome,
    ballAtPeak: BallState,
    peakMs: number,
    now: number,
    isServe = false,
    wallNow = nowMs(),
    struckAtMs = peakMs,
  ): void {
    if (outcome.kind === 'ignore') return;
    if (outcome.kind === 'whiff') {
      const labels: Record<typeof outcome.reason, string> = {
        early: 'CEDO DEMAIS',
        late: 'TARDE DEMAIS',
        'out-of-reach': 'FORA DE ALCANCE',
        'dead-ball': 'BOLA MORTA',
      };
      this.setFeedback(labels[outcome.reason], 'bad');
      this.audio?.failure();
      return;
    }

    // Rewind + fast-forward: the new flight starts at the physical peak instant,
    // then advances to now — detection latency never enters the physics.
    const lagSec = Math.max(0, (now - peakMs) / 1000);
    // Struck at the top of the toss: the console game's fast serve, with its white streak.
    this.fastServe = isServe && this.phase.kind === 'player-serve' && Math.abs(struckAtMs - this.phase.idealHitMs) <= FAST_SERVE_MS;
    const outgoing = isServe
      ? solveOutgoing(ballAtPeak.position, {
        x: -serviceSide(this.score.points) * (1.6 + outcome.timingErrorMs / 110),
        z: -4 - outcome.timingErrorMs / 150,
      }, this.fastServe ? 0.62 : 0.95)
      : outcome.outgoing;
    this.pendingPoint = undefined;
    this.servingFlight = isServe;
    this.ball = createBall(ballAtPeak.position, outgoing, 'player');
    this.tape = [{ tMs: peakMs, ball: this.ball }];
    this.lastSimulationTimeMs = Math.max(this.lastSimulationTimeMs, now);
    this.lastWallTimeMs = wallNow;
    this.wallToSimulationOffsetMs = now - wallNow;
    this.phase = { kind: 'rally' };
    this.opponentHitPlan = null;
    this.audio?.racket(0.4 + 0.6 * outcome.quality01);
    this.effects.impact(ballAtPeak.position, outcome.quality01);
    for (let elapsed = 0; elapsed < lagSec && this.phase.kind === 'rally';) {
      const dt = Math.min(1 / 60, lagSec - elapsed);
      elapsed += dt;
      this.stepBall(dt, peakMs + elapsed * 1000);
    }
    if (this.phase.kind !== 'rally') return;

    const spinLabel = outcome.spin > 0.4 ? ' · TOPSPIN' : outcome.spin < -0.4 ? ' · SLICE' : '';
    const dirLabel = outcome.direction === 'cross' ? 'CRUZADA' : outcome.direction === 'line' ? 'PARALELA' : 'CENTRO';
    if (outcome.smash) this.setFeedback('SMASH!', 'good');
    else if (outcome.quality01 > 0.85) this.setFeedback('NO PONTO!', 'good');
    if (this.fastServe) this.setFeedback('SAQUE FORTE!', 'good');
    const heightLabel = outcome.height === 'high' ? ' · ALTA' : outcome.height === 'low' ? ' · RASANTE' : '';
    this.status = isServe ? 'Saque diagonal' : `${dirLabel}${heightLabel}${spinLabel}`;
  }

  /** Ball state at the given timestamp, reconstructed from the tape of the current flight. */
  private rewind(tMs: number): BallState | null {
    const anchor = this.tapeAt(tMs);
    return anchor ? advanceBall(anchor.ball, (tMs - anchor.tMs) / 1000) : null;
  }

  private tapeAt(tMs: number): TapeEntry | undefined {
    for (let i = this.tape.length - 1; i >= 0; i -= 1) {
      const entry = this.tape[i]!;
      if (entry.tMs <= tMs) return entry;
    }
    return undefined;
  }

  private simulationTimestampAt(wallTimestampMs: number, observedWallTimestampMs: number): number {
    this.notePauseBoundary(observedWallTimestampMs);
    return mapWallTimestampToSimulationMs(
      wallTimestampMs,
      observedWallTimestampMs,
      this.wallToSimulationOffsetMs,
      this.lastSimulationTimeMs,
      this.lastWallTimeMs,
      MAX_FRAME_DELTA_SECONDS * 1000,
    );
  }

  // ---------------------------------------------------------------- update

  private update(fixedDt: number, now: number, wallNow: number): void {
    this.notePauseBoundary(wallNow);
    if (now < this.lastSimulationTimeMs) {
      // An input can land between fixed steps and advance the ball beyond this queued step.
      // Skip that stale step so the tape and physics clock stay ordered.
      this.render();
      return;
    }
    this.wallToSimulationOffsetMs = now - wallNow;
    this.lastWallTimeMs = wallNow;
    const dt = elapsedSimulationSeconds(this.lastSimulationTimeMs, now, fixedDt);
    this.lastSimulationTimeMs = now;
    this.stepPhase(dt, now);
    this.stepAvatars(dt);
    this.stepBall(dt, now);
    this.stepAnimations(dt);
    this.render();
  }

  private notePauseBoundary(wallNow: number): void {
    if (
      Number.isFinite(this.lastWallTimeMs)
      && wallNow - this.lastWallTimeMs > MAX_FRAME_DELTA_SECONDS * 1000
    ) {
      this.pauseBoundaryWallTimeMs = Math.max(this.pauseBoundaryWallTimeMs, this.lastWallTimeMs);
    }
  }

  private stepPhase(dt: number, now: number): void {
    switch (this.phase.kind) {
      case 'point-over':
        if (now >= this.phase.resumeAtMs) this.startPoint(now);
        break;
      case 'match-over':
        this.restart.step(dt);
        break;
      case 'player-serve': {
        // Toss missed and the ball came back down: re-toss quietly, no penalty.
        if (this.ball && this.ball.position.y <= 0.6 && this.ball.velocity.y < 0) {
          this.tossBall(now);
        }
        break;
      }
      case 'opponent-serve':
        if (now < this.phase.hitAtMs && this.ball) {
          // The ball rises out of the opponent's hand, so the serve can be seen coming.
          const rise = 1 - Math.max(0, this.phase.hitAtMs - now) / OPPONENT_TOSS_MS;
          const y = SERVE_HOLD_HEIGHT + (SERVE_CONTACT_HEIGHT - SERVE_HOLD_HEIGHT) * Math.sin(Math.max(0, rise) * Math.PI / 2);
          this.ball = createBall({ ...this.ball.position, y }, { x: 0, y: 0, z: 0 }, 'opponent');
        }
        if (now >= this.phase.hitAtMs && this.ball) {
          // The serve is not a return: always in, modest pace, slight lateral variety.
          const from = { x: this.serveX, y: SERVE_CONTACT_HEIGHT, z: -BASELINE_Z - 0.35 };
          // Diagonal: into the box across from where the server stands.
          const targetX = -Math.sign(this.serveX) * (1.2 + Math.random() * 1.3);
          const velocity = solveOutgoing(from, { x: targetX, z: 3.5 + Math.random() }, 1.25);
          this.ball = createBall(from, velocity, 'opponent');
          this.tape = [{ tMs: now, ball: this.ball }];
          this.opponentSwingT = 0;
          this.opponentServed = true;
          this.servingFlight = true;
          this.phase = { kind: 'rally' };
          this.audio?.racket(0.5);
          this.status = 'Saque do adversário — prepare-se';
        }
        break;
      case 'rally':
        break;
    }
  }

  private startPoint(now: number): void {
    this.servingFlight = false;
    this.playerX = this.score.server === 'player' ? this.serveX : 0;
    this.opponentX = this.score.server === 'opponent' ? this.serveX : 0;
    this.opponentHitPlan = null;
    this.opponentReturns = 0;
    this.opponentBeaten = false;
    if (this.score.server === 'player') {
      this.tossBall(now);
      this.status = 'Seu saque: raquetada! No topo sai forte';
    } else {
      this.ball = createBall({ x: this.serveX, y: SERVE_HOLD_HEIGHT, z: -BASELINE_Z - 0.35 }, { x: 0, y: 0, z: 0 }, 'opponent');
      this.tape = [{ tMs: now, ball: this.ball }];
      this.phase = { kind: 'opponent-serve', hitAtMs: now + OPPONENT_TOSS_MS };
      this.status = 'Saque do adversário…';
    }
  }

  private tossBall(now: number): void {
    const from = { x: this.playerX - SERVE_CONTACT_X_OFFSET, y: SERVE_HOLD_HEIGHT, z: BASELINE_Z + 0.1 };
    // Held in the hand first; stepBall throws it up at `tossAtMs`.
    this.ball = createBall({ ...from, y: SERVE_HOLD_HEIGHT }, { x: 0, y: 0, z: 0 }, 'player');
    this.tossAtMs = now + SERVE_HOLD_MS;
    this.tape = [{ tMs: now, ball: this.ball }];
    const apexSec = TOSS_VY / 9.8;
    // Ideal contact slightly past the apex on the way down — classic serve timing.
    this.phase = { kind: 'player-serve', idealHitMs: this.tossAtMs + (apexSec + 0.12) * 1000 };
  }

  private stepBall(dt: number, now: number): void {
    // Ball physics runs in rally and during the serve toss; everything else is paused.
    if ((this.phase.kind !== 'rally' && this.phase.kind !== 'player-serve') || !this.ball) return;

    if (this.pendingPoint) {
      const { winner, label, deadAt } = this.pendingPoint;
      if (now >= deadAt + 650) this.endPoint(winner, label, now);
      return;
    }
    if (this.phase.kind === 'player-serve') {
      if (now < this.tossAtMs) return;
      if (this.ball.velocity.y === 0) this.ball = createBall(this.ball.position, { x: 0, y: TOSS_VY, z: 0 }, 'player');
    }
    const before = this.ball;
    const after = advanceBall(before, dt);
    this.ball = after;
    this.tape.push({ tMs: now, ball: after, playerX: this.playerX, playerSpeed: this.playerLateralSpeed });
    while (this.tape.length > 0 && this.tape[0]!.tMs < now - TAPE_WINDOW_MS) this.tape.shift();

    if (this.phase.kind !== 'rally') return;

    const receiver: PlayerSide = before.lastHitter === 'player' ? 'opponent' : 'player';
    if (crossesNetBelowCord(before, after, dt, NET_HEIGHT)) {
      if (this.servingFlight && before.bounces === 0) this.serveFault(receiver, now);
      else this.endPoint(receiver, 'NA REDE!', now);
      return;
    }
    if (after.bounces > before.bounces) {
      const impact = groundImpact(before);
      if (before.bounces === 0) {
        if (!legalLanding(impact.x, impact.z, before.lastHitter, this.servingFlight ? serviceSide(this.score.points) : undefined)) {
          if (this.servingFlight && before.bounces === 0) this.serveFault(receiver, now);
          else this.endPoint(receiver, 'FORA!', now);
          return;
        }
        this.bounceRing.position.set(impact.x, 0.027, impact.z);
        this.bounceAge = 0;
        this.audio?.bounce(0.35);
      }
      if (after.bounces >= 2) {
        this.finishFlight(after.lastHitter, 'SEGUNDO QUIQUE', now, now - dt * 1000 + impact.seconds * 1000);
        return;
      }
    }
    if (Math.abs(after.position.z) > 15 || Math.abs(after.position.x) > 8 || (after.velocity.x === 0 && after.velocity.y === 0 && after.velocity.z === 0)) {
      if (this.servingFlight && before.bounces === 0) this.serveFault(receiver, now);
      else if (after.bounces > 0) this.finishFlight(after.lastHitter, 'SEM DEVOLUÇÃO', now);
      else this.endPoint(receiver, 'FORA!', now);
      return;
    }

    this.stepOpponentPlan(now);
  }

  private stepOpponentPlan(now: number): void {
    if (!this.ball) return;
    if ((this.servingFlight && this.ball.bounces === 0) || this.ball.lastHitter !== 'player' || this.ball.velocity.z >= 0) {
      this.opponentHitPlan = null;
      return;
    }
    if (this.opponentBeaten) return;
    if (!this.opponentHitPlan) {
      const crossing = timeAtPlane(this.ball, OPPONENT_CONTACT_PLANE_Z);
      if (!crossing) return;
      this.opponentHitPlan = {
        hitAtMs: now + crossing.timeSeconds * 1000,
        contactAfterSeconds: crossing.timeSeconds,
        fromBall: this.ball,
      };
    }

    if (now >= this.opponentHitPlan.hitAtMs) {
      const plan = this.opponentHitPlan;
      const contactBall = ballAtPlannedContact(plan);
      // The first returns of a point are certain, so there is always a rally; after that it can be beaten.
      let roll = this.opponentReturns < SURE_RETURNS ? 0 : undefined;
      const decision = decideReturn(this.opponentAi, this.pressureOnOpponent(contactBall), () => {
        const value = roll ?? Math.random();
        roll = undefined;
        return value;
      }, RALLY_AI);
      this.opponentHitPlan = null;
      if (decision.kind === 'no-return') {
        // Ball plays on and the bounce rules score the point; the opponent visibly fails to get there.
        this.opponentBeaten = true;
        return;
      }
      this.opponentReturns += 1;
      this.ball = resolveScheduledOpponentReturn(
        plan,
        now,
        { x: decision.targetX, z: decision.targetZ },
        decision.flightTimeSeconds,
      );
      this.tape = [{ tMs: now, ball: this.ball }];
      this.servingFlight = false;
      this.opponentSwingT = 0;
      this.opponentServed = false;
      this.audio?.racket(0.4);
      this.effects.impact(this.ball.position, 0.1);
    }
  }

  /** How much the player's last shot pressures the opponent — pace and width raise faults. */
  private pressureOnOpponent(ball = this.ball): number {
    if (!ball) return 0;
    const speed = Math.hypot(ball.velocity.x, ball.velocity.z);
    const width = Math.abs(ball.position.x) / COURT_HALF_WIDTH;
    return Math.min(1, Math.max(0, (speed - 10) / 12) * 0.7 + width * 0.3);
  }

  private serveFault(receiver: PlayerSide, now: number): void {
    this.faults += 1;
    if (this.faults >= 2) {
      this.endPoint(receiver, 'DUPLA FALTA', now);
      return;
    }
    this.startPoint(now);
    this.setFeedback('FALTA · SEGUNDO SAQUE', 'bad');
  }

  private finishFlight(winner: PlayerSide, label: string, now: number, deadAt = now): void {
    if (winner === 'opponent') this.pendingPoint = { winner, label, deadAt };
    else this.endPoint(winner, label, now);
  }

  private endPoint(winner: PlayerSide, headline: string, now = nowMs()): void {
    this.pendingPoint = undefined;
    this.faults = 0;
    const result = awardPoint(this.score, winner);
    this.score = result.state;
    this.opponentAi = adaptOpponentSkill(this.opponentAi, winner);
    this.opponentHitPlan = null;

    const youWon = winner === 'player';
    this.setFeedback(headline, youWon ? 'good' : 'bad');
    if (result.matchWonBy) {
      this.phase = { kind: 'match-over' };
      this.status = result.matchWonBy === 'player' ? 'VOCÊ VENCEU A PARTIDA!' : 'Adversário venceu a partida';
      this.audio?.milestone();
    } else if (result.gameWonBy) {
      this.phase = { kind: 'point-over', resumeAtMs: now + POINT_PAUSE_S * 1500 };
      this.status = result.gameWonBy === 'player' ? 'GAME SEU!' : 'Game do adversário';
      this.audio?.milestone();
    } else {
      this.phase = { kind: 'point-over', resumeAtMs: now + POINT_PAUSE_S * 1000 };
      this.status = youWon ? 'Ponto seu!' : 'Ponto do adversário';
      if (youWon) this.audio?.success(1);
      else this.audio?.failure();
    }
    this.ball = null;
    this.tape = [];
    this.callScore(result);
    if (youWon) {
      this.cheerS = 1.8;
      this.audio?.cheer(result.gameWonBy ? 1.6 : 1);
    }
  }

  private callScore(result: { gameWonBy?: unknown; matchWonBy?: unknown }): void {
    if (result.matchWonBy) this.audio?.say('Fim de jogo');
    else if (result.gameWonBy) this.audio?.say('Game');
    else {
      const labels = pointLabels(this.score);
      this.audio?.say(`${labels.player} a ${labels.opponent}`.replace('AD', 'vantagem'));
    }
  }

  private stepAvatars(dt: number): void {
    // Auto-movement like the Miis: glide toward the incoming ball's lateral position.
    let targetX = this.phase.kind === 'player-serve' ? this.serveX : 0;
    if (this.ball && this.ball.velocity.z > 0.5 && this.ball.position.z < PLAYER_HOME_Z + 2) {
      const arrival = advanceBall(this.ball, timeAtPlane(this.ball, 7.2)?.timeSeconds ?? 0).position.x;
      // Stand beside the ball, so the racket meets it rather than the body: forehand unless it is far left.
      if (this.readySide === 0) this.readySide = arrival >= this.playerX - 0.3 ? 1 : -1;
      targetX = Math.max(-2.8, Math.min(2.8, arrival - this.readySide * RACKET_REACH_X));
    }
    else this.readySide = 0;
    const before = this.playerX;
    const delta = targetX - this.playerX;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), PLAYER_MOVE_SPEED * dt);
    this.playerX += step;
    this.playerLateralSpeed = Math.abs(this.playerX - before) / Math.max(dt, 1e-6);

    let oppTarget = this.phase.kind === 'opponent-serve' ? this.serveX : 0;
    if (this.ball && this.ball.velocity.z < -0.5) {
      oppTarget = Math.max(-2.5, Math.min(2.5, this.opponentHitPlan ? ballAtPlannedContact(this.opponentHitPlan).position.x : this.ball.position.x));
    }
    // Beaten: left stranded on the wrong side, short of the ball.
    if (this.opponentBeaten && this.ball) oppTarget = this.ball.position.x > 0 ? -2.5 : 2.5;
    const oppDelta = oppTarget - this.opponentX;
    const oppSpeed = 2.5 + this.opponentAi.skill * 3.5;
    const oppStep = Math.sign(oppDelta) * Math.min(Math.abs(oppDelta), oppSpeed * dt);
    this.opponentX += oppStep;
    this.playerMotion = step / Math.max(dt, 1e-6);
    this.opponentMotion = oppStep / Math.max(dt, 1e-6);
    this.playerStride += Math.abs(step);
    this.opponentStride += Math.abs(oppStep);
  }

  private stepAnimations(dt: number): void {
    this.bounceAge += dt;
    this.swingAnimT = Math.min(1, this.swingAnimT + dt / 0.45);
    this.opponentSwingT = Math.min(1, this.opponentSwingT + dt / 0.45);
  }

  private render(): void {
    const at = nowMs();
    const dt = Math.min(0.05, Math.max(0, (at - this.renderedAtMs) / 1000));
    this.renderedAtMs = at;
    this.cheerS = Math.max(0, this.cheerS - dt);
    for (const part of this.crowd) part.position.y = this.cheerS > 0 ? Math.abs(Math.sin(at / 90)) * 0.22 : 0;
    if (this.ball) {
      this.ballMesh.visible = true;
      this.ballMesh.position.set(this.ball.position.x, Math.max(0.18, this.ball.position.y), this.ball.position.z);
    } else {
      this.ballMesh.visible = false;
    }
    this.bounceRing.visible = this.bounceAge < 0.28;
    this.bounceRing.material.opacity = Math.max(0, 0.72 * (1 - this.bounceAge / 0.28));
    this.bounceRing.scale.setScalar(0.11 + this.bounceAge * 1.25);
    this.ballShadow.visible = this.ball !== null;
    if (this.ball) {
      const { x, y, z } = this.ball.position;
      this.ballShadow.position.set(x, 0.024, z);
      this.ballShadow.scale.setScalar(1 + y * 0.14);
      this.ballShadow.material.opacity = 0.45 / (1 + y * 0.35);
    }
    const playerServing = this.phase.kind === 'player-serve';
    const opponentServing = this.phase.kind === 'opponent-serve';
    this.player.root.position.set(this.playerX, 0, playerServing ? BASELINE_Z + 0.45 : PLAYER_HOME_Z);
    this.opponent.root.position.set(this.opponentX, 0, opponentServing ? -BASELINE_Z - 0.45 : OPPONENT_HOME_Z);
    const serving = this.phase.kind === 'player-serve' ? (nowMs() < this.tossAtMs ? 'hold' : 'toss') : undefined;
    const struck = this.serveStroke && this.swingAnimT < 1;
    this.player.animate(this.playerStride, this.playerMotion, this.swingAnimT, this.swingDirection, this.readySide, struck ? 'strike' : serving);
    const opponentToss = this.phase.kind === 'opponent-serve' ? 'toss' : this.opponentServed && this.opponentSwingT < 1 ? 'strike' : undefined;
    this.opponent.animate(this.opponentStride, -this.opponentMotion, this.opponentSwingT, 1, 0, opponentToss);
    const portrait = Math.max(0, 1.35 - this.camera.aspect);
    // Low and just behind the player, drifting with them, as in the console game.
    const follow = this.playerX * 0.45;
    this.camera.position.set(follow, 5.2 + portrait * 3, 16.2 + portrait * 8);
    this.camera.lookAt(follow * 0.5, 0.2, 0);
    const ball = this.ball;
    const incoming = ball && this.phase.kind === 'rally' && ball.lastHitter === 'opponent' && ball.velocity.z > 0.5;
    this.effects.timing(
      this.playerX,
      DEFAULT_GEOMETRY.contactPlaneZ,
      incoming ? (DEFAULT_GEOMETRY.contactPlaneZ - ball.position.z) / ball.velocity.z : undefined,
      DEFAULT_GEOMETRY.maxTimingMs / 1000,
    );
    this.effects.step(dt, ball && this.fastServe && this.servingFlight ? this.ballMesh.position : undefined, this.camera);
  }

  // ---------------------------------------------------------------- hud & lifecycle

  private setFeedback(text: string, tone: 'good' | 'bad' | 'neutral'): void {
    this.feedbackCounter += 1;
    this.feedback = { id: this.feedbackCounter, text, tone };
  }

  private publishHud(): void {
    const labels = pointLabels(this.score);
    this.onHud({
      score: this.score.games.player,
      label: `${labels.player} × ${labels.opponent}`,
      speed01: 0,
      status: this.status,
      feedback: this.feedback,
      tennis: {
        points: labels,
        games: this.score.games,
        server: this.score.server,
        winner: this.score.matchWinner,
        secondServe: this.faults === 1,
        restart01: Math.round(this.restart.progress01 * 20) / 20,
      },
    });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.loop.dispose();
  }
}
