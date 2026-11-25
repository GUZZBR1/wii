import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import { GameLoop } from '../core/GameLoop';
import { applySprint, applyStep, easeSpeed, type Gait, gaitFor, nextPace, type Pace, stumble } from './gait';
import { HurdleFlow, type ItemKind, RUNNER_Z } from './hurdleFlow';
import { ItemAssets } from './itemAssets';
import { JUMP_DURATION_S, jumpHeight } from './jump';
import { type Lane, nextKind, nextLane } from './spawn';
import { isPerfectJump, TrackScore } from './trackScore';

export interface GameHudState { score: number; label: string; speed01: number; status: string }
type Item = { group: THREE.Group; kind: ItemKind; lane: number; z: number; passed: boolean };
const GAIT_STATUS: Record<Gait, string> = { idle: 'Parado', walk: 'Andando', run: 'Correndo' };

export class TrackGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
  private readonly runner = new THREE.Group();
  private readonly legs: THREE.Group[] = [];
  private readonly arms: THREE.Group[] = [];
  private readonly items: Item[] = [];
  private readonly itemAssets = new ItemAssets();
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private lane = 0;
  /** Speed asked for by the player and who set it; `shownSpeed` eases toward it. */
  private pace: Pace = { owner: 'camera', speed01: 0, cadenceSpm: 0 };
  private shownSpeed = 0;
  private gait: Gait = 'idle';
  private stridePhase = 0;
  private readonly score = new TrackScore();
  private readonly hurdleFlow = new HurdleFlow();
  private jumpTime = 0;
  private travelled = 0;
  private readonly laneHistory: Lane[] = [];
  private lastHud = '';
  private status = 'Ande ou corra no lugar com a câmera, ou use ↓';

  constructor(canvas: HTMLCanvasElement, private readonly onHud: (state: GameHudState) => void) {
    this.scene.background = new THREE.Color(0x223038);
    this.scene.fog = new THREE.Fog(0x223038, 25, 75);
    this.camera.position.set(0, 3.4, 11);
    this.camera.lookAt(0, 1.5, -8);
    this.setupScene();
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt) => this.update(dt));
    this.hudTimer = window.setInterval(() => this.publishHud(), 200);
  }

  private setupScene(): void {
    this.scene.add(new THREE.HemisphereLight(0xbad8e6, 0x253038, 2.1));
    const sun = new THREE.DirectionalLight(0xfff1d0, 3);
    sun.position.set(-5, 10, 6); this.scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 100), new THREE.MeshBasicMaterial({ color: 0x263235 }));
    ground.rotation.x = -Math.PI / 2; ground.position.z = -30; this.scene.add(ground);
    const track = new THREE.Mesh(new THREE.PlaneGeometry(9, 90), new THREE.MeshBasicMaterial({ color: 0x454e50 }));
    track.rotation.x = -Math.PI / 2; track.position.set(0, 0.02, -32); this.scene.add(track);
    const stripeGeo = new THREE.BoxGeometry(0.035, 0.01, 90);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf4b544 });
    for (const x of [-3, 0, 3]) { const line = new THREE.Mesh(stripeGeo, stripeMat); line.position.set(x, 0.035, -32); this.scene.add(line); }
    for (let i = 0; i < 12; i += 1) {
      const h = 2 + (i % 3) * 1.2;
      const building = new THREE.Mesh(new THREE.BoxGeometry(2 + (i % 2), h, 2), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x27373b : 0x202c30, flatShading: true }));
      building.position.set(i % 2 ? -7 : 7, h / 2, -6 - i * 5); this.scene.add(building);
    }
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.85, 4, 8), new THREE.MeshStandardMaterial({ color: 0xeff0e9, roughness: 0.72, flatShading: true }));
    torso.position.y = 1.22; this.runner.add(torso);
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 1), new THREE.MeshStandardMaterial({ color: 0xe8b896, flatShading: true }));
    head.position.y = 2.08; this.runner.add(head);
    const trousers = new THREE.MeshStandardMaterial({ color: 0x34434a, flatShading: true });
    const shoes = new THREE.MeshStandardMaterial({ color: 0xf7a942, flatShading: true });
    for (const side of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(side * 0.16, 0.82, 0);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.48, 3, 5), trousers); thigh.position.y = -0.25; leg.add(thigh);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.12, 0.38), shoes); foot.position.set(0, -0.58, -0.06); leg.add(foot);
      this.runner.add(leg); this.legs.push(leg);
      const arm = new THREE.Group(); arm.position.set(side * 0.4, 1.63, 0);
      const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.4, 3, 5), trousers); upperArm.position.y = -0.23; arm.add(upperArm);
      arm.rotation.z = side * -0.12; this.runner.add(arm); this.arms.push(arm);
    }
    this.runner.position.set(0, 0, RUNNER_Z); this.scene.add(this.runner);
    this.addItem('hurdle', -1, -30);
    this.addItem('hurdle', 1, -48);
  }

  private addItem(kind: ItemKind, lane: Lane, z: number): void {
    if (kind === 'hurdle') {
      this.laneHistory.push(lane);
      if (this.laneHistory.length > 2) this.laneHistory.shift();
    }
    const group = this.itemAssets.create(kind);
    group.position.set(lane * 1.5, 0, z); this.scene.add(group); this.items.push({ group, kind, lane, z, passed: false });
  }

  onAction(event: SportActionEvent): void {
    if (event.type === 'step') this.pace = applyStep(this.pace);
    if (event.type === 'sprint') this.pace = applySprint(this.pace, event);
    if (event.type === 'jump') { this.jumpTime = JUMP_DURATION_S; this.status = 'Salto!'; }
    if (event.type === 'lane') { this.lane = Math.max(-1, Math.min(1, this.lane + (event.direction === 'left' ? -1 : 1))); }
  }

  onKey(key: string): void {
    if (key === 'ArrowLeft' || key.toLowerCase() === 'a') this.lane = Math.max(-1, this.lane - 1);
    if (key === 'ArrowRight' || key.toLowerCase() === 'd') this.lane = Math.min(1, this.lane + 1);
    if (key === ' ' || key === 'ArrowUp' || key.toLowerCase() === 'w') this.jumpTime = JUMP_DURATION_S;
    if (key === 'ArrowDown' || key.toLowerCase() === 's') {
      // Keyboard cycles stopped → walking → running and keeps the pick until the player steps on camera.
      this.pace = { owner: 'keyboard', speed01: nextPace(this.pace.speed01), cadenceSpm: 0 };
    }
  }

  private update(dt: number): void {
    this.shownSpeed = easeSpeed(this.shownSpeed, this.pace.speed01, dt);
    const speed = this.shownSpeed;
    const gait = gaitFor(speed, this.gait);
    if (gait !== this.gait) this.status = GAIT_STATUS[gait];
    this.gait = gait;

    this.score.advance(dt, speed);
    this.runner.position.x += (this.lane * 1.5 - this.runner.position.x) * Math.min(1, dt * 10);
    // One leg swing per step: follow the player's cadence, or estimate it from speed for the keyboard.
    if (gait !== 'idle') this.stridePhase += dt * Math.PI * (this.pace.cadenceSpm || 70 + speed * 130) / 60;
    const swing = gait === 'idle' ? 0 : gait === 'walk' ? 0.4 : 0.95;
    const stride = Math.sin(this.stridePhase) * swing;
    this.legs[0]!.rotation.x = stride; this.legs[1]!.rotation.x = -stride;
    this.arms[0]!.rotation.x = -stride * (gait === 'run' ? 1.1 : 0.65); this.arms[1]!.rotation.x = -this.arms[0]!.rotation.x;
    this.runner.rotation.x = gait === 'run' ? -0.16 : 0;
    if (this.jumpTime > 0) {
      this.jumpTime = Math.max(0, this.jumpTime - dt);
      this.runner.position.y = jumpHeight(this.jumpTime);
      if (this.jumpTime === 0) this.status = GAIT_STATUS[gait];
    } else this.runner.position.y = gait === 'run' ? Math.abs(Math.sin(this.stridePhase)) * 0.14 : 0;
    const advance = dt * speed * 22;
    const airborne = this.jumpTime > 0.15 || this.runner.position.y > 0.45;
    this.travelled += advance;
    const flow = this.hurdleFlow.advance(this.items, advance, this.lane, airborne, this.travelled);
    for (const { hurdle: item, outcome } of flow.judged) {
      // Only a jump over the hurdle can be perfect; dodging it by lane just clears it.
      if (outcome === 'cleared') this.score.hurdleCleared(item.lane === this.lane && isPerfectJump(this.jumpTime));
      if (outcome === 'hit') {
        this.score.hurdleHit();
        this.shownSpeed = stumble(this.shownSpeed);
        this.status = 'Tropeçou!';
      }
      if (outcome === 'collected') {
        this.score.coinCollected();
        item.group.visible = false;
      }
    }
    for (const old of flow.despawned) {
      this.items.splice(this.items.indexOf(old), 1);
      this.scene.remove(old.group);
    }
    for (const item of this.items) item.group.position.z = item.z;
    if (flow.spawn) {
      const kind = nextKind(Math.random);
      this.addItem(kind, nextLane(this.laneHistory, Math.random), -48);
    }
  }

  private publishHud(): void {
    const score = this.score.display;
    const label = String(score).padStart(5, '0');
    const key = `${label}-${this.shownSpeed.toFixed(2)}-${this.status}`;
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud({ score, label, speed01: this.shownSpeed, status: this.status });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    // Items leave the scene first so their shared resources are freed once, by their owner.
    for (const item of this.items) this.scene.remove(item.group);
    this.items.length = 0;
    this.loop.dispose();
    this.itemAssets.dispose();
  }
}
