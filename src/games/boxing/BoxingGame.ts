import * as THREE from 'three';
import type { Hand, SportActionEvent } from '../../cv/protocol';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { GameHudState, HudFeedback } from '../core/hud';
import { RunGate, type RunPhase } from '../track/runGate';
import { applyLatePunch, applyOpponentPunch, applyPlayerPunch, createBoxing, MAX_HP, ROUND_COUNT, tickRound, type BoxingState } from './boxingRules';
import type { BoxingMode } from './boxingModes';
import { createImpactSparkPool, type ImpactEffectKind, type ImpactSparkPool } from './impactEffects';
import { createFirstPersonGloves, createMiiBoxer, type FirstPersonGloves, type MiiBoxer, type MiiBoxerFootwork, type MiiBoxerState } from './miiBoxer';
import {
  createOpponentAi,
  IMPACT_GRACE_MS,
  isDodged,
  MAX_PUNCH_LOOKBACK_MS,
  type OpponentAiState,
  type OpponentAttack,
  openingAt,
  stepOpponent,
  type Zone,
} from './opponentAi';
import { opponentProfile, type OpponentProfile, type OpponentProfileId } from './opponentProfiles';
import { createPunchingBag, type PunchingBag } from './punchingBag';
import {
  inPunchRange,
  moveAround,
  OPPONENT_START,
  PLAYER_START,
  type RingPosition,
  rightOf,
  stepOpponentPosition,
} from './ringMovement';
import { buildBoxingRing, type BoxingRing } from './ringScene';
import {
  DEFAULT_DODGE_CHALLENGE_CONFIG,
  DEFAULT_DODGE_SEQUENCE,
  DodgeChallenge,
  type DodgeChallengeEvent,
  PunchingBagTrainer,
  type PunchingBagEvent,
} from './trainingRules';

/**
 * First-person boxing. The body is the dodge (lane zone) and the footwork (a held lean circles,
 * a step in depth approaches or retreats), the arms are the punches. The camera pipeline's
 * RunGate decides whether the fight may progress.
 *
 * Time base: `fightMs` advances only while the gate is running, so countdowns and pauses freeze
 * the opponent and the round clock together. A punch is adjudicated at its physical peak, mapped
 * into fight time by its age. Training modes use the same gate and clock, but replace the match
 * rules with the pure trainers from `trainingRules.ts`.
 */

const ROUND_BREAK_MS = 3000;
const MATCH_PAUSE_MS = 5000;
const KEY_PUNCH_POWER01 = 0.65;
/** Matches the camera detector's per-hand refractory; key auto-repeat must not outpunch an arm. */
const KEY_PUNCH_COOLDOWN_MS = 250;
/** Fight time after a dodge in which one punch counts as a counter. */
const COUNTER_WINDOW_MS = 1100;
const GUARD_KEYS = new Set(['arrowdown', 'q']);
const PUNCH_KEY = 'e';
const PUNCH_ANIM_S = 0.24;
const OPPONENT_HIT_S = 0.35;
const ZONE_WIDTH = 0.7;
const ZONE_HISTORY_MS = 1000;
const RING_CANVAS_Y = 1.05;
const CAMERA_EYE_Y = RING_CANVAS_Y + 1.55;
/** Footwork speeds in m/s. */
const KEY_MOVE_SPEED = 1.4;
const BODY_MOVE_SPEED = 0.7;
/** A lean held this long also circles; shorter ones are only a dodge. */
const LEAN_CIRCLE_AFTER_MS = 350;
/** Sideways ring displacement that also counts as occupying a lateral dodge lane. */
const RING_DODGE_LANE_M = 0.45;
/** Opponent footwork normalization, matching the approach/circle speeds in ringMovement. */
const OPPONENT_FORWARD_SPEED = 0.6;
const OPPONENT_CIRCLE_SPEED = 0.25;
const BAG_POSITION: RingPosition = Object.freeze({ x: 0, z: 0 });
const MOVE_KEYS: Record<string, { forward: number; strafe: number }> = {
  w: { forward: 1, strafe: 0 },
  s: { forward: -1, strafe: 0 },
  a: { forward: 0, strafe: -1 },
  d: { forward: 0, strafe: 1 },
};
const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
const HANDS = ['left', 'right'] as const;

export interface BoxingGameOptions {
  mode?: BoxingMode;
  opponent?: OpponentProfileId;
}

export interface BoxingScoreboard {
  playerHp: number;
  opponentHp: number;
  maxHp: number;
  round: number;
  rounds: number;
  secondsLeft: number;
  /** Present before the first bell and after a terminal fight/training result. */
  selectionOpen?: boolean;
  training?: BoxingTrainingScoreboard;
}

export interface BoxingTrainingScoreboard {
  kind: 'bag' | 'dodge';
  score: number;
  combo?: number;
  precision01?: number;
  attacksResolved?: number;
  attacksTotal?: number;
  attacksRemaining?: number;
  hitsTaken?: number;
  hitsRemaining?: number;
}

export type BoxingHudState = GameHudState & { banner?: { title: string; detail?: string }; boxing: BoxingScoreboard };

export class BoxingGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 80);
  private readonly opponentBoxer: MiiBoxer | undefined;
  private readonly gloves: FirstPersonGloves;
  private readonly bag: PunchingBag | undefined;
  private readonly sparks: ImpactSparkPool = createImpactSparkPool();
  private readonly ring: BoxingRing | undefined;
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private readonly gate = new RunGate();
  private readonly mode: BoxingMode;
  private readonly profile: OpponentProfile;

  private match: BoxingState = createBoxing();
  private ai: OpponentAiState;
  private bagTrainer: PunchingBagTrainer | undefined;
  private dodgeChallenge: DodgeChallenge | undefined;
  private fightMs = 0;
  private animTimeS = 0;
  /** Wall time the fight last (re)started; punches peaking before it belong to a frozen fight. */
  private runningSinceWallMs = Number.POSITIVE_INFINITY;
  private lastPhase: RunPhase = 'countdown';
  /** Wall time of the last bell, until the next exchange starts. */
  private roundEndedWallMs: number | undefined;
  private breakMsLeft = 0;
  private restartMsLeft = 0;
  private zone: Zone = 0;
  private cameraZone: Zone | undefined;
  /** The lean the camera sees right now; unlike `cameraZone` it is forgotten with the opinion. */
  private lean: Zone = 0;
  private leanHeldMs = 0;
  private cameraDepth: -1 | 0 | 1 = 0;
  private readonly moveKeys = new Set<string>();
  private playerPos: RingPosition = PLAYER_START;
  private opponentPos: RingPosition = OPPONENT_START;
  private circleDirection: -1 | 1 = 1;
  private dodgeOffset = 0;
  private keyGuard = false;
  /** The punch key alternates arms, so two taps are a one-two. */
  private nextKeyHand: Hand = 'right';
  private cameraGuard = false;
  /** Fight-time bounds of the open counter window, if any. */
  private counter: { fromMs: number; untilMs: number } | undefined;
  private zoneHistory: { atMs: number; zone: Zone; guarded: boolean; inRange: boolean }[] = [];
  private punchAnimS: Record<Hand, number> = { left: PUNCH_ANIM_S, right: PUNCH_ANIM_S };
  private opponentHitS = 0;
  private hitShakeS = 0;
  private opponentFootwork: Required<MiiBoxerFootwork> = { speed01: 0, forward: 0, strafe: 0 };
  private keyPunchAtMs: Record<Hand, number> = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  private status = 'Soque quando a guarda abrir';
  private feedback: HudFeedback | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: BoxingHudState) => void,
    private readonly audio?: ProceduralAudio,
    private readonly rng: () => number = Math.random,
    options: BoxingGameOptions = {},
  ) {
    this.mode = options.mode ?? 'fight';
    this.profile = opponentProfile(options.opponent);
    this.status = this.initialStatus();
    this.ai = createOpponentAi(this.fightMs, this.rng, this.profile.skill);
    this.scene.background = new THREE.Color(0x0b1522);

    if (this.mode === 'bag') {
      this.opponentBoxer = undefined;
      this.bagTrainer = new PunchingBagTrainer();
      this.opponentPos = BAG_POSITION;
    } else {
      this.opponentBoxer = createMiiBoxer({
        shirtColor: this.profile.shirtColor,
        trimColor: this.profile.trimColor,
        shortsColor: this.profile.shortsColor,
        gloveColor: this.profile.gloveColor,
      });
      this.scene.add(this.opponentBoxer.root);
    }

    if (this.mode === 'bag') {
      this.bag = createPunchingBag();
      this.scene.add(this.bag.root);
    } else {
      this.bag = undefined;
    }
    if (this.mode === 'dodge') this.dodgeChallenge = new DodgeChallenge();

    this.placeFighters(1);
    this.gloves = createFirstPersonGloves();
    this.camera.add(this.gloves.root);
    this.scene.add(this.camera);
    this.scene.add(this.sparks.root);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt) => this.update(dt));
    if (this.loop.renderer) {
      this.ring = buildBoxingRing(this.scene, this.loop.renderer);
    } else {
      this.scene.add(new THREE.HemisphereLight(0xf0f4ff, 0x2a2018, 2));
    }
    this.poseGloves();
    this.hudTimer = window.setInterval(() => this.publishHud(), 100);
  }

  // ---------------------------------------------------------------- input

  setTracking(tracking: string): void {
    this.gate.setTracking(tracking);
    this.syncPhase();
    this.publishHud();
  }

  /** Same authority rule as the track: a changed body zone applies absolutely, keys hold until then. */
  setLaneZone(zone: Zone | undefined): void {
    this.lean = zone ?? 0;
    if (zone === undefined) return;
    if (zone !== this.cameraZone) this.zone = zone;
    this.cameraZone = zone;
  }

  resetLaneZone(): void {
    this.cameraZone = undefined;
    this.lean = 0;
  }

  /** Unlike the lane, a guard never latches: a camera with no opinion is not guarding. */
  setGuard(guard: boolean | undefined): void {
    this.cameraGuard = guard === true;
  }

  /** Like the guard, footwork never latches: no opinion means standing still. */
  setDepthMove(move: -1 | 0 | 1 | undefined): void {
    this.cameraDepth = move ?? 0;
  }

  private guarding(): boolean {
    return this.keyGuard || this.cameraGuard;
  }

  onAction(event: SportActionEvent): void {
    if (event.type !== 'punch-start' && event.type !== 'punch') return;
    if (event.type === 'punch-start') {
      if (this.punchingActive() || (this.mode === 'dodge' && this.trainingActive())) {
        this.punchAnimS[event.hand] = 0;
        this.audio?.whoosh(0.55);
      }
      return;
    }

    if (this.mode === 'bag') {
      if (event.peakTimestampMs < this.runningSinceWallMs) return;
      if (this.trainingActive()) this.landBagPunch(event.power01, event.hand);
      return;
    }
    if (this.mode === 'dodge') return;

    if (event.peakTimestampMs < this.runningSinceWallMs) return;
    if (this.fighting()) {
      const ageMs = Math.min(MAX_PUNCH_LOOKBACK_MS, Math.max(0, performance.now() - event.peakTimestampMs));
      this.landPunch(event.power01, this.fightMs - ageMs);
      return;
    }
    // Confirmation lags the peak: a punch that peaked before the bell still counts. The fight
    // clock has been frozen since the bell, so its age is measured back from there.
    if (this.gate.phase !== 'running' || this.roundEndedWallMs === undefined) return;
    const beforeBellMs = this.roundEndedWallMs - event.peakTimestampMs;
    if (beforeBellMs < 0 || beforeBellMs > MAX_PUNCH_LOOKBACK_MS) return;
    this.landPunch(event.power01, this.fightMs - beforeBellMs, applyLatePunch);
  }

  onKey(key: string): void {
    const pressed = key.toLowerCase();
    const move = pressed === 'arrowleft' ? -1 : pressed === 'arrowright' ? 1 : 0;
    const hand: Hand | undefined = pressed === PUNCH_KEY ? this.nextKeyHand : undefined;
    const guard = GUARD_KEYS.has(pressed);
    const footwork = pressed in MOVE_KEYS;
    if (move === 0 && !hand && !guard && !footwork) return;
    if (guard) this.keyGuard = true;
    if (footwork) this.moveKeys.add(pressed);
    if (this.gate.resumeByKey()) {
      this.syncPhase();
      return;
    }
    if (move !== 0) {
      this.zone = Math.max(-1, Math.min(1, this.zone + move)) as Zone;
    } else if (hand && this.punchingActive() && this.fightMs - this.keyPunchAtMs[hand] >= KEY_PUNCH_COOLDOWN_MS) {
      this.keyPunchAtMs[hand] = this.fightMs;
      this.nextKeyHand = hand === 'right' ? 'left' : 'right';
      this.punchAnimS[hand] = 0;
      this.audio?.whoosh(KEY_PUNCH_POWER01);
      if (this.mode === 'bag') this.landBagPunch(KEY_PUNCH_POWER01, hand);
      else this.landPunch(KEY_PUNCH_POWER01, this.fightMs);
    }
  }

  onKeyUp(key: string): void {
    const released = key.toLowerCase();
    if (GUARD_KEYS.has(released)) this.keyGuard = false;
    this.moveKeys.delete(released);
  }

  private fighting(): boolean {
    return this.mode === 'fight' && this.gate.phase === 'running' && this.breakMsLeft <= 0 && !this.match.winner;
  }

  private trainingActive(): boolean {
    if (this.gate.phase !== 'running' || this.restartMsLeft > 0) return false;
    if (this.mode === 'bag') return this.bagTrainer?.snapshot.status === 'active';
    if (this.mode === 'dodge') return this.dodgeChallenge?.snapshot.status === 'active';
    return false;
  }

  private punchingActive(): boolean {
    return this.mode === 'fight' ? this.fighting() : this.mode === 'bag' && this.trainingActive();
  }

  private landPunch(power01: number, atMs: number, apply = applyPlayerPunch): void {
    const sample = [...this.zoneHistory].reverse().find((entry) => entry.atMs <= atMs);
    if (!(sample?.inRange ?? inPunchRange(this.playerPos, this.opponentPos))) {
      this.setFeedback('LONGE DEMAIS', 'neutral');
      return;
    }
    const decided = this.match.winner;
    const counter = this.counter !== undefined && atMs >= this.counter.fromMs && atMs <= this.counter.untilMs;
    const result = apply(this.match, power01, openingAt(this.ai, atMs), counter);
    this.match = result.state;
    const blocked = result.damage === 0;
    this.spawnOpponentImpact(power01, blocked ? 'block' : 'hit');
    if (result.damage > 0) {
      if (counter) this.counter = undefined; // one counter per dodge
      this.opponentHitS = OPPONENT_HIT_S;
      this.setFeedback(result.ko ? 'NOCAUTE!' : counter ? 'CONTRA-ATAQUE!' : 'ACERTOU!', 'good');
      this.audio?.punchImpact(0.4 + 0.6 * power01, false);
      if (counter || result.ko) this.audio?.crowdReact(result.ko ? 1 : 0.7);
    } else {
      this.setFeedback('BLOQUEADO', 'neutral');
      this.audio?.punchImpact(0.3 + 0.4 * power01, true);
    }
    if (result.ko || this.match.winner !== decided) this.endMatch();
  }

  private landBagPunch(power01: number, hand: Hand): void {
    if (this.bagTrainer?.snapshot.status !== 'active') return;
    if (!inPunchRange(this.playerPos, this.opponentPos)) {
      this.setFeedback('LONGE DEMAIS', 'neutral');
      return;
    }
    this.bag?.hit(hand, power01);
    this.spawnBagImpact(power01);
    const events = this.bagTrainer.punch({ timeSeconds: this.fightMs / 1000, strength01: power01 });
    this.applyBagEvents(events);
  }

  // ---------------------------------------------------------------- update

  private syncPhase(): void {
    const { phase } = this.gate;
    if (phase === 'running' && this.lastPhase !== 'running') this.runningSinceWallMs = performance.now();
    this.lastPhase = phase;
  }

  private update(dt: number): void {
    this.gate.advance(dt);
    this.syncPhase();
    if (this.gate.phase === 'running') this.step(dt * 1000);
    if (this.gate.phase !== 'paused') {
      this.animTimeS += dt;
      for (const hand of HANDS) this.punchAnimS[hand] = Math.min(PUNCH_ANIM_S, this.punchAnimS[hand] + dt);
      this.opponentHitS = Math.max(0, this.opponentHitS - dt);
      this.hitShakeS = Math.max(0, this.hitShakeS - dt);
      this.bag?.update(dt);
      this.sparks.update(dt);
    }
    this.poseScene(dt);
  }

  private step(dtMs: number): void {
    if (this.mode === 'bag') {
      this.stepBag(dtMs);
      return;
    }
    if (this.mode === 'dodge') {
      this.stepDodge(dtMs);
      return;
    }
    this.stepFight(dtMs);
  }

  private stepBag(dtMs: number): void {
    const trainer = this.bagTrainer;
    if (!trainer) return;
    if (trainer.snapshot.status === 'won') {
      this.restartMsLeft -= dtMs;
      if (this.restartMsLeft <= 0) this.resetTraining();
      return;
    }

    this.fightMs += dtMs;
    this.movePlayer(dtMs);
    this.applyBagEvents(trainer.advanceTo(this.fightMs / 1000));
  }

  private stepDodge(dtMs: number): void {
    const challenge = this.dodgeChallenge;
    if (!challenge) return;
    if (challenge.snapshot.status !== 'active') {
      this.restartMsLeft -= dtMs;
      if (this.restartMsLeft <= 0) this.resetTraining();
      return;
    }

    this.fightMs += dtMs;
    this.movePlayer(dtMs);
    this.applyDodgeEvents(challenge.advance(dtMs / 1000, this.trainingLaneZone()));
  }

  private stepFight(dtMs: number): void {
    if (this.match.winner) {
      this.restartMsLeft -= dtMs;
      if (this.restartMsLeft <= 0) {
        this.match = createBoxing();
        this.resetExchange();
        this.status = 'Nova luta';
      }
      return;
    }
    if (this.breakMsLeft > 0) {
      this.breakMsLeft -= dtMs;
      if (this.breakMsLeft <= 0) this.resetExchange();
      return;
    }

    this.fightMs += dtMs;
    this.moveFighters(dtMs);
    const inRange = inPunchRange(this.playerPos, this.opponentPos);
    this.zoneHistory.push({ atMs: this.fightMs, zone: this.zone, guarded: this.guarding(), inRange });
    while (this.zoneHistory[0] && this.zoneHistory[0].atMs < this.fightMs - ZONE_HISTORY_MS) this.zoneHistory.shift();

    const stepped = stepOpponent(this.ai, this.fightMs, this.zone, this.rng);
    this.ai = stepped.state;
    if (stepped.attack) this.resolveAttack(stepped.attack);
    if (this.match.winner) return;

    // A punch already past its impact is only waiting out pose latency: the bell does not save
    // the player. It resolves before the last tick so it can still change the decision.
    const { phase } = this.ai;
    if (dtMs >= this.match.roundMsLeft && phase.kind === 'windup' && phase.impactAtMs <= this.fightMs) {
      this.resolveAttack(phase);
      if (this.match.winner) return;
    }

    const tick = tickRound(this.match, dtMs);
    this.match = tick.state;
    if (!tick.roundEnded) return;
    this.roundEndedWallMs = performance.now();
    if (tick.matchEnded) this.endMatch();
    else {
      this.breakMsLeft = ROUND_BREAK_MS;
      this.audio?.bell('round');
    }
  }

  private movePlayer(dtMs: number): void {
    const dtS = dtMs / 1000;
    let forward = 0;
    let strafe = 0;
    for (const key of this.moveKeys) {
      forward += MOVE_KEYS[key]!.forward * KEY_MOVE_SPEED;
      strafe += MOVE_KEYS[key]!.strafe * KEY_MOVE_SPEED;
    }
    this.leanHeldMs = this.lean === 0 ? 0 : this.leanHeldMs + dtMs;
    if (this.leanHeldMs > LEAN_CIRCLE_AFTER_MS) strafe += this.lean * BODY_MOVE_SPEED;
    forward += this.cameraDepth * BODY_MOVE_SPEED;
    // Keys and body together are no faster than the keys alone.
    const limit = (speed: number) => clampUnit(speed / KEY_MOVE_SPEED) * KEY_MOVE_SPEED * dtS;
    this.playerPos = moveAround(this.playerPos, this.opponentPos, limit(forward), limit(strafe));
  }

  private moveFighters(dtMs: number): void {
    this.movePlayer(dtMs);

    const dtS = dtMs / 1000;
    const beforeX = this.opponentPos.x;
    const beforeZ = this.opponentPos.z;
    const moved = stepOpponentPosition(this.opponentPos, this.playerPos, this.ai.phase.kind, this.circleDirection, dtS);
    this.opponentPos = moved.position;
    this.circleDirection = moved.direction;
    this.updateOpponentFootwork((this.opponentPos.x - beforeX) / dtS, (this.opponentPos.z - beforeZ) / dtS);
  }

  private updateOpponentFootwork(velocityX: number, velocityZ: number): void {
    const speed = Math.hypot(velocityX, velocityZ);
    if (speed < 1e-6) {
      this.opponentFootwork.speed01 = 0;
      this.opponentFootwork.forward = 0;
      this.opponentFootwork.strafe = 0;
      return;
    }
    const distance = Math.hypot(this.playerPos.x - this.opponentPos.x, this.playerPos.z - this.opponentPos.z) || 1;
    const forwardX = (this.playerPos.x - this.opponentPos.x) / distance;
    const forwardZ = (this.playerPos.z - this.opponentPos.z) / distance;
    const right = rightOf(this.opponentPos, this.playerPos);
    this.opponentFootwork.speed01 = Math.min(1, speed / OPPONENT_FORWARD_SPEED);
    this.opponentFootwork.forward = clampUnit((velocityX * forwardX + velocityZ * forwardZ) / OPPONENT_FORWARD_SPEED);
    this.opponentFootwork.strafe = clampUnit((velocityX * right.x + velocityZ * right.z) / OPPONENT_CIRCLE_SPEED);
  }

  /** Lane zone for training: explicit lean/key input wins, but real displacement off center also counts. */
  private trainingLaneZone(): Zone {
    if (this.zone !== 0) return this.zone;
    const lateral = this.playerPos.x - this.opponentPos.x;
    if (lateral > RING_DODGE_LANE_M) return 1;
    if (lateral < -RING_DODGE_LANE_M) return -1;
    return 0;
  }

  private resolveAttack(attack: OpponentAttack): void {
    const samples = this.zoneHistory
      .filter(({ atMs }) => atMs >= attack.impactAtMs && atMs <= attack.impactAtMs + IMPACT_GRACE_MS);
    // Range is judged as the fist arrives; the bell path may resolve before any sample.
    if (!(samples[0]?.inRange ?? inPunchRange(this.playerPos, this.opponentPos))) {
      this.setFeedback('LONGE DEMAIS', 'neutral');
      this.audio?.whoosh(0.6);
      return;
    }
    const dodged = isDodged(attack.targetZone, samples.map(({ zone }) => zone));
    // Same grace as the dodge: fists that come up within the pose-latency window count.
    const guarded = samples.some((sample) => sample.guarded);
    const result = applyOpponentPunch(this.match, { dodged, guarded });
    this.match = result.state;
    if (dodged) {
      this.counter = { fromMs: this.fightMs, untilMs: this.fightMs + COUNTER_WINDOW_MS };
      this.setFeedback('ESQUIVOU!', 'good');
      this.audio?.success(1);
    } else if (guarded && !result.ko) {
      this.spawnPlayerImpact(0.45, 'block');
      this.setFeedback('DEFENDEU', 'neutral');
      this.audio?.punchImpact(0.65, true);
    } else {
      this.spawnPlayerImpact(0.85, 'hit');
      this.hitShakeS = 0.3;
      this.setFeedback(result.ko ? 'NOCAUTE…' : 'LEVOU UM SOCO', 'bad');
      this.audio?.punchImpact(0.85, false);
    }
    if (result.ko) this.endMatch();
  }

  private applyBagEvents(events: readonly PunchingBagEvent[]): void {
    for (const event of events) {
      if (event.kind === 'hit') {
        this.setFeedback(`${Math.round(event.precision01 * 100)}% · +${event.points}`, 'good');
        this.audio?.punchImpact(0.35 + 0.65 * event.strength01, false);
      } else if (event.kind === 'punch-error') {
        const text = event.reason === 'weak' ? 'FRACO' : event.reason === 'duplicate' ? 'JÁ CONTADO' : 'FORA DO RITMO';
        this.setFeedback(text, event.reason === 'timing' ? 'bad' : 'neutral');
        this.audio?.punchImpact(0.25 + 0.35 * event.strength01, true);
      } else if (event.kind === 'beat-missed') {
        this.setFeedback('PERDEU O RITMO', 'neutral');
      } else {
        this.finishTraining('Saco completo!', true);
      }
    }
  }

  private applyDodgeEvents(events: readonly DodgeChallengeEvent[]): void {
    for (const event of events) {
      if (event.kind === 'attack-telegraph') {
        const side = event.safeLane < 0 ? 'a esquerda' : event.safeLane > 0 ? 'a direita' : 'o centro';
        this.status = `Ocupe ${side}`;
      } else if (event.kind === 'attack-active') {
        this.audio?.whoosh(0.8);
      } else if (event.kind === 'attack-resolved') {
        if (event.outcome === 'correct' || event.outcome === 'early') {
          this.setFeedback(event.outcome === 'correct' ? 'ESQUIVOU!' : 'CEDO, MAS VALEU', 'good');
          this.audio?.success(event.outcome === 'correct' ? 1 : 0.55);
        } else {
          this.spawnPlayerImpact(0.8, 'hit');
          this.hitShakeS = 0.3;
          this.setFeedback(event.outcome === 'late' ? 'TARDE DEMAIS' : 'LEVOU UM SOCO', 'bad');
          this.audio?.punchImpact(0.85, false);
        }
        this.status = `${event.dodges} esquivas · ${event.hits} golpes sofridos`;
      } else if (event.kind === 'won') {
        this.finishTraining('Esquiva completa!', true);
      } else {
        this.finishTraining(event.reason === 'hit-limit' ? 'Acertaram você!' : 'Desafio perdido', false);
      }
    }
  }

  private finishTraining(title: string, won: boolean): void {
    this.restartMsLeft = MATCH_PAUSE_MS;
    this.status = title;
    this.audio?.bell(won ? 'ko' : 'round');
    if (won) this.audio?.crowdReact(1);
    else this.audio?.failure();
  }

  /** A fresh opponent in guard: nothing wound up before a break carries into the next exchange. */
  private resetExchange(): void {
    this.breakMsLeft = 0;
    this.roundEndedWallMs = undefined;
    this.counter = undefined;
    this.zoneHistory = [];
    this.playerPos = PLAYER_START;
    this.opponentPos = OPPONENT_START;
    this.circleDirection = 1;
    this.leanHeldMs = 0;
    this.opponentFootwork = { speed01: 0, forward: 0, strafe: 0 };
    this.ai = createOpponentAi(this.fightMs, this.rng, this.profile.skill);
    this.runningSinceWallMs = performance.now();
  }

  private resetTraining(): void {
    this.restartMsLeft = 0;
    this.fightMs = 0;
    this.zoneHistory = [];
    this.playerPos = PLAYER_START;
    this.opponentPos = this.mode === 'bag' ? BAG_POSITION : OPPONENT_START;
    this.leanHeldMs = 0;
    this.opponentFootwork = { speed01: 0, forward: 0, strafe: 0 };
    if (this.mode === 'bag') {
      this.bagTrainer = new PunchingBagTrainer();
      this.bag?.reset();
    }
    if (this.mode === 'dodge') this.dodgeChallenge = new DodgeChallenge();
    this.runningSinceWallMs = performance.now();
    this.status = this.initialStatus();
  }

  private endMatch(): void {
    this.restartMsLeft = MATCH_PAUSE_MS;
    this.status = this.match.winner === 'player' ? 'VOCÊ VENCEU!' : this.match.winner === 'draw' ? 'Empate' : 'Adversário venceu';
    this.audio?.bell('ko');
    if (this.match.winner === 'player') this.audio?.crowdReact(1);
  }

  private initialStatus(): string {
    if (this.mode === 'bag') return 'Siga o ritmo do saco';
    if (this.mode === 'dodge') return 'Leia o golpe e ocupe a zona segura';
    return 'Soque quando a guarda abrir';
  }

  private trainingFinished(): boolean {
    if (this.mode === 'bag') return this.bagTrainer?.snapshot.status === 'won';
    if (this.mode === 'dodge') return this.dodgeChallenge !== undefined && this.dodgeChallenge.snapshot.status !== 'active';
    return false;
  }

  // ---------------------------------------------------------------- scene

  private poseScene(dt: number): void {
    this.placeFighters(1 - Math.exp(-14 * dt));
    this.poseGloves();
  }

  /** The dodge is a sideways offset from the stance, with the eyes staying on the opponent. */
  private placeFighters(blend: number): void {
    const { playerPos, opponentPos } = this;
    this.dodgeOffset += (this.zone * ZONE_WIDTH - this.dodgeOffset) * blend;
    const right = rightOf(playerPos, opponentPos);
    this.camera.position.set(
      playerPos.x + right.x * this.dodgeOffset,
      CAMERA_EYE_Y + Math.sin(this.hitShakeS * 70) * this.hitShakeS * 0.12,
      playerPos.z + right.z * this.dodgeOffset,
    );
    this.camera.lookAt(opponentPos.x, RING_CANVAS_Y + 1.35, opponentPos.z);
    this.bag?.root.position.set(opponentPos.x, RING_CANVAS_Y, opponentPos.z);
    if (this.opponentBoxer) {
      let telegraphOffset = 0;
      const dodge = this.dodgeChallenge?.snapshot;
      if (this.mode === 'dodge' && dodge?.currentAttack && (dodge.phase === 'telegraph' || dodge.phase === 'active')) {
        telegraphOffset = dodge.currentAttack.attackLane * 0.14;
      }
      this.opponentBoxer.root.position.set(
        opponentPos.x + right.x * telegraphOffset,
        RING_CANVAS_Y,
        opponentPos.z + right.z * telegraphOffset,
      );
      this.opponentBoxer.root.rotation.y = Math.atan2(playerPos.x - opponentPos.x, playerPos.z - opponentPos.z) + Math.PI;
    }
  }

  private opponentAnimationState(): MiiBoxerState {
    if (this.mode === 'dodge') {
      const snapshot = this.dodgeChallenge?.snapshot;
      if (!snapshot) return 'guard';
      if (snapshot.status === 'won') return 'dizzy';
      if (snapshot.status === 'lost') return 'guard';
      if (snapshot.phase === 'telegraph') return 'windup';
      if (snapshot.phase === 'active') return 'punch';
      return 'guard';
    }
    if (this.match.winner === 'player') return 'knockdown';
    if (this.opponentHitS > 0) return 'hit';
    const { phase } = this.ai;
    if (phase.kind === 'windup') {
      return phase.impactAtMs - this.fightMs <= 220 ? 'punch' : 'windup';
    }
    if (phase.kind === 'guard') return 'guard';
    return 'idle';
  }

  private poseGloves(): void {
    const reach = (hand: Hand) => Math.sin((this.punchAnimS[hand] / PUNCH_ANIM_S) * Math.PI);
    this.gloves.animate(this.animTimeS, {
      guard: this.guarding() ? 1 : 0.35,
      leftPunch: reach('left'),
      rightPunch: reach('right'),
    });
    if (this.opponentBoxer) {
      this.opponentBoxer.setState(this.opponentAnimationState());
      this.opponentBoxer.animate(this.animTimeS, this.opponentFootwork);
    }
  }

  private impactSurface(height: number, radius: number): { x: number; y: number; z: number } {
    const dx = this.playerPos.x - this.opponentPos.x;
    const dz = this.playerPos.z - this.opponentPos.z;
    const distance = Math.hypot(dx, dz) || 1;
    return {
      x: this.opponentPos.x + (dx / distance) * radius,
      y: RING_CANVAS_Y + height,
      z: this.opponentPos.z + (dz / distance) * radius,
    };
  }

  private spawnOpponentImpact(power01: number, kind: ImpactEffectKind): void {
    const point = this.impactSurface(1.35, 0.32);
    this.sparks.spawn(point.x, point.y, point.z, power01, kind);
  }

  private spawnBagImpact(power01: number): void {
    const point = this.impactSurface(1.25, 0.36);
    this.sparks.spawn(point.x, point.y, point.z, power01, 'hit');
  }

  private spawnPlayerImpact(power01: number, kind: ImpactEffectKind): void {
    const dx = this.opponentPos.x - this.camera.position.x;
    const dy = RING_CANVAS_Y + 1.35 - this.camera.position.y;
    const dz = this.opponentPos.z - this.camera.position.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    const reach = 0.48;
    this.sparks.spawn(
      this.camera.position.x + (dx / distance) * reach,
      this.camera.position.y + (dy / distance) * reach,
      this.camera.position.z + (dz / distance) * reach,
      power01,
      kind,
    );
  }

  // ---------------------------------------------------------------- hud & lifecycle

  private setFeedback(text: string, tone: HudFeedback['tone']): void {
    this.feedback = { id: (this.feedback?.id ?? 0) + 1, text, tone };
  }

  private trainingScoreboard(): BoxingTrainingScoreboard | undefined {
    if (this.mode === 'bag') {
      const snapshot = this.bagTrainer?.snapshot;
      if (!snapshot) return undefined;
      return {
        kind: 'bag',
        score: snapshot.score,
        combo: snapshot.combo,
        precision01: snapshot.averagePrecision01,
      };
    }
    if (this.mode === 'dodge') {
      const snapshot = this.dodgeChallenge?.snapshot;
      if (!snapshot) return undefined;
      const attacksTotal = DEFAULT_DODGE_SEQUENCE.length;
      return {
        kind: 'dodge',
        score: snapshot.score,
        attacksResolved: snapshot.resolvedAttacks,
        attacksTotal,
        attacksRemaining: Math.max(0, attacksTotal - snapshot.resolvedAttacks),
        hitsTaken: snapshot.hits,
        hitsRemaining: Math.max(0, DEFAULT_DODGE_CHALLENGE_CONFIG.maxHits + 1 - snapshot.hits),
      };
    }
    return undefined;
  }

  private publishHud(): void {
    const training = this.trainingScoreboard();
    const finished = this.mode === 'fight' ? this.match.winner !== undefined : this.trainingFinished();
    const countdownDetail = this.mode === 'bag' ? 'Prepare o ritmo' : this.mode === 'dodge' ? 'Leia o golpe' : 'Guarda alta';
    const banner = this.gate.phase === 'countdown' ? { title: String(this.gate.count), detail: countdownDetail }
      : this.gate.phase === 'paused' ? { title: 'PAUSA', detail: 'Volte para a câmera ou aperte W A S D' }
      : finished ? { title: this.status }
      : this.mode === 'fight' && this.breakMsLeft > 0 ? { title: `ROUND ${this.match.round}`, detail: 'Intervalo' }
      : undefined;
    const selectionOpen = this.gate.phase === 'countdown' || finished;
    this.onHud({
      score: training?.score ?? this.match.opponentHp,
      label: training ? String(training.score) : `${this.match.playerHp} × ${this.match.opponentHp}`,
      speed01: 0,
      status: this.status,
      feedback: this.feedback,
      banner,
      boxing: {
        playerHp: this.match.playerHp,
        opponentHp: this.match.opponentHp,
        maxHp: MAX_HP,
        round: this.match.round,
        rounds: ROUND_COUNT,
        secondsLeft: Math.ceil(this.match.roundMsLeft / 1000),
        ...(selectionOpen ? { selectionOpen: true } : {}),
        ...(training ? { training } : {}),
      },
    });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.ring?.dispose();
    this.loop.dispose();
  }
}
