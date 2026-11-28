import * as THREE from 'three';

export type ImpactEffectKind = 'hit' | 'block';

export interface ImpactSparkPool {
  /** One `Points` object backed by preallocated attributes; add it once to the scene. */
  readonly root: THREE.Points;
  /** Number of sparks currently alive. Intended for tests and diagnostics, not per-frame UI work. */
  readonly activeCount: number;
  /** Reuses pool slots for a burst. Optional `(dirX, dirZ)` biases particles along the blow. */
  spawn(x: number, y: number, z: number, power01: number, kind?: ImpactEffectKind, dirX?: number, dirZ?: number): void;
  /** Integrates the live sparks with the caller-owned fixed-step delta. */
  update(dtSeconds: number): void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const HIDDEN_Y = -1000;
const GOLDEN_ANGLE = 2.399963229728653;

/** A soft round dot, built from raw pixels so it needs no DOM canvas. */
function createSparkTexture(): THREE.DataTexture {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radius = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      pixels[(y * size + x) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, (1 - radius) * 2.5)));
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A fixed-capacity spark pool. All buffers and slots are allocated up front; hits only overwrite
 * slots, and `update` mutates the same typed arrays in place. Dead sparks are parked below the arena.
 */
export function createImpactSparkPool(capacity = 96): ImpactSparkPool {
  if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer');

  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const velocities = new Float32Array(capacity * 3);
  const lifeSeconds = new Float32Array(capacity);
  for (let index = 0; index < capacity; index += 1) positions[index * 3 + 1] = HIDDEN_Y;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    // Without a map a point is a hard square, huge when it bursts right in front of the camera.
    map: createSparkTexture(),
    size: 0.055,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const root = new THREE.Points(geometry, material);
  root.name = 'impact-spark-pool';
  root.frustumCulled = false;
  root.renderOrder = 3;

  let nextSlot = 0;
  let burstIndex = 0;

  return {
    root,
    get activeCount() {
      let count = 0;
      for (let index = 0; index < capacity; index += 1) if (lifeSeconds[index] > 0) count += 1;
      return count;
    },
    spawn(x, y, z, power01, kind = 'hit') {
      const power = clamp01(Number.isFinite(power01) ? power01 : 0);
      const count = 6 + Math.round(power * 8);
      burstIndex += 1;
      for (let spark = 0; spark < count; spark += 1) {
        const slot = nextSlot;
        nextSlot = (nextSlot + 1) % capacity;
        const offset = slot * 3;
        const angle = burstIndex * 0.71 + spark * GOLDEN_ANGLE;
        const speed = 0.42 + power * 0.85 + (spark % 3) * 0.11;
        positions[offset] = x;
        positions[offset + 1] = y;
        positions[offset + 2] = z;
        velocities[offset] = Math.cos(angle) * speed * 0.75;
        velocities[offset + 1] = 0.45 + power * 0.7 + (spark % 2) * 0.2;
        velocities[offset + 2] = Math.sin(angle) * speed * 0.75;
        lifeSeconds[slot] = 0.18 + power * 0.1 + spark * 0.006;

        const heat = 0.72 + 0.28 * ((spark + burstIndex) % 2);
        if (kind === 'block') {
          colors[offset] = 0.35 * heat;
          colors[offset + 1] = 0.68 * heat;
          colors[offset + 2] = 1;
        } else {
          colors[offset] = 1;
          colors[offset + 1] = 0.62 * heat;
          colors[offset + 2] = 0.16 * heat;
        }
      }
      geometry.attributes.position!.needsUpdate = true;
      geometry.attributes.color!.needsUpdate = true;
    },
    update(dtSeconds) {
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
      const dt = Math.min(dtSeconds, 0.05);
      let changed = false;
      for (let slot = 0; slot < capacity; slot += 1) {
        if (lifeSeconds[slot] <= 0) continue;
        changed = true;
        lifeSeconds[slot] -= dt;
        const offset = slot * 3;
        if (lifeSeconds[slot] <= 0) {
          positions[offset + 1] = HIDDEN_Y;
          continue;
        }
        velocities[offset + 1] -= 3.8 * dt;
        positions[offset] += velocities[offset] * dt;
        positions[offset + 1] += velocities[offset + 1] * dt;
        positions[offset + 2] += velocities[offset + 2] * dt;
      }
      if (changed) geometry.attributes.position!.needsUpdate = true;
    },
  };
}

const TRAIL_DOTS = 5;
/** How far apart the dots sit, as a share of the shoulder-to-glove line. */
const TRAIL_SPACING = 0.18;

export type PunchTrailTone = 'heavy' | 'counter';

/** A chain of shrinking spheres behind a travelling glove: white gold for power, cyan for a counter. */
export function createPunchTrail() {
  const root = new THREE.Group();
  root.name = 'punch-trail';
  const geometry = new THREE.SphereGeometry(0.11, 8, 6);
  const dots = Array.from({ length: TRAIL_DOTS }, (_, index) => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.7 * (1 - index / TRAIL_DOTS),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `punch-trail-${index}`;
    mesh.scale.setScalar(1 - index / (TRAIL_DOTS + 2));
    mesh.visible = false;
    root.add(mesh);
    return { mesh, material };
  });

  return {
    root,
    /** Lays the dots from the glove back toward the shoulder. */
    show(shoulder: THREE.Vector3, glove: THREE.Vector3, tone: PunchTrailTone): void {
      dots.forEach(({ mesh, material }, index) => {
        mesh.position.lerpVectors(glove, shoulder, index * TRAIL_SPACING);
        material.color.setHex(tone === 'counter' ? 0x66f2ff : 0xffe6a0);
        mesh.visible = true;
      });
    },
    clear(): void {
      for (const { mesh } of dots) mesh.visible = false;
    },
  };
}

const RING_S = 0.22;
const FLASH_S = 0.075;
const RING_POOL_SIZE = 3;

/** Expanding shockwave rings + brief core contact flash; pooled so combos never clip earlier rings. */
export function createImpactRing() {
  const root = new THREE.Group();
  root.name = 'impact-ring-pool';
  const ringGeometry = new THREE.RingGeometry(0.08, 0.2, 18);
  const flashGeometry = new THREE.CircleGeometry(0.14, 16);

  const rings = Array.from({ length: RING_POOL_SIZE }, (_, index) => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.name = `impact-ring-${index}`;
    mesh.visible = false;
    mesh.renderOrder = 4;
    root.add(mesh);
    return { mesh, material, ageS: RING_S, size: 1 };
  });

  const flashMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const flashMesh = new THREE.Mesh(flashGeometry, flashMaterial);
  flashMesh.name = 'impact-flash';
  flashMesh.visible = false;
  flashMesh.renderOrder = 5;
  root.add(flashMesh);
  let flashAgeS = FLASH_S;
  let flashSize = 1;
  let nextRing = 0;

  return {
    root,
    burst(point: { x: number; y: number; z: number }, power01: number, kind: ImpactEffectKind, scale = 1): void {
      const power = clamp01(power01);
      const ring = rings[nextRing]!;
      nextRing = (nextRing + 1) % RING_POOL_SIZE;
      ring.mesh.position.set(point.x, point.y, point.z);
      ring.material.color.setHex(kind === 'block' ? 0x7ec8ff : 0xfff3a8);
      ring.size = (0.65 + power * 1.1) * scale;
      ring.ageS = 0;
      ring.mesh.scale.setScalar(ring.size);
      ring.material.opacity = 1;
      ring.mesh.visible = true;

      flashMesh.position.set(point.x, point.y, point.z);
      flashMaterial.color.setHex(kind === 'block' ? 0x9ed8ff : 0xffffff);
      flashSize = (0.7 + power * 0.9) * scale;
      flashAgeS = 0;
      flashMesh.scale.setScalar(flashSize);
      flashMaterial.opacity = kind === 'block' ? 0.6 : 0.92;
      flashMesh.visible = true;
    },
    update(dtSeconds: number, camera: THREE.Camera): void {
      if (flashMesh.visible) {
        flashAgeS += dtSeconds;
        flashMesh.visible = flashAgeS < FLASH_S;
        const t = Math.min(1, flashAgeS / FLASH_S);
        flashMesh.scale.setScalar(flashSize * (1 + t * 1.4));
        flashMaterial.opacity = Math.max(0, 1 - t) * 0.9;
        flashMesh.quaternion.copy(camera.quaternion);
      }
      for (const ring of rings) {
        if (!ring.mesh.visible) continue;
        ring.ageS += dtSeconds;
        ring.mesh.visible = ring.ageS < RING_S;
        const t = Math.min(1, ring.ageS / RING_S);
        ring.mesh.scale.setScalar(ring.size * (1 + t * 2.1));
        ring.material.opacity = Math.max(0, (1 - t) ** 1.4);
        ring.mesh.quaternion.copy(camera.quaternion);
      }
    },
  };
}
