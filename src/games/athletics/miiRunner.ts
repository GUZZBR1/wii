import * as THREE from 'three';

export interface MiiRunner {
  /** Faces local -Z. The owner sets position and heading; the runner handles limbs, bob and lean. */
  root: THREE.Group;
  animate(stridePhase: number, speed01: number, lean: number): void;
}

export function createMiiRunner(): MiiRunner {
  const material = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });
  const shirt = material(0xffffff);
  const accent = material(0x2f9be8);
  const skin = material(0xf2c29a);
  const shorts = material(0x35516e);
  const hair = material(0x4a2f1f);
  const shoes = material(0xff8a2a);

  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const body = new THREE.Group();
  body.scale.setScalar(0.75);
  root.add(body);

  const part = (geometry: THREE.BufferGeometry, mat: THREE.Material, y: number, parent: THREE.Object3D, z = 0) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(0, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const joint = (x: number, y: number, parent: THREE.Object3D) => {
    const group = new THREE.Group();
    group.position.set(x, y, 0);
    parent.add(group);
    return group;
  };

  part(new THREE.CapsuleGeometry(0.31, 0.42, 6, 16), shirt, 1.22, body);
  part(new THREE.CylinderGeometry(0.318, 0.318, 0.14, 20, 1, true), accent, 1.3, body);
  part(new THREE.SphereGeometry(0.4, 24, 18), skin, 2.04, body);
  part(new THREE.SphereGeometry(0.415, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), hair, 2.06, body, 0.02);
  part(new THREE.CylinderGeometry(0.41, 0.41, 0.11, 24, 1, true), accent, 2.2, body);
  part(new THREE.BoxGeometry(0.44, 0.04, 0.24), accent, 2.17, body, -0.46);

  const limbs = [-1, 1].map((side) => {
    const hip = joint(side * 0.17, 0.9, body);
    part(new THREE.CapsuleGeometry(0.13, 0.22, 4, 10), shorts, -0.2, hip);
    const knee = joint(0, -0.42, hip);
    part(new THREE.CapsuleGeometry(0.1, 0.24, 4, 10), skin, -0.2, knee);
    part(new THREE.BoxGeometry(0.22, 0.14, 0.4), shoes, -0.43, knee, -0.07);
    const shoulder = joint(side * 0.4, 1.5, body);
    part(new THREE.CapsuleGeometry(0.095, 0.18, 4, 10), shirt, -0.16, shoulder);
    const elbow = joint(0, -0.34, shoulder);
    part(new THREE.CapsuleGeometry(0.075, 0.18, 4, 10), skin, -0.14, elbow);
    part(new THREE.SphereGeometry(0.11, 12, 10), skin, -0.32, elbow);
    return { side, hip, knee, shoulder, elbow };
  });

  return {
    root,
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
