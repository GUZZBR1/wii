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
  const events: { direction: 'left' | 'right'; atMs: number }[] = [];
  let lane = 0;
  const laneTrace: { atMs: number; lane: number }[] = [];
  for (let time = 0; time <= totalMs; time += stepMs) {
    const event = tracker.update(pose(time, { shiftUserRightSw: shiftAt(time, timeline) }), calibration());
    if (event) {
      events.push({ direction: event, atMs: time });
      lane = Math.max(-1, Math.min(1, lane + (event === 'left' ? -1 : 1)));
    }
    laneTrace.push({ atMs: time, lane });
  }
  return { events, laneTrace };
}

function laneExtremes(trace: { lane: number }[]): { min: number; max: number } {
  return { min: Math.min(...trace.map((p) => p.lane)), max: Math.max(...trace.map((p) => p.lane)) };
}

describe('LanePositionTracker', () => {
  it('follows a held right displacement into the right lane and back to center on return', () => {
    const { laneTrace } = driveTracker([
      { atMs: 1000, shiftSw: 0.3 },
      { atMs: 2500, shiftSw: 0 },
    ], 4000);
    expect(laneExtremes(laneTrace)).toEqual({ min: 0, max: 1 });
    expect(laneTrace.at(-1)!.lane).toBe(0);
  });

  it('never enters the left lane when the player only leans right, even with overshoot on return', () => {
    // The exact failure mode of the gesture detector: fast lean right, fast return overshooting
    // past center. Position control can at most return to center — never invert.
    const { laneTrace } = driveTracker([
      { atMs: 1000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 1800, shiftSw: -0.09, rampMs: 250 },
      { atMs: 2600, shiftSw: 0 },
    ], 3500);
    expect(laneExtremes(laneTrace).min).toBe(0);
    expect(laneTrace.at(-1)!.lane).toBe(0);
  });

  it('moves into the right lane fast enough to matter during a quick dodge', () => {
    const { events, laneTrace } = driveTracker([
      { atMs: 1000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 1500, shiftSw: 0, rampMs: 300 },
    ], 2500);
    const displacedWindow = laneTrace.filter((p) => p.atMs >= 1000 && p.atMs <= 1500);
    // While the body is out there the lane must already be right — not after the gesture ends.
    expect(Math.max(...displacedWindow.map((p) => p.lane))).toBe(1);
    expect(events[0]?.direction).toBe('right');
  });

  it('reads a whole-body step to the right as right lane, not just a spine lean', () => {
    // shiftUserRightSw moves the torso core in image space — the same signal a lateral step produces.
    const { laneTrace } = driveTracker([{ atMs: 800, shiftSw: 0.5 }], 2500);
    expect(laneExtremes(laneTrace).max).toBe(1);
    expect(laneTrace.at(-1)!.lane).toBe(1); // still out there, still right lane
  });

  it('mirrors the behavior for the left side', () => {
    const { laneTrace } = driveTracker([{ atMs: 800, shiftSw: -0.3 }], 2500);
    expect(laneExtremes(laneTrace).min).toBe(-1);
    expect(laneTrace.at(-1)!.lane).toBe(-1);
  });

  it('does not flap lanes around noisy center postures', () => {
    const tracker = new LanePositionTracker();
    const events: string[] = [];
    for (let time = 0; time <= 3000; time += 33) {
      const jitter = Math.sin(time / 61) * 0.03; // sub-threshold noise, ±0.03 shoulder widths
      const event = tracker.update(pose(time, { shiftUserRightSw: jitter }), calibration());
      if (event) events.push(event);
    }
    expect(events).toEqual([]);
  });
});

describe('lane position control through the real pipeline and calibrator', () => {
  function drivePipeline(timeline: { atMs: number; shiftSw: number; rampMs?: number }[], totalMs: number) {
    const calibrator = new AdaptiveCalibrator();
    const pipeline = new ActionPipeline();
    let profile: CalibrationProfile | undefined;
    let lane = 0;
    const laneTrace: { atMs: number; lane: number }[] = [];
    for (let time = 0; time <= totalMs; time += 33) {
      const snapshot = pose(time, { shiftUserRightSw: shiftAt(time, timeline) });
      // The exact App.tsx wiring: every frame is calibration evidence first, control input second.
      profile = calibrator.update(snapshot) ?? profile;
      const result = pipeline.update(snapshot, profile);
      for (const event of result.events) {
        if (event.type === 'lane') lane = Math.max(-1, Math.min(1, lane + (event.direction === 'left' ? -1 : 1)));
      }
      laneTrace.push({ atMs: time, lane });
    }
    return { laneTrace, profile };
  }

  it('converges calibration and follows the player into the right lane', () => {
    const { laneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3 },
      { atMs: 6000, shiftSw: 0 },
    ], 8000);
    expect(laneExtremes(laneTrace)).toEqual({ min: 0, max: 1 });
  });

  it.each([8, 15, 30])('does not chase a %i s held lane position into the neutral reference', (holdS) => {
    // Holding the right lane is how position control is played — even a 30 s hold must not move
    // neutral, and the return to center must land back in the center lane, never the opposite one.
    const holdMs = holdS * 1000;
    const { laneTrace, profile } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3, rampMs: 0 },
      { atMs: 4000 + holdMs, shiftSw: 0, rampMs: 0 },
    ], 4000 + holdMs + 4000);
    const held = laneTrace.filter((p) => p.atMs >= 4000 + holdMs / 2 && p.atMs < 4000 + holdMs);
    expect(Math.min(...held.map((p) => p.lane))).toBe(1); // lane never dropped back while held
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
    expect(laneTrace.at(-1)!.lane).toBe(0);
    expect(Math.min(...laneTrace.map((p) => p.lane))).toBe(0); // never inverted, even on return
  });

  it('a player who only ever leans right never ends up in the left lane', () => {
    const { laneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 4800, shiftSw: -0.06, rampMs: 250 }, // snap-back overshoot past center
      { atMs: 5600, shiftSw: 0 },
      { atMs: 7000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 7800, shiftSw: 0, rampMs: 300 },
    ], 9500);
    expect(Math.min(...laneTrace.map((p) => p.lane))).toBe(0);
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
    const { laneTrace, profile } = drivePipeline(timeline, 16000);
    expect(laneExtremes(laneTrace)).toEqual({ min: -1, max: 1 });
    expect(laneTrace.at(-1)!.lane).toBe(0);
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });
});
