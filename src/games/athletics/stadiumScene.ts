import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSkyDome } from '../track/scenery';
import { LANE_WIDTH, lapLength, R_KERB, R_RUN, sampleTrack, STRAIGHT } from './trackCurve';

const LANES = 8;
/** Track edges as outward offsets from the lane 1 running line. */
const INNER = R_KERB - R_RUN;
const OUTER = INNER + LANES * LANE_WIDTH;
const SUN_OFFSET = new THREE.Vector3(18, 32, 14);

/** Flat strip following the track between two outward offsets; u crosses it, v counts `tile` metres. */
function ribbon(from: number, to: number, inner: number, outer: number, y: number, steps: number, tile = 4) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const distance = from + ((to - from) * i) / steps;
    // The end of a full lap must not wrap back to the start of the sample.
    const s = sampleTrack(distance, 0);
    for (const [offset, u] of [
      [inner, 0],
      [outer, 1],
    ] as const) {
      positions.push(s.x + s.normalX * offset, y, s.z + s.normalZ * offset);
      uvs.push(u, (distance - from) / tile);
    }
    const a = i * 2;
    if (i < steps) indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function trackTexture(anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponível');
  context.fillStyle = '#C76553';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // Rubber granules.
  for (let i = 0; i < 2600; i += 1) {
    context.fillStyle = i % 2 ? '#ffffff14' : '#00000018';
    context.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 3, 3);
  }
  context.fillStyle = '#ffffff';
  const line = 6;
  for (let lane = 0; lane <= LANES; lane += 1) {
    context.fillRect((lane / LANES) * (canvas.width - line), 0, line, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  return texture;
}

const matte = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });

/** Grandstands along both straights, merged into a single draw call. */
function architecture(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    parts.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  };
  const front = R_RUN + OUTER + 4;
  for (const side of [-1, 1]) {
    for (let tier = 0; tier < 4; tier += 1) {
      box(STRAIGHT, 1.1 * (tier + 1), 2, 0, 0.55 * (tier + 1), side * (front + tier * 2));
    }
    box(STRAIGHT + 4, 0.4, 11, 0, 9.4, side * (front + 3.5));
    for (let x = -STRAIGHT / 2; x <= STRAIGHT / 2; x += STRAIGHT / 6) box(0.4, 9.4, 0.4, x, 4.7, side * (front + 8));
  }
  // Arch behind the first bend.
  const gateX = STRAIGHT / 2 + R_RUN + OUTER + 6;
  box(2, 10, 2, gateX, 5, -9);
  box(2, 10, 2, gateX, 5, 9);
  box(2.4, 2, 22, gateX, 11, 0);
  const mesh = new THREE.Mesh(mergeGeometries(parts), matte('#F7F5F0'));
  for (const part of parts) part.dispose();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** `count` copies spread evenly around the oval, `laneOffset` lanes out from lane 1. */
function ring(geometry: THREE.BufferGeometry, color: number, count: number, laneOffset: number, y: number) {
  const mesh = new THREE.InstancedMesh(geometry, matte(color), count);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < count; i += 1) {
    const s = sampleTrack((lapLength(laneOffset) * (i + 0.5)) / count, laneOffset);
    mesh.setMatrixAt(i, matrix.makeTranslation(s.x, y, s.z));
  }
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  return mesh;
}

export interface Stadium {
  /** Moves the shadow frustum with the runner and keeps the sky centred on the camera. */
  follow(runner: THREE.Vector3, camera: THREE.Vector3): void;
  dispose(): void;
}

export function buildStadium(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Stadium {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.4;

  const sky = createSkyDome();
  scene.fog = new THREE.Fog(sky.bottomColor, 80, 220);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 100 });
  sun.shadow.camera.updateProjectionMatrix();

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), matte('#82B66B'));
  ground.position.y = -0.03;
  ground.receiveShadow = true;

  const lap = lapLength(0);
  const surface = new THREE.MeshStandardMaterial({
    map: trackTexture(renderer.capabilities.getMaxAnisotropy()),
    roughness: 0.9,
    metalness: 0,
  });
  const track = new THREE.Mesh(ribbon(0, lap - 1e-6, INNER, OUTER, 0, 400), surface);
  const kerb = new THREE.Mesh(ribbon(0, lap - 1e-6, INNER - 0.12, INNER, 0.03, 400), matte('#F7F5F0'));
  const finish = new THREE.Mesh(ribbon(-0.25, 0.25, INNER, OUTER, 0.012, 1), matte(0xffffff));
  for (const mesh of [track, kerb, finish]) mesh.receiveShadow = true;

  scene.add(
    sky.mesh,
    new THREE.HemisphereLight(0xdff3ff, 0x6f9460, 1.1),
    sun,
    sun.target,
    ground,
    track,
    kerb,
    finish,
    architecture(),
    ring(new THREE.CylinderGeometry(0.35, 0.45, 3, 8), 0x9a6a43, 56, 24, 1.5),
    ring(new THREE.SphereGeometry(2.2, 12, 10), 0x4fa85a, 56, 24, 4.4),
    ring(new THREE.CylinderGeometry(0.1, 0.14, 7, 8), 0xdfe3e6, 24, 9, 3.5),
    ring(new THREE.SphereGeometry(0.35, 10, 8), 0xfff3c4, 24, 9, 7.1),
  );

  return {
    follow(runner, camera) {
      sun.target.position.copy(runner);
      sun.position.copy(runner).add(SUN_OFFSET);
      sky.mesh.position.copy(camera);
    },
    // Meshes are freed by the loop's disposeObjectTree; these live outside what it walks.
    dispose() {
      scene.environment = null;
      environment.dispose();
      sun.dispose();
    },
  };
}
