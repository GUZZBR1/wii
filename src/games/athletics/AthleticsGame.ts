import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { Feedback } from '../track/feedback';
import { applySprint, applyStep, easeSpeed, type Gait, gaitFor, type Pace } from '../track/gait';
import { RunGate } from '../track/runGate';
import type { GameHudState } from '../track/TrackGame';
import { createMiiRunner, type MiiRunner } from './miiRunner';
import { formatTime, type Goal, MAX_SPEED_MPS, parseRecords, placeAmong, Race, recordTime, type Split } from './race';
import { buildStadium, type Stadium } from './stadiumScene';
import { LANE_WIDTH, R_RUN, sampleTrack, type TrackSample } from './trackCurve';

export interface AthleticsHudState extends GameHudState {
  finish?: { title: string; detail: string };
}

const INTRO_S = 2.2;
const KEY_PACE_STEP = 0.2;
const CHASE_RATE = 6;
const GAIT_STATUS: Record<Gait, string> = { idle: 'Parado', walk: 'Andando', run: 'Correndo' };
const RECORDS_KEY = 'wii-athletics-records';
/** Pacers in lanes 2 and 3; shorter races are run faster. */
const RIVALS = [
  { lane: 1, shirt: 0xe8604c, speed01: 0.84 },
  { lane: 2, shirt: 0x4fbf58, speed01: 0.72 },
];
const GOAL_PACE: Record<Goal, number> = { 100: 1.08, 400: 1, 800: 0.92 };

/** What it takes to draw one athlete; the player and the rivals share it. */
interface Athlete {
  mii: MiiRunner;
  lane: number;
  speed01: number;
  stridePhase: number;
  lean: number;
}
interface Rival extends Athlete {
  target: number;
  race: Race;
}

const strideStep = (dt: number, speed01: number, cadenceSpm = 0) =>
  (dt * Math.PI * (cadenceSpm || 70 + speed01 * 130)) / 60;

export class AthleticsGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(54, 1, 0.1, 350);
  private readonly player: Athlete = { mii: createMiiRunner(), lane: 0, speed01: 0, stridePhase: 0, lean: 0 };
  private readonly rivals: Rival[];
  private readonly loop: GameLoop;
  private readonly stadium: Stadium;
  private readonly hudTimer: number;
  private readonly gate = new RunGate();
  private readonly race: Race;
  private readonly intro: THREE.CatmullRomCurve3;
  private readonly lookTarget = new THREE.Vector3();
  private readonly chasePosition = new THREE.Vector3();
  private readonly chaseTarget = new THREE.Vector3();
  private introTime = 0;
  private pace: Pace = { owner: 'camera', speed01: 0, cadenceSpm: 0 };
  private gait: Gait = 'idle';
  private outcome?: { place: number; best: number; isNew: boolean };
  private feedback?: Feedback;
  private lastHud = '';

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: AthleticsHudState) => void,
    private readonly audio?: ProceduralAudio,
    goalMeters: Goal = 400,
  ) {
    this.race = new Race(goalMeters);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt) => this.update(dt));
    this.stadium = buildStadium(this.scene, this.loop.renderer);
    this.loop.onQualityChange = (tier) => this.stadium.setShadows(tier === 0);
    this.rivals = RIVALS.map(({ lane, shirt, speed01 }) => ({
      mii: createMiiRunner(shirt),
      lane,
      speed01: 0,
      stridePhase: lane,
      lean: 0,
      target: speed01 * GOAL_PACE[goalMeters],
      race: new Race(goalMeters),
    }));
    this.scene.add(this.player.mii.root, ...this.rivals.map((rival) => rival.mii.root));
    this.drawAll(0);
    const end = this.chasePosition.clone();
    this.intro = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-40, 55, 100),
      new THREE.Vector3(-5, 30, 75),
      new THREE.Vector3(end.x - 18, 9, end.z + 8),
      end,
    ]);
    this.camera.position.copy(this.intro.getPoint(0));
    this.lookTarget.set(0, 0, 0);
    this.camera.lookAt(this.lookTarget);
    this.stadium.follow(this.player.mii.root.position, this.camera.position);
    this.hudTimer = window.setInterval(() => this.publishHud(), 80);
  }

  setTracking(tracking: string): void {
    this.gate.setTracking(tracking);
    this.publishHud();
  }

  onAction(event: SportActionEvent): void {
    if (event.type === 'step') this.pace = applyStep(this.pace);
    if (event.type === 'sprint') this.pace = applySprint(this.pace, event);
  }

  onKey(key: string): void {
    const pressed = key.toLowerCase();
    const faster = pressed === 'arrowup' || pressed === 'w' || pressed === ' ';
    if (!faster && pressed !== 'arrowdown' && pressed !== 's') return;
    if (this.race.finished || this.gate.resumeByKey()) return;
    const speed01 = THREE.MathUtils.clamp(this.pace.speed01 + (faster ? KEY_PACE_STEP : -KEY_PACE_STEP), 0, 1);
    this.pace = { owner: 'keyboard', speed01: Math.round(speed01 * 10) / 10, cadenceSpm: 0 };
  }

  /**
   * Places and animates one athlete. Distance is offset by the goal, so every lane finishes on the
   * painted line and outer lanes get the staggered start of a real track.
   */
  private draw(athlete: Athlete, distance: number, dt: number): TrackSample {
    const at = sampleTrack(distance - this.race.goal, athlete.lane);
    const { root } = athlete.mii;
    root.position.set(at.x, 0, at.z);
    root.rotation.y = Math.atan2(-at.tangentX, -at.tangentZ);
    const speed = athlete.speed01 * MAX_SPEED_MPS;
    const radius = R_RUN + athlete.lane * LANE_WIDTH;
    const lean = Math.abs(at.tangentZ) > 1e-3 ? Math.atan((speed * speed) / (9.81 * radius)) : 0;
    athlete.lean = THREE.MathUtils.damp(athlete.lean, lean, 6, dt);
    athlete.mii.animate(athlete.stridePhase, athlete.speed01, athlete.lean);
    return at;
  }

  /** Draws everyone and refreshes where the chase camera wants to be. */
  private drawAll(dt: number): void {
    for (const rival of this.rivals) this.draw(rival, rival.race.distance, dt);
    const at = this.draw(this.player, this.race.distance, dt);
    this.chasePosition.set(at.x - at.tangentX * 6, 3.2, at.z - at.tangentZ * 6);
    this.chaseTarget.set(at.x + at.tangentX * 5, 1.1, at.z + at.tangentZ * 5);
  }

  private update(dt: number): void {
    const introDone = this.introTime >= INTRO_S;
    if (!introDone) this.introTime = Math.min(INTRO_S, this.introTime + dt);
    else this.gate.advance(dt);
    // A pause freezes everyone; after the finish line the limbs ease to rest.
    if (this.gate.phase === 'running') this.step(dt);
    this.drawAll(dt);

    if (this.introTime < INTRO_S) {
      const t = THREE.MathUtils.smoothstep(this.introTime / INTRO_S, 0, 1);
      this.intro.getPoint(t, this.camera.position);
      this.lookTarget.set(0, 0, 0).lerp(this.chaseTarget, t);
    } else {
      const blend = 1 - Math.exp(-CHASE_RATE * dt);
      this.camera.position.lerp(this.chasePosition, blend);
      this.lookTarget.lerp(this.chaseTarget, blend);
    }
    this.camera.lookAt(this.lookTarget);
    this.stadium.follow(this.player.mii.root.position, this.camera.position);
  }

  private step(dt: number): void {
    // Rivals move first, so one that crosses on the same step as the player is already counted.
    for (const rival of this.rivals) {
      const surge = 1 + 0.03 * Math.sin(rival.race.seconds * 0.7 + rival.lane * 2);
      rival.speed01 = easeSpeed(rival.speed01, rival.race.finished ? 0 : rival.target * surge, dt);
      if (rival.speed01 > 0) rival.stridePhase += strideStep(dt, rival.speed01);
      rival.race.advance(dt, rival.speed01);
    }
    const { player } = this;
    player.speed01 = easeSpeed(player.speed01, this.race.finished ? 0 : this.pace.speed01, dt);
    this.gait = gaitFor(player.speed01, this.gait);
    if (this.gait !== 'idle') player.stridePhase += strideStep(dt, player.speed01, this.pace.cadenceSpm);
    const split = this.race.advance(dt, player.speed01);
    if (split) this.announce(split);
  }

  /** The record lives in this browser only; blocked storage just means it is not remembered. */
  private finishRace(): void {
    let records = {};
    try {
      records = parseRecords(localStorage.getItem(RECORDS_KEY));
    } catch {}
    const result = recordTime(records, this.race.goal, this.race.seconds);
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(result.records));
    } catch {}
    const rivals = this.rivals.map((rival) => rival.race);
    this.outcome = { place: placeAmong(this.race.seconds, rivals), best: result.best, isNew: result.isNew };
  }

  private announce(split: Split): void {
    if (this.race.finished) {
      this.finishRace();
      this.audio?.success();
    } else this.audio?.milestone();
    this.feedback = {
      id: (this.feedback?.id ?? 0) + 1,
      kind: 'clear',
      text: `${split.meters} m · ${formatTime(split.seconds)}`,
    };
    this.publishHud();
  }

  private publishHud(): void {
    const { race, gate } = this;
    const meters = Math.floor(race.distance);
    const label = formatTime(race.seconds);
    const speed01 = Math.round(this.player.speed01 * 100) / 100;
    const waiting = this.introTime < INTRO_S || race.finished;
    const banner = waiting
      ? undefined
      : gate.phase === 'countdown'
        ? { title: String(gate.count) }
        : gate.phase === 'paused'
          ? {
              title: 'PAUSADO',
              detail: 'Tracking perdido · volte ao quadro ou aperte uma tecla para seguir no teclado',
            }
          : undefined;
    const { outcome } = this;
    const record = outcome?.isNew ? 'Novo recorde pessoal!' : `Recorde pessoal: ${formatTime(outcome?.best ?? 0)}`;
    const finish = outcome
      ? {
          title: `${outcome.place}º lugar · ${label}`,
          detail: [record, ...race.splits.map((s) => `${s.meters} m ${formatTime(s.seconds)}`)].join(' · '),
        }
      : undefined;
    const status = `${meters} / ${race.goal} m · ${GAIT_STATUS[this.gait]}`;
    const key = `${label}-${speed01}-${status}-${this.feedback?.id}-${banner?.title}-${finish?.title}`;
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud({ score: meters, label, speed01, status, feedback: this.feedback, banner, finish });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.stadium.dispose();
    this.loop.dispose();
  }
}
