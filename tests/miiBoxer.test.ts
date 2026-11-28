import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createMiiBoxer,
  type MiiBoxer,
  type MiiBoxerFootwork,
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

const FRAME_S = 1 / 60;

function animateFrames(boxer: MiiBoxer, startS: number, frames: number, footwork?: MiiBoxerFootwork): void {
  for (let frame = 1; frame <= frames; frame += 1) boxer.animate(startS + frame * FRAME_S, footwork);
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
    expect(meshes).toHaveLength(10);
    expect(new Set(meshes.map((mesh) => mesh.material)).size).toBe(2);
    for (const mesh of meshes) {
      expect(mesh).not.toBeInstanceOf(THREE.SkinnedMesh);
      expect(mesh).not.toBeInstanceOf(THREE.InstancedMesh);
      if (mesh.name === 'mii-face-patch') {
        expect(mesh.visible).toBe(false);
        continue;
      }
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
      ready: 0.5,
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
    const input = { speed01: 1, forward: 1, strafe: 1 };
    const boxer = createMiiBoxer();
    const still = createMiiBoxer();
    boxer.animate(0);
    still.animate(0);
    animateFrames(boxer, 0, 30, input);
    animateFrames(still, 0, 30);
    expect(poseDifference(snapshotPose(boxer.root), snapshotPose(still.root))).toBeGreaterThan(0.05);

    // The stride fades with elapsed time; once faded it matches a boxer that never moved.
    animateFrames(boxer, 0.5, 90);
    animateFrames(still, 0.5, 90);
    expect(snapshotPose(boxer.root)).toEqual(snapshotPose(still.root));
  });

  it('ramps the stride in instead of applying full speed in the first frame', () => {
    const input = { speed01: 1, forward: 1, strafe: 0 };
    const boxer = createMiiBoxer();
    const still = createMiiBoxer();
    boxer.animate(0);
    still.animate(0);
    const hipDifference = () =>
      Math.abs(named(boxer.root, 'mii-boxer-left-hip').rotation.x - named(still.root, 'mii-boxer-left-hip').rotation.x);

    boxer.animate(FRAME_S, input);
    still.animate(FRAME_S);
    const firstFrame = hipDifference();
    animateFrames(boxer, FRAME_S, 29, input);
    animateFrames(still, FRAME_S, 29);

    expect(firstFrame).toBeGreaterThan(0.001);
    expect(firstFrame).toBeLessThan(0.03);
    expect(hipDifference()).toBeGreaterThan(0.1);
  });

  it('smooths a footwork direction reversal through center', () => {
    const boxer = createMiiBoxer();
    const still = createMiiBoxer();
    boxer.animate(0);
    still.animate(0);
    animateFrames(boxer, 0, 30, { speed01: 1, forward: 1, strafe: 0 });
    animateFrames(still, 0, 30);
    const pitchDifference = () =>
      named(boxer.root, 'mii-boxer-body').rotation.x - named(still.root, 'mii-boxer-body').rotation.x;
    const forwardPitch = pitchDifference();

    boxer.animate(0.5 + FRAME_S, { speed01: 1, forward: -1, strafe: 0 });
    still.animate(0.5 + FRAME_S);
    expect(pitchDifference()).toBeGreaterThan(0);
    expect(pitchDifference()).toBeLessThan(forwardPitch);

    animateFrames(boxer, 0.5 + FRAME_S, 18, { speed01: 1, forward: -1, strafe: 0 });
    animateFrames(still, 0.5 + FRAME_S, 18);
    expect(pitchDifference()).toBeLessThan(-0.02);
  });

  it('damps the footwork instead of snapping the legs when the boxer stops', () => {
    const run = (stopped: number) => {
      const boxer = createMiiBoxer();
      const still = createMiiBoxer();
      boxer.animate(0);
      still.animate(0);
      animateFrames(boxer, 0, 30, { speed01: 1, forward: 1, strafe: 0 });
      animateFrames(still, 0, 30);
      boxer.animate(0.5 + stopped);
      still.animate(0.5 + stopped);
      return {
        pose: snapshotPose(boxer.root),
        leftover: Math.abs(
          named(boxer.root, 'mii-boxer-body').rotation.x - named(still.root, 'mii-boxer-body').rotation.x,
        ),
      };
    };
    expect(run(FRAME_S).leftover).toBeGreaterThan(0.02);
    expect(run(1).leftover).toBe(0);
    expect(run(FRAME_S).pose).toEqual(run(FRAME_S).pose);
  });

  it('keeps pose and momentum continuous when a transition is interrupted', () => {
    const boxer = createMiiBoxer();
    boxer.animate(0);
    boxer.setState('guard');
    animateFrames(boxer, 0, 4);
    const interruptedAt = 4 * FRAME_S;
    const before = snapshotPose(boxer.root);
    const pitchBefore = named(boxer.root, 'mii-boxer-body').rotation.x;

    boxer.setState('hit');
    boxer.animate(interruptedAt);
    expect(snapshotPose(boxer.root)).toEqual(before);

    // A millisecond is too little time for the hit retarget to erase the inbound guard momentum.
    boxer.animate(interruptedAt + 0.001);
    expect(named(boxer.root, 'mii-boxer-body').rotation.x).toBeLessThan(pitchBefore);
  });

  it('never moves at the instant of a retarget through the windup-punch-recover-hit chain', () => {
    const runChain = () => {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      boxer.setState('guard');
      // Each retarget lands mid-motion: five frames into the previous, still unsettled state.
      const retargets = new Map<number, MiiBoxerState>([
        [6, 'windup'],
        [11, 'punch'],
        [16, 'recover'],
        [21, 'hit'],
      ]);
      for (let frame = 1; frame <= 30; frame += 1) {
        const time = frame * FRAME_S;
        boxer.animate(time);
        const next = retargets.get(frame);
        if (next) {
          const atBoundary = snapshotPose(boxer.root);
          boxer.setState(next);
          boxer.animate(time);
          // Zero time elapsed across the retarget, so a continuous integration bit-repeats the pose.
          expect(snapshotPose(boxer.root)).toEqual(atBoundary);
        }
      }
      return snapshotPose(boxer.root);
    };
    expect(runChain()).toEqual(runChain());
  });

  it('carries velocity across the windup-punch retarget instead of restarting from rest', () => {
    const eps = 0.001;
    const woundUpToBoundary = () => {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      boxer.setState('guard');
      animateFrames(boxer, 0, 12);
      boxer.setState('windup');
      animateFrames(boxer, 0.2, 6);
      return boxer;
    };
    const boundary = 0.3;
    const travel = (boxer: MiiBoxer) => {
      const at = snapshotPose(boxer.root);
      boxer.animate(boundary + eps);
      return poseDifference(at, snapshotPose(boxer.root));
    };

    // Both boxers reach the boundary instant through the identical sequence, so they are bit-equal
    // there; one keeps winding up, the other retargets to punch. The retargeted boxer's velocity
    // is the inbound velocity, damped a little by the spring over the millisecond — not erased.
    const uninterrupted = woundUpToBoundary();
    const inbound = travel(uninterrupted);
    const retargeted = woundUpToBoundary();
    retargeted.setState('punch');
    const outbound = travel(retargeted);
    expect(inbound).toBeGreaterThan(0.0005);
    expect(outbound / inbound).toBeGreaterThan(0.5);
  });

  it('follows a punch through and damps the return without a hold plateau', () => {
    const boxer = createMiiBoxer();
    boxer.animate(0);
    boxer.setState('windup');
    animateFrames(boxer, 0, 30);
    const windupZ = glovePoint(boxer, 'right').z;
    boxer.setState('punch');
    const travel: number[] = [];
    for (let frame = 1; frame <= 30; frame += 1) {
      boxer.animate(0.5 + frame * FRAME_S);
      travel.push(glovePoint(boxer, 'right').z);
    }

    expect(Math.abs(travel[0]! - windupZ)).toBeLessThan(0.03);

    // More negative is farther forward. The target extension peaks at 0.16 s and spring
    // follow-through crests the glove around 0.2 s — just before the nominal contact instant
    // used by the game about 0.22 s after entering `punch`. Before the crest the glove moves
    // strictly forward, after it strictly back — a single continuous peak, never a flat hold.
    const crest = travel.indexOf(Math.min(...travel));
    expect(crest).toBeGreaterThanOrEqual(10);
    expect(crest).toBeLessThanOrEqual(12);
    for (let frame = 0; frame < crest; frame += 1) expect(travel[frame + 1]!).toBeLessThan(travel[frame]!);
    for (let frame = crest; frame < 18; frame += 1) expect(travel[frame + 1]!).toBeGreaterThan(travel[frame]!);
    // Frame 13 is the nominal contact instant, about 0.22 s after the game enters `punch`.
    expect(travel[12]! - travel[crest]!).toBeLessThan(0.02);

    // A hold plateau would park the glove for several frames; here only the crest straddle moves
    // less than a tenth of a millimetre, and the return is essentially at rest well before 0.5 s.
    let parked = 0;
    for (let frame = 1; frame < 20; frame += 1) {
      if (Math.abs(travel[frame]! - travel[frame - 1]!) < 1e-4) parked += 1;
    }
    expect(parked).toBeLessThanOrEqual(1);
    expect(Math.abs(travel[29]! - travel[28]!)).toBeLessThan(0.001);
    expect(travel[29]! - travel[crest]!).toBeGreaterThan(0.2);
  });

  it('mirrors the windup arms for the left hand', () => {
    const pose = (hand: 'left' | 'right') => {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      boxer.setState('windup', hand);
      boxer.animate(0.5);
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

  it('mirrors the punch arms for the left hand near full extension', () => {
    const pose = (hand: 'left' | 'right') => {
      const boxer = createMiiBoxer();
      boxer.animate(0);
      boxer.setState('punch', hand);
      animateFrames(boxer, 0, 12); // the crest of the extension
      return boxer;
    };
    const right = pose('right');
    const left = pose('left');
    // Mirroring is approximate to within a couple of degrees: the punch target starts from the
    // captured entry pose, and neither it nor the idle stance it grows from is mirror symmetric,
    // so the springs track slightly different paths for the two hands. A broken mirror would be
    // off by radians, not hundredths.
    for (const joint of ['shoulder', 'elbow'] as const) {
      const thrown = named(right.root, `mii-boxer-right-${joint}`).rotation;
      const mirrored = named(left.root, `mii-boxer-left-${joint}`).rotation;
      expect(mirrored.x).toBeCloseTo(thrown.x, 1);
      expect(mirrored.y).toBeCloseTo(-thrown.y, 1);
      expect(mirrored.z).toBeCloseTo(-thrown.z, 1);
    }
    expect(named(left.root, 'mii-boxer-body').rotation.y).toBeCloseTo(
      -named(right.root, 'mii-boxer-body').rotation.y,
      1,
    );
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite animation time %s',
    (time) => {
      const boxer = createMiiBoxer();
      expect(() => boxer.animate(time)).toThrow(TypeError);
    },
  );
});
