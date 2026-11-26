import type { PoseSnapshot, TrackingState } from '../cv/protocol';
import { landmarkConfidence } from './math';

const CORE_BODY_LANDMARKS = [11, 12, 23, 24] as const;
/**
 * Consecutive bad frames before 'lost' — ~270 ms at 30 fps, ~530 ms at 15 fps. Short enough
 * to catch a real blackout, long enough that a fast jump or a blur burst stays 'degraded'
 * instead of resetting the cadence/jump/channel state that 'lost' clears downstream.
 */
const BAD_FRAMES_TO_LOST = 8;
export type LandmarkSpace = 'image' | 'world';

export class TrackingGate {
  private goodFrames = 0;
  private badFrames = 0;
  private state: TrackingState = 'lost';

  constructor(
    private readonly requiredIndices: readonly number[] = CORE_BODY_LANDMARKS,
    private readonly space: LandmarkSpace = 'image',
  ) {}

  evaluate(
    snapshot: PoseSnapshot,
    requiredIndices: readonly number[] = this.requiredIndices,
    space: LandmarkSpace = this.space,
  ): { state: TrackingState; confidence: number } {
    const points = space === 'world' ? snapshot.worldLandmarks : snapshot.landmarks;
    const required = requiredIndices.map((index) => points[index]);
    const complete = required.length > 0 && required.every((point) => point !== undefined);
    const confidence = complete ? landmarkConfidence(...required) : 0;
    if (complete && confidence >= 0.55) {
      this.goodFrames += 1;
      this.badFrames = 0;
      if (this.goodFrames >= 3) this.state = 'tracked';
      else if (this.state !== 'tracked') this.state = 'degraded';
    } else {
      this.badFrames += 1;
      this.goodFrames = 0;
      if (this.badFrames >= BAD_FRAMES_TO_LOST) this.state = 'lost';
      else this.state = 'degraded';
    }
    return { state: this.state, confidence };
  }

  reset(): void { this.goodFrames = 0; this.badFrames = 0; this.state = 'lost'; }
}
