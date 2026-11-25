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
  frameId: number;
  timestampMs: number;
  receivedAtMs: number;
  inferenceMs: number;
  delegate: Delegate;
  landmarks: readonly Point3[];
  worldLandmarks: readonly Point3[];
  trackingState: TrackingState;
  bodyConfidence: number;
}

export interface CalibrationProfile {
  version: 1;
  completedAtMs: number;
  dominantHand: Hand;
  image: {
    torsoHeight: number;
    hipY0: number;
    kneeToHipY0: { left: number; right: number };
    shoulderWidth: number;
    torsoLeanRad0: number;
  };
  world: { shoulderWidth: number; readyWristLocal: Point3 };
  swing?: { softSpeed: number; strongSpeed: number };
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
  frameId: number;
  timestampMs: number;
  bitmap: ImageBitmap;
}

export type WorkerRequest = WorkerInit | WorkerFrame | { type: 'DISPOSE' };

export type WorkerReply =
  | { type: 'READY'; delegate: Delegate }
  | {
      type: 'POSE';
      frameId: number;
      timestampMs: number;
      inferenceMs: number;
      delegate: Delegate;
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
  | ActionBase & { type: 'swing'; side: 'forehand' | 'backhand'; power01: number; aimZone: AimZone };

interface ActionBase {
  id: number;
  timestampMs: number;
  confidence: number;
  trackingState: 'tracked';
  source: 'cv' | 'keyboard';
}
