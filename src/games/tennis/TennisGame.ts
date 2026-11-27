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
import { createAthlete } from './athlete';
import { advanceBall, createBall, solveOutgoing, timeAtPlane, type BallState } from './ballistics';
import { adjudicateContact, type ContactOutcome } from './contactAdjudicator';
import { adaptOpponentSkill, createOpponentAi, decideReturn, type OpponentAiState } from './opponentAi';
import { ballAtPlannedContact, resolveScheduledOpponentReturn, type OpponentHitPlan } from './opponentReturn';
import { crossesNetBelowCord } from './rallyPhysics';
import { BASELINE_Z, COURT_HALF_WIDTH, groundImpact, legalLanding, LINE_WIDTH, NET_HALF_WIDTH, NET_HEIGHT, SERVICE_LINE_Z, serviceSide } from './court';
import { awardPoint, createScore, pointLabels, type PlayerSide, type TennisScoreState } from './tennisScore';

/**
 * Wii-Sports-style tennis: a game of WHEN, not WHERE. The player never aims with the arm —
 * direction comes from swing timing relative to the ball's arrival, adjudicated retroactively
 * against the ball state rewound to the swing's physical peak (docs/design-tenis.md §3).
 * Movement is automatic; the only skills are timing and reading the ball.
 *
 * Time base: performance.now() milliseconds, because peakTimestampMs lives in it.
 */

const NET_Z = 0;
const OPPONENT_CONTACT_PLANE_Z = -7.2;
const PLAYER_HOME_Z = 8.3;
const OPPONENT_HOME_Z = -8.3;
const PLAYER_MOVE_SPEED = 5.5;
const TAPE_WINDOW_MS = 1200;
const POINT_PAUSE_S = 2.0;
const TOSS_VY = 5.4; // apex ≈ 1.49 m above the release
const SERVE_CONTACT_X_OFFSET = 0.35;

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
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 90);
  private readonly ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 10),
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
  private readonly loop: GameLoop;
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
    this.scene.background = new THREE.Color(0xb8e0f4);
    this.scene.fog = new THREE.Fog(0xb8e0f4, 27, 66);
    this.camera.position.set(0, 7.5, 14.5);
    this.camera.lookAt(0, 1, -3);
    this.scene.add(new THREE.HemisphereLight(0xe3f4d5, 0x1a2c1e, 2));
    const sun = new THREE.DirectionalLight(0xffefc4, 3);
    sun.position.set(-5, 9, 8);
    this.scene.add(sun);

    const court = new THREE.Mesh(new THREE.PlaneGeometry(9.4, 22), new THREE.MeshStandardMaterial({ color: 0x38866a, roughness: 0.8 }));
    court.rotation.x = -Math.PI / 2;
    this.scene.add(court);
    const surround = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), new THREE.MeshStandardMaterial({ color: 0x335974, roughness: 1 }));
    surround.rotation.x = -Math.PI / 2;
    surround.position.y = -0.02;
    this.scene.add(surround);

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8ebd7 });
    const addLine = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lineMat);
      m.position.set(x, 0.015, z);
      this.scene.add(m);
    };
    const singlesWidth = 2 * COURT_HALF_WIDTH + LINE_WIDTH;
    for (const z of [-BASELINE_Z, BASELINE_Z]) addLine(9.2, LINE_WIDTH, 0, z);
    for (const z of [-SERVICE_LINE_Z, SERVICE_LINE_Z]) addLine(singlesWidth, LINE_WIDTH, 0, z);
    for (const x of [-4.55, 4.55, -COURT_HALF_WIDTH, COURT_HALF_WIDTH]) addLine(LINE_WIDTH, 2 * BASELINE_Z, x, 0);
    addLine(LINE_WIDTH, 2 * SERVICE_LINE_Z, 0, 0);
    for (const z of [-BASELINE_Z + 0.12, BASELINE_Z - 0.12]) addLine(LINE_WIDTH, 0.24, 0, z);

    const netWidth = NET_HALF_WIDTH * 2;
    const strands: number[] = [];
    for (let x = -NET_HALF_WIDTH; x <= NET_HALF_WIDTH; x += 0.115) strands.push(x, 0.04, NET_Z, x, NET_HEIGHT, NET_Z);
    for (let y = 0.04; y <= NET_HEIGHT; y += 0.085) strands.push(-NET_HALF_WIDTH, y, NET_Z, NET_HALF_WIDTH, y, NET_Z);
    const mesh = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(strands, 3));
    this.scene.add(new THREE.LineSegments(mesh, new THREE.LineBasicMaterial({ color: 0x24444d })));
    const tape = new THREE.Mesh(new THREE.BoxGeometry(netWidth, 0.055, 0.055), lineMat);
    tape.position.y = NET_HEIGHT;
    this.scene.add(tape);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x304e63 });
    for (const x of [-NET_HALF_WIDTH, NET_HALF_WIDTH]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 1.05, 8), postMat);
      post.position.set(x, 0.525, 0);
      this.scene.add(post);
    }
    const wall = new THREE.Mesh(new THREE.BoxGeometry(22, 1.7, 0.2), postMat);
    wall.position.set(0, 0.85, -13);
    this.scene.add(wall);
    const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x548a58 });
    for (let i = 0; i < 9; i += 1) {
      const tree = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4 + (i % 3) * 0.28, 1), canopyMaterial);
      tree.position.set(-13 + i * 3.2, 2.8 + (i % 3) * 0.3, -15 - (i % 2));
      this.scene.add(tree);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.23, 2.3, 7), postMat);
      trunk.position.set(tree.position.x, 1.15, tree.position.z);
      this.scene.add(trunk);
    }
    this.player.grip.add(this.makeRacket());
    this.opponent.grip.add(this.makeRacket());
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.bounceRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.player.root, this.opponent.root, this.ballMesh, this.ballShadow, this.bounceRing);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, simulationTimeMs, wallTimeMs) => (
      this.update(dt, simulationTimeMs, wallTimeMs)
    ));
    this.hudTimer = window.setInterval(() => this.publishHud(), 200);
  }

  private makeRacket(): THREE.Group {
    const group = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.35, 6), new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
    handle.position.y = 0.17;
    group.add(handle);
    const head = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 6, 14), new THREE.MeshStandardMaterial({ color: 0xcf3d3d }));
    head.position.y = 0.45;
    group.add(head);
    return group;
  }

  // ---------------------------------------------------------------- input

  onAction(event: SportActionEvent): void {
    if (event.type === 'swing-start') {
      this.swingDirection = event.hand === 'left' ? -1 : 1;
      this.swingAnimT = 0;
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
    this.applyPlayerOutcome(outcome, ballAtPeak, simulationSwing.peakTimestampMs, now, false, wallNow);
  }

  private resolveServe(
    swing: { side: 'forehand' | 'backhand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number },
    now: number,
    wallNow: number,
  ): void {
    if (this.phase.kind !== 'player-serve' || !this.ball) return;
    const ballAtPeak = this.rewind(swing.peakTimestampMs);
    if (!ballAtPeak) return;
    // Temporal override: the toss defines its own ideal instant (just past the apex), and the
    // generous reach matches the serve's high contact — the serve teaches the timing mechanic.
    const outcome = adjudicateContact({
      ballAtPeak,
      playerX: this.playerX + SERVE_CONTACT_X_OFFSET,
      movementPenalty01: 0,
      swing,
      timingErrorOverrideMs: swing.peakTimestampMs - this.phase.idealHitMs,
      geometry: { reachRadius: 2.2, playerZ: BASELINE_Z + 1, maxTimingMs: 320 },
    });
    this.applyPlayerOutcome(outcome, ballAtPeak, swing.peakTimestampMs, now, true, wallNow);
  }

  private applyPlayerOutcome(
    outcome: ContactOutcome,
    ballAtPeak: BallState,
    peakMs: number,
    now: number,
    isServe = false,
    wallNow = nowMs(),
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
    const outgoing = isServe
      ? solveOutgoing(ballAtPeak.position, {
        x: -serviceSide(this.score.points) * (1.6 + outcome.timingErrorMs / 110),
        z: -4 - outcome.timingErrorMs / 150,
      }, 0.88 - outcome.quality01 * 0.12)
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
    this.audio?.hit(0.4 + 0.6 * outcome.quality01);
    for (let elapsed = 0; elapsed < lagSec && this.phase.kind === 'rally';) {
      const dt = Math.min(1 / 60, lagSec - elapsed);
      elapsed += dt;
      this.stepBall(dt, peakMs + elapsed * 1000);
    }
    if (this.phase.kind !== 'rally') return;

    const spinLabel = outcome.spin > 0.4 ? ' · TOPSPIN' : outcome.spin < -0.4 ? ' · SLICE' : '';
    const dirLabel = outcome.direction === 'cross' ? 'CRUZADA' : outcome.direction === 'line' ? 'PARALELA' : 'CENTRO';
    if (outcome.smash) this.setFeedback('SMASH!', 'good');
    else if (outcome.quality01 > 0.85) this.setFeedback(isServe ? 'SAQUE PERFEITO' : 'NO PONTO!', 'good');
    this.status = isServe ? 'Saque diagonal' : `${dirLabel}${spinLabel}`;
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
        if (now >= this.phase.hitAtMs && this.ball) {
          // The serve is not a return: always in, modest pace, slight lateral variety.
          const from = { x: this.serveX, y: 2.2, z: -BASELINE_Z - 0.35 };
          const targetX = Math.sign(this.serveX) * (1.2 + Math.random() * 1.3);
          const velocity = solveOutgoing(from, { x: targetX, z: 3.5 + Math.random() }, 1.05);
          this.ball = createBall(from, velocity, 'opponent');
          this.tape = [{ tMs: now, ball: this.ball }];
          this.opponentSwingT = 0;
          this.servingFlight = true;
          this.phase = { kind: 'rally' };
          this.audio?.hit(0.5);
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
    if (this.score.server === 'player') {
      this.tossBall(now);
      this.status = 'Seu saque — raquetada no ápice!';
    } else {
      this.ball = createBall({ x: this.serveX, y: 2.2, z: -BASELINE_Z - 0.35 }, { x: 0, y: 0, z: 0 }, 'opponent');
      this.tape = [{ tMs: now, ball: this.ball }];
      this.phase = { kind: 'opponent-serve', hitAtMs: now + 900 };
      this.status = 'Saque do adversário…';
    }
  }

  private tossBall(now: number): void {
    const from = { x: this.playerX + SERVE_CONTACT_X_OFFSET, y: 1.4, z: BASELINE_Z + 0.35 };
    this.ball = createBall(from, { x: 0, y: TOSS_VY, z: 0 }, 'player');
    this.tape = [{ tMs: now, ball: this.ball }];
    const apexSec = TOSS_VY / 9.8;
    // Ideal contact slightly past the apex on the way down — classic serve timing.
    this.phase = { kind: 'player-serve', idealHitMs: now + (apexSec + 0.12) * 1000 };
  }

  private stepBall(dt: number, now: number): void {
    // Ball physics runs in rally and during the serve toss; everything else is paused.
    if ((this.phase.kind !== 'rally' && this.phase.kind !== 'player-serve') || !this.ball) return;

    if (this.pendingPoint) {
      const { winner, label, deadAt } = this.pendingPoint;
      if (now >= deadAt + 650) this.endPoint(winner, label, now);
      return;
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
      const decision = decideReturn(this.opponentAi, this.pressureOnOpponent(contactBall), Math.random);
      this.opponentHitPlan = null;
      if (decision.kind === 'no-return') return; // ball plays on — the bounce rules score the point
      this.ball = resolveScheduledOpponentReturn(
        plan,
        now,
        { x: decision.targetX, z: decision.targetZ },
        decision.flightTimeSeconds,
      );
      this.tape = [{ tMs: now, ball: this.ball }];
      this.servingFlight = false;
      this.opponentSwingT = 0;
      this.audio?.hit(0.45);
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
  }

  private stepAvatars(dt: number): void {
    // Auto-movement like the Miis: glide toward the incoming ball's lateral position.
    let targetX = this.phase.kind === 'player-serve' ? this.serveX : 0;
    if (this.ball && this.ball.velocity.z > 0.5 && this.ball.position.z < PLAYER_HOME_Z + 2) {
      targetX = Math.max(-2.8, Math.min(2.8, advanceBall(this.ball, timeAtPlane(this.ball, 7.2)?.timeSeconds ?? 0).position.x));
    }
    const before = this.playerX;
    const delta = targetX - this.playerX;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), PLAYER_MOVE_SPEED * dt);
    this.playerX += step;
    this.playerLateralSpeed = Math.abs(this.playerX - before) / Math.max(dt, 1e-6);

    let oppTarget = this.phase.kind === 'opponent-serve' ? this.serveX : 0;
    if (this.ball && this.ball.velocity.z < -0.5) {
      oppTarget = Math.max(-2.5, Math.min(2.5, this.opponentHitPlan ? ballAtPlannedContact(this.opponentHitPlan).position.x : this.ball.position.x));
    }
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
    this.swingAnimT = Math.min(1, this.swingAnimT + dt / 0.28);
    this.opponentSwingT = Math.min(1, this.opponentSwingT + dt / 0.28);
  }

  private render(): void {
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
    this.player.animate(this.playerStride, this.playerMotion, this.swingAnimT, this.swingDirection);
    this.opponent.animate(this.opponentStride, -this.opponentMotion, this.opponentSwingT, 1);
    const portrait = Math.max(0, 1.35 - this.camera.aspect);
    this.camera.position.set(0, 8.2 + portrait * 3, 18 + portrait * 8);
    this.camera.lookAt(0, 0.75, 0);
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
