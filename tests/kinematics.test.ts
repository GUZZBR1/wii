import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '@wii/spatial-core';
import { AutoCalibrator } from '../src/cv/autoCalibrator';
import { Calibrator } from '../src/cv/calibrator';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { landmarkConfidence } from '../src/kinematics/math';
import { LaneLeanDetector, torsoLeanDeltaRad } from '../src/kinematics/postureSignals';
import { hasMeaningfulLateralComponent, SwingDetector } from '../src/kinematics/swingDetector';
import { calibration, pose, poseWithHipBounce, poseWithWorldShoulderWidth, poseWithWorldTorso, rollUpperBody, rotateWorldYaw } from './fixtures/syntheticPose';
import { cadenceHarness } from './fixtures/torsoHarness';

/** Feeds the pipeline with torso bounce at 150 spm between `from` and `until` — the run-in-place signal. */
function driveBounce(pipeline: ActionPipeline, profile: ReturnType<typeof calibration>, from: number, until: number, startAt = 0) {
  const hz = 150 / 60;
  for (let time = startAt; time <= until; time += 33) {
    const units = time >= from ? 0.04 * Math.sin((2 * Math.PI * hz * (time - from)) / 1000) : 0;
    pipeline.update(poseWithHipBounce(time, units * 0.4), profile);
  }
}

function withWorldConfidence(snapshot: ReturnType<typeof pose>, index: number, visibility: number, presence: number) {
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point, pointIndex) => pointIndex === index ? { ...point, visibility, presence } : point),
  };
}

describe('1-Euro filter', () => {
  it('reduces static jitter and follows a fast movement', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
    const noisy = [0, 0.02, -0.02, 0.01, -0.01, 0];
    const outputs = noisy.map((value, i) => filter.filter(value, i * 33));
    expect(Math.abs(outputs.at(-1)!)).toBeLessThan(0.02);
    const moved = filter.filter(1, 200);
    expect(moved).toBeGreaterThan(outputs.at(-1)!);
  });
});

describe('landmark confidence', () => {
  it('returns zero for no visible points and falls back to presence when visibility is omitted', () => {
    expect(landmarkConfidence()).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, presence: 0.8 })).toBe(0.8);
  });

  it('returns zero for non-finite confidence instead of propagating it', () => {
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.NaN })).toBe(0);
    // NaN masks a finite presence through Math.min; positive infinity masks it only when both are infinite.
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.NaN, presence: 0.9 })).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.POSITIVE_INFINITY, presence: 0.9 })).toBe(0.9);
  });
});

describe('cadence tracker', () => {
  it('counts steps from torso bounce and reports a bounded arcade speed', () => {
    const { feed } = cadenceHarness();
    const results = [];
    for (let time = 0; time <= 4000; time += 33) {
      const active = time >= 200 && time <= 3000;
      const units = active ? 0.04 * Math.sin((2 * Math.PI * 2.5 * (time - 200)) / 1000) : 0;
      results.push({ time, ...feed(poseWithHipBounce(time, units * 0.4)) });
    }
    const steps = results.filter((r) => r.step);
    expect(steps.length).toBeGreaterThan(3);
    const active = results.filter((r) => r.time > 1500 && r.time <= 3000);
    expect(active.every((r) => r.speed01 > 0)).toBe(true);
    expect(Math.max(...results.map((r) => r.speed01))).toBeLessThanOrEqual(1);
    expect(results.at(-1)!.cadenceSpm).toBe(0);
  });

  it('drops the previous cadence window after a long pause', () => {
    const { feed } = cadenceHarness();
    const hz = 2.5;
    const results = [];
    for (let time = 0; time <= 6000; time += 33) {
      const bouncing = (time >= 200 && time <= 2000) || (time >= 4600 && time <= 4700);
      const units = bouncing ? 0.04 * Math.sin((2 * Math.PI * hz * time) / 1000) : 0;
      results.push({ time, ...feed(poseWithHipBounce(time, units * 0.4)) });
    }
    // Steady bouncing establishes a cadence...
    expect(results.filter((r) => r.time > 1200 && r.time <= 2000).every((r) => r.speed01 > 0)).toBe(true);
    // ...it stops during the pause (within the 1.6-period stop deadline), and the brief
    // pulse afterwards cannot resurrect it.
    expect(results.filter((r) => r.time > 2800).every((r) => r.cadenceSpm === 0)).toBe(true);
  });
});

describe('swing detector', () => {
  it('uses a bounded lateral component for stroke candidates', () => {
    expect(hasMeaningfulLateralComponent(10, 2.4)).toBe(false);
    expect(hasMeaningfulLateralComponent(10, 2.5)).toBe(true);
    expect(hasMeaningfulLateralComponent(10, 2.6)).toBe(true);
  });

  it('emits one swing and ignores the fast return until the ready pose is held', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    expect(detector.update(pose(0), profile)).toBeUndefined();
    expect(detector.update(pose(100, { wristLateral: -0.3 }), profile)).toMatchObject({ kind: 'onset' });
    expect(detector.update(pose(150, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
    expect(detector.update(pose(200, { wristLateral: 0 }), profile)).toBeUndefined();
    expect(detector.update(pose(400, { wristLateral: 0 }), profile)).toBeUndefined();
  });

  it.each(['wristVertical', 'wristDepth'] as const)('does not confirm a swing from %s motion', (axis) => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const signals = [detector.update(pose(0), profile)];
    for (let time = 100; time <= 500; time += 40) {
      signals.push(detector.update(pose(time, { [axis]: 0.3, wristLateral: 0.02 }), profile));
    }
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('keeps a lateral peak when the wrist finishes upward', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const frames = [pose(0), pose(33), pose(66, { wristLateral: -0.11 })];
    for (let time = 99; time <= 495; time += 33) frames.push(pose(time, { wristLateral: -0.12, wristVertical: 0.3 }));
    const signals = frames.map((frame) => detector.update(frame, profile)).filter((output) => output?.kind === 'confirmed');
    expect(signals).toMatchObject([{ side: 'forehand' }]);
  });

  it('requires a new neutral dwell after each swing', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    detector.reset();
    for (let time = 0; time <= 240; time += 40) detector.update(pose(time), profile);
    detector.update(pose(270, { wristLateral: -0.2 }), profile);
    expect(detector.update(pose(310, { wristLateral: 0.2 }), profile)).toBeDefined();
    detector.update(pose(1500), profile); // a single neutral frame
    detector.update(pose(1540, { wristLateral: -0.2 }), profile);
    expect(detector.update(pose(1580, { wristLateral: 0.2 }), profile)).toBeUndefined();
  });

  it('drops a pending swing after a tracking gap', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    detector.update(pose(0), profile);
    detector.update(pose(99, { wristLateral: -0.3 }), profile);
    expect(detector.update(pose(3099, { wristLateral: -0.3 }), profile)).toBeUndefined();
  });

  it('classifies the peak stroke direction, robust to body yaw', () => {
    const classify = (hand: 'left' | 'right', displacement: number, rotate = false) => {
      const detector = new SwingDetector(hand);
      const profile = calibration();
      let signal: ReturnType<SwingDetector['update']>;
      for (const time of [0, 20, 40, 60, 80, 110]) {
        const progress = time <= 80 ? time / 80 : 1 - (time - 80) / 30;
        const snapshot = pose(time, { [hand === 'right' ? 'wristLateral' : 'leftWristLateral']: displacement * progress });
        const current = detector.update(rotate ? rotateWorldYaw(snapshot, 0.9) : snapshot, profile);
        if (current?.kind === 'confirmed') signal = current;
      }
      return signal;
    };
    expect(classify('right', 0.2)).toMatchObject({ side: 'backhand' });
    expect(classify('right', -0.2)).toMatchObject({ side: 'forehand' });
    expect(classify('left', 0.2)).toMatchObject({ side: 'forehand' });
    expect(classify('right', -0.2, true)).toMatchObject({ side: 'forehand' });
    expect(classify('left', 0.2, true)).toMatchObject({ side: 'forehand' });
  });

  it('does not infer a swing from frame-to-frame shoulder-width variation', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const frames = [0.4, 0.6, 0.4, 0.6, 0.4].map((width, index) => poseWithWorldShoulderWidth(index * 33, width));
    const signals = frames.map((frame) => detector.update(frame, profile)).filter(Boolean);
    expect(signals).toHaveLength(0);
  });

  it('waits for a neutral ready pose before rearming after a confirmed tracking loss', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    detector.reset();
    for (let time = 0; time <= 240; time += 40) expect(detector.update(pose(time), profile)).toBeUndefined();
    expect(detector.update(pose(270, { wristLateral: -0.2 }), profile)).toMatchObject({ kind: 'onset' });
    expect(detector.update(pose(310, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
  });

  it('re-arms without a wrist reference after low speed is sustained', () => {
    const detector = new SwingDetector('right');
    const base = calibration();
    const profile = { ...base, world: { ...base.world, readyWristLocal: undefined } };
    detector.update(pose(0), profile);
    detector.update(pose(100, { wristLateral: -0.3 }), profile);
    expect(detector.update(pose(150, { wristLateral: 0.2 }), profile)).toMatchObject({ kind: 'confirmed' });
    for (let time = 200; time <= 700; time += 50) detector.update(pose(time), profile);

    expect(detector.update(pose(750, { wristLateral: -0.3 }), profile)).toMatchObject({ kind: 'onset' });
    expect(detector.update(pose(800, { wristLateral: 0.2 }), profile)).toMatchObject({ kind: 'confirmed' });
  });

  it('does not count a tracking gap as velocity-only re-arm dwell', () => {
    const detector = new SwingDetector('right');
    const base = calibration();
    const profile = { ...base, world: { ...base.world, readyWristLocal: undefined } };
    detector.update(pose(0), profile);
    detector.update(pose(100, { wristLateral: -0.3 }), profile);
    detector.update(pose(150, { wristLateral: 0.2 }), profile);
    for (let time = 200; time <= 600; time += 50) detector.update(pose(time), profile);
    detector.update(pose(900), profile); // resumes after a 300 ms hole: not observed rest

    expect(detector.update(pose(950, { wristLateral: -0.3 }), profile)).toBeUndefined();
  });
});

describe('world-space posture calibration', () => {
  it('stores the leg-derived vertical and the habitual lean baseline', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { leanRad: 0.2 }));
    const world = calibrator.finish()!.world;
    expect(world.leanUp0.x).toBeCloseTo(0, 2);
    expect(world.leanUp0.y).toBeCloseTo(-1, 2);
    expect(world.leanUp0.z).toBeCloseTo(0, 2);
    expect(world.torsoLeanRad0).toBeCloseTo(0.2, 2);
  });

  it('completes with knees and ankles invisible the whole time — leanUp0 comes from the trunk', () => {
    // Track framing: the camera only sees head, shoulders and hips. Calibration must still
    // complete, and the lean reference falls back to the trunk direction — tilted together
    // with the trunk lean, which is exactly what measuring lean as a delta absorbs.
    const noLegs = (time: number) => {
      const snapshot = pose(time, { leanRad: 0.2, hiddenLandmarks: [25, 26, 27, 28] });
      return {
        ...snapshot,
        worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
      };
    };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(noLegs(time));
    const profile = calibrator.finish();
    expect(profile).not.toBeNull();
    expect(profile!.world.leanUp0).toBeDefined();
    // Trunk-derived: the reference leans with the trunk instead of pointing straight up.
    expect(Math.abs(profile!.world.leanUp0.x)).toBeGreaterThan(0.05);
  });

  it('prefers the leg vertical over the trunk direction when the stance is verified', () => {
    // Same trunk lean as the trunk-fallback test, but with legs visible and straight:
    // the reference must come from the legs — straight up, not tilted with the trunk.
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { leanRad: 0.2 }));
    const world = calibrator.finish()!.world;
    expect(Math.abs(world.leanUp0.x)).toBeLessThan(0.02);
    expect(world.leanUp0.y).toBeCloseTo(-1, 2);
  });

  it('falls back to the trunk vertical when straight-leg coverage drops below 65% of all frames', () => {
    const noAnkles = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time, { leanRad: 0.2 }), 27, 0, 0), 28, 0, 0,
    );
    const calibrateWithGaps = (hideAnkles: (frame: number) => boolean) => {
      const calibrator = new Calibrator();
      calibrator.start(0);
      for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
        calibrator.add(hideAnkles(frame) ? noAnkles(time) : pose(time, { leanRad: 0.2 }));
      }
      return calibrator.finish()!.world;
    };
    // Mostly visible legs: the leg vertical wins — upright reference.
    expect(Math.abs(calibrateWithGaps((frame) => frame % 4 === 0).leanUp0.x)).toBeLessThan(0.02);
    // Legs hidden half the time: coverage insufficient — the trunk direction takes over.
    expect(Math.abs(calibrateWithGaps((frame) => frame % 2 === 0).leanUp0.x)).toBeGreaterThan(0.05);
  });

  it('omits readyWristLocal when wrist coverage is below 65% but keeps the rest of the profile', () => {
    const noWrists = (time: number) => {
      const one = withWorldConfidence(pose(time), 15, 0, 0);
      return withWorldConfidence(one, 16, 0, 0);
    };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      calibrator.add(frame % 2 === 0 ? noWrists(time) : pose(time));
    }
    const profile = calibrator.finish()!;
    expect(profile).not.toBeNull();
    expect(profile.world.readyWristLocal).toBeUndefined();
    expect(profile.world.leanUp0).toBeDefined();
  });

  it('does not publish a non-finite wrist reference', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) {
      const snapshot = pose(time);
      const worldLandmarks = [...snapshot.worldLandmarks];
      worldLandmarks[15] = { ...worldLandmarks[15]!, x: Number.NaN };
      calibrator.add({ ...snapshot, worldLandmarks });
    }

    const profile = calibrator.finish();
    expect(profile).not.toBeNull();
    expect(profile?.world.readyWristLocal?.left).toBeUndefined();
    expect(profile?.world.readyWristLocal?.right).toBeDefined();
    expect(Number.isFinite(profile?.world.shoulderWidth)).toBe(true);
  });

  it.each(['left', 'right'] as const)('calibrates the %s wrist reference independently', (hand) => {
    const missing = hand === 'left' ? 16 : 15;
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(withWorldConfidence(pose(time), missing, 0, 0));

    const profile = calibrator.finish();
    expect(profile).not.toBeNull();
    expect(profile?.world.readyWristLocal?.[hand]).toBeDefined();
    expect(profile?.world.readyWristLocal?.[hand === 'left' ? 'right' : 'left']).toBeUndefined();
  });

  it('keeps readyWristLocal when wrist coverage suffices even if the legs are never verified', () => {
    // Wrists visible throughout, ankles hidden throughout: tennis framing without leg
    // verification — swings must still get their reference while the lean falls back.
    const noAnkles = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time), 27, 0, 0), 28, 0, 0,
    );
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(noAnkles(time));
    const profile = calibrator.finish()!;
    expect(profile.world.readyWristLocal).toBeDefined();
    expect(profile.world.leanUp0).toBeDefined();
  });

  it('rejects calibration when the torso core stays below the confidence gate', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { hiddenLandmarks: [11, 12, 23, 24] }));
    expect(calibrator.finish()).toBeNull();
  });

  it('rejects frames that would fail the body tracking gate — lost frames never count as valid', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    // The body gate marks a frame degraded/lost when image landmarks [11,12,23,24] drop
    // below 0.55. Finish() must agree — its confidence set has to stay a superset of the
    // gate's, otherwise tolerated bad frames would enter the medians as valid samples.
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { hiddenLandmarks: [23, 24] }));
    expect(calibrator.finish()).toBeNull();
  });

  it('rejects calibration when confidence is NaN instead of counting those frames as valid', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    // `< 0.55` rejection gates never fire on NaN — without the non-finite floor these frames
    // passed every gate and poisoned the medians (medianConfidence came out NaN, ratio 1).
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { confidence: Number.NaN }));
    expect(calibrator.finish()).toBeNull();
  });

  it('counts degraded frames in calibration coverage instead of hiding them from the ratio', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      const invalid = frame % 2 === 1;
      const snapshot = pose(time, invalid ? { hiddenLandmarks: [23, 24] } : {});
      if (invalid) snapshot.trackingState = 'degraded';
      calibrator.add(snapshot);
    }
    expect(calibrator.finish()).toBeNull();
  });

  it('emits no image-space calibration block — jump and cadence are self-referencing now', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time));
    const profile = calibrator.finish()!;
    expect(profile.version).toBe(3);
    expect('image' in profile).toBe(false);
  });

  it('uses world torso geometry for lane lean and emits one direction while the pose is held', () => {
    const detector = new LaneLeanDetector();
    const profile = calibration();
    const leanPose = pose(99, { leanRad: 0.24 });
    expect(torsoLeanDeltaRad(leanPose, profile)).toBeCloseTo(0.24, 2);
    expect(torsoLeanDeltaRad(rotateWorldYaw(leanPose, 0.9), profile)).toBeCloseTo(0.24, 2);
    const signals = [0, 33, 66, 99, 132, 165, 198].map((time) => detector.update(
      pose(time, { leanRad: time < 99 ? 0 : 0.24 }), profile,
    )).filter(Boolean);
    expect(signals).toEqual(['right']);
  });

  it.each([
    [0.3, 0, 'right'], [-0.3, 0, 'left'], [0.3, 0.9, 'right'], [-0.3, 0.9, 'left'],
  ] as const)('measures a rigid trunk roll of %s rad at yaw %s', (roll, yaw, direction) => {
    const frame = (time: number, radians: number) => rotateWorldYaw(rollUpperBody(pose(time), radians), yaw);
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(frame(time, time % 200 === 0 ? 0.01 : -0.01));
    const profile = calibrator.finish()!;
    expect(torsoLeanDeltaRad(frame(0, roll), profile)).toBeCloseTo(roll, 1);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 12 }, (_, i) => detector.update(frame(i * 33, i < 4 ? 0 : roll), profile));
    expect(signals.filter(Boolean)).toEqual([direction]);
  });

  it('does not read a body turn as lean after calibrating with a forward-tilted trunk', () => {
    // Level camera, trunk calibrated 20° forward: the slanted trunk would lean the reference,
    // but the stored vertical comes from the legs, which point along gravity.
    const tilt = (20 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const down = { x: 0, y: 1, z: 0 };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(poseWithWorldTorso(time, { up, down }));
    const profile = calibrator.finish()!;
    const turned = rotateWorldYaw(poseWithWorldTorso(0, { up, down }), Math.PI / 4);
    expect(torsoLeanDeltaRad(turned, profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      rotateWorldYaw(poseWithWorldTorso(i * 33, { up, down }), (i * Math.PI) / 20), profile,
    ));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('does not read an upright body turn as lean when the camera is tilted', () => {
    // Webcam pitched 25°: the calibrated trunk-up is tilted in camera space.
    const tilt = (25 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const profile = { ...calibration(), world: { ...calibration().world, leanUp0: up } };
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { up }), profile)).toBeCloseTo(0, 3);
    // A 45° body turn measured ≈ −0.30 rad against the camera's horizontal plane.
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { up, yawRad: Math.PI / 4 }), profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      poseWithWorldTorso(i * 33, { up, yawRad: (i * Math.PI) / 20 }), profile,
    ));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it.each([[0.24, 'right'], [-0.24, 'left']] as const)('measures a real %s rad lean at 45° yaw with a tilted camera', (leanRad, direction) => {
    const tilt = (25 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const profile = { ...calibration(), world: { ...calibration().world, leanUp0: up } };
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { up, yawRad: Math.PI / 4, leanRad }), profile)).toBeCloseTo(leanRad, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      poseWithWorldTorso(i * 33, { up, yawRad: Math.PI / 4, leanRad: i < 4 ? 0 : leanRad }), profile,
    ));
    expect(signals.filter(Boolean)).toEqual([direction]);
  });

  it('measures a whole-body lean where the thighs rotate with the trunk', () => {
    // Ankle-pivot lean: trunk and thighs stay parallel, so the fixed reference must not follow.
    const down = { x: Math.sin(0.24), y: Math.cos(0.24), z: 0 };
    const profile = calibration();
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { leanRad: 0.24, down }), profile)).toBeCloseTo(0.24, 2);
  });

  it('keeps the neutral baseline when the knees leave the camera frame', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { leanRad: 0.2 }));
    const profile = calibrator.finish()!;
    const hiddenKnees = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time, { leanRad: 0.2 }), 25, 0, 0), 26, 0, 0,
    );
    expect(torsoLeanDeltaRad(hiddenKnees(0), profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 8 }, (_, i) => detector.update(hiddenKnees(i * 33), profile));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('keeps lane lean working with a trunk-derived reference when the legs were never visible', () => {
    // The trunk-derived reference absorbs the habitual posture at calibration; a lean AWAY
    // from neutral must still read as a delta and emit lane changes.
    const noLegs = (time: number, leanRad = 0) => {
      const snapshot = pose(time, { leanRad, hiddenLandmarks: [25, 26, 27, 28] });
      return {
        ...snapshot,
        worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
      };
    };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(noLegs(time));
    const profile = calibrator.finish()!;
    // Neutral reads zero...
    expect(torsoLeanDeltaRad(noLegs(0), profile)).toBeCloseTo(0, 1);
    // ...and a real lean reads as a delta of the right size.
    expect(torsoLeanDeltaRad(noLegs(0, 0.24), profile)).toBeCloseTo(0.24, 1);
    const detector = new LaneLeanDetector();
    const signals = [0, 33, 66, 99, 132, 165, 198].map((time) => detector.update(
      noLegs(time, time < 99 ? 0 : 0.24), profile,
    )).filter(Boolean);
    expect(signals).toEqual(['right']);
  });

  it('waits for neutral posture before emitting a lane change after tracking reset', () => {
    const detector = new LaneLeanDetector();
    const profile = calibration();
    detector.reset();
    expect(detector.update(pose(0, { leanRad: 0.24 }), profile)).toBeUndefined();
    for (let time = 33; time <= 500; time += 33) expect(detector.update(pose(time), profile)).toBeUndefined();
    const signals = [533, 566, 599, 632, 665].map((time) => detector.update(pose(time, { leanRad: 0.24 }), profile)).filter(Boolean);
    expect(signals).toEqual(['right']);
  });
});

describe('action pipeline tracking gate', () => {
  it('keeps all discrete action signals quiet for a stationary jitter fixture', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = Array.from({ length: 90 }, (_, index) => {
      const jitter = index % 2 === 0 ? 0.015 : -0.015;
      return pipeline.update(pose(index * 33, { kneeLeft: jitter, kneeRight: -jitter, wristLateral: jitter / 10 }), profile).events;
    }).flat().filter((event) => event.type !== 'sprint');
    expect(events).toHaveLength(0);
  });

  it('does not emit sport actions while pose confidence is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const visible = [pose(0), pose(33), pose(66)];
    visible.forEach((frame) => { pipeline.update(frame, profile); });
    const lost = [pose(100, { confidence: 0.1 }), pose(133, { confidence: 0.1 }), pose(166, { confidence: 0.1 }), pose(199, { confidence: 0.1 })];
    expect(lost.flatMap((frame) => pipeline.update(frame, profile).events)).toHaveLength(0);
  });

  it('keeps upper-body swings available when knees are outside the camera frame', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hiddenKnees = { hiddenLandmarks: [25, 26] } as const;
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time, hiddenKnees), profile); });
    pipeline.update(pose(100, { ...hiddenKnees, wristLateral: -0.3 }), profile);
    const result = pipeline.update(pose(133, { ...hiddenKnees, wristLateral: 0.2 }), profile);
    expect(result.snapshot.trackingState).toBe('tracked');
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    expect(result.events.filter((event) => event.type === 'sprint').every((event) => event.speed01 === 0)).toBe(true);
  });

  it('preserves the step stream through a one-frame confidence dip', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * time) / 1000) * 0.4);
    for (let time = 0; time <= 1500; time += 33) pipeline.update(bounceAt(time), profile);
    const before = pipeline.update(bounceAt(1533), profile);
    expect(before.controls.trackingState).toBe('tracked');
    const degraded = pipeline.update(pose(1566, { confidence: 0.1 }), profile);
    expect(degraded.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'degraded' });
    expect(degraded.events.filter((event) => event.type === 'step')).toHaveLength(0);
    // The gate needs three consecutive good frames to leave 'degraded' — and no spurious
    // step fires out of the dip itself.
    const recovery = [1599, 1632, 1665].map((time) => pipeline.update(bounceAt(time), profile));
    expect(recovery.at(-1)!.controls.trackingState).toBe('tracked');
  });

  it('exposes neutral continuous sprint control as cadence tracking is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    const active = pipeline.update(poseWithHipBounce(1079, 0), profile);
    expect(active.controls.sprintSpeed01).toBeGreaterThan(0);
    const lost = [1110, 1143, 1176, 1209].map((time) => pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile)).at(-1)!;
    expect(lost.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' });
  });

  it.each([
    ['hidden hips', 'degraded'],
    ['reset', 'lost'],
  ] as const)('stops the sprint exactly once on %s', (cause, state) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    const after = [1112, 1145].flatMap((time) => {
      if (cause === 'reset') return pipeline.reset();
      return pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile).events;
    });
    expect(after.filter((event) => event.type === 'sprint')).toMatchObject([{ speed01: 0, cadenceSpm: 0, trackingState: state }]);
  });

  it('keeps cadence running when calibration is removed mid-stream', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) * 0.4);
    for (let time = 0; time <= 1046; time += 33) pipeline.update(bounceAt(time), profile);

    const frames = [1079, 1112, 1145].map((time) => pipeline.update(bounceAt(time)));
    expect(frames.every((frame) => frame.controls.trackingState === 'tracked')).toBe(true);
    expect(frames.at(-1)!.controls.sprintSpeed01).toBeGreaterThan(0);
    expect(frames.flatMap((frame) => frame.events).filter((event) => event.type === 'sprint' && event.speed01 === 0)).toHaveLength(0);
  });

  it('keeps the sprint going when the knees leave the camera frame', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const events = [];
    for (let time = 0; time <= 2500; time += 33) {
      const units = time >= 66 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) : 0;
      const snapshot = poseWithHipBounce(time, units * 0.4);
      // Knees and ankles are out of frame the whole time — irrelevant for torso-driven cadence.
      const hiddenLegs = {
        ...snapshot,
        landmarks: snapshot.landmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
      };
      events.push(...pipeline.update(hiddenLegs, profile).events);
    }
    const steps = events.filter((event) => event.type === 'step');
    expect(steps.length).toBeGreaterThan(3);
    expect(events.filter((event) => event.type === 'sprint').every((event) => event.trackingState === 'tracked')).toBe(true);
  });

  it('keeps a standstill measured on a tracked pose stamped as tracked', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    const still = [1600, 1633].flatMap((time) => pipeline.update(pose(time), profile).events);
    expect(still.filter((event) => event.type === 'sprint')).toMatchObject([
      { speed01: 0, cadenceSpm: 0, trackingState: 'tracked' },
      { speed01: 0, cadenceSpm: 0, trackingState: 'tracked' },
    ]);
  });

  it('keeps the swing arc across a brief wrist occlusion and reports the gate confidence', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(withWorldConfidence(pose(99, { wristLateral: -0.3 }), 11, 0.6, 0.6), profile);
    pipeline.update(withWorldConfidence(pose(132, { wristLateral: -0.3 }), 16, 0.1, 0.1), profile);
    pipeline.update(pose(165, { wristLateral: 0.2 }), profile);
    pipeline.update(pose(198, { wristLateral: 0.2 }), profile);
    const recovery = pipeline.update(pose(231, { wristLateral: 0.2 }), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(swing).toMatchObject({ type: 'swing', confidence: 0.6 });
    expect(swing?.timestampMs).toBe(231);
    expect(swing?.type === 'swing' ? swing.peakTimestampMs : undefined).toBe(99);
  });

  it('keeps cadence events while filtering a small periodic hip bounce out of jump events', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = [];
    for (let time = 0; time <= 3000; time += 33) {
      const units = time >= 200 ? 0.05 * Math.sin((2 * Math.PI * time) / 500) : 0;
      events.push(...pipeline.update(poseWithHipBounce(time, units * 0.4), profile).events);
    }
    // The hip bounce IS the running signal now — cadence comes from the same channel that
    // the jump detector must reject as a jump.
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(3);
    expect(events.filter((event) => event.type === 'jump')).toHaveLength(0);
  });

  it('uses peak-frame confidence even when confidence is lower at confirmation time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3 }), profile);
    pipeline.update(withWorldConfidence(pose(132, { wristLateral: -0.3 }), 16, 0.1, 0.1), profile);
    pipeline.update(pose(165, { wristLateral: 0.2 }), profile);
    pipeline.update(pose(198, { wristLateral: 0.2 }), profile);
    const recovery = pipeline.update(withWorldConfidence(pose(231, { wristLateral: 0.2 }), 11, 0.6, 0.6), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(swing).toMatchObject({ type: 'swing', confidence: 0.95, timestampMs: 231, peakTimestampMs: 99 });
  });

  it('uses landmark presence as well as visibility to gate a swing', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const lowPresence = (time: number, wristLateral = 0) => withWorldConfidence(pose(time, { wristLateral }), 11, 0.95, 0.4);
    [0, 33, 66].forEach((time) => { pipeline.update(lowPresence(time), profile); });
    pipeline.update(lowPresence(99, -0.3), profile);
    const result = pipeline.update(lowPresence(132, 0.2), profile);
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('allows a swing when only its feature landmarks are tracked, and labels that local gate', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const missingHips = (time: number, wristLateral = 0) => {
      const snapshot = pose(time, { wristLateral });
      snapshot.landmarks = snapshot.landmarks.map((point, index) => [23, 24].includes(index) ? { ...point, visibility: 0.1, presence: 0.1 } : point);
      return snapshot;
    };
    [0, 33, 66].forEach((time) => { pipeline.update(missingHips(time), profile); });
    pipeline.update(missingHips(99, -0.3), profile);
    const recovery = pipeline.update(missingHips(132, 0.2), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(recovery.snapshot.trackingState).toBe('lost');
    expect(swing).toMatchObject({ type: 'swing', trackingState: 'tracked' });
  });
});

describe('mão da raquete', () => {
  it.each(['wristLateral', 'leftWristLateral'] as const)('reconhece o golpe sem escolher a mão (%s)', (wrist) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [pose(0), pose(33), pose(66), pose(99), pose(132, { [wrist]: -0.3 }), pose(165, { [wrist]: 0.2 }), pose(198, { [wrist]: 0.2 })];
    const swings = frames.flatMap((frame) => pipeline.update(frame, profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('segura a confirmação enquanto a outra mão ainda voa e deixa o golpe mais forte vencer', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    // Weak right arc reverses and confirms fast; the left wrist starts a strong arc in the
    // same frame, so the right's confirmation is held instead of locking the left out.
    pipeline.update(pose(99, { wristLateral: -0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.15 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    pipeline.update(pose(165, { leftWristLateral: 0.35 }), profile);
    pipeline.update(pose(198, { leftWristLateral: 0.55 }), profile);
    const released = pipeline.update(pose(231, { leftWristLateral: 0.2 }), profile);
    const swings = released.events.filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ side: 'forehand' });
    expect(swings[0]!.type === 'swing' && swings[0]!.power01).toBeGreaterThan(0.5);
  });

  it('solta o golpe segurado quando a mão rival perde o rastreamento sem confirmar', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Left wrist vanishes: once its gate is lost the pending arc dies and the held swing emits.
    const swings = [165, 198, 231, 264]
      .flatMap((time) => pipeline.update(withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0), profile).events)
      .filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('desiste de esperar quando o rival fica degradado sem confirmar nem perder o rastreamento', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // 3 bad + 1 good keeps the rival gate forever degraded: its pending arc is never updated,
    // never confirmed and never reset — only the hold bound frees the waiting swing.
    const flapping = (time: number) => (Math.floor((time - 165) / 33) % 4 === 3
      ? pose(time, { wristLateral: 0.05 })
      : withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0));
    const frames = Array.from({ length: 15 }, (_, i) => 165 + i * 33);
    const swings = frames.flatMap((time) => pipeline.update(flapping(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('descarta a confirmação dentro do bloqueio em vez de deixá-la disputar depois', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3 }), profile);
    const first = pipeline.update(pose(132, { wristLateral: 0.2 }), profile);
    expect(first.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    // Back near the ready pose (|wristLateral| < 0.14 keeps the wrist within reach) the
    // right detector re-readies before its second arc.
    for (let time = 165; time <= 495; time += 33) pipeline.update(pose(time, { wristLateral: -0.05 }), profile);
    pipeline.update(pose(495, { wristLateral: -0.05, leftWristLateral: 0.5 }), profile);
    // Block runs to 532 ms: the dominant left arc confirms inside it and is discarded;
    // only the right's post-block confirmation may reach the game.
    const blocked = pipeline.update(pose(528, { wristLateral: 0.35, leftWristLateral: 0.15 }), profile);
    const released = pipeline.update(pose(561, { wristLateral: -0.05, leftWristLateral: 0.15 }), profile);
    const swings = [blocked, released].flatMap((result) => result.events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ type: 'swing', side: 'backhand', timestampMs: 561, peakTimestampMs: 528 });
  });

  it('descarta o golpe segurado quando o próprio pulso perde o rastreamento', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Both wrists vanish: the held swing's own basis is gone — it must be dropped, not released.
    const lost = (time: number) => withWorldConfidence(withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0), 16, 0, 0);
    const swings = [165, 198, 231, 264].flatMap((time) => pipeline.update(lost(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(0);
  });
});

describe('action pipeline (upper-body only)', () => {
  /** Full torso-core visibility, legs and wrists absent in BOTH spaces the whole time. */
  const torsoOnly = (time: number, hipYOffset = 0) => {
    const snapshot = poseWithHipBounce(time, hipYOffset);
    return {
      ...snapshot,
      landmarks: snapshot.landmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
    };
  };

  it('produces sprint and step events with legs and wrists absent the whole time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const events = [];
    for (let time = 0; time <= 3000; time += 33) {
      const units = time >= 200 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 200)) / 1000) : 0;
      events.push(...pipeline.update(torsoOnly(time, -units * 0.4), profile).events);
    }
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(3);
    expect(events.some((event) => event.type === 'sprint' && event.speed01 > 0)).toBe(true);
  });

  it('does not emit jumps for running bounce but does emit a mid-run jump, torso-only', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 2.8;
    // Same physics-coherent shape as the detector tests: crouch, quadratic powered rise
    // (velocity peaks at liftoff), simplified hold and landing.
    const jumpAt = (timeMs: number) => {
      const t = timeMs - 3000;
      if (t < 0) return 0;
      if (t < 250) return -0.1 * Math.sin((Math.PI * t) / 250) * 0.5 - (0.1 * t) / 500;
      if (t < 430) { const u = (t - 250) / 180; return -0.1 + 0.35 * u * u; }
      if (t < 700) return 0.25;
      if (t < 1000) return 0.25 * (1 - (t - 700) / 300);
      return 0;
    };
    const events = [];
    for (let time = 0; time <= 5000; time += 33) {
      // Quiet standing first (arms the jump detector), then bounce, then bounce+jump.
      const bouncing = time >= 1000;
      const units = (bouncing ? 0.05 * Math.sin((2 * Math.PI * hz * (time - 1000)) / 1000) : 0) + jumpAt(time);
      events.push(...pipeline.update(torsoOnly(time, -units * 0.4), profile).events);
    }
    const jumps = events.filter((event) => event.type === 'jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.timestampMs).toBeGreaterThan(3000);
    // No jump is emitted during the pure-bounce portion before 3000.
    expect(events.filter((event) => event.type === 'jump' && event.timestampMs < 3000)).toHaveLength(0);
  });

  it('keeps swings available without readyWristLocal; lanes, cadence and jump still work', () => {
    const pipeline = new ActionPipeline();
    const noWristProfile = {
      ...calibration(),
      world: { ...calibration().world, readyWristLocal: undefined },
    };
    const events = [];
    const hz = 150 / 60;
    for (let time = 0; time <= 2500; time += 33) {
      const units = time >= 200 && time <= 1500 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 200)) / 1000) : 0;
      // Big wrist arcs on top — swings remain available because their references are only
      // a re-arm fast path, not an onset prerequisite.
      const snapshot = torsoOnly(time, units * 0.4);
      const withWrist = {
        ...snapshot,
        worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index === 16 ? { ...point, x: -0.2 - (time % 2 === 0 ? -0.3 : 0.3), visibility: 0.95, presence: 0.95 } : point)),
      };
      events.push(...pipeline.update(withWrist, noWristProfile).events);
    }
    expect(events.filter((event) => event.type === 'swing').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(2);
  });
});

describe('calibração automática', () => {
  const run = (frame: (time: number) => ReturnType<typeof pose>) => {
    const auto = new AutoCalibrator();
    return Array.from({ length: 61 }, (_, i) => auto.update(frame(i * 100)));
  };

  it('calibra sozinha com o corpo parado, com repouso para as duas mãos', () => {
    const auto = new AutoCalibrator();
    const profile = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100), { needsWrists: true }))
      .find((step) => step.profile)?.profile;
    expect(profile?.world.readyWristLocal?.left).toBeDefined();
    expect(profile?.world.readyWristLocal?.right).toBeDefined();
  });

  it('não calibra enquanto a pessoa se mexe', () => {
    expect(run((time) => pose(time, { hipRise: time % 1000 < 500 ? 0 : 0.3 })).some((step) => step.profile)).toBe(false);
  });

  it('pede enquadramento sem rastreamento', () => {
    expect(run((time) => ({ ...pose(time), trackingState: 'lost' })).every((step) => step.phase === 'framing')).toBe(true);
  });
});

it('completa a calibração de corrida sem nunca ver joelhos, tornozelos ou punhos', () => {
  const auto = new AutoCalibrator();
  const hidden = (time: number) => {
    const snapshot = pose(time, { hiddenLandmarks: [15, 16, 25, 26, 27, 28] });
    return {
      ...snapshot,
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
    };
  };
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(hidden(i * 100)));
  const done = steps.find((step) => step.profile);
  expect(done?.profile).toBeDefined();
  // Núcleo do torso presente; referência de punho omitida — swings ficam fora, o resto joga.
  expect(done?.profile?.world.readyWristLocal).toBeUndefined();
  expect(done?.profile?.world.leanUp0).toBeDefined();
});

it('pede enquadramento quando não há ninguém no quadro', () => {
  const empty = { ...pose(0), landmarks: [], worldLandmarks: [], trackingState: 'lost' as const };
  expect(new AutoCalibrator().update(empty)).toEqual({ phase: 'framing', progress: 0 });
});

it('conta quadros sem enquadramento na cobertura em vez de escondê-los da razão', () => {
  const auto = new AutoCalibrator();
  // All good until the collection starts (~1 s), then every other frame goes bad: in the
  // 3 s window they are ~half the total — under the 65% coverage gate, so it must retry.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100, { confidence: i <= 10 || i % 2 === 0 ? 0.95 : 0.1 })));
  expect(steps.some((step) => step.profile)).toBe(false);
});

it('no modo tênis pede enquadramento enquanto os punhos não aparecem', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 45 }, (_, i) => auto.update(pose(i * 100, { hiddenLandmarks: [15, 16] }), { needsWrists: true }));
  expect(steps.every((step) => step.phase === 'framing')).toBe(true);
});

it('no modo tênis não conclui se os punhos somem durante a coleta', () => {
  const auto = new AutoCalibrator();
  // Wrists visible at framing, gone (image and world) through most of the collection:
  // coverage below 65% omits readyWristLocal — for tennis that means retry, not a
  // swing-less profile.
  const frame = (i: number) => {
    const time = i * 100;
    if (i <= 12) return pose(time);
    const snapshot = pose(time, { hiddenLandmarks: [15, 16] });
    return {
      ...snapshot,
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
    };
  };
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(frame(i), { needsWrists: true }));
  expect(steps.some((step) => step.profile)).toBe(false);
});

it('no modo tênis conclui com os punhos visíveis mesmo sem joelhos nem tornozelos', () => {
  const auto = new AutoCalibrator();
  const hidden = (time: number) => {
    const snapshot = pose(time, { hiddenLandmarks: [25, 26, 27, 28] });
    return {
      ...snapshot,
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
    };
  };
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(hidden(i * 100), { needsWrists: true }));
  const done = steps.find((step) => step.profile);
  expect(done?.profile).toBeDefined();
  expect(done?.profile?.world.readyWristLocal).toBeDefined();
});

it('tolera um quadro ruim isolado no meio da coleta', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100, { confidence: i === 25 ? 0.1 : 0.95 })));
  expect(steps.some((step) => step.profile)).toBe(true);
});

const lostPose = (time: number) => ({ ...pose(time), landmarks: [], worldLandmarks: [], trackingState: 'lost' as const });

it('absorve uma perda curta de rastreamento na cobertura da coleta', () => {
  const auto = new AutoCalibrator();
  // ~600 ms sem pose no meio da janela: ~20% dos quadros — a cobertura de 65% ainda aprova.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 20 && i < 26 ? lostPose(i * 100) : pose(i * 100)));
  expect(steps.some((step) => step.profile)).toBe(true);
});

it('encerra a tentativa no prazo mesmo quando o rastreamento não volta', () => {
  const auto = new AutoCalibrator();
  // Coleta começa (~1 s) e a pose some de vez: o prazo encerra a tentativa, a cobertura
  // rejeita e o framing retorna — nada de coleta travada nem reset antecipado.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i <= 12 ? pose(i * 100) : lostPose(i * 100)));
  expect(steps.some((step) => step.phase === 'collecting')).toBe(true);
  expect(steps.some((step) => step.profile)).toBe(false);
  expect(steps.at(-1)?.phase).toBe('framing');
});

it('rejeita pela cobertura e retenta quando a perda cobre boa parte da janela', () => {
  const auto = new AutoCalibrator();
  // 1,2 s sem pose numa janela de 3 s: ~60% de válidos, abaixo dos 65% — a tentativa morre
  // na cobertura, não no reset, e a coleta recomeça com o corpo de volta.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 13 && i < 25 ? lostPose(i * 100) : pose(i * 100)));
  expect(steps.some((step) => step.profile)).toBe(false);
  expect(steps.at(-1)?.phase).toBe('collecting');
});

it('absorve na cobertura uma perda durante o repouso sem reiniciar', () => {
  const auto = new AutoCalibrator();
  // A âncora inicia a exposição; uma perda durante o settling entra na cobertura e atrasa a convergência.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 5 && i < 9 ? lostPose(i * 100) : pose(i * 100)));
  expect(steps.slice(9).some((step) => step.phase === 'framing')).toBe(false);
  expect(steps.some((step) => step.profile)).toBe(true);
});

it('tolera um lost transitório no meio da coleta', () => {
  const auto = new AutoCalibrator();
  // A ~130 ms tracking blackout inside the collection (the gate flips to 'lost' after 4
  // bad core frames) must not throw the attempt away: the lost frames count toward the
  // coverage denominator like any other bad frame and the profile still comes out.
  const lost = (time: number) => ({ ...pose(time, { hiddenLandmarks: [11, 12, 23, 24] }), trackingState: 'lost' as const });
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 13 && i <= 16 ? lost(i * 100) : pose(i * 100)));
  expect(steps[13]?.phase).toBe('collecting');
  expect(steps[16]?.phase).toBe('collecting');
  expect(steps.some((step) => step.profile)).toBe(true);
});

it('derruba a tentativa quando a pessoa se move durante um blecaute que o gate não recupera', () => {
  const auto = new AutoCalibrator();
  // Blackout at i=13-16 during which the player steps aside (hipRise shifts hips/shoulders
  // by 0.08 > STILL_TOLERANCE). Afterwards the gate flaps — a bad frame every third keeps
  // 'tracked' unreachable — yet ~71% of samples are individually valid. A visible frame
  // outside 'tracked' still proves where the body is: it must re-verify stillness instead
  // of feeding post-move positions into the same medians as the pre-move ones.
  const frame = (i: number) => {
    const time = i * 100;
    if (i <= 12) return pose(time);
    if (i <= 16) return { ...pose(time, { hiddenLandmarks: [11, 12, 23, 24] }), trackingState: 'lost' as const };
    const moved = { hipRise: 0.2 };
    const bad = (i - 17) % 3 === 2;
    return { ...pose(time, bad ? { ...moved, hiddenLandmarks: [11, 12, 23, 24] } : moved), trackingState: 'degraded' as const };
  };
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(frame(i)));
  expect(steps.some((step) => step.profile)).toBe(false);
});

it('converge em dois segundos de sinal válido quando a cobertura é contínua', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100)));

  expect(steps[19]?.phase).toBe('collecting');
  expect(steps[20]?.phase).toBe('done');
});

it('prolonga a calibração após um blackout curto no início da coleta', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 10 && i < 15 ? lostPose(i * 100) : pose(i * 100)));

  expect(steps[20]?.phase).toBe('collecting');
  expect(steps.findIndex((step) => step.phase === 'done')).toBe(25);
});

it('não credita um intervalo longo sem callbacks como sinal válido', () => {
  const calibrator = new Calibrator();
  calibrator.start(0, 1000);
  for (let index = 0; index < 12; index += 1) calibrator.add(pose(index * 20));
  calibrator.add(pose(2000));

  expect(calibrator.finish()).toBeNull();
});

it('mantém convergência com um callback perdido em fluxo de cadência baixa', () => {
  const calibrator = new Calibrator();
  calibrator.start(0, 1000);
  for (let time = 0; time < 2000; time += 143) {
    if (time !== 715) calibrator.add(pose(time));
  }
  calibrator.add(pose(2000));

  expect(calibrator.finish()).not.toBeNull();
});

it('ignora a estabilidade dos punhos ao calibrar corrida e deixa a referência ausente', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 61 }, (_, i) => {
    const snapshot = pose(i * 100, { wristLateral: i < 11 ? 0 : 0.4 });
    return auto.update(snapshot);
  });

  expect(steps.find((step) => step.profile)?.profile?.world.readyWristLocal).toBeUndefined();
});

it('movimento sustentado do punho invalida só aquela mão, sem reancorar o torso', () => {
  const auto = new AutoCalibrator();
  const snapshots = Array.from({ length: 42 }, (_, index) => {
    const snapshot = pose(index * 100);
    if (index < 11) return snapshot;
    const landmarks = [...snapshot.landmarks];
    landmarks[15] = { ...landmarks[15]!, x: landmarks[15]!.x + 0.08 };
    const worldLandmarks = [...snapshot.worldLandmarks];
    worldLandmarks[15] = { ...worldLandmarks[15]!, x: worldLandmarks[15]!.x + 0.2 };
    return { ...snapshot, landmarks, worldLandmarks };
  });
  const steps = snapshots.map((snapshot) => auto.update(snapshot, { needsWrists: true }));

  // O torso continua coletando; apenas a evidência anterior do punho esquerdo é descartada.
  expect(steps[11]?.phase).toBe('collecting');
  const completed = steps.find((step) => step.phase === 'done');
  expect(completed).toBeDefined();
  expect(completed?.profile?.world.readyWristLocal?.left).toBeUndefined();
  expect(completed?.profile?.world.readyWristLocal?.right).toBeDefined();
});

it('movimento sustentado do core invalida o torso, mas um deslocamento curto não reinicia a tentativa', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 42 }, (_, index) => {
    const snapshot = pose(index * 100);
    if (index < 11) return auto.update(snapshot);
    const landmarks = [...snapshot.landmarks];
    landmarks[11] = { ...landmarks[11]!, x: landmarks[11]!.x - 0.08 };
    landmarks[12] = { ...landmarks[12]!, x: landmarks[12]!.x + 0.08 };
    const worldLandmarks = [...snapshot.worldLandmarks];
    worldLandmarks[11] = { ...worldLandmarks[11]!, x: worldLandmarks[11]!.x + 0.1 };
    worldLandmarks[12] = { ...worldLandmarks[12]!, x: worldLandmarks[12]!.x - 0.1 };
    return auto.update({ ...snapshot, landmarks, worldLandmarks });
  });

  expect(steps[11]?.phase).toBe('collecting');
  expect(steps[20]?.phase).toBe('settling');
  expect(steps.find((step) => step.phase === 'done')?.profile).toBeDefined();
});

it('profundidade sustentada do punho invalida só aquela mão sem depender da projeção 2D', () => {
  const auto = new AutoCalibrator();
  const snapshots = Array.from({ length: 42 }, (_, index) => {
    const snapshot = pose(index * 100);
    if (index < 11) return snapshot;
    const worldLandmarks = [...snapshot.worldLandmarks];
    worldLandmarks[16] = { ...worldLandmarks[16]!, z: worldLandmarks[16]!.z + 0.2 };
    return { ...snapshot, worldLandmarks };
  });
  const steps = snapshots.map((snapshot) => auto.update(snapshot, { needsWrists: true }));

  expect(steps[11]?.phase).toBe('collecting');
  const completed = steps.find((step) => step.phase === 'done');
  expect(completed).toBeDefined();
  expect(completed?.profile?.world.readyWristLocal?.right).toBeUndefined();
  expect(completed?.profile?.world.readyWristLocal?.left).toBeDefined();
});
