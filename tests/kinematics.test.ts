import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/cv/oneEuroFilter';
import { Calibrator } from '../src/cv/calibrator';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { CadenceTracker } from '../src/kinematics/cadenceTracker';
import { JumpDetector } from '../src/kinematics/jumpDetector';
import { landmarkConfidence } from '../src/kinematics/math';
import { LaneLeanDetector, torsoLeanDeltaRad } from '../src/kinematics/postureSignals';
import { SchmittTrigger } from '../src/kinematics/schmittTrigger';
import { hasMeaningfulLateralComponent, SwingDetector } from '../src/kinematics/swingDetector';
import { calibration, pose } from './fixtures/syntheticPose';

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

describe('Schmitt trigger', () => {
  it('fires once on the upward crossing and rearms below the off threshold', () => {
    const trigger = new SchmittTrigger(0.1, 0.05, 200);
    expect(trigger.update(0.11, 0)).toBe(true);
    expect(trigger.update(0.18, 40)).toBe(false);
    expect(trigger.update(0.04, 70)).toBe(false);
    expect(trigger.update(0.11, 240)).toBe(true);
  });
});

describe('landmark confidence', () => {
  it('returns zero for no visible points and falls back to presence when visibility is omitted', () => {
    expect(landmarkConfidence()).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, presence: 0.8 })).toBe(0.8);
  });
});

describe('cadence tracker', () => {
  it('counts alternating knee lifts and reports a bounded arcade speed', () => {
    const tracker = new CadenceTracker();
    const profile = calibration();
    const samples = [
      [0, 0, 0], [100, 0.16, 0], [180, 0.16, 0], [240, 0, 0],
      [500, 0, 0.16], [580, 0, 0.16], [640, 0, 0],
      [900, 0.16, 0], [980, 0.16, 0], [1040, 0, 0],
    ] as const;
    const result = samples.map(([time, left, right]) => tracker.update(pose(time, { kneeLeft: left, kneeRight: right }), profile));
    expect(result.filter((item) => item.step)).toHaveLength(3);
    expect(result.at(-1)!.cadenceSpm).toBeGreaterThan(0);
    expect(result.at(-1)!.speed01).toBeGreaterThan(0);
    expect(result.at(-1)!.speed01).toBeLessThanOrEqual(1);
    expect(tracker.update(pose(1600), profile).cadenceSpm).toBe(0);
  });

  it('drops the previous cadence window after a long pause', () => {
    const tracker = new CadenceTracker();
    const profile = calibration();
    const frames = [
      [0, 0, 0], [100, 0.16, 0], [180, 0.16, 0], [220, 0, 0],
      [400, 0, 0.16], [480, 0, 0.16], [520, 0, 0],
      [700, 0.16, 0], [780, 0.16, 0], [820, 0, 0], [2100, 0, 0],
      [2400, 0.16, 0], [2480, 0.16, 0], [2520, 0, 0],
    ] as const;
    const result = frames.map(([time, left, right]) => tracker.update(pose(time, { kneeLeft: left, kneeRight: right }), profile));
    expect(result.at(-3)!.step).toBe('left');
    expect(result.at(-3)!.cadenceSpm).toBe(0);
  });
});

describe('jump detector', () => {
  it('emits once on takeoff and does not emit again on landing', () => {
    const detector = new JumpDetector();
    const profile = calibration();
    const frames = [
      pose(0), pose(33), pose(66), pose(100), pose(133), pose(166),
      pose(199, { hipRise: 0.07 }), pose(232, { hipRise: 0.12 }), pose(266, { hipRise: 0.18 }),
      pose(299, { hipRise: 0.25 }), pose(332, { hipRise: 0.3 }), pose(366, { hipRise: 0.28 }),
      pose(399, { hipRise: 0.22 }), pose(432, { hipRise: 0.12 }), pose(466, { hipRise: 0.06 }),
      pose(499, { hipRise: 0.02 }), pose(666), pose(833),
    ];
    const fired = frames.map((frame) => detector.update(frame, profile)).filter(Boolean);
    expect(fired).toHaveLength(1);
  });

  it('keeps takeoff detection stable when the same movement is sampled at different frame rates', () => {
    const profile = calibration();
    const riseAt = (time: number): number => {
      if (time < 50 || time >= 650) return 0;
      if (time <= 250) return 0.3 * (time - 50) / 200;
      if (time <= 350) return 0.3;
      return 0.3 * (650 - time) / 300;
    };
    const fireTimes: number[] = [];
    for (const frameInterval of [16, 33, 50, 67]) {
      const detector = new JumpDetector();
      const fired: number[] = [];
      for (let time = 0; time <= 1300; time += frameInterval) {
        if (detector.update(pose(time, { hipRise: riseAt(time - 200) }), profile)) fired.push(time);
      }
      expect(fired).toHaveLength(1);
      fireTimes.push(fired[0]!);
    }
    expect(Math.max(...fireTimes) - Math.min(...fireTimes)).toBeLessThanOrEqual(75);
  });
});

describe('swing detector', () => {
  it('uses a bounded lateral component for stroke candidates', () => {
    expect(hasMeaningfulLateralComponent(10, 2.4)).toBe(false);
    expect(hasMeaningfulLateralComponent(10, 2.5)).toBe(true);
    expect(hasMeaningfulLateralComponent(10, 2.6)).toBe(true);
  });

  it('emits one swing and ignores the fast return until the ready pose is held', () => {
    const detector = new SwingDetector();
    const profile = calibration('right');
    expect(detector.update(pose(0), profile)).toBeUndefined();
    expect(detector.update(pose(100, { wristLateral: -0.3 }), profile)).toBeUndefined();
    expect(detector.update(pose(150, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
    expect(detector.update(pose(200, { wristLateral: 0 }), profile)).toBeUndefined();
    expect(detector.update(pose(400, { wristLateral: 0 }), profile)).toBeUndefined();
  });

  it('does not classify a vertical or depth-only wrist motion as a forehand or backhand', () => {
    const detector = new SwingDetector();
    const profile = calibration('right');
    expect(detector.update(pose(0), profile)).toBeUndefined();
    expect(detector.update(pose(100, { wristVertical: 0.4 }), profile)).toBeUndefined();
    expect(detector.update(pose(200, { wristDepth: 0.4 }), profile)).toBeUndefined();
  });

  it('classifies the peak stroke direction and maps the peak wrist position into three aim zones', () => {
    const classify = (hand: 'left' | 'right', displacement: number) => {
      const detector = new SwingDetector();
      const profile = calibration(hand);
      let signal: ReturnType<SwingDetector['update']>;
      for (const time of [0, 20, 40, 60, 80, 110]) {
        const progress = time <= 80 ? time / 80 : 1 - (time - 80) / 30;
        const current = detector.update(pose(time, { wristLateral: displacement * progress }), profile);
        if (current) signal = current;
      }
      return signal;
    };
    expect(classify('right', 0.2)).toMatchObject({ side: 'backhand', aimZone: 'cross' });
    expect(classify('right', 0.1)).toMatchObject({ aimZone: 'center' });
    expect(classify('right', -0.2)).toMatchObject({ side: 'forehand', aimZone: 'line' });
    expect(classify('left', 0.2)).toMatchObject({ side: 'forehand' });
  });

  it('waits for a neutral ready pose before rearming after a confirmed tracking loss', () => {
    const detector = new SwingDetector();
    const profile = calibration('right');
    detector.reset();
    for (let time = 0; time <= 240; time += 40) expect(detector.update(pose(time), profile)).toBeUndefined();
    expect(detector.update(pose(270, { wristLateral: -0.2 }), profile)).toBeUndefined();
    expect(detector.update(pose(310, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
  });
});

describe('world-space posture calibration', () => {
  it('stores neutral trunk lean in world coordinates', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { leanRad: 0.2 }));
    expect(calibrator.finish('right')?.world.torsoLeanRad0).toBeCloseTo(0.2, 2);
  });

  it('rejects calibration when the full-body landmarks stay below the confidence gate', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { hiddenLandmarks: [25, 26] }));
    expect(calibrator.finish('right')).toBeNull();
  });

  it('counts degraded frames in calibration coverage instead of hiding them from the ratio', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      const invalid = frame % 2 === 1;
      const snapshot = pose(time, invalid ? { hiddenLandmarks: [25, 26] } : {});
      if (invalid) snapshot.trackingState = 'degraded';
      calibrator.add(snapshot);
    }
    expect(calibrator.finish('right')).toBeNull();
  });

  it('uses world torso geometry for lane lean and emits one direction while the pose is held', () => {
    const detector = new LaneLeanDetector();
    const profile = calibration();
    const leanPose = pose(99, { leanRad: 0.24 });
    expect(torsoLeanDeltaRad(leanPose, profile)).toBeCloseTo(0.24, 2);
    const signals = [0, 33, 66, 99, 132, 165, 198].map((time) => detector.update(
      pose(time, { leanRad: time < 99 ? 0 : 0.24 }), profile,
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
    const profile = calibration('right');
    const hiddenKnees = { hiddenLandmarks: [25, 26] } as const;
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time, hiddenKnees), profile); });
    pipeline.update(pose(100, { ...hiddenKnees, wristLateral: -0.3 }), profile);
    const result = pipeline.update(pose(133, { ...hiddenKnees, wristLateral: 0.2 }), profile);
    expect(result.snapshot.trackingState).toBe('tracked');
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    expect(result.events.filter((event) => event.type === 'sprint')).toHaveLength(0);
  });

  it('preserves a raised-knee latch through a one-frame confidence dip', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { kneeLeft: 0.16 }), profile);
    pipeline.update(pose(132, { kneeLeft: 0.16 }), profile);
    pipeline.update(pose(165, { kneeLeft: 0.16 }), profile);
    const firstStep = pipeline.update(pose(198, { kneeLeft: 0.16 }), profile);
    expect(firstStep.events.filter((event) => event.type === 'step')).toHaveLength(1);
    const degraded = pipeline.update(pose(231, { kneeLeft: 0.16, confidence: 0.1 }), profile);
    expect(degraded.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'degraded' });
    const recovery = [264, 297, 330].map((time) => pipeline.update(pose(time, { kneeLeft: 0.16 }), profile));
    expect(recovery.flatMap((result) => result.events).filter((event) => event.type === 'step')).toHaveLength(0);
  });

  it('exposes neutral continuous sprint control as cadence tracking is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [
      [0, 0, 0], [33, 0, 0], [66, 0, 0],
      [166, 0.16, 0], [246, 0.16, 0], [306, 0, 0],
      [566, 0, 0.16], [646, 0, 0.16], [706, 0, 0],
      [966, 0.16, 0], [1046, 0.16, 0],
    ] as const;
    const active = frames.map(([time, left, right]) => pipeline.update(pose(time, { kneeLeft: left, kneeRight: right }), profile)).at(-1)!;
    expect(active.controls.sprintSpeed01).toBeGreaterThan(0);
    const lost = [1110, 1143, 1176, 1209].map((time) => pipeline.update(pose(time, { hiddenLandmarks: [25, 26] }), profile)).at(-1)!;
    expect(lost.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' });
  });

  it('keeps the swing arc across a brief wrist occlusion and reports the gate confidence', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration('right');
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

  it('uses peak-frame confidence even when confidence is lower at confirmation time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration('right');
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
    const profile = calibration('right');
    const lowPresence = (time: number, wristLateral = 0) => withWorldConfidence(pose(time, { wristLateral }), 11, 0.95, 0.4);
    [0, 33, 66].forEach((time) => { pipeline.update(lowPresence(time), profile); });
    pipeline.update(lowPresence(99, -0.3), profile);
    const result = pipeline.update(lowPresence(132, 0.2), profile);
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('allows a swing when only its feature landmarks are tracked, and labels that local gate', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration('right');
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
