import { describe, expect, it } from 'vitest';
import {
  collectFixedStepTimestamps,
  elapsedSimulationSeconds,
  mapWallTimestampToSimulationMs,
  toSimulationTimestampMs,
} from '../src/games/core/fixedStepTiming';

describe('fixed-step simulation timestamps', () => {
  it('gives separate simulation times to catch-up steps in a 30 Hz frame', () => {
    const fixed = 1 / 60;
    const result = collectFixedStepTimestamps(1_000, 1 / 30, fixed, 5);

    expect(result.timestampsMs).toHaveLength(2);
    expect(result.timestampsMs[0]).toBeCloseTo(1_016.666666, 5);
    expect(result.timestampsMs[1]).toBeCloseTo(1_033.333333, 5);
    expect(result.timestampsMs[1]! - result.timestampsMs[0]!).toBeCloseTo(1_000 / 60, 5);
    expect(result.remainderSeconds).toBeCloseTo(0, 8);
  });

  it('retains a fractional frame remainder when no full step is due', () => {
    const result = collectFixedStepTimestamps(2_000, 1 / 120, 1 / 60, 5);

    expect(result.timestampsMs).toEqual([]);
    expect(result.remainderSeconds).toBeCloseTo(1 / 120, 10);
  });

  it('keeps the catch-up limit without creating a timestamp jump on the next frame', () => {
    const first = collectFixedStepTimestamps(3_000, 0.12, 1 / 60, 5);

    expect(first.timestampsMs).toHaveLength(5);
    expect(first.remainderSeconds).toBe(0);
    const lastStep = first.timestampsMs.at(-1)!;
    const wallToSimulationOffsetMs = lastStep - 3_120;
    const cameraEventTime = toSimulationTimestampMs(3_130, wallToSimulationOffsetMs);
    const nextFrame = collectFixedStepTimestamps(lastStep, 1 / 60, 1 / 60, 5);

    expect(cameraEventTime).toBeGreaterThan(lastStep);
    expect(cameraEventTime).toBeLessThan(nextFrame.timestampsMs[0]!);
    expect(nextFrame.timestampsMs[0]! - lastStep).toBeCloseTo(1_000 / 60, 5);
  });

  it('skips a step older than an input timestamp, then advances only the remaining interval', () => {
    const lastTapeTime = 1_025;
    expect(elapsedSimulationSeconds(lastTapeTime, 1_016.666667, 1 / 60)).toBe(0);
    expect(elapsedSimulationSeconds(lastTapeTime, 1_033.333333, 1 / 60)).toBeCloseTo(1 / 120, 5);
  });

  it('maps an input between steps onto the current simulation interval', () => {
    expect(mapWallTimestampToSimulationMs(1_025, 1_025, 0, 1_000, 1_000, 100)).toBe(1_025);
  });

  it('does not advance the simulation clock by a full background-tab pause', () => {
    expect(mapWallTimestampToSimulationMs(11_000, 11_000, 0, 1_000, 1_000, 100)).toBe(1_100);
  });
});
