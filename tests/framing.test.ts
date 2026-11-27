import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { HeadWarning, upsideDown } from '../src/kinematics/framing';
import { calibration, pose } from './fixtures/syntheticPose';

const flipped = (time: number) => {
  const base = pose(time);
  return { ...base, landmarks: base.landmarks.map((point) => ({ ...point, y: 1 - point.y })) };
};

describe('framing', () => {
  it('warns only about a head that stays out, and drops the warning when it returns', () => {
    const warning = new HeadWarning();
    const at = (time: number, noseY: number) => {
      const base = pose(time);
      return warning.update({ ...base, landmarks: base.landmarks.map((point, index) => (index === 0 ? { ...point, y: noseY } : point)) });
    };
    for (let time = 0; time <= 1000; time += 100) expect(at(time, -0.1)).toBe(false); // a hop
    expect(at(1100, 0.2)).toBe(false);
    for (let time = 1200; time < 2700; time += 100) expect(at(time, -0.1)).toBe(false);
    expect(at(2700, -0.1)).toBe(true);
    expect(at(2800, 0.01)).toBe(true);
    expect(at(2900, 0.05)).toBe(false);
  });

  it('never drives the game from an upside-down skeleton', () => {
    expect(upsideDown(flipped(0))).toBe(true);
    const pipeline = new ActionPipeline();
    for (let time = 0; time <= 2000; time += 33) {
      const result = pipeline.update(flipped(time), calibration());
      expect(result.snapshot.trackingState).not.toBe('tracked');
      expect(result.events).toEqual([]);
      expect(result.controls.laneZone).toBeUndefined();
    }
  });
});
