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
  /** Core shoulders/hips status; each sport action carries confidence from its own landmark gate. */
  trackingState: TrackingState;
  bodyConfidence: number;
}

export interface CalibrationProfile {
  version: 1;
  completedAtMs: number;
  image: {
    torsoHeight: number;
    hipY0: number;
    kneeToHipY0: { left: number; right: number };
    shoulderWidth: number;
  };
  world: {
    shoulderWidth: number;
    torsoLeanRad0: number;
    /** Each wrist relative to its shoulder in a body-local frame, normalized by calibrated shoulder width. */
    readyWristLocal: Record<Hand, Point3>;
  };
  quality: { validFrameRatio: number; medianConfidence: number };
}

export interface WorkerInit {
  type: 'INIT';
  wasmBaseUrl: string;
  modelUrl: string;
  delegate: Delegate;
}

export interface WorkerFrame {
  type: 'FRAME';
  timestampMs: number;
  bitmap: ImageBitmap;
}

export type WorkerRequest = WorkerInit | WorkerFrame | { type: 'DISPOSE' };

export type WorkerReply =
  | { type: 'READY'; delegate: Delegate }
  | {
      type: 'POSE';
      timestampMs: number;
      landmarks: Point3[];
      worldLandmarks: Point3[];
    }
  | { type: 'FALLBACK'; from: 'GPU'; to: 'CPU'; reason: string }
  | { type: 'ERROR'; stage: 'init' | 'detect'; fatal: boolean; message: string };

export type AimZone = 'cross' | 'center' | 'line';
export type SportActionEvent =
  | ActionBase & { type: 'sprint'; speed01: number; cadenceSpm: number }
  | ActionBase & { type: 'step'; side: Hand }
  | ActionBase & { type: 'jump' }
  | ActionBase & { type: 'lane'; direction: 'left' | 'right' }
  | ActionBase & { type: 'swing'; side: 'forehand' | 'backhand'; power01: number; aimZone: AimZone; peakTimestampMs?: number };

export interface ContinuousControls {
  /** Always neutral when cadence tracking is degraded or lost. */
  sprintSpeed01: number;
  cadenceSpm: number;
  trackingState: TrackingState;
}

interface ActionBase {
  id: number;
  /** Video-frame timestamp that confirmed this event; swing also carries its estimated peak-frame timestamp. */
  timestampMs: number;
  /** Confidence is the minimum visibility/presence for landmarks used by this action. */
  confidence: number;
  trackingState: 'tracked';
  source: 'cv' | 'keyboard';
}
