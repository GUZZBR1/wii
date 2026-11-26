import { describe, expect, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { LanePositionTracker } from '../src/kinematics/postureSignals';
import { calibration, pose } from './fixtures/syntheticPose';

/** Smoothly ramps toward each keyframed displacement — bodies accelerate, they don't teleport. */
function shiftAt(timeMs: number, timeline: { atMs: number; shiftSw: number; rampMs?: number }[]): number {
  let value = 0;
  for (const key of timeline) {
    const t = Math.max(0, Math.min(1, (timeMs - key.atMs) / (key.rampMs ?? 400)));
    const ease = t * t * (3 - 2 * t);
    value += (key.shiftSw - value) * ease;
  }
  return value;
}

function driveTracker(timeline: { atMs: number; shiftSw: number; rampMs?: number }[], totalMs: number, stepMs = 33) {
  const tracker = new LanePositionTracker();
  const zoneTrace: { atMs: number; zone: number }[] = [];
  for (let time = 0; time <= totalMs; time += stepMs) {
    const zone = tracker.update(pose(time, { shiftUserRightSw: shiftAt(time, timeline) }), calibration());
    zoneTrace.push({ atMs: time, zone: zone ?? 0 });
  }
  return zoneTrace;
}

function zoneExtremes(trace: { zone: number }[]): { min: number; max: number } {
  return { min: Math.min(...trace.map((p) => p.zone)), max: Math.max(...trace.map((p) => p.zone)) };
}

describe('LanePositionTracker', () => {
  it('follows a held right displacement into the right zone and back to center on return', () => {
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.3 },
      { atMs: 2500, shiftSw: 0 },
    ], 4000);
    expect(zoneExtremes(zoneTrace)).toEqual({ min: 0, max: 1 });
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it('never enters the left zone when the player only leans right, even with overshoot on return', () => {
    // The exact failure mode of the gesture detector: fast lean right, fast return overshooting
    // past center. Position control can at most return to center — never invert.
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 1800, shiftSw: -0.09, rampMs: 250 },
      { atMs: 2600, shiftSw: 0 },
    ], 3500);
    expect(zoneExtremes(zoneTrace).min).toBe(0);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it('reaches the right zone while the body is still out there during a quick dodge', () => {
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 1500, shiftSw: 0, rampMs: 300 },
    ], 2500);
    const displacedWindow = zoneTrace.filter((p) => p.atMs >= 1000 && p.atMs <= 1500);
    // While the body is out there the zone must already be right — not after the gesture ends.
    expect(Math.max(...displacedWindow.map((p) => p.zone))).toBe(1);
  });

  it('reads a whole-body step to the right as right zone, not just a spine lean', () => {
    // shiftUserRightSw moves the torso core in image space — the same signal a lateral step produces.
    const zoneTrace = driveTracker([{ atMs: 800, shiftSw: 0.5 }], 2500);
    expect(zoneExtremes(zoneTrace).max).toBe(1);
    expect(zoneTrace.at(-1)!.zone).toBe(1); // still out there, still right zone
  });

  it('mirrors the behavior for the left side', () => {
    const zoneTrace = driveTracker([{ atMs: 800, shiftSw: -0.3 }], 2500);
    expect(zoneExtremes(zoneTrace).min).toBe(-1);
    expect(zoneTrace.at(-1)!.zone).toBe(-1);
  });

  it('does not flap zones around noisy center postures', () => {
    const tracker = new LanePositionTracker();
    const zones = new Set<number>();
    for (let time = 0; time <= 3000; time += 33) {
      const jitter = Math.sin(time / 61) * 0.03; // sub-threshold noise, ±0.03 shoulder widths
      zones.add(tracker.update(pose(time, { shiftUserRightSw: jitter }), calibration()) ?? 0);
    }
    expect([...zones]).toEqual([0]);
  });
});

describe('lane position control through the real pipeline and calibrator', () => {
  function drivePipeline(timeline: { atMs: number; shiftSw: number; rampMs?: number }[], totalMs: number) {
    const calibrator = new AdaptiveCalibrator();
    const pipeline = new ActionPipeline();
    let profile: CalibrationProfile | undefined;
    const zoneTrace: { atMs: number; zone: number | undefined }[] = [];
    for (let time = 0; time <= totalMs; time += 33) {
      const snapshot = pose(time, { shiftUserRightSw: shiftAt(time, timeline) });
      // The exact App.tsx wiring: every frame is calibration evidence first — with the lane zone
      // as context — control input second.
      profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
      const result = pipeline.update(snapshot, profile);
      zoneTrace.push({ atMs: time, zone: result.controls.laneZone });
    }
    return { zoneTrace, profile };
  }

  function lanes(zoneTrace: { zone: number | undefined }[]): number[] {
    return zoneTrace.filter((p) => p.zone !== undefined).map((p) => p.zone!);
  }

  it('converges calibration and follows the player into the right lane', () => {
    const { zoneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3 },
      { atMs: 6000, shiftSw: 0 },
    ], 8000);
    expect(Math.max(...lanes(zoneTrace))).toBe(1);
    expect(Math.min(...lanes(zoneTrace))).toBe(0);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it.each([8, 15, 30])('does not chase a %i s held lane position into the neutral reference', (holdS) => {
    // Holding the right lane is how position control is played — even a 30 s hold must not move
    // neutral, and the return to center must land back in the center zone, never the opposite one.
    const holdMs = holdS * 1000;
    const { zoneTrace, profile } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3, rampMs: 0 },
      { atMs: 4000 + holdMs, shiftSw: 0, rampMs: 0 },
    ], 4000 + holdMs + 4000);
    const held = zoneTrace.filter((p) => p.atMs >= 4000 + holdMs / 2 && p.atMs < 4000 + holdMs);
    expect(Math.min(...held.map((p) => p.zone ?? 0))).toBe(1); // zone never dropped back while held
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.min(...lanes(zoneTrace))).toBe(0); // never inverted, even on return
  });

  it.each([0.13, 0.2])('does not chase a shallow %f sw hold either — the admission gate clears the lane band', (shiftSw) => {
    // Regression for the shallow-hold hole: a displacement just past the lane-enter threshold is
    // an active lane, so it must contribute zero posture evidence even though it is small.
    const { zoneTrace, profile } = drivePipeline([
      { atMs: 4000, shiftSw, rampMs: 0 },
      { atMs: 34000, shiftSw: 0, rampMs: 0 },
    ], 38000);
    const held = zoneTrace.filter((p) => p.atMs >= 20000 && p.atMs < 34000);
    expect(Math.min(...held.map((p) => p.zone ?? 0))).toBe(1); // lane held all the way through
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });

  it('adapts to a small sustained stance shift so dodges away from it still reach the lane', () => {
    // Regression for the hysteresis-band hole: settling 0.07 sw right of center never enters a
    // lane, so it is stance rather than control — the reference must follow it, or a leftward
    // dodge measured from the stale center falls short of the left lane.
    const { zoneTrace, profile } = drivePipeline([
      { atMs: 5000, shiftSw: 0.07, rampMs: 500 },
      { atMs: 28000, shiftSw: -0.08, rampMs: 300 }, // 0.15 sw dodge left from the shifted stance
      { atMs: 29500, shiftSw: 0.07, rampMs: 400 },
    ], 31000);
    const duringDodge = zoneTrace.filter((p) => p.atMs >= 28100 && p.atMs <= 29400);
    expect(Math.min(...duringDodge.map((p) => p.zone ?? 0))).toBe(-1);
    // And the shift is stance, not a lane: while settled, the zone stays center.
    const settled = zoneTrace.filter((p) => p.atMs >= 15000 && p.atMs <= 27000);
    expect(settled.every((p) => p.zone === 0 || p.zone === undefined)).toBe(true);
    void profile;
  });

  it('a player who only ever leans right never ends up in the left lane', () => {
    const { zoneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 4800, shiftSw: -0.06, rampMs: 250 }, // snap-back overshoot past center
      { atMs: 5600, shiftSw: 0 },
      { atMs: 7000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 7800, shiftSw: 0, rampMs: 300 },
    ], 9500);
    expect(Math.min(...lanes(zoneTrace))).toBe(0);
  });

  it('alternating dodge gameplay tracks both lanes and returns to center at rest', () => {
    const timeline = [
      { atMs: 4000, shiftSw: 0.3, rampMs: 250 }, // dodge right
      { atMs: 6000, shiftSw: 0, rampMs: 300 },
      { atMs: 8000, shiftSw: -0.3, rampMs: 250 }, // dodge left
      { atMs: 10000, shiftSw: 0, rampMs: 300 },
      { atMs: 12000, shiftSw: 0.3, rampMs: 250 }, // dodge right again
      { atMs: 14000, shiftSw: 0, rampMs: 300 },
    ];
    const { zoneTrace, profile } = drivePipeline(timeline, 16000);
    expect(Math.min(...lanes(zoneTrace))).toBe(-1);
    expect(Math.max(...lanes(zoneTrace))).toBe(1);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });
});
