import * as THREE from 'three';
import type { Hand } from '../../cv/protocol';
import { paint } from '../core/vertexPaint';

export interface PunchingBag {
  /**
   * Stands on the ring canvas at the owner's position. The pivot and bag swing internally;
   * the owner only positions the root and disposes it with the scene tree.
   */
  readonly root: THREE.Group;
  /** Applies one physical punch. Strength is clamped to 0..1; weak punches still move the bag a little. */
  hit(hand: Hand, strength01: number): void;
  /** Advances the pendulum by the caller-owned fixed-step delta. */
  update(dtSeconds: number): void;
  /** Centers the bag for a new training round without reallocating its meshes. */
  reset(): void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampAngle = (value: number) => Math.max(-0.58, Math.min(0.58, value));

function part(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(paint(geometry, color), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Creates a procedural heavy bag. It is deliberately a small hierarchy of simple vertex-colored
 * meshes rather than a merged static mesh: the pivot rotates as a pendulum while the bag twists.
 */
export function createPunchingBag(): PunchingBag {
  const root = new THREE.Group();
  root.name = 'punching-bag-root';
  const pivot = new THREE.Group();
  pivot.name = 'punching-bag-pivot';
  pivot.position.y = 3.4;
  root.add(pivot);

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58, metalness: 0.02 });
  const chain = part(new THREE.CylinderGeometry(0.026, 0.026, 1.42, 10), 0xc9d4dc, material, 0, -0.71, 0);
  chain.name = 'punching-bag-chain';
  const swivel = part(new THREE.SphereGeometry(0.085, 12, 8), 0x8fa4b0, material, 0, -1.43, 0);
  swivel.name = 'punching-bag-swivel';

  const swing = new THREE.Group();
  swing.name = 'punching-bag-swing';
  swing.position.y = -1.95;
  pivot.add(chain, swivel, swing);

  const body = part(new THREE.CapsuleGeometry(0.34, 0.78, 6, 22), 0xb82f2b, material, 0, 0, 0);
  body.name = 'punching-bag-body';
  const topBand = part(new THREE.CylinderGeometry(0.345, 0.345, 0.09, 22), 0xf7f5f0, material, 0, 0.49, 0);
  topBand.name = 'punching-bag-top-band';
  const lowerBand = part(new THREE.CylinderGeometry(0.345, 0.345, 0.075, 22), 0x2477d2, material, 0, -0.36, 0);
  lowerBand.name = 'punching-bag-lower-band';
  const target = part(new THREE.CylinderGeometry(0.18, 0.18, 0.025, 24).rotateX(Math.PI / 2), 0xffd66b, material, 0, 0.08, 0.345);
  target.name = 'punching-bag-target';
  swing.add(body, topBand, lowerBand, target);

  let angleX = 0;
  let angleZ = 0;
  let twist = 0;
  let velocityX = 0;
  let velocityZ = 0;
  let twistVelocity = 0;

  const integratePendulum = (dt: number) => {
    velocityX += (-17 * angleX - 3.1 * velocityX) * dt;
    velocityZ += (-19 * angleZ - 3.4 * velocityZ) * dt;
    twistVelocity += (-24 * twist - 4.5 * twistVelocity) * dt;
    angleX = clampAngle(angleX + velocityX * dt);
    angleZ = clampAngle(angleZ + velocityZ * dt);
    twist = Math.max(-0.8, Math.min(0.8, twist + twistVelocity * dt));
    pivot.rotation.x = angleX;
    pivot.rotation.z = angleZ;
    swing.rotation.y = twist;
  };

  return {
    root,
    hit(hand, strength01) {
      const strength = clamp01(Number.isFinite(strength01) ? strength01 : 0);
      const side = hand === 'left' ? -1 : 1;
      velocityX += 2.6 * strength;
      velocityZ += side * 0.34 * strength;
      twistVelocity += -side * 1.1 * strength;
    },
    update(dtSeconds) {
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
      integratePendulum(Math.min(dtSeconds, 0.05));
    },
    reset() {
      angleX = 0;
      angleZ = 0;
      twist = 0;
      velocityX = 0;
      velocityZ = 0;
      twistVelocity = 0;
      pivot.rotation.set(0, 0, 0);
      swing.rotation.set(0, 0, 0);
    },
  };
}
