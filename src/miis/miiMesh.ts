import * as THREE from 'three';
import { createMiiFaceTexture } from '../mii/faceRenderer';
import {
  createMiiFacePatch,
  createMiiHairGeometry,
  createMiiHeadGeometry,
  createMiiNoseGeometry,
  miiHairColor,
} from '../mii/miiHead';
import { type MiiFaceSpec, SKIN_PALETTE } from '../mii/miiSpec';
import type { SiteMii } from './siteMii';

/** Mii estilizado: pés em y=0, olhando para +z, cerca de 2 unidades de altura. */
export interface MiiModel {
  readonly root: THREE.Group;
  /** `phase` avança com a caminhada; `amount` 0 deixa o Mii parado. */
  pose(phase: number, amount: number): void;
}

function material(color: string) {
  return new THREE.MeshLambertMaterial({ color });
}

function add(parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function ball(radius: number) {
  return new THREE.SphereGeometry(radius, 12, 10);
}

/** A mesma cabeça dos jogos (formato, cabelo, nariz e rosto desenhado), virada para +z. */
function createHead(face: MiiFaceSpec, textureSize: number) {
  const head = new THREE.Group();
  head.rotation.y = Math.PI;
  const skin = new THREE.MeshLambertMaterial({ color: SKIN_PALETTE[face.skin] });
  add(head, createMiiHeadGeometry(face), skin);
  add(head, createMiiNoseGeometry(face), skin);
  const hair = createMiiHairGeometry(face);
  if (hair) add(head, hair, new THREE.MeshLambertMaterial({ color: miiHairColor(face), side: THREE.DoubleSide }));
  if (typeof document !== 'undefined') {
    const mount = createMiiFacePatch(face);
    mount.object.position.y = 0;
    mount.setTexture(createMiiFaceTexture(face, textureSize));
    head.add(mount.object);
  }
  return head;
}

export function createMiiModel(mii: SiteMii, textureSize = 128): MiiModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const skin = new THREE.MeshLambertMaterial({ color: SKIN_PALETTE[mii.face.skin] });
  const shirt = material(mii.shirtColor);
  const pants = material('#33415c');
  const width = 0.8 + mii.build * 0.5;

  add(
    root,
    new THREE.CircleGeometry(0.4, 20),
    new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.18, depthWrite: false }),
  ).rotation.x = -Math.PI / 2;

  const legs = [-1, 1].map((side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13 * width, 0.46, 0);
    add(hip, new THREE.CapsuleGeometry(0.09, 0.26, 4, 8), pants, 0, -0.23, 0);
    body.add(hip);
    return hip;
  });

  const torso = add(body, new THREE.CylinderGeometry(0.2, 0.31, 0.56, 16), shirt, 0, 0.72, 0);
  torso.scale.set(width, 1, width * 0.85);
  add(body, ball(0.2), shirt, 0, 0.99, 0).scale.set(width, 0.55, width * 0.85);

  const arms = [-1, 1].map((side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.24 * width, 0.96, 0);
    shoulder.rotation.z = side * 0.28;
    add(shoulder, new THREE.CapsuleGeometry(0.065, 0.3, 4, 8), shirt, 0, -0.2, 0);
    add(shoulder, ball(0.085), skin, 0, -0.43, 0);
    body.add(shoulder);
    return shoulder;
  });

  const head = createHead(mii.face, textureSize);
  head.position.set(0, 1.43, 0);
  body.add(head);

  root.scale.setScalar(0.85 + mii.height * 0.3);

  return {
    root,
    pose(phase, amount) {
      const swing = Math.sin(phase) * 0.6 * amount;
      legs[0].rotation.x = swing;
      legs[1].rotation.x = -swing;
      arms[0].rotation.x = -swing;
      arms[1].rotation.x = swing;
      body.position.y = Math.abs(Math.cos(phase)) * 0.05 * amount;
    },
  };
}

export function createMiiLights(): THREE.Object3D[] {
  const sun = new THREE.DirectionalLight('#ffffff', 1.5);
  sun.position.set(1, 2, 3);
  return [new THREE.HemisphereLight('#ffffff', '#8899aa', 1.8), sun];
}
