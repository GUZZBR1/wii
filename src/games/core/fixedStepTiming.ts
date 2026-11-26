export interface FixedStepSchedule {
  readonly timestampsMs: readonly number[];
  readonly remainderSeconds: number;
}

/** Maps catch-up simulation steps onto the interval that has elapsed on the render clock. */
export function collectFixedStepTimestamps(
  frameTimestampMs: number,
  accumulatedSeconds: number,
  stepSeconds: number,
  maxSteps: number,
): FixedStepSchedule {
  const timestampsMs: number[] = [];
  let remainderSeconds = accumulatedSeconds;

  while (remainderSeconds >= stepSeconds && timestampsMs.length < maxSteps) {
    remainderSeconds -= stepSeconds;
    timestampsMs.push(frameTimestampMs - remainderSeconds * 1000);
  }

  if (maxSteps > 0 && timestampsMs.length === maxSteps) remainderSeconds = 0;
  return { timestampsMs, remainderSeconds };
}
