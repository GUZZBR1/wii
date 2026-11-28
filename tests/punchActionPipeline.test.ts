import { describe, expect, it } from 'vitest';
import type { PoseSnapshot, SportActionEvent } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose } from './fixtures/syntheticPose';

/** Right arm blended from guard (0) to a straight punch toward the camera (1). */
function rightArm(time: number, extension: number, hiddenLandmarks: readonly number[] = []): PoseSnapshot {
  const snapshot = pose(time, { hiddenLandmarks });
  const world = [...snapshot.worldLandmarks];
  const shoulder = world[12]!;
  const place = (index: number, y0: number, z0: number, y1: number, z1: number) => {
    const visible = hiddenLandmarks.includes(index) ? 0 : 0.95;
    world[index] = {
      x: shoulder.x,
      y: shoulder.y + y0 + (y1 - y0) * extension,
      z: z0 + (z1 - z0) * extension,
      visibility: visible,
      presence: visible,
    };
  };
  place(14, 0.28, -0.05, 0.02, -0.3);
  place(16, 0, -0.18, 0.02, -0.58);
  return { ...snapshot, worldLandmarks: world };
}

/** 300 ms in guard, a 150 ms extension, then held. */
function jab(pipeline: ActionPipeline, profile = calibration(), hidden: readonly number[] = []): SportActionEvent[] {
  const events: SportActionEvent[] = [];
  for (let time = 0; time <= 900; time += 33) {
    const extension = Math.min(1, Math.max(0, (time - 300) / 150));
    events.push(...pipeline.update(rightArm(time, extension, hidden), profile).events);
  }
  return events.filter((event) => event.type === 'punch-start' || event.type === 'punch');
}

describe('punch wiring in ActionPipeline', () => {
  it('emits the onset before the confirmed punch, once each, for the punching hand', () => {
    const events = jab(new ActionPipeline());
    expect(events.map((event) => event.type)).toEqual(['punch-start', 'punch']);
    const [start, punch] = events;
    if (punch?.type !== 'punch') throw new Error('missing punch');
    expect(start).toMatchObject({ hand: 'right', source: 'cv', trackingState: 'tracked' });
    expect(punch.hand).toBe('right');
    expect(punch.onsetTimestampMs).toBe(start!.timestampMs);
    expect(punch.id).toBeGreaterThan(start!.id);
  });

  it('attaches trajectory measurement and geometry classification to confirmed punches', () => {
    const punch = jab(new ActionPipeline()).find((event) => event.type === 'punch');
    if (punch?.type !== 'punch') throw new Error('missing punch');
    expect(punch.punchKind).toBe('straight');
    expect(punch.punchTargetZone).toBe('head');
    expect(punch.measurement?.samples.length).toBeGreaterThanOrEqual(2);
    expect(punch.measurement?.forwardTravel).toBeGreaterThan(0.2);
  });

  it('stays silent until the calibration scale has converged', () => {
    const profile = { ...calibration(), readiness: { scale01: 0.2, neutral01: 1 } };
    expect(jab(new ActionPipeline(), profile)).toEqual([]);
  });

  it('stays silent when the punching elbow is not visible', () => {
    expect(jab(new ActionPipeline(), calibration(), [14])).toEqual([]);
  });

  it('keeps punching when the hips are cropped out of the webcam frame', () => {
    const cropHips = (snapshot: PoseSnapshot): PoseSnapshot => ({
      ...snapshot,
      landmarks: snapshot.landmarks.map((point, index) => index === 23 || index === 24 ? { ...point, visibility: 0.1, presence: 0.1 } : point),
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => index === 23 || index === 24 ? { ...point, visibility: 0.1, presence: 0.1 } : point),
    });
    const pipeline = new ActionPipeline();
    const events: SportActionEvent[] = [];
    for (let time = 0; time <= 900; time += 33) {
      const extension = Math.min(1, Math.max(0, (time - 300) / 150));
      events.push(...pipeline.update(cropHips(rightArm(time, extension)), calibration()).events);
    }
    expect(events.filter((event) => event.type === 'punch-start' || event.type === 'punch').map((event) => event.type)).toEqual(['punch-start', 'punch']);
  });

  it('discards a punch whose measurement overlaps a fast shoulder drop', () => {
    const pipeline = new ActionPipeline();
    const events: SportActionEvent[] = [];
    for (let time = 0; time <= 900; time += 33) {
      const extension = Math.min(1, Math.max(0, (time - 300) / 150));
      const snapshot = rightArm(time, extension);
      // Start the duck after the onset race: the onset is already legitimate, but the
      // shoulder reference drops while the punch is being confirmed.
      const drop = 0.06 * Math.min(1, Math.max(0, (time - 400) / 150));
      const landmarks = snapshot.landmarks.map((point, index) => [0, 11, 12, 23, 24].includes(index) ? { ...point, y: point.y + drop } : point);
      events.push(...pipeline.update({ ...snapshot, landmarks }, calibration()).events);
    }
    expect(events.some((event) => event.type === 'punch-start')).toBe(true);
    expect(events.some((event) => event.type === 'punch')).toBe(false);
  });

  it('forgets the previous session on reset', () => {
    const pipeline = new ActionPipeline();
    jab(pipeline);
    pipeline.reset(933);
    expect(jab(pipeline).map((event) => event.type)).toEqual(['punch-start', 'punch']);
  });

  it('restates the guard every frame, only once calibration can scale it', () => {
    const guardAt = (extension: number, scale01: number) => {
      const pipeline = new ActionPipeline();
      const profile = { ...calibration(), readiness: { scale01, neutral01: 1 } };
      // Both arms mirror the right one, so the left fist is in place too.
      const both = (time: number) => {
        const snapshot = rightArm(time, extension);
        const world = [...snapshot.worldLandmarks];
        for (const [from, to] of [[14, 13], [16, 15]] as const) {
          world[to] = { ...world[from]!, x: world[11]!.x };
        }
        return { ...snapshot, worldLandmarks: world };
      };
      let guard: boolean | undefined;
      for (let time = 0; time <= 200; time += 33) guard = pipeline.update(both(time), profile).controls.guard;
      return guard;
    };
    expect(guardAt(0, 1)).toBe(true);
    expect(guardAt(1, 1)).toBe(false);
    expect(guardAt(0, 0.2)).toBeUndefined();
  });
});
