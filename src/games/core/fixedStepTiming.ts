export interface FixedStepSchedule {
  readonly timestampsMs: readonly number[];
  readonly remainderSeconds: number;
}

export const MAX_FRAME_DELTA_SECONDS = 0.1;

/** Maps each executed fixed update onto a monotonically increasing simulation clock. */
export function collectFixedStepTimestamps(
  lastSimulationTimeMs: number,
  accumulatedSeconds: number,
  stepSeconds: number,
  maxSteps: number,
): FixedStepSchedule {
  const timestampsMs: number[] = [];
  let remainderSeconds = accumulatedSeconds;

  while (remainderSeconds >= stepSeconds && timestampsMs.length < maxSteps) {
    remainderSeconds -= stepSeconds;
    timestampsMs.push(lastSimulationTimeMs + (timestampsMs.length + 1) * stepSeconds * 1000);
  }

  if (maxSteps > 0 && timestampsMs.length === maxSteps) remainderSeconds = 0;
  return { timestampsMs, remainderSeconds };
}

/** Converts camera/input timestamps to the same clock as the last completed simulation step. */
export function toSimulationTimestampMs(wallTimestampMs: number, wallToSimulationOffsetMs: number): number {
  return wallTimestampMs + wallToSimulationOffsetMs;
}

export function mapWallTimestampToSimulationMs(
  eventWallTimestampMs: number,
  observedWallTimestampMs: number,
  wallToSimulationOffsetMs: number,
  lastSimulationTimeMs: number,
  lastWallTimestampMs: number,
  maxFrameDeltaMs: number,
): number {
  const projected = toSimulationTimestampMs(eventWallTimestampMs, wallToSimulationOffsetMs);
  if (!Number.isFinite(lastSimulationTimeMs) || !Number.isFinite(lastWallTimestampMs)) return projected;
  const acceptedElapsedMs = Math.min(maxFrameDeltaMs, Math.max(0, observedWallTimestampMs - lastWallTimestampMs));
  return Math.min(projected, lastSimulationTimeMs + acceptedElapsedMs);
}

export function elapsedSimulationSeconds(previousTimeMs: number, nextTimeMs: number, initialStepSeconds: number): number {
  if (!Number.isFinite(previousTimeMs)) return initialStepSeconds;
  return Math.max(0, (nextTimeMs - previousTimeMs) / 1000);
}
