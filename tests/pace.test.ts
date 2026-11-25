import { describe, expect, it } from 'vitest';
import { gaitFor, type Gait } from '../src/games/track/gait';
import { CadenceTracker, type CadenceResult } from '../src/kinematics/cadenceTracker';
import { calibration, pose } from './fixtures/syntheticPose';

const START = 500;
const STOP = 8000;

/** Marches in place at `spm` steps per minute from START to STOP, then stands still. */
function march(spm: number): (CadenceResult & { time: number })[] {
  const tracker = new CadenceTracker();
  const profile = calibration();
  const step = 60_000 / spm;
  return Array.from({ length: 320 }, (_, frame) => {
    const time = frame * 33;
    const elapsed = time - START;
    const lift = elapsed >= 0 && time <= STOP ? 0.25 * Math.sin((Math.PI * (elapsed % step)) / step) : 0;
    const left = Math.floor(elapsed / step) % 2 === 0;
    return { time, ...tracker.update(pose(time, { kneeLeft: left ? lift : 0, kneeRight: left ? 0 : lift }), profile) };
  });
}

describe('pace from marching in place', () => {
  it.each([60, 90, 110, 130, 160, 190])('keeps moving without dropouts at %i steps per minute', (spm) => {
    const steady = march(spm).filter((r) => r.time > 3000 && r.time <= STOP);
    expect(steady.filter((r) => r.speed01 === 0)).toHaveLength(0);
    for (const r of steady) expect(Math.abs(r.cadenceSpm - spm) / spm).toBeLessThan(0.15);
  });

  it('goes faster the faster the player steps', () => {
    const speeds = [60, 90, 120, 150, 180].map((spm) => march(spm).find((r) => r.time > 6000)!.speed01);
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b));
    expect(new Set(speeds).size).toBe(speeds.length);
  });

  it.each([60, 110, 180])('stops soon after the player stops at %i steps per minute', (spm) => {
    expect(march(spm).filter((r) => r.time > STOP + 1700).every((r) => r.speed01 === 0)).toBe(true);
  });

  it('does not move for a single knee raise or for standing still', () => {
    const tracker = new CadenceTracker();
    const speeds = Array.from({ length: 90 }, (_, i) => tracker.update(pose(i * 33, { kneeLeft: i > 10 && i < 30 ? 0.25 : 0 }), calibration()).speed01);
    expect(Math.max(...speeds)).toBe(0);
  });

  it.each([[0, 'idle'], [90, 'walk'], [120, 'walk'], [160, 'run'], [190, 'run']] as const)('reads %i steps per minute as %s', (spm, gait) => {
    const speed = spm === 0 ? 0 : march(spm).find((r) => r.time > 6000)!.speed01;
    expect(gaitFor(speed, 'idle')).toBe(gait);
  });

  it('does not flicker between walking and running near the transition', () => {
    let gait: Gait = 'run';
    for (const speed of [0.56, 0.52, 0.56, 0.52]) gait = gaitFor(speed, gait);
    expect(gait).toBe('run');
    expect(gaitFor(0.45, gait)).toBe('walk');
  });
});
