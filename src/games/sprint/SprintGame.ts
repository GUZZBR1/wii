import * as THREE from 'three';
import { GameLoop } from '../core/GameLoop';
import { biomeAt } from '../track/biomes';
import { createSkyDome, SCENERY_MAX_Z, SCENERY_MIN_Z, SceneryPool } from '../track/scenery';
import { scrollZ } from '../track/scroll';
import { Race, RACE_METRES } from './race';

export interface SprintHudState {
  score: number;
  label: string;
  speed01: number;
  status: string;
  banner?: { title: string; detail?: string };
  finished?: { title: string; detail: string };
}

const LANE_X = [-2.25, -0.75, 0.75, 2.25];
/** Screen lane of the player and of each rival. */
const PLAYER_LANE = 1;
const RIVAL_LANES = [0, 2, 3];
const PLAYER_Z = 3;
/** World units per metre of race. */
const SCALE = 1.2;

interface Figure { group: THREE.Group; legs: THREE.Group[]; arms: THREE.Group[]; phase: number }

export class SprintGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(56, 1, 0.1, 160);
  private readonly race = new Race();
  private readonly sky = createSkyDome();
  private readonly scenery = new SceneryPool(biomeAt(0).current.props);
  private readonly stripes: THREE.Mesh[] = [];
  private readonly finishLine = new THREE.Group();
  private readonly player: Figure;
  private readonly rivals: Figure[];
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private lastHud = '';

  constructor(canvas: HTMLCanvasElement, private readonly onHud: (state: SprintHudState) => void) {
    const biome = biomeAt(0).current;
    this.sky.topColor.setHex(biome.skyTop);
    this.sky.bottomColor.setHex(biome.skyBottom);
    this.camera.position.set(0, 3.6, 10);
    this.camera.lookAt(0, 1.1, -6);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-5, 10, 6);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x88aa77, 2), sun, this.sky.mesh, this.scenery.group);
    this.buildTrack(biome.ground);
    this.player = this.buildRunner(0x2f9be8, LANE_X[PLAYER_LANE]!);
    this.rivals = [0xe8604c, 0x4fbf58, 0xf5b52e].map((color, i) => this.buildRunner(color, LANE_X[RIVAL_LANES[i]!]!));
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt) => this.update(dt));
    this.hudTimer = window.setInterval(() => this.publish(), 80);
    this.publish();
  }

  private buildTrack(groundColor: number): void {
    const lambert = (color: number) => new THREE.MeshLambertMaterial({ color });
    const flat = (width: number, material: THREE.Material, y: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 100), material);
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, y, -30); this.scene.add(mesh);
    };
    flat(120, lambert(groundColor), 0);
    flat(6.2, lambert(0xc4553f), 0.02);
    const white = lambert(0xffffff);
    const line = new THREE.BoxGeometry(0.07, 0.01, 100);
    for (const x of [-3, -1.5, 0, 1.5, 3]) {
      const mesh = new THREE.Mesh(line, white); mesh.position.set(x, 0.035, -30); this.scene.add(mesh);
    }
    // Cross marks give the sense of speed.
    const mark = new THREE.BoxGeometry(0.5, 0.011, 0.14);
    for (let z = SCENERY_MIN_Z; z < SCENERY_MAX_Z; z += 4) {
      for (const x of [-3.3, 3.3]) {
        const mesh = new THREE.Mesh(mark, white); mesh.position.set(x, 0.04, z); this.scene.add(mesh); this.stripes.push(mesh);
      }
    }
    const post = new THREE.BoxGeometry(0.14, 3.6, 0.14);
    const dark = lambert(0x222831);
    for (const x of [-3.2, 3.2]) { const mesh = new THREE.Mesh(post, dark); mesh.position.set(x, 1.8, 0); this.finishLine.add(mesh); }
    const square = new THREE.BoxGeometry(0.4, 0.3, 0.06);
    for (let i = 0; i < 16; i += 1) {
      for (const row of [0, 1]) {
        const mesh = new THREE.Mesh(square, (i + row) % 2 ? dark : white);
        mesh.position.set(-3 + i * 0.4, 3.2 + row * 0.3, 0); this.finishLine.add(mesh);
      }
    }
    this.scene.add(this.finishLine);
  }

  private buildRunner(color: number, x: number): Figure {
    const lambert = (value: number) => new THREE.MeshLambertMaterial({ color: value, flatShading: true });
    const shirt = lambert(color), skin = lambert(0xf2c29a), shorts = lambert(0x35516e);
    const group = new THREE.Group();
    const part = (geometry: THREE.BufferGeometry, material: THREE.Material, y: number, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(geometry, material); mesh.position.y = y; parent.add(mesh);
    };
    part(new THREE.CapsuleGeometry(0.28, 0.42, 4, 10), shirt, 1.12, group);
    part(new THREE.SphereGeometry(0.3, 14, 10), skin, 1.82, group);
    const legs: THREE.Group[] = [], arms: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(side * 0.14, 0.72, 0);
      part(new THREE.CapsuleGeometry(0.11, 0.46, 3, 8), shorts, -0.35, leg);
      const arm = new THREE.Group(); arm.position.set(side * 0.38, 1.38, 0);
      part(new THREE.CapsuleGeometry(0.08, 0.34, 3, 8), skin, -0.24, arm);
      group.add(leg, arm); legs.push(leg); arms.push(arm);
    }
    group.position.set(x, 0, PLAYER_Z);
    this.scene.add(group);
    return { group, legs, arms, phase: 0 };
  }

  private animate(figure: Figure, speed: number, dt: number): void {
    const effort = Math.min(1, speed / 7);
    if (speed > 0.2) figure.phase += dt * Math.PI * (1.4 + speed * 0.28);
    const swing = Math.sin(figure.phase) * effort * 1.1;
    figure.legs[0]!.rotation.x = swing; figure.legs[1]!.rotation.x = -swing;
    figure.arms[0]!.rotation.x = -swing; figure.arms[1]!.rotation.x = swing;
    figure.group.rotation.x = -effort * 0.14;
    figure.group.position.y = Math.abs(Math.sin(figure.phase)) * 0.1 * effort;
  }

  onAction(): void {}

  setEffort(effort01: number): void { this.race.setEffort(effort01); }

  setTracking(tracking: string): void {
    // A player the camera lost stops pushing; momentum fades on its own.
    if (tracking === 'SEM POSE') this.race.setEffort(0);
  }

  onKey(key: string): void {
    if ([' ', 'arrowup', 'w'].includes(key.toLowerCase())) this.race.tap();
  }

  private update(dt: number): void {
    const before = this.race.distance;
    const rivalsBefore = this.race.rivals.map((rival) => rival.distance);
    this.race.step(dt);
    const advance = (this.race.distance - before) * SCALE;
    for (const stripe of this.stripes) stripe.position.z = scrollZ(stripe.position.z, advance, SCENERY_MIN_Z, SCENERY_MAX_Z);
    this.scenery.update(advance, biomeAt(0).current.props);
    this.finishLine.position.z = PLAYER_Z - (RACE_METRES - this.race.distance) * SCALE;
    // Once crossed it would sweep through the camera.
    this.finishLine.visible = this.finishLine.position.z < PLAYER_Z + 0.5;
    this.animate(this.player, this.race.speed, dt);
    this.race.rivals.forEach((rival, i) => {
      const figure = this.rivals[i]!;
      this.animate(figure, (rival.distance - rivalsBefore[i]!) / dt, dt);
      // Rivals are drawn relative to the player. One left behind stays just at their shoulder, so it
      // is still seen without filling the camera.
      figure.group.position.z = PLAYER_Z - THREE.MathUtils.clamp((rival.distance - this.race.distance) * SCALE, -1.2, 40);
    });
  }

  private publish(): void {
    const { race } = this;
    const metres = Math.min(RACE_METRES, Math.floor(race.distance));
    const banner = race.phase === 'countdown' ? { title: String(Math.ceil(race.countdown)), detail: 'Prepare-se: corra no lugar quando zerar' } : undefined;
    const finished = race.finishS !== undefined
      ? { title: `${race.place}º lugar`, detail: `${race.finishS.toFixed(2)} s nos ${RACE_METRES} metros` }
      : undefined;
    const state: SprintHudState = {
      score: metres,
      label: `${metres} m`,
      speed01: Math.round(race.effort01 * 100) / 100,
      status: race.phase === 'racing' ? `${race.place}º lugar · ${race.elapsedS.toFixed(1)} s` : race.phase === 'finished' ? 'Chegada!' : 'Corra no lugar com a câmera, ou aperte espaço várias vezes',
      banner,
      finished,
    };
    const key = JSON.stringify(state);
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud(state);
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.scene.remove(this.sky.mesh, this.scenery.group);
    this.loop.dispose();
    this.sky.dispose();
    this.scenery.dispose();
  }
}
