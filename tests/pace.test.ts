import { describe, expect, it } from 'vitest';
import { gaitFor, type Gait, nextPace } from '../src/games/track/gait';
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
  it.each([40, 60, 90, 110, 130, 160, 190])('keeps moving without dropouts at %i steps per minute', (spm) => {
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

  it('needs two fresh steps to move again after stopping', () => {
    const tracker = new CadenceTracker();
    const profile = calibration();
    const results: { time: number; speed01: number; step?: string }[] = [];
    const feed = (time: number, kneeLeft: number, kneeRight: number) =>
      results.push({ time, ...tracker.update(pose(time, { kneeLeft, kneeRight }), profile) });
    const raiseLeft = (start: number) => { for (let t = start; t < start + 200; t += 33) feed(t, 0.25, 0); };
    const raiseRight = (start: number) => { for (let t = start; t < start + 200; t += 33) feed(t, 0, 0.25); };
    // Alternating square-wave steps every 400 ms (150 steps/min), then a long stop.
    for (let time = 0; time <= 500; time += 33) feed(time, 0, 0);
    for (let time = 533; time <= 4500; time += 33) {
      const phase = (time - 533) % 800;
      feed(time, phase < 400 ? 0.25 : 0, phase >= 400 ? 0.25 : 0);
    }
    expect(results.at(-1)!.speed01).toBeGreaterThan(0);
    for (let time = 4533; time <= 5267; time += 33) feed(time, 0, 0);
    expect(results.at(-1)!.speed01).toBe(0);
    // One isolated step ~1.1 s after the last starts a new sequence: it fires but does not move.
    raiseLeft(5300);
    for (let time = 5500; time < 5700; time += 33) feed(time, 0, 0);
    const isolated = results.filter((r) => r.time >= 5300 && r.time < 5700);
    expect(isolated.some((r) => r.step === 'left')).toBe(true);
    expect(isolated.every((r) => r.speed01 === 0)).toBe(true);
    // The second step completes one interval and movement resumes.
    raiseRight(5700);
    expect(results.at(-1)!.speed01).toBeGreaterThan(0);
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

  it('cycles stopped, walking and running on distinct key presses', () => {
    expect(nextPace(0)).toBe(0.3);
    expect(nextPace(0.3)).toBe(0.8);
    expect(nextPace(0.8)).toBe(0);
    expect(nextPace(0.64)).toBe(0);
  });
});
