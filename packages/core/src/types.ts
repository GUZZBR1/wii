export type Hand = 'left' | 'right';
export type Delegate = 'GPU' | 'CPU';
export type TrackingState = 'calibrating' | 'tracked' | 'degraded' | 'lost';

export interface Point3 {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

export interface PoseSnapshot {
  timestampMs: number;
  landmarks: readonly Point3[];
  worldLandmarks: readonly Point3[];
  trackingState: TrackingState;
  bodyConfidence: number;
  /**
   * Pixel dimensions of the frame the normalized landmarks were measured on. Needed because x
   * is normalized by width and y by height independently: any Euclidean length in image space
   * must rescale the y component by frameHeight/frameWidth first, or landscape frames inflate
   * tilted measurements.
   */
  frameWidth: number;
  frameHeight: number;
}
