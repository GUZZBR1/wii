import * as THREE from 'three';

export function createAthlete(shirt: number, facing: number) {
  const root = new THREE.Group();
  root.rotation.y = facing;
  const torso = new THREE.Group();
  torso.position.y = 0.88;
  root.add(torso);
  const fabric = new THREE.MeshStandardMaterial({ color: shirt });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd99a72 });
  const shorts = new THREE.MeshStandardMaterial({ color: 0x26334b });
  const shoe = new THREE.MeshStandardMaterial({ color: 0xf7f6eb });
  const add = (parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
  };
  add(torso, new THREE.CapsuleGeometry(0.29, 0.32, 4, 10), fabric, 0, 0.3);
  add(torso, new THREE.SphereGeometry(0.24, 12, 8), skin, 0, 0.88);
  add(torso, new THREE.SphereGeometry(0.244, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), shorts, 0, 0.94);
  const legs = [-1, 1].map((side) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.15, 0.83, 0);
    root.add(leg);
    add(leg, new THREE.CapsuleGeometry(0.115, 0.18, 4, 8), shorts, 0, -0.17);
    add(leg, new THREE.CapsuleGeometry(0.075, 0.24, 4, 8), skin, 0, -0.49);
    add(leg, new THREE.BoxGeometry(0.19, 0.15, 0.31), shoe, 0, -0.73, -0.05);
    return leg;
  });
  const arms = [-1, 1].map((side) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.32, 0.48, 0);
    torso.add(arm);
    add(arm, new THREE.CapsuleGeometry(0.085, 0.29, 4, 8), skin, 0, -0.2);
    return arm;
  });
  const grip = new THREE.Group();
  grip.position.set(0, -0.39, -0.03);
  grip.rotation.z = -1.25;
  arms[1]!.add(grip);

  return {
    root, grip,
    animate(stride: number, speed: number, swing: number, direction: number) {
      const step = Math.sin(stride * 10) * Math.min(1, Math.abs(speed) / 3);
      const arc = Math.sin(Math.PI * swing);
      torso.rotation.set(0, arc * direction * 0.8, -speed * 0.035);
      torso.position.y = 0.88 + Math.abs(step) * 0.055;
      legs[0]!.rotation.x = step * 0.6;
      legs[1]!.rotation.x = -step * 0.6;
      arms[0]!.rotation.set(-0.45 + step * 0.24, 0, -0.25);
      arms[1]!.rotation.set(-0.55 - arc * 1.2, arc * direction, 0.35 + arc * 1.35);
    },
  };
}
