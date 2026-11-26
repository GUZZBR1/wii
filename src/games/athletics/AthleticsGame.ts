import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { Feedback } from '../track/feedback';
import { applySprint, applyStep, easeSpeed, type Gait, gaitFor, type Pace } from '../track/gait';
import { RunGate } from '../track/runGate';
import { distanceLabel, finishResult, raceStatus, type AthleticsResult } from './hud';
import { createMiiRunner } from './miiRunner';
import { formatTime, MAX_SPEED_MPS, Race, type Split } from './race';
import { buildStadium, type Stadium } from './stadiumScene';
import { R_RUN, sampleTrack, type TrackSample } from './trackCurve';

export interface AthleticsHudState {
  score: number;
  label: string;
  speed01: number;
  status: string;
  feedback?: Feedback;
  banner?: { title: string; detail?: string };
  result?: AthleticsResult;
}

const INTRO_S = 2.2;
const KEY_PACE_STEP = 0.2;
const CHASE_RATE = 6;
const GAIT_STATUS: Record<Gait, string> = { idle: 'Parado', walk: 'Andando', run: 'Correndo' };

export class AthleticsGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(54, 1, 0.1, 350);
  private readonly runner = createMiiRunner();
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
  private shownSpeed = 0;
  private gait: Gait = 'idle';
  private stridePhase = 0;
  private lean = 0;
  private feedback?: Feedback;
  private lastHud = '';

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: AthleticsHudState) => void,
    private readonly audio?: ProceduralAudio,
    goalMeters = 400,
  ) {
    this.race = new Race(goalMeters);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt) => this.update(dt));
    try {
      this.stadium = buildStadium(this.scene, this.loop.renderer);
    } catch (error) {
      this.loop.dispose();
      throw error;
    }
    this.scene.add(this.runner.root);

    this.placeRunner(sampleTrack(0));
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
    this.stadium.follow(this.runner.root.position, this.camera.position);
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
    const slower = pressed === 'arrowdown' || pressed === 's';
    if (!faster && !slower) return;
    if (this.race.finished || this.gate.resumeByKey()) return;
    const speed01 = THREE.MathUtils.clamp(this.pace.speed01 + (faster ? KEY_PACE_STEP : -KEY_PACE_STEP), 0, 1);
    this.pace = { owner: 'keyboard', speed01: Math.round(speed01 * 10) / 10, cadenceSpm: 0 };
  }

  /** Puts the runner on the track and refreshes where the chase camera wants to be. */
  private placeRunner(at: TrackSample): void {
    const { root } = this.runner;
    root.position.set(at.x, 0, at.z);
    root.rotation.y = Math.atan2(-at.tangentX, -at.tangentZ);
    this.chasePosition.set(at.x - at.tangentX * 6, 3.2, at.z - at.tangentZ * 6);
    this.chaseTarget.set(at.x + at.tangentX * 5, 1.1, at.z + at.tangentZ * 5);
  }

  private update(dt: number): void {
    if (this.introTime < INTRO_S) this.introTime = Math.min(INTRO_S, this.introTime + dt);
    else this.gate.advance(dt);
    if (this.gate.phase === 'running') this.step(dt);

    const at = sampleTrack(this.race.distance);
    this.placeRunner(at);
    const speed = this.shownSpeed * MAX_SPEED_MPS;
    const bend = Math.abs(at.tangentZ) > 1e-3;
    this.lean = THREE.MathUtils.damp(this.lean, bend ? Math.atan((speed * speed) / (9.81 * R_RUN)) : 0, 6, dt);
    this.runner.animate(this.stridePhase, this.shownSpeed, this.lean);

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
    this.stadium.follow(this.runner.root.position, this.camera.position);
  }

  private step(dt: number): void {
    this.shownSpeed = easeSpeed(this.shownSpeed, this.race.finished ? 0 : this.pace.speed01, dt);
    this.gait = gaitFor(this.shownSpeed, this.gait);
    if (this.gait !== 'idle') {
      this.stridePhase += (dt * Math.PI * (this.pace.cadenceSpm || 70 + this.shownSpeed * 130)) / 60;
    }
    const split = this.race.advance(dt, this.shownSpeed);
    if (split) this.announce(split);
  }

  private announce(split: Split): void {
    if (this.race.finished) this.audio?.success();
    else this.audio?.milestone();
    this.feedback = {
      id: (this.feedback?.id ?? 0) + 1,
      kind: 'clear',
      text: `${split.meters} m · ${formatTime(split.seconds)}`,
    };
    this.publishHud();
  }

  private publishHud(): void {
    const { race, gate } = this;
    const label = distanceLabel(race.distance, race.goal);
    const speed01 = Math.round(this.shownSpeed * 100) / 100;
    const banner = this.introTime < INTRO_S || race.finished
      ? undefined
      : gate.phase === 'countdown'
        ? { title: String(gate.count) }
        : gate.phase === 'paused'
          ? {
              title: 'PAUSADO',
              detail: 'Tracking perdido · volte ao quadro ou aperte uma tecla para seguir no teclado',
            }
          : undefined;
    const result = race.finished ? finishResult(race.seconds, race.goal, race.splits) : undefined;
    const status = raceStatus(race.seconds, GAIT_STATUS[this.gait]);
    const key = `${label}-${speed01}-${status}-${this.feedback?.id}-${banner?.title}-${result?.time}`;
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud({
      score: Math.floor(race.distance),
      label,
      speed01,
      status,
      feedback: this.feedback,
      banner,
      result,
    });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.stadium.dispose();
    this.loop.dispose();
  }
}
