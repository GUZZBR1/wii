import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createFirstPersonGloves,
  createMiiBoxer,
  type MiiBoxer,
  type MiiBoxerState,
} from '../src/games/boxing/miiBoxer';
import { disposeObjectTree } from '../src/games/core/GameLoop';

function meshesIn(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

function snapshotPose(root: THREE.Object3D): number[] {
  const values: number[] = [];
  root.traverse((object) => {
    values.push(
      object.position.x,
      object.position.y,
      object.position.z,
      object.rotation.x,
      object.rotation.y,
      object.rotation.z,
    );
  });
  return values;
}

function poseDifference(before: number[], after: number[]): number {
  return before.reduce((total, value, index) => total + Math.abs(value - after[index]!), 0);
}

function named(root: THREE.Object3D, name: string): THREE.Object3D {
  const object = root.getObjectByName(name);
  expect(object, name).toBeDefined();
  return object!;
}

function glovePoint(boxer: MiiBoxer, side: 'left' | 'right'): THREE.Vector3 {
  boxer.root.updateMatrixWorld(true);
  return named(boxer.root, `mii-boxer-${side}-elbow`).localToWorld(new THREE.Vector3(0, -0.34, -0.02));
}

function boxerIn(state: MiiBoxerState, timeSeconds: number): MiiBoxer {
  const boxer = createMiiBoxer();
  boxer.animate(0);
  boxer.setState(state);
  boxer.animate(timeSeconds);
  return boxer;
}

function expectTreeDisposable(root: THREE.Object3D): void {
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  for (const mesh of meshesIn(root)) {
    resources.add(mesh.geometry);
    resources.add(mesh.material as THREE.Material);
  }
  let disposals = 0;
  for (const resource of resources) {
    resource.addEventListener('dispose', () => {
      disposals += 1;
    });
  }
  disposeObjectTree(root);
  expect(disposals).toBe(resources.size);
}

describe('createMiiBoxer', () => {
  it('creates an articulated merged hierarchy with vertex colors and few meshes', () => {
    const boxer = createMiiBoxer();
    const meshes = meshesIn(boxer.root);
    expect(meshes).toHaveLength(9);
    expect(new Set(meshes.map((mesh) => mesh.material)).size).toBe(1);
    for (const mesh of meshes) {
      expect(mesh).not.toBeInstanceOf(THREE.SkinnedMesh);
      expect(mesh).not.toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.geometry.getAttribute('color')).toBeDefined();
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.vertexColors).toBe(true);
    }
    for (const side of ['left', 'right'] as const) {
      for (const joint of ['hip', 'knee', 'shoulder', 'elbow'] as const) {
        expect(boxer.root.getObjectByName(`mii-boxer-${side}-${joint}`)).toBeDefined();
      }
    }
  });

  it('uses resources that disposeObjectTree can release exactly once', () => {
    expectTreeDisposable(createMiiBoxer().root);
  });

  it('poses the neutral idle stance instead of leaving the rig at zero rotations', () => {
    const boxer = createMiiBoxer();
    const before = snapshotPose(boxer.root);
    boxer.animate(0);
    const after = snapshotPose(boxer.root);
    expect(poseDifference(before, after)).toBeGreaterThan(0.5);
  });

  it('measurably changes the pose for every state', () => {
    const sampleTimes: Record<MiiBoxerState, number> = {
      idle: 0.5,
      guard: 0.5,
      windup: 0.5,
      punch: 0.12,
      recover: 0.5,
      hit: 0.1,
      dizzy: 0.5,
      knockdown: 0.8,
      getup: 0.4,
    };
    for (const [state, time] of Object.entries(sampleTimes) as [MiiBoxerState, number][]) {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      if (state === 'idle') {
        boxer.setState('guard');
        boxer.animate(0.3);
      }
      const before = snapshotPose(boxer.root);
      boxer.setState(state);
      boxer.animate(time);
      const after = snapshotPose(boxer.root);
      expect(poseDifference(before, after), state).toBeGreaterThan(0.5);
    }
  });

  it('raises the gloves in guard and extends the right glove forward in punch', () => {
    const idle = createMiiBoxer();
    idle.animate(0);
    const idleLeftY = glovePoint(idle, 'left').y;
    const idleRightY = glovePoint(idle, 'right').y;

    const guard = boxerIn('guard', 0.5);
    expect(glovePoint(guard, 'left').y).toBeGreaterThan(idleLeftY + 0.15);
    expect(glovePoint(guard, 'right').y).toBeGreaterThan(idleRightY + 0.15);

    const windupRightZ = glovePoint(boxerIn('windup', 0.5), 'right').z;
    const punchRightZ = glovePoint(boxerIn('punch', 0.12), 'right').z;
    expect(punchRightZ).toBeLessThan(windupRightZ - 0.2);
  });

  it('makes knockdown clearly fallen and getup visibly lower but recovering', () => {
    const knockdown = boxerIn('knockdown', 0.8);
    const knockdownBody = named(knockdown.root, 'mii-boxer-body');
    expect(knockdownBody.rotation.x).toBeGreaterThan(1.1);

    knockdown.root.updateMatrixWorld(true);
    const downHeadY = knockdownBody.localToWorld(new THREE.Vector3(0, 2.04, 0)).y;
    expect(downHeadY).toBeLessThan(0.5);

    const getup = boxerIn('getup', 0.4);
    const getupBody = named(getup.root, 'mii-boxer-body');
    expect(getupBody.position.y).toBeLessThan(-0.1);
    expect(Math.abs(getupBody.rotation.x)).toBeLessThan(Math.abs(knockdownBody.rotation.x) * 0.5);
  });

  it('recovers from knockdown through getup without snapping upright', () => {
    const boxer = createMiiBoxer();
    boxer.animate(0);
    boxer.setState('knockdown');
    boxer.animate(0.8);
    boxer.setState('getup');

    const body = named(boxer.root, 'mii-boxer-body');
    boxer.animate(0.95);
    expect(body.rotation.x).toBeGreaterThan(0.45);
    boxer.animate(1.4);
    expect(Math.abs(body.rotation.x)).toBeLessThan(0.5);
    expect(body.position.y).toBeLessThan(-0.15);
    boxer.animate(2);
    expect(Math.abs(body.rotation.x)).toBeLessThan(0.15);
    expect(body.position.y).toBeGreaterThan(-0.1);
  });

  it('oscillates deterministically while dizzy', () => {
    const boxer = createMiiBoxer();
    boxer.animate(0);
    boxer.setState('dizzy');
    boxer.animate(0.5);
    const first = snapshotPose(boxer.root);
    boxer.animate(1);
    const second = snapshotPose(boxer.root);
    expect(poseDifference(first, second)).toBeGreaterThan(0.1);
    boxer.animate(1);
    expect(snapshotPose(boxer.root)).toEqual(second);
  });

  it('repeats exactly for the same sequence of explicit times and states', () => {
    const runSequence = () => {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      boxer.setState('guard');
      boxer.animate(0.31);
      boxer.setState('windup');
      boxer.animate(0.55);
      boxer.setState('punch');
      boxer.animate(0.67);
      return snapshotPose(boxer.root);
    };
    expect(runSequence()).toEqual(runSequence());
  });

  it('uses the explicit clock for state transition progress', () => {
    const early = createMiiBoxer();
    const late = createMiiBoxer();
    early.animate(0);
    late.animate(0);
    early.setState('guard');
    late.setState('guard');
    early.animate(0.04);
    late.animate(0.3);
    expect(poseDifference(snapshotPose(early.root), snapshotPose(late.root))).toBeGreaterThan(0.5);
  });

  it('adds subtle deterministic leg and trunk motion for footwork input', () => {
    const boxer = createMiiBoxer();
    boxer.animate(0.4);
    const planted = snapshotPose(boxer.root);

    boxer.animate(0.4, { speed01: 1, forward: 1, strafe: 1 });
    const moving = snapshotPose(boxer.root);
    expect(poseDifference(planted, moving)).toBeGreaterThan(0.05);

    // The stride fades with elapsed time; once faded it matches a boxer that never moved.
    boxer.animate(2);
    const still = createMiiBoxer();
    still.animate(0.4);
    still.animate(2);
    expect(snapshotPose(boxer.root)).toEqual(snapshotPose(still.root));
  });

  it('damps the footwork instead of snapping the legs when the boxer stops', () => {
    const run = (stopped: number) => {
      const boxer = createMiiBoxer();
      const still = createMiiBoxer();
      boxer.animate(1, { speed01: 1, forward: 1, strafe: 1 });
      still.animate(1);
      boxer.animate(1 + stopped);
      still.animate(1 + stopped);
      return {
        pose: snapshotPose(boxer.root),
        leftover: Math.abs(
          named(boxer.root, 'mii-boxer-left-hip').rotation.x - named(still.root, 'mii-boxer-left-hip').rotation.x,
        ),
      };
    };
    expect(run(1 / 60).leftover).toBeGreaterThan(0.05);
    expect(run(1).leftover).toBe(0);
    expect(run(1 / 60).pose).toEqual(run(1 / 60).pose);
  });

  it.each([
    ['windup', 0.5],
    ['punch', 0.12],
  ] as const)('mirrors the %s arms for the left hand', (state, time) => {
    const pose = (hand: 'left' | 'right') => {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      boxer.setState(state, hand);
      // Past the blend from idle.
      boxer.animate(time);
      if (state === 'windup') boxer.animate(time);
      return boxer;
    };
    const right = pose('right');
    const left = pose('left');
    for (const joint of ['shoulder', 'elbow'] as const) {
      const thrown = named(right.root, `mii-boxer-right-${joint}`).rotation;
      const mirrored = named(left.root, `mii-boxer-left-${joint}`).rotation;
      expect(mirrored.x).toBeCloseTo(thrown.x);
      expect(mirrored.y).toBeCloseTo(-thrown.y);
      expect(mirrored.z).toBeCloseTo(-thrown.z);
    }
    expect(named(left.root, 'mii-boxer-body').rotation.y).toBeCloseTo(-named(right.root, 'mii-boxer-body').rotation.y);
    expect(named(left.root, 'mii-boxer-left-hip').rotation.x).toBeCloseTo(
      named(right.root, 'mii-boxer-left-hip').rotation.x,
    );
  });

  it('restarts a punch for the other hand but not for the same one', () => {
    const boxer = createMiiBoxer();
    boxer.animate(0);
    boxer.setState('punch');
    boxer.animate(0.12);
    const extended = glovePoint(boxer, 'right').z;
    boxer.setState('punch', 'right');
    boxer.animate(1);
    expect(glovePoint(boxer, 'right').z).toBeGreaterThan(extended + 0.2);
    const restingLeft = glovePoint(boxer, 'left').z;
    boxer.setState('punch', 'left');
    boxer.animate(1.12);
    expect(glovePoint(boxer, 'left').z).toBeLessThan(restingLeft - 0.2);
  });

  it('opens the guard while recovering', () => {
    const guard = boxerIn('guard', 0.5);
    const recover = boxerIn('recover', 0.5);
    for (const side of ['left', 'right'] as const) {
      expect(glovePoint(recover, side).y).toBeLessThan(glovePoint(guard, side).y - 0.05);
    }
    const spread = (boxer: MiiBoxer) => glovePoint(boxer, 'right').x - glovePoint(boxer, 'left').x;
    expect(spread(recover)).toBeGreaterThan(spread(guard) + 0.1);
  });

  it('rejects non-finite animation times', () => {
    const boxer = createMiiBoxer();
    expect(() => boxer.animate(Number.NaN)).toThrow(TypeError);
  });
});

describe('createFirstPersonGloves', () => {
  it('creates two large translucent merged gloves without skinned or instanced meshes', () => {
    const gloves = createFirstPersonGloves();
    const meshes = meshesIn(gloves.root);
    expect(meshes).toHaveLength(2);
    for (const mesh of meshes) {
      expect(mesh).not.toBeInstanceOf(THREE.SkinnedMesh);
      expect(mesh).not.toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.geometry.getAttribute('color')).toBeDefined();
      expect(mesh.geometry.getAttribute('position')!.count).toBeGreaterThan(300);
      mesh.geometry.computeBoundingBox();
      const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
      expect(Math.max(size.x, size.y, size.z)).toBeGreaterThan(0.35);
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.vertexColors).toBe(true);
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeGreaterThan(0);
      expect(material.opacity).toBeLessThan(1);
      expect(material.depthWrite).toBe(false);
    }
  });

  it('uses resources that disposeObjectTree can release exactly once', () => {
    expectTreeDisposable(createFirstPersonGloves().root);
  });

  it('animates deterministically and moves only the punching glove forward', () => {
    const gloves = createFirstPersonGloves();
    const input = { guard: 1, leftPunch: 0, rightPunch: 0 };
    gloves.animate(1.25, input);
    const initial = snapshotPose(gloves.root);
    gloves.animate(1.25, input);
    expect(snapshotPose(gloves.root)).toEqual(initial);

    const left = named(gloves.root, 'first-person-left-glove');
    const right = named(gloves.root, 'first-person-right-glove');
    const leftStart = left.position.clone();
    const rightStart = right.position.clone();
    gloves.animate(1.25, { ...input, leftPunch: 1 });
    expect(left.position.z).toBeLessThan(leftStart.z - 0.3);
    expect(left.position.distanceTo(leftStart)).toBeGreaterThan(0.3);
    expect(right.position.distanceTo(rightStart)).toBe(0);
  });

  it('changes pose when guard or punch inputs change', () => {
    const gloves = createFirstPersonGloves();
    gloves.animate(0.8, { guard: 0, leftPunch: 0, rightPunch: 0 });
    const relaxed = snapshotPose(gloves.root);
    gloves.animate(0.8, { guard: 1, leftPunch: 0.5, rightPunch: 0 });
    const guardedPunch = snapshotPose(gloves.root);
    expect(poseDifference(relaxed, guardedPunch)).toBeGreaterThan(0.5);
  });

  it('uses the explicit time for idle glove motion', () => {
    const gloves = createFirstPersonGloves();
    const input = { guard: 0.65, leftPunch: 0, rightPunch: 0 };
    gloves.animate(0.2, input);
    const early = snapshotPose(gloves.root);
    gloves.animate(0.85, input);
    const late = snapshotPose(gloves.root);
    expect(poseDifference(early, late)).toBeGreaterThan(0.01);
  });
});

describe('first-person gloves framing', () => {
  it('leaves the opponent visible between and above the resting fists', () => {
    const gloves = createFirstPersonGloves();
    gloves.animate(0, { guard: 0.35 });
    const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 80);
    gloves.root.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    for (const mesh of meshesIn(gloves.root)) {
      const position = mesh.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index += 1) {
        const point = new THREE.Vector3()
          .fromBufferAttribute(position, index)
          .applyMatrix4(mesh.matrixWorld)
          .project(camera);
        expect(point.y).toBeLessThan(-0.3);
        expect(Math.abs(point.x)).toBeGreaterThan(0.2);
      }
    }
    disposeObjectTree(gloves.root);
  });
});
