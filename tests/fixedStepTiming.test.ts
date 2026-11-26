import { describe, expect, it } from 'vitest';
import { collectFixedStepTimestamps } from '../src/games/core/fixedStepTiming';

describe('fixed-step simulation timestamps', () => {
  it('gives separate simulation times to catch-up steps in a 30 Hz frame', () => {
    const fixed = 1 / 60;
    const frameTimeMs = 1_033.333333;
    const result = collectFixedStepTimestamps(frameTimeMs, 1 / 30, fixed, 5);

    expect(result.timestampsMs).toHaveLength(2);
    expect(result.timestampsMs[0]).toBeCloseTo(1_016.666666, 5);
    expect(result.timestampsMs[1]).toBeCloseTo(frameTimeMs, 5);
    expect(result.timestampsMs[1]! - result.timestampsMs[0]!).toBeCloseTo(1_000 / 60, 5);
    expect(result.remainderSeconds).toBeCloseTo(0, 8);
  });

  it('retains a fractional frame remainder when no full step is due', () => {
    const result = collectFixedStepTimestamps(2_000, 1 / 120, 1 / 60, 5);

    expect(result.timestampsMs).toEqual([]);
    expect(result.remainderSeconds).toBeCloseTo(1 / 120, 10);
  });

  it('keeps the existing catch-up limit and drops excess accumulated time', () => {
    const result = collectFixedStepTimestamps(3_000, 0.12, 1 / 60, 5);

    expect(result.timestampsMs).toHaveLength(5);
    expect(result.remainderSeconds).toBe(0);
  });
});
