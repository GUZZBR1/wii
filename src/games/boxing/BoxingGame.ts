import * as THREE from 'three';
import type { Hand, SportActionEvent } from '../../cv/protocol';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { GameHudState, HudFeedback } from '../core/hud';
import { RunGate, type RunPhase } from '../track/runGate';
import { applyLatePunch, applyOpponentPunch, applyPlayerPunch, createBoxing, MAX_HP, ROUND_COUNT, tickRound, type BoxingState } from './boxingRules';
import { createFirstPersonGloves, createMiiBoxer, type FirstPersonGloves, type MiiBoxer, type MiiBoxerState } from './miiBoxer';
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

/**
 * First-person boxing. The body is the dodge (lane zone) and the footwork (a held lean circles,
 * a step in depth approaches or retreats), the arms are the punches. The camera pipeline's
 * RunGate decides whether the fight may progress.
 *
 * Time base: `fightMs` advances only while the gate is running, so countdowns and pauses freeze
 * the opponent and the round clock together. A punch is adjudicated at its physical peak, mapped
 * into fight time by its age.
 */

const ROUND_BREAK_MS = 3000;
const MATCH_PAUSE_MS = 5000;
const KEY_PUNCH_POWER01 = 0.65;
/** Matches the camera detector's per-hand refractory; key auto-repeat must not outpunch an arm. */
const KEY_PUNCH_COOLDOWN_MS = 250;
/** Fight time after a dodge in which one punch counts as a counter. */
const COUNTER_WINDOW_MS = 1100;
const GUARD_KEYS = new Set(['arrowdown', 's']);
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
const MOVE_KEYS: Record<string, { forward: number; strafe: number }> = {
  w: { forward: 1, strafe: 0 },
  x: { forward: -1, strafe: 0 },
  q: { forward: 0, strafe: -1 },
  e: { forward: 0, strafe: 1 },
};
const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
const HANDS = ['left', 'right'] as const;

export interface BoxingScoreboard {
  playerHp: number;
  opponentHp: number;
  maxHp: number;
  round: number;
  rounds: number;
  secondsLeft: number;
}

export type BoxingHudState = GameHudState & { banner?: { title: string; detail?: string }; boxing: BoxingScoreboard };

export class BoxingGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 80);
  private readonly opponentBoxer: MiiBoxer;
  private readonly gloves: FirstPersonGloves;
  private readonly ring: BoxingRing | undefined;
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private readonly gate = new RunGate();

  private match: BoxingState = createBoxing();
  private ai: OpponentAiState;
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
  private cameraGuard = false;
  /** Fight-time bounds of the open counter window, if any. */
  private counter: { fromMs: number; untilMs: number } | undefined;
  private zoneHistory: { atMs: number; zone: Zone; guarded: boolean; inRange: boolean }[] = [];
  private punchAnimS: Record<Hand, number> = { left: PUNCH_ANIM_S, right: PUNCH_ANIM_S };
  private opponentHitS = 0;
  private hitShakeS = 0;
  private keyPunchAtMs: Record<Hand, number> = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  private status = 'Soque quando a guarda abrir';
  private feedback: HudFeedback | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: BoxingHudState) => void,
    private readonly audio?: ProceduralAudio,
    private readonly rng: () => number = Math.random,
  ) {
    this.ai = createOpponentAi(this.fightMs, this.rng);
    this.scene.background = new THREE.Color(0x0b1522);
    this.opponentBoxer = createMiiBoxer({
      shirtColor: 0x2f6fd0,
      trimColor: 0xf7f5f0,
      shortsColor: 0x1d3f73,
      gloveColor: 0x2f6fd0,
    });
    this.placeFighters(1);
    this.scene.add(this.opponentBoxer.root);
    this.gloves = createFirstPersonGloves();
    this.camera.add(this.gloves.root);
    this.scene.add(this.camera);
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
      if (this.fighting()) {
        this.punchAnimS[event.hand] = 0;
        this.audio?.whoosh(0.55);
      }
      return;
    }
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
    const hand: Hand | undefined = pressed === 'a' ? 'left' : pressed === 'd' ? 'right' : undefined;
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
    } else if (hand && this.fighting() && this.fightMs - this.keyPunchAtMs[hand] >= KEY_PUNCH_COOLDOWN_MS) {
      this.keyPunchAtMs[hand] = this.fightMs;
      this.punchAnimS[hand] = 0;
      this.audio?.whoosh(KEY_PUNCH_POWER01);
      this.landPunch(KEY_PUNCH_POWER01, this.fightMs);
    }
  }

  onKeyUp(key: string): void {
    const released = key.toLowerCase();
    if (GUARD_KEYS.has(released)) this.keyGuard = false;
    this.moveKeys.delete(released);
  }

  private fighting(): boolean {
    return this.gate.phase === 'running' && this.breakMsLeft <= 0 && !this.match.winner;
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
    }
    this.poseScene(dt);
  }

  private step(dtMs: number): void {
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

  private moveFighters(dtMs: number): void {
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

    const moved = stepOpponentPosition(this.opponentPos, this.playerPos, this.ai.phase.kind, this.circleDirection, dtS);
    this.opponentPos = moved.position;
    this.circleDirection = moved.direction;
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
      this.setFeedback('DEFENDEU', 'neutral');
      this.audio?.punchImpact(0.65, true);
    } else {
      this.hitShakeS = 0.3;
      this.setFeedback(result.ko ? 'NOCAUTE…' : 'LEVOU UM SOCO', 'bad');
      this.audio?.punchImpact(0.85, false);
    }
    if (result.ko) this.endMatch();
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
    this.ai = createOpponentAi(this.fightMs, this.rng);
    this.runningSinceWallMs = performance.now();
  }

  private endMatch(): void {
    this.restartMsLeft = MATCH_PAUSE_MS;
    this.status = this.match.winner === 'player' ? 'VOCÊ VENCEU!' : this.match.winner === 'draw' ? 'Empate' : 'Adversário venceu';
    this.audio?.bell('ko');
    if (this.match.winner === 'player') this.audio?.crowdReact(1);
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
    this.opponentBoxer.root.position.set(opponentPos.x, RING_CANVAS_Y, opponentPos.z);
    this.opponentBoxer.root.rotation.y = Math.atan2(playerPos.x - opponentPos.x, playerPos.z - opponentPos.z) + Math.PI;
  }

  private opponentAnimationState(): MiiBoxerState {
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
    this.opponentBoxer.setState(this.opponentAnimationState());
    this.opponentBoxer.animate(this.animTimeS);
  }

  // ---------------------------------------------------------------- hud & lifecycle

  private setFeedback(text: string, tone: HudFeedback['tone']): void {
    this.feedback = { id: (this.feedback?.id ?? 0) + 1, text, tone };
  }

  private publishHud(): void {
    const banner = this.gate.phase === 'countdown' ? { title: String(this.gate.count), detail: 'Guarda alta' }
      : this.gate.phase === 'paused' ? { title: 'PAUSA', detail: 'Volte para a câmera ou aperte ← → A D' }
      : this.match.winner ? { title: this.status }
      : this.breakMsLeft > 0 ? { title: `ROUND ${this.match.round}`, detail: 'Intervalo' }
      : undefined;
    this.onHud({
      score: this.match.opponentHp,
      label: `${this.match.playerHp} × ${this.match.opponentHp}`,
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
      },
    });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.ring?.dispose();
    this.loop.dispose();
  }
}
