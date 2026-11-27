import * as THREE from 'three';

export type ImpactEffectKind = 'hit' | 'block';

export interface ImpactSparkPool {
  /** One `Points` object backed by preallocated attributes; add it once to the scene. */
  readonly root: THREE.Points;
  /** Number of sparks currently alive. Intended for tests and diagnostics, not per-frame UI work. */
  readonly activeCount: number;
  /** Reuses pool slots for a small burst. No geometry, material or particle object is allocated here. */
  spawn(x: number, y: number, z: number, power01: number, kind?: ImpactEffectKind): void;
  /** Integrates the live sparks with the caller-owned fixed-step delta. */
  update(dtSeconds: number): void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const HIDDEN_Y = -1000;
const GOLDEN_ANGLE = 2.399963229728653;

/**
 * A fixed-capacity spark pool. All buffers and slots are allocated up front; hits only overwrite
 * slots, and `update` mutates the same typed arrays in place. Dead sparks are parked below the arena.
 */
export function createImpactSparkPool(capacity = 48): ImpactSparkPool {
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
    size: 0.075,
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
      const count = 4 + Math.round(power * 3);
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
        lifeSeconds[slot] = 0.18 + power * 0.1 + spark * 0.012;

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
