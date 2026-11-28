import * as THREE from 'three';
import {
  createMiiFacePatch,
  createMiiHairGeometry,
  createMiiHeadGeometry,
  createMiiNoseGeometry,
  miiHairColor,
  miiHeadScale,
  type MiiFaceMount,
} from '../../mii/miiHead';
import { DEFAULT_MII_FACE_SPEC, SKIN_PALETTE, type MiiFaceSpec } from '../../mii/miiSpec';
import { merge, paint } from './geometry';

export interface MiiRunner {
  /** Faces local -Z. The owner sets position and heading; the runner handles limbs, bob and lean. */
  root: THREE.Group;
  facePatch: MiiFaceMount;
  animate(stridePhase: number, speed01: number, lean: number): void;
}

export function createMiiCapBandGeometry(face: MiiFaceSpec): THREE.BufferGeometry {
  const [sx, , sz] = miiHeadScale(face);
  return new THREE.CylinderGeometry(0.41, 0.41, 0.11, 24, 1, true).scale(sx, 1, sz);
}

export function createMiiRunner(shirtColor = 0xffffff, face: MiiFaceSpec = DEFAULT_MII_FACE_SPEC): MiiRunner {
  const accent = 0x2f9be8;
  const skin = SKIN_PALETTE[face.skin];
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const body = new THREE.Group();
  body.scale.setScalar(0.75);
  root.add(body);

  // Parts that move together are merged into one mesh per joint: 9 draw calls per runner.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 });
  const pending = new Map<THREE.Object3D, THREE.BufferGeometry[]>();
  const part = (geometry: THREE.BufferGeometry, color: number, y: number, parent: THREE.Object3D, z = 0) => {
    const parts = pending.get(parent) ?? [];
    parts.push(paint(geometry.translate(0, y, z), color));
    pending.set(parent, parts);
  };
  const joint = (x: number, y: number, parent: THREE.Object3D) => {
    const group = new THREE.Group();
    group.position.set(x, y, 0);
    parent.add(group);
    return group;
  };

  // Revolved profile: narrow waist, broader chest, rounded shoulders.
  const profile = [
    [0, -0.52],
    [0.2, -0.49],
    [0.26, -0.35],
    [0.24, -0.15],
    [0.29, 0.1],
    [0.34, 0.3],
    [0.3, 0.44],
    [0.16, 0.52],
    [0, 0.54],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  part(new THREE.LatheGeometry(profile, 20), shirtColor, 1.22, body);
  part(new THREE.CylinderGeometry(0.31, 0.288, 0.14, 20, 1, true), accent, 1.31, body);
  part(createMiiHeadGeometry(face), skin, 2.04, body);
  const hair = createMiiHairGeometry(face);
  if (hair) part(hair, miiHairColor(face), 2.04, body);
  part(createMiiNoseGeometry(face), skin, 2.04, body);
  part(createMiiCapBandGeometry(face), accent, 2.2, body);
  // Curved brim: a flat sector of a disc centred on the head, pointing forwards (-Z).
  part(new THREE.CylinderGeometry(0.62, 0.62, 0.035, 24, 1, false, Math.PI * 0.74, Math.PI * 0.52), accent, 2.16, body);
  const shoe = (width: number, height: number, length: number) =>
    new THREE.CapsuleGeometry(0.1, 0.2, 4, 12).rotateX(Math.PI / 2).scale(width, height, length);

  const limbs = [-1, 1].map((side) => {
    const hip = joint(side * 0.17, 0.9, body);
    part(new THREE.CapsuleGeometry(0.13, 0.22, 4, 10), 0x35516e, -0.2, hip);
    const knee = joint(0, -0.42, hip);
    part(new THREE.CapsuleGeometry(0.1, 0.24, 4, 10), skin, -0.2, knee);
    part(shoe(1.15, 0.75, 1), 0xff8a2a, -0.42, knee, -0.07);
    part(shoe(1.2, 0.3, 1.04), 0xffffff, -0.48, knee, -0.07);
    const shoulder = joint(side * 0.4, 1.5, body);
    part(new THREE.CapsuleGeometry(0.095, 0.18, 4, 10), shirtColor, -0.16, shoulder);
    const elbow = joint(0, -0.34, shoulder);
    part(new THREE.CapsuleGeometry(0.075, 0.18, 4, 10), skin, -0.14, elbow);
    part(new THREE.SphereGeometry(0.11, 12, 10), skin, -0.32, elbow);
    return { side, hip, knee, shoulder, elbow };
  });

  for (const [parent, parts] of pending) {
    const mesh = new THREE.Mesh(merge(parts), material);
    mesh.castShadow = true;
    parent.add(mesh);
  }
  const facePatch = createMiiFacePatch(face);
  body.add(facePatch.object);

  return {
    root,
    facePatch,
    animate(stridePhase, speed01, lean) {
      const effort = Math.min(1, speed01 * 1.4);
      for (const { side, hip, knee, shoulder, elbow } of limbs) {
        const phase = stridePhase + (side > 0 ? Math.PI : 0);
        hip.rotation.x = Math.sin(phase) * 0.95 * effort;
        // Knees only fold backwards, most while the leg swings forward.
        knee.rotation.x = -Math.max(0, Math.cos(phase)) * 1.5 * effort;
        shoulder.rotation.x = -Math.sin(phase) * 0.9 * effort;
        shoulder.rotation.z = side * 0.12;
        elbow.rotation.x = 0.25 + effort * 1.1;
      }
      body.position.y = Math.abs(Math.sin(stridePhase)) * 0.1 * effort;
      root.rotation.x = -0.18 * speed01;
      root.rotation.z = lean;
    },
  };
}
