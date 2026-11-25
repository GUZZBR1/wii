import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/cv/oneEuroFilter';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { CadenceTracker } from '../src/kinematics/cadenceTracker';
import { JumpDetector } from '../src/kinematics/jumpDetector';
import { SchmittTrigger } from '../src/kinematics/schmittTrigger';
import { SwingDetector } from '../src/kinematics/swingDetector';
import { calibration, pose } from './fixtures/syntheticPose';

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
});

describe('jump detector', () => {
  it('emits once on takeoff and does not emit again on landing', () => {
    const detector = new JumpDetector();
    const profile = calibration();
    const frames = [
      pose(0), pose(33, { hipRise: 0.07 }), pose(66, { hipRise: 0.12 }), pose(100, { hipRise: 0.18 }),
      pose(133, { hipRise: 0.25 }), pose(166, { hipRise: 0.3 }), pose(200, { hipRise: 0.28 }),
      pose(233, { hipRise: 0.22 }), pose(266, { hipRise: 0.12 }), pose(300, { hipRise: 0.06 }),
      pose(333, { hipRise: 0.02 }), pose(500), pose(700),
    ];
    const fired = frames.map((frame) => detector.update(frame, profile)).filter(Boolean);
    expect(fired).toHaveLength(1);
  });
});

describe('swing detector', () => {
  it('emits one swing and ignores the fast return until the ready pose is held', () => {
    const detector = new SwingDetector();
    const profile = calibration('right');
    detector.setPowerAnchors(1, 10);
    expect(detector.update(pose(0), profile)).toBeUndefined();
    expect(detector.update(pose(100, { wristLateral: -0.3 }), profile)).toMatchObject({ side: 'forehand' });
    expect(detector.update(pose(150, { wristLateral: 0.2 }), profile)).toBeUndefined();
    expect(detector.update(pose(200, { wristLateral: 0 }), profile)).toBeUndefined();
    expect(detector.update(pose(400, { wristLateral: 0 }), profile)).toBeUndefined();
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
});
