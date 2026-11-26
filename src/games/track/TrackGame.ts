import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import { GameLoop } from '../core/GameLoop';
import { type BiomeSpec, biomeAt } from './biomes';
import { type Feedback, awardText, SHAKE_DURATION_S, shakeOffset } from './feedback';
import { adjudicationDt, applySprint, applyStep, easeSpeed, type Gait, gaitFor, nextPace, type Pace, stumble } from './gait';
import { HurdleFlow, type ItemKind, RUNNER_Z } from './hurdleFlow';
import { ItemAssets } from './itemAssets';
import { JUMP_DURATION_S, jumpHeight } from './jump';
import { parseRanking, type RunResult, rankRun } from './ranking';
import { RunGate } from './runGate';
import { createSkyDome, DustPool, SCENERY_MAX_Z, SCENERY_MIN_Z, SceneryPool } from './scenery';
import { scrollZ, timeBoost } from './scroll';
import { type Lane, nextKind, nextLane } from './spawn';
import { isPerfectJump, TrackScore } from './trackScore';

export interface GameHudState { score: number; label: string; speed01: number; status: string; feedback?: Feedback; combo?: number; banner?: { title: string; detail?: string }; result?: RunResult }
type Item = { group: THREE.Group; kind: ItemKind; lane: number; z: number; passed: boolean };
type BiomeColor = Exclude<keyof BiomeSpec, 'id' | 'endDistance' | 'props'>;
const RANKING_KEY = 'wii-track-ranking';
const GAIT_STATUS: Record<Gait, string> = { idle: 'Parado', walk: 'Andando', run: 'Correndo' };

export class TrackGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(54, 1, 0.1, 120);
  private readonly runner = new THREE.Group();
  private readonly torsoGroup = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly legs: THREE.Group[] = [];
  private readonly shins: THREE.Group[] = [];
  private readonly feet: THREE.Mesh[] = [];
  private readonly arms: THREE.Group[] = [];
  private readonly forearms: THREE.Group[] = [];
  private readonly stripes: THREE.Mesh[] = [];
  private readonly skyDome = createSkyDome();
  private readonly sceneryPool = new SceneryPool(biomeAt(0).current.props);
  private readonly dustPool = new DustPool();
  /** Colors that follow the biome, each paired with the BiomeSpec field it reads. */
  private readonly tints: [THREE.Color, BiomeColor][] = [];
  private readonly tintTarget = new THREE.Color();
  private camX = 0;
  private landingDip = 0;
  private readonly shadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
  private readonly items: Item[] = [];
  private readonly itemAssets = new ItemAssets();
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private lane = 0;
  private cameraLaneZone: -1 | 0 | 1 | undefined;
  /** Speed asked for by the player and who set it; `shownSpeed` eases toward it. */
  private pace: Pace = { owner: 'camera', speed01: 0, cadenceSpm: 0 };
  private shownSpeed = 0;
  private gait: Gait = 'idle';
  private stridePhase = 0;
  private readonly score = new TrackScore();
  private readonly hurdleFlow = new HurdleFlow();
  private jumpTime = 0;
  private jumpSource: 'camera' | 'keyboard' = 'camera';
  private travelled = 0;
  /** Seconds actually spent moving: standing still, pauses and countdowns do not speed the run up. */
  private movingTime = 0;
  private lastSprintInputAtMs?: number;
  private readonly laneHistory: Lane[] = [];
  private lastHud = '';
  private feedback?: Feedback;
  private shakeTime = 0;
  private readonly gate = new RunGate();
  private result?: RunResult;
  private status = 'Ande ou corra no lugar com a câmera, ou use ↓';

  constructor(canvas: HTMLCanvasElement, private readonly onHud: (state: GameHudState) => void) {
    this.scene.background = null;
    this.camera.position.set(0, 3.1, 9.4);
    this.camera.lookAt(0, 1.4, -8);
    this.setupScene();
    this.applyBiome();
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, _simulationTimeMs, wallTimeMs) => this.update(dt, wallTimeMs));
    if (this.loop.renderer) this.loop.renderer.toneMapping = THREE.NeutralToneMapping;
    this.hudTimer = window.setInterval(() => this.publishHud(), 80);
  }

  private setupScene(): void {
    const fog = new THREE.Fog(0xd0eafc, 22, 64);
    this.scene.fog = fog;
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 2);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-5, 10, 6);
    this.scene.add(hemi, sun, this.skyDome.mesh, this.sceneryPool.group, this.dustPool.mesh);
    const surface = () => new THREE.MeshLambertMaterial();
    const ground = surface(), track = surface(), curb = surface(), stripe = surface();
    const flat = (width: number, length: number, material: THREE.Material, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), material);
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, y, z); this.scene.add(mesh);
    };
    flat(120, 100, ground, 0, -30);
    flat(4.8, 90, track, 0.02, -30);
    const curbGeo = new THREE.BoxGeometry(0.22, 0.14, 90);
    for (const x of [-2.5, 2.5]) {
      const curbs = new THREE.Mesh(curbGeo, curb);
      curbs.position.set(x, 0.07, -30); this.scene.add(curbs);
    }
    const stripeGeo = new THREE.BoxGeometry(0.08, 0.01, 2.2);
    for (const x of [-0.75, 0.75]) {
      for (let z = SCENERY_MIN_Z; z < SCENERY_MAX_Z; z += 4) {
        const mesh = new THREE.Mesh(stripeGeo, stripe);
        mesh.position.set(x, 0.035, z); this.scene.add(mesh); this.stripes.push(mesh);
      }
    }
    this.tints.push(
      [this.skyDome.topColor, 'skyTop'], [this.skyDome.bottomColor, 'skyBottom'], [fog.color, 'skyBottom'],
      [ground.color, 'ground'], [track.color, 'track'], [curb.color, 'curb'], [stripe.color, 'stripe'],
      [hemi.color, 'hemiSky'], [hemi.groundColor, 'hemiGround'], [sun.color, 'sun'],
    );
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.set(0, 0.045, RUNNER_Z); this.scene.add(this.shadow);
    // Articulated Mii-like proportions with upper body counter-rotation, knee joints, and ankle push-off.
    const lambert = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });
    const shirt = lambert(0xffffff), accent = lambert(0x2f9be8), skin = lambert(0xf2c29a), shorts = lambert(0x35516e), shoes = lambert(0xff8a2a);
    const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.runner) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z); parent.add(mesh);
      return mesh;
    };
    this.torsoGroup.position.set(0, 0.78, 0);
    part(new THREE.CapsuleGeometry(0.34, 0.4, 4, 12), shirt, 0, 0.35, 0, this.torsoGroup);
    part(new THREE.CylinderGeometry(0.35, 0.35, 0.14, 16, 1, true), accent, 0, 0.44, 0, this.torsoGroup);
    this.headGroup.position.set(0, 1.2, 0);
    part(new THREE.SphereGeometry(0.42, 16, 12), skin, 0, 0, 0, this.headGroup);
    part(new THREE.CylinderGeometry(0.41, 0.425, 0.13, 16, 1, true), accent, 0, 0.13, 0, this.headGroup);
    part(new THREE.BoxGeometry(0.46, 0.05, 0.26), accent, 0, 0.1, -0.48, this.headGroup);
    this.torsoGroup.add(this.headGroup);
    this.runner.add(this.torsoGroup);

    const thighGeo = new THREE.CapsuleGeometry(0.13, 0.22, 3, 8);
    const shinGeo = new THREE.CapsuleGeometry(0.105, 0.2, 3, 8);
    const footGeo = new THREE.BoxGeometry(0.25, 0.14, 0.4);
    const upperArmGeo = new THREE.CapsuleGeometry(0.095, 0.2, 3, 8);
    const handGeo = new THREE.SphereGeometry(0.145, 10, 8);
    for (const side of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(side * 0.17, 0.74, 0);
      part(thighGeo, shorts, 0, -0.18, 0, leg);
      const shin = new THREE.Group(); shin.position.set(0, -0.36, 0);
      part(shinGeo, skin, 0, -0.15, 0, shin);
      const foot = part(footGeo, shoes, 0, -0.3, -0.06, shin);
      leg.add(shin);
      const arm = new THREE.Group(); arm.position.set(side * 0.46, 0.68, 0);
      part(upperArmGeo, shirt, 0, -0.14, 0, arm);
      const forearm = new THREE.Group(); forearm.position.set(0, -0.28, 0);
      part(handGeo, skin, 0, -0.18, -0.04, forearm);
      arm.add(forearm);
      this.torsoGroup.add(arm);
      this.runner.add(leg);
      this.legs.push(leg); this.shins.push(shin); this.feet.push(foot);
      this.arms.push(arm); this.forearms.push(forearm);
    }
    this.runner.position.set(0, 0, RUNNER_Z); this.scene.add(this.runner);
    this.addItem('hurdle', -1, -30);
    this.addItem('hurdle', 1, -48);
  }

  /** Blends every tinted color toward the next biome; returns the current one. */
  private applyBiome(): BiomeSpec {
    const { current, next, blend01 } = biomeAt(this.travelled);
    for (const [color, key] of this.tints) color.setHex(current[key]).lerp(this.tintTarget.setHex(next[key]), blend01);
    return current;
  }

  private addItem(kind: ItemKind, lane: Lane, z: number): void {
    if (kind === 'hurdle') {
      this.laneHistory.push(lane);
      if (this.laneHistory.length > 2) this.laneHistory.shift();
    }
    const group = this.itemAssets.create(kind);
    group.position.set(lane * 1.5, 0, z); this.scene.add(group); this.items.push({ group, kind, lane, z, passed: false });
  }

  setTracking(tracking: string): void {
    this.gate.setTracking(tracking);
    this.publishHud();
  }

  /**
   * Camera lane authority: the zone is the position the player's body actually occupies, so it
   * applies absolutely — never as a step — whenever it changes, in any game phase. Keyboard
   * steps still write the lane directly and hold until the body zone changes again; while the
   * zone is undefined the camera has no opinion and the keyboard owns the lane outright.
   * The comparison rests on the last DEFINED zone, not current availability: reacquiring the
   * same zone after a blurry frame is not a body movement and must not steamroll a keyboard
   * pick made during the drop.
   */
  setLaneZone(zone: -1 | 0 | 1 | undefined): void {
    if (zone === undefined) return;
    if (zone !== this.cameraLaneZone) this.lane = zone;
    this.cameraLaneZone = zone;
  }

  /** Ends the camera session's lane authority: the next session reasserts from a clean comparison. */
  resetLaneZone(): void {
    this.cameraLaneZone = undefined;
  }

  onAction(event: SportActionEvent): void {
    if (event.type === 'step') this.pace = applyStep(this.pace);
    if (event.type === 'sprint') {
      this.lastSprintInputAtMs = event.timestampMs;
      this.pace = applySprint(this.pace, event);
    }
    if (this.result || this.gate.phase !== 'running') return;
    if (event.type === 'jump') { this.jumpTime = JUMP_DURATION_S; this.jumpSource = 'camera'; this.status = 'Salto!'; }
  }

  onKey(key: string): void {
    const pressed = key.toLowerCase();
    if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'a', 'd', 'w', 's'].includes(pressed)) return;
    if (this.result || this.gate.resumeByKey()) return;
    if (this.gate.phase !== 'running' && pressed !== 'arrowdown' && pressed !== 's') return;
    if (key === 'ArrowLeft' || key.toLowerCase() === 'a') this.lane = Math.max(-1, this.lane - 1);
    if (key === 'ArrowRight' || key.toLowerCase() === 'd') this.lane = Math.min(1, this.lane + 1);
    if (key === ' ' || key === 'ArrowUp' || key.toLowerCase() === 'w') { this.jumpTime = JUMP_DURATION_S; this.jumpSource = 'keyboard'; }
    if (key === 'ArrowDown' || key.toLowerCase() === 's') {
      // Keyboard cycles stopped → walking → running and keeps the pick until the player steps on camera.
      this.pace = { owner: 'keyboard', speed01: nextPace(this.pace.speed01), cadenceSpm: 0 };
    }
  }

  private showFeedback(kind: Feedback['kind'], text: string): void {
    this.feedback = { id: (this.feedback?.id ?? 0) + 1, kind, text };
    this.publishHud();
  }

  private update(dt: number, wallTimeMs: number): void {
    // Everything below is frozen until the gate opens: no travel, score, jump or judging.
    if (this.result) return;
    this.gate.advance(dt);
    if (this.gate.phase !== 'running') return;
    this.shakeTime = Math.max(0, this.shakeTime - dt);
    const shake = shakeOffset(this.shakeTime);
    this.shownSpeed = easeSpeed(this.shownSpeed, this.pace.speed01, dt);
    const speed = this.shownSpeed;
    const gait = gaitFor(speed, this.gait);
    if (gait !== this.gait) this.status = GAIT_STATUS[gait];
    this.gait = gait;

    const cameraInputAgeMs = this.lastSprintInputAtMs !== undefined ? Math.max(0, wallTimeMs - this.lastSprintInputAtMs) : 0;
    const physicsDt = adjudicationDt(this.pace, dt, cameraInputAgeMs);
    // Keep visual scroll alive while camera input is actively coasting ('degraded' within the
    // stale budget) so transient single-frame occlusion bursts never freeze the track on screen,
    // while hurdle collision adjudication still respects physicsDt.
    const visualDt = physicsDt > 0
      ? physicsDt
      : this.pace.owner === 'camera' && this.pace.cameraTracking === 'degraded' && cameraInputAgeMs <= 400
        ? dt
        : 0;
    this.score.advance(physicsDt, speed);
    this.runner.position.x += (this.lane * 1.5 - this.runner.position.x) * Math.min(1, dt * 10);
    // Lean into the lane change, upright again on arrival.
    this.runner.rotation.z = THREE.MathUtils.damp(this.runner.rotation.z, (this.runner.position.x - this.lane * 1.5) * 0.14, 14, dt);
    // One leg swing per step: follow the player's cadence, or estimate it from speed for the keyboard.
    const lastStep = Math.floor(this.stridePhase / Math.PI);
    if (gait !== 'idle') this.stridePhase += dt * Math.PI * (this.pace.cadenceSpm || 70 + speed * 130) / 60;
    const isRun = gait === 'run';
    const swing = gait === 'idle' ? 0 : gait === 'walk' ? 0.48 : 0.85 + Math.min(0.25, speed * 0.25);
    const airbornePose = this.jumpTime > 0;
    for (const index of [0, 1] as const) {
      const phase = this.stridePhase + (index === 1 ? Math.PI : 0);
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      // In camera view (-Z is forward down the track), positive rotation.x swings the limb backward
      // and negative rotation.x drives the knee/arm forward.
      const thighPitch = airbornePose
        ? (index === 0 ? -0.75 : 0.35)
        : gait === 'idle'
          ? 0
          : s * swing - (isRun ? Math.max(0, -s) * 0.22 : 0);
      // Knee only bends backward (+rotation.x): heel kick during recovery (c < 0) and high-knee bend.
      const kneeFlex = airbornePose
        ? (index === 0 ? 0.95 : 0.65)
        : gait === 'idle'
          ? 0
          : isRun
            ? Math.max(0, -c) * 1.15 + Math.max(0, -s) * 0.35
            : Math.max(0, -c) * 0.45;
      const footPitch = airbornePose
        ? 0.25
        : gait === 'idle'
          ? 0
          : Math.max(0, s) * (isRun ? 0.38 : 0.18) - Math.max(0, -s) * 0.15;
      this.legs[index]!.rotation.x = THREE.MathUtils.damp(this.legs[index]!.rotation.x, thighPitch, 22, dt);
      this.shins[index]!.rotation.x = THREE.MathUtils.damp(this.shins[index]!.rotation.x, kneeFlex, 24, dt);
      this.feet[index]!.rotation.x = THREE.MathUtils.damp(this.feet[index]!.rotation.x, footPitch, 22, dt);

      // Contra-lateral arm pump: right arm swings forward with left leg, elbows bent in an L during running.
      const armPhase = phase + Math.PI;
      const armSin = Math.sin(armPhase);
      const armPitch = airbornePose
        ? -0.55
        : gait === 'idle'
          ? 0
          : armSin * swing * (isRun ? 1.05 : 0.65);
      const elbowFlex = airbornePose
        ? -0.85
        : gait === 'idle'
          ? -0.1
          : isRun
            ? -0.75 - Math.max(0, -armSin) * 0.45
            : -0.25 - Math.max(0, -armSin) * 0.2;
      const side = index === 0 ? -1 : 1;
      this.arms[index]!.rotation.x = THREE.MathUtils.damp(this.arms[index]!.rotation.x, armPitch, 22, dt);
      this.arms[index]!.rotation.z = side * (isRun ? 0.14 : 0.08);
      this.forearms[index]!.rotation.x = THREE.MathUtils.damp(this.forearms[index]!.rotation.x, elbowFlex, 24, dt);
      this.forearms[index]!.rotation.y = -side * (isRun ? 0.22 : 0.08);
    }

    const strideSin = Math.sin(this.stridePhase);
    const targetForwardLean = airbornePose ? -0.08 : gait === 'idle' ? 0 : -(0.06 + speed * 0.18);
    this.runner.rotation.x = THREE.MathUtils.damp(this.runner.rotation.x, targetForwardLean, 12, dt);
    this.torsoGroup.rotation.y = THREE.MathUtils.damp(
      this.torsoGroup.rotation.y,
      gait === 'idle' ? 0 : -strideSin * (isRun ? 0.18 : 0.08),
      18,
      dt,
    );
    this.headGroup.rotation.y = -this.torsoGroup.rotation.y * 0.55;
    this.headGroup.rotation.x = -this.runner.rotation.x * 0.45;
    if (this.jumpTime > 0) {
      const jumpDt = this.jumpSource === 'keyboard' ? dt : physicsDt;
      this.jumpTime = Math.max(0, this.jumpTime - jumpDt);
      this.runner.position.y = jumpHeight(this.jumpTime);
      if (this.jumpTime === 0) {
        this.status = GAIT_STATUS[gait];
        this.landingDip = 0.22;
        this.dustPool.emit(this.runner.position.x, RUNNER_Z + 0.2, 8);
      }
    } else {
      const bounceAmp = gait === 'run' ? 0.11 + speed * 0.06 : gait === 'walk' ? 0.035 : 0;
      this.runner.position.y = bounceAmp > 0 ? Math.abs(Math.sin(this.stridePhase)) * bounceAmp : 0;
      if (gait === 'run' && Math.floor(this.stridePhase / Math.PI) !== lastStep) this.dustPool.emit(this.runner.position.x, RUNNER_Z + 0.2, 2);
    }
    if (speed > 0) this.movingTime += physicsDt;
    const boost = timeBoost(this.movingTime);
    const advance = physicsDt * speed * 22 * boost;
    const visualAdvance = visualDt * speed * 22 * boost;
    const airborne = this.jumpTime > 0.15 || this.runner.position.y > 0.45;
    this.travelled += visualAdvance;
    for (const stripe of this.stripes) stripe.position.z = scrollZ(stripe.position.z, visualAdvance, SCENERY_MIN_Z, SCENERY_MAX_Z);
    this.sceneryPool.update(visualAdvance, this.applyBiome().props);
    this.dustPool.update(dt, visualAdvance);
    this.shadow.position.x = this.runner.position.x;
    // The shadow shrinks as the runner rises, which is what reads as height.
    this.shadow.scale.setScalar(1 / (1 + this.runner.position.y * 0.6));
    this.camX = THREE.MathUtils.damp(this.camX, this.runner.position.x * 0.35, 6, dt);
    this.landingDip = THREE.MathUtils.damp(this.landingDip, 0, 9, dt);
    const bob = gait === 'run' && this.jumpTime === 0 ? Math.abs(Math.sin(this.stridePhase)) * 0.04 : 0;
    this.camera.position.set(this.camX + shake.x, 3.1 + bob - this.landingDip + shake.y, 9.4);
    this.camera.lookAt(this.camX * 0.5, 1.4, -8);
    const fov = THREE.MathUtils.damp(this.camera.fov, 54 + 8 * THREE.MathUtils.clamp(speed, 0, 1), 3, dt);
    if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const flow = this.hurdleFlow.advance(this.items, advance, this.lane, airborne, this.travelled, boost);
    for (const { hurdle: item, outcome } of flow.judged) {
      // A dodge scores nothing and leaves the combo as it is.
      if (outcome === 'cleared') this.showFeedback('clear', awardText(this.score.hurdleCleared(isPerfectJump(this.jumpTime))));
      if (outcome === 'hit') {
        const penalty = this.score.hurdleHit();
        this.shownSpeed = stumble(this.shownSpeed);
        this.shakeTime = SHAKE_DURATION_S;
        this.showFeedback('hit', `TROPEÇOU! −${penalty}`);
      }
      if (outcome === 'collected') {
        this.showFeedback('coin', `+${this.score.coinCollected()}`);
        item.group.visible = false;
      }
    }
    if (this.score.over) this.endRun();
    for (const old of flow.despawned) {
      this.items.splice(this.items.indexOf(old), 1);
      this.scene.remove(old.group);
    }
    for (const item of this.items) {
      item.group.position.z = item.z;
      if (item.kind === 'coin') item.group.rotation.y += dt * 3;
    }
    if (flow.spawn) {
      const kind = nextKind(Math.random);
      this.addItem(kind, nextLane(this.laneHistory, Math.random), -48);
    }
  }

  /** The ranking lives in this browser only; blocked storage just means it is not remembered. */
  private endRun(): void {
    let previous: number[] = [];
    try { previous = parseRanking(localStorage.getItem(RANKING_KEY)); } catch {}
    this.result = rankRun(previous, this.score.peak);
    try { localStorage.setItem(RANKING_KEY, JSON.stringify(this.result.ranking)); } catch {}
    this.publishHud();
  }

  private publishHud(): void {
    const score = this.score.display;
    const speed = Math.round(this.shownSpeed * 100) / 100;
    const { combo } = this.score;
    const banner = this.result
      ? undefined
      : this.gate.phase === 'countdown'
      ? { title: String(this.gate.count) }
      : this.gate.phase === 'paused'
        ? { title: 'PAUSADO', detail: 'Tracking perdido · volte ao quadro ou aperte uma tecla para seguir no teclado' }
        : undefined;
    const label = String(score).padStart(5, '0');
    const key = `${label}-${speed}-${this.status}-${this.feedback?.id}-${combo}-${banner?.title}-${this.result?.points}`;
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud({ score, label, speed01: speed, status: this.status, feedback: this.feedback, combo, banner, result: this.result });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    // Pooled objects leave the scene first so their resources are freed once, by their owner.
    for (const item of this.items) this.scene.remove(item.group);
    this.items.length = 0;
    this.scene.remove(this.sceneryPool.group, this.dustPool.mesh, this.skyDome.mesh);
    this.loop.dispose();
    this.itemAssets.dispose();
    this.sceneryPool.dispose();
    this.dustPool.dispose();
    this.skyDome.dispose();
  }
}
