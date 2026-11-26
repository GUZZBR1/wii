import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { headOutOfFrame, upsideDown } from '../src/kinematics/framing';
import { calibration, pose } from './fixtures/syntheticPose';

const flipped = (time: number) => {
  const base = pose(time);
  return { ...base, landmarks: base.landmarks.map((point) => ({ ...point, y: 1 - point.y })) };
};

describe('framing', () => {
  it('flags a head that left the top of the picture', () => {
    const base = pose(0);
    const cut = { ...base, landmarks: base.landmarks.map((point, index) => (index === 0 ? { ...point, y: -0.2 } : point)) };
    expect(headOutOfFrame(cut)).toBe(true);
    expect(headOutOfFrame(base)).toBe(false);
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
