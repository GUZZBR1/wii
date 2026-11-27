import * as THREE from 'three';

/** A Wii-style player: big head, tapered shirt, short legs, floating hands, racket in the right one. */
export function createAthlete(shirt: number, facing: number) {
  const root = new THREE.Group();
  root.rotation.y = facing;
  const material = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
  const fabric = material(shirt);
  // Palette shared with the athletics runner.
  const skin = material(0xf2c29a);
  const hair = material(0x4a2f22);
  const band = material(0x2f9be8);
  const trousers = material(0xe9edf0);
  const shoe = material(0xfbfbf4);
  const dark = material(0x222831);
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, paint: THREE.Material, x: number, y: number, z = 0) => {
    const mesh = new THREE.Mesh(geometry, paint);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const group = (parent: THREE.Object3D, x: number, y: number, z = 0) => {
    const node = new THREE.Group();
    node.position.set(x, y, z);
    parent.add(node);
    return node;
  };

  const shadow = add(root, new THREE.CircleGeometry(0.46, 20), new THREE.MeshBasicMaterial({ color: 0x10301c, transparent: true, opacity: 0.35, depthWrite: false }), 0, 0.022);
  shadow.rotation.x = -Math.PI / 2;

  const torso = group(root, 0, 0.6);
  const profile = [[0, -0.04], [0.2, 0], [0.24, 0.2], [0.29, 0.46], [0.24, 0.62], [0.1, 0.7], [0, 0.72]].map(([x, y]) => new THREE.Vector2(x, y));
  add(torso, new THREE.LatheGeometry(profile, 20), fabric, 0, 0);
  add(torso, new THREE.SphereGeometry(0.43, 24, 18), skin, 0, 1.1);
  // Hair wraps the back of the head, which is what the player's camera sees.
  add(torso, new THREE.SphereGeometry(0.445, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, 0, 1.12, 0.03).rotation.x = 0.35;
  add(torso, new THREE.CylinderGeometry(0.437, 0.437, 0.08, 24, 1, true), band, 0, 1.24);
  for (const x of [-0.15, 0.15]) add(torso, new THREE.SphereGeometry(0.04, 8, 6), dark, x, 1.12, -0.41);

  const legs = [-1, 1].map((side) => {
    const leg = group(root, side * 0.13, 0.6);
    add(leg, new THREE.CapsuleGeometry(0.095, 0.26, 4, 10), trousers, 0, -0.22);
    add(leg, new THREE.CapsuleGeometry(0.1, 0.14, 4, 10), shoe, 0, -0.5, -0.07).rotation.x = Math.PI / 2;
    return leg;
  });

  const [freeHand, racketHand] = [-1, 1].map((side) => {
    const hand = group(torso, side * 0.46, 0.2, -0.06);
    add(hand, new THREE.SphereGeometry(0.105, 12, 10), skin, 0, 0);
    return hand;
  }) as [THREE.Group, THREE.Group];

  const grip = group(racketHand, 0, 0, 0);
  grip.rotation.z = -1.1;

  // The streak the racket head leaves behind during a stroke.
  const swoosh = add(root, new THREE.RingGeometry(0.75, 1.25, 32, 1, 0, Math.PI * 1.1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }), 0, 0.95);
  swoosh.rotation.x = -Math.PI / 2;
  swoosh.visible = false;
  const swooshPaint = swoosh.material as THREE.MeshBasicMaterial;

  return {
    root, grip,
    animate(stride: number, speed: number, swing: number, direction: number) {
      const step = Math.sin(stride * 9) * Math.min(1, Math.abs(speed) / 3);
      const swinging = swing < 1;
      // Fast through the ball, slower on the follow-through.
      const eased = 1 - (1 - swing) ** 2;
      // Angle around the body, 0 straight ahead: starts behind on the stroke side and wraps across.
      const angle = (2.3 - 4.2 * eased) * direction;
      torso.rotation.set(0, swinging ? -angle * 0.4 : 0, -speed * 0.04);
      torso.position.y = 0.6 + Math.abs(step) * 0.07;
      legs[0]!.rotation.x = step * 0.7;
      legs[1]!.rotation.x = -step * 0.7;
      freeHand.position.set(-0.46, 0.2 + step * 0.08, -0.06 - step * 0.12);
      if (swinging) {
        racketHand.position.set(Math.sin(angle) * 0.62, 0.22 + eased * 0.3, -Math.cos(angle) * 0.62);
        // Lay the racket out radially, pointing away from the body.
        racketHand.rotation.set(0, -angle, 0);
        grip.rotation.set(-Math.PI / 2, 0, 0);
      } else {
        racketHand.position.set(0.46, 0.2, -0.06);
        racketHand.rotation.set(0, 0, 0);
        grip.rotation.set(0, 0, -1.1);
      }
      swoosh.visible = swinging;
      swooshPaint.opacity = 0.55 * Math.sin(Math.PI * swing);
      swoosh.rotation.z = Math.PI / 2 - angle - (direction > 0 ? 0 : Math.PI * 1.1);
    },
  };
}

/** Oversized oval head with strings, so the stroke reads from across the court. */
export function createRacket(frame: number): THREE.Group {
  const group = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.36, 8), new THREE.MeshStandardMaterial({ color: 0x24282e }));
  handle.position.y = 0.12;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.028, 8, 28), new THREE.MeshStandardMaterial({ color: frame, roughness: 0.35 }));
  rim.position.y = 0.6;
  rim.scale.y = 1.25;
  const strings: number[] = [];
  for (let i = -3; i <= 3; i += 1) {
    const offset = i * 0.065;
    const reach = Math.sqrt(0.25 ** 2 - offset ** 2);
    strings.push(offset, 0.6 - reach * 1.25, 0, offset, 0.6 + reach * 1.25, 0);
    strings.push(-reach, 0.6 + offset * 1.25, 0, reach, 0.6 + offset * 1.25, 0);
  }
  const mesh = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(strings, 3)),
    new THREE.LineBasicMaterial({ color: 0xf4f6f0 }),
  );
  group.add(handle, rim, mesh);
  return group;
}
