import type { PoseSnapshot, TrackingState } from '../cv/protocol';
import { landmarkConfidence } from './math';

export class TrackingGate {
  private goodFrames = 0;
  private badFrames = 0;
  private state: TrackingState = 'lost';

  update(snapshot: PoseSnapshot): TrackingState {
    const l = snapshot.landmarks;
    const required = [l[11], l[12], l[15], l[16], l[23], l[24], l[25], l[26]].filter((p): p is NonNullable<typeof p> => Boolean(p));
    const confidence = landmarkConfidence(...required);
    if (required.length === 8 && confidence >= 0.55) {
      this.goodFrames += 1;
      this.badFrames = 0;
      if (this.goodFrames >= 3) this.state = 'tracked';
      else if (this.state !== 'tracked') this.state = 'degraded';
    } else {
      this.badFrames += 1;
      this.goodFrames = 0;
      if (this.badFrames >= 4) this.state = 'lost';
      else this.state = 'degraded';
    }
    return this.state;
  }

  reset(): void { this.goodFrames = 0; this.badFrames = 0; this.state = 'lost'; }
}
