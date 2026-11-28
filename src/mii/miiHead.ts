import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HAIR_PALETTE, type MiiFaceSpec } from './miiSpec';

export const MII_HEAD_CENTER_Y = 2.04;
export const MII_HEAD_RADIUS = 0.4;

const HEAD_SHAPES = [
  [1, 1, 1],
  [0.92, 1.08, 0.96],
  [1.1, 0.94, 0.98],
  [0.96, 1.12, 0.92],
  [1.12, 1, 0.9],
  [0.88, 0.98, 1.05],
  [1.04, 0.9, 1],
  [0.94, 1.04, 1.08],
] as const;

export function miiHeadScale(spec: MiiFaceSpec): readonly [number, number, number] {
  return HEAD_SHAPES[spec.head % HEAD_SHAPES.length];
}

/** Head-local fallback geometry: even with no texture this smooth vertex-colored sphere is the whole cost. */
export function createMiiHeadGeometry(spec: MiiFaceSpec): THREE.BufferGeometry {
  const [sx, sy, sz] = miiHeadScale(spec);
  return new THREE.SphereGeometry(MII_HEAD_RADIUS, 24, 18).scale(sx, sy, sz);
}

function mergeRaw(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Could not merge the Mii geometry');
  return merged;
}

function cap(radius: number, thetaLength: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, 24, 12, 0, Math.PI * 2, 0, thetaLength).translate(0, 0.015, 0.02);
}

function ball(radius: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, 12, 9).scale(sx, sy, sz).translate(x, y, z);
}

/** Simple hair masses in head-local coordinates; they merge into the same vertex-colored body mesh. */
export function createMiiHairGeometry(spec: MiiFaceSpec): THREE.BufferGeometry | undefined {
  if (spec.hair === 0) return undefined;
  let parts: THREE.BufferGeometry[] = [];
  if (spec.hair === 1) {
    parts = [cap(0.418, Math.PI * 0.43)];
  } else if (spec.hair === 2) {
    parts = [cap(0.42, Math.PI * 0.45), ball(0.15, 0.19, 0.16, -0.2, 1.45, 0.55, 0.7)];
  } else if (spec.hair === 3) {
    parts = [cap(0.41, Math.PI * 0.35)];
    for (let index = 0; index < 5; index += 1) {
      const x = (index - 2) * 0.095;
      parts.push(new THREE.ConeGeometry(0.07, 0.2 + 0.035 * (2 - Math.abs(index - 2)), 8).translate(x, 0.43, -0.02));
    }
  } else if (spec.hair === 4) {
    parts = [
      cap(0.435, Math.PI * 0.52),
      ball(0.17, -0.31, -0.06, 0.02, 0.75, 1.35, 0.9),
      ball(0.17, 0.31, -0.06, 0.02, 0.75, 1.35, 0.9),
    ];
  } else if (spec.hair === 5) {
    parts = [
      cap(0.42, Math.PI * 0.45),
      new THREE.CapsuleGeometry(0.09, 0.28, 4, 10).rotateX(Math.PI / 2).translate(0, 0.02, 0.42),
    ];
  } else if (spec.hair === 6) {
    parts = [new THREE.BoxGeometry(0.11, 0.18, 0.55).translate(0, 0.36, 0.02)];
  } else if (spec.hair === 7) {
    for (const [x, y, z] of [
      [-0.2, 0.27, -0.08],
      [0, 0.34, -0.07],
      [0.2, 0.27, -0.08],
      [-0.22, 0.17, 0.08],
      [0, 0.24, 0.12],
      [0.22, 0.17, 0.08],
    ])
      parts.push(ball(0.13, x, y, z, 1.05, 0.9, 1.05));
  } else if (spec.hair === 8) {
    parts = [cap(0.407, Math.PI * 0.34)];
  } else if (spec.hair === 9) {
    parts = [cap(0.425, Math.PI * 0.48), new THREE.CapsuleGeometry(0.18, 0.36, 4, 12).translate(0, -0.16, 0.27)];
  } else if (spec.hair === 10) {
    parts = [cap(0.42, Math.PI * 0.44)];
    for (const x of [-0.15, 0, 0.15]) parts.push(ball(0.11, x, 0.16, -0.27, 1.2, 0.55, 0.55));
  } else {
    parts = [
      cap(0.47, Math.PI * 0.42),
      ball(0.15, -0.3, 0.03, 0.08, 0.95, 1.1, 0.95),
      ball(0.15, 0.3, 0.03, 0.08, 0.95, 1.1, 0.95),
      ball(0.2, 0, 0.04, 0.25, 1.15, 1.05, 0.9),
    ];
  }
  const merged = mergeRaw(parts);
  const [sx, sy, sz] = miiHeadScale(spec);
  return merged.scale(sx, sy, sz);
}

/**
 * How far the nose tip stands in front of the exact front head surface. Small enough that every
 * style keeps most of its volume inside the head, large enough to read as a nose at arm's length.
 */
const NOSE_PROTRUSION = 0.02;

/** Exact front (-Z) surface of the scaled head ellipsoid at head-local height y on the x = 0 plane. */
function headFrontSurfaceZ(y: number, sy: number, sz: number): number {
  return -MII_HEAD_RADIUS * sz * Math.sqrt(1 - Math.min(1, Math.abs(y) / (MII_HEAD_RADIUS * sy)) ** 2);
}

/**
 * Nose primitive in head-local coordinates; its vertical position follows the same band as the texture.
 * Every primitive is seated on the exact front ellipsoid surface at its own centre height — a fixed
 * base depth buries flat noses in deep head shapes whenever the band approaches y = 0.
 */
export function createMiiNoseGeometry(spec: MiiFaceSpec): THREE.BufferGeometry {
  const [, sy, sz] = miiHeadScale(spec);
  const y = ((spec.noseY - 50) / 100) * 0.8;
  // Places a primitive built around the origin so its centre sits halfDepthZ inside the surface at
  // centreY, minus the protrusion: the back half intersects the head, the tip stays visibly outside.
  const seat = (part: THREE.BufferGeometry, centerY: number, halfDepthZ: number): THREE.BufferGeometry =>
    part.translate(0, centerY, headFrontSurfaceZ(centerY, sy, sz) + halfDepthZ - NOSE_PROTRUSION);
  if (spec.nose === 0) return seat(ball(0.038, 0, 0, 0, 0.85, 1.05, 0.7), y, 0.038 * 0.7);
  if (spec.nose === 1) return seat(ball(0.052, 0, 0, 0, 1, 1.1, 0.82), y, 0.052 * 0.82);
  if (spec.nose === 2) return seat(new THREE.ConeGeometry(0.045, 0.13, 10).rotateX(-Math.PI / 2), y, 0.13 / 2);
  if (spec.nose === 3) return seat(ball(0.055, 0, 0, 0, 1.45, 0.75, 0.6), y - 0.005, 0.055 * 0.6);
  if (spec.nose === 4) {
    return seat(new THREE.CapsuleGeometry(0.036, 0.075, 4, 10).rotateX(Math.PI / 2), y, (0.075 + 2 * 0.036) / 2);
  }
  if (spec.nose === 5) {
    return seat(new THREE.ConeGeometry(0.04, 0.1, 10).rotateX(-Math.PI / 2).rotateZ(Math.PI), y + 0.012, 0.1 / 2);
  }
  if (spec.nose === 6) return seat(ball(0.065, 0, 0, 0, 1.35, 0.55, 0.42), y - 0.01, 0.065 * 0.42);
  return mergeRaw([
    seat(new THREE.CapsuleGeometry(0.032, 0.07, 4, 8).rotateX(Math.PI / 2), y + 0.025, (0.07 + 2 * 0.032) / 2),
    seat(ball(0.045, 0, 0, 0, 1.05, 0.85, 0.8), y - 0.018, 0.045 * 0.8),
  ]);
}

let sharedFacePatchGeometry: THREE.BufferGeometry | undefined;

/**
 * Front spherical arc centred on local -Z. The geometry is immutable and shared by every Mii;
 * if a scene disposal releases its GPU copy, Three simply uploads the same immutable data again.
 */
export function miiFacePatchGeometry(): THREE.BufferGeometry {
  if (!sharedFacePatchGeometry) {
    const phiLength = 1.5;
    const phiCenter = -Math.PI / 2;
    sharedFacePatchGeometry = new THREE.SphereGeometry(
      MII_HEAD_RADIUS * 1.018,
      24,
      14,
      phiCenter - phiLength / 2,
      phiLength,
      Math.PI * 0.18,
      Math.PI * 0.64,
    );
    sharedFacePatchGeometry.name = 'mii-shared-face-patch';
  }
  return sharedFacePatchGeometry;
}

export interface MiiFaceMount {
  spec: MiiFaceSpec;
  object: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  radius: number;
  setTexture(texture: THREE.CanvasTexture | undefined): void;
}

/** Curved transparent patch owned by the body hierarchy; only visibility changes, never its geometry. */
export function createMiiFacePatch(spec: MiiFaceSpec): MiiFaceMount {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    alphaTest: 0.03,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(miiFacePatchGeometry(), material);
  mesh.name = 'mii-face-patch';
  mesh.position.y = MII_HEAD_CENTER_Y;
  const [sx, sy, sz] = miiHeadScale(spec);
  mesh.scale.set(sx, sy, sz);
  mesh.visible = false;
  mesh.renderOrder = 2;
  return {
    spec,
    object: mesh,
    radius: MII_HEAD_RADIUS * 1.2,
    setTexture(texture) {
      material.map = texture ?? null;
      material.needsUpdate = true;
      mesh.visible = texture !== undefined;
    },
  };
}

export function miiHairColor(spec: MiiFaceSpec): number {
  return HAIR_PALETTE[spec.hairColor];
}
