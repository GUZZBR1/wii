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
  dominantHand: Hand;
  image: {
    torsoHeight: number;
    hipY0: number;
    kneeToHipY0: { left: number; right: number };
    shoulderWidth: number;
  };
  world: {
    shoulderWidth: number;
    /**
     * Standing vertical captured at calibration from the extended legs (≈ gravity) — the fixed
     * lean reference, absorbing camera roll/pitch without inheriting the player's habitual trunk
     * posture or rotating with a lean. Calibration is rejected when the legs cannot be verified.
     */
    leanUp0: Point3;
    /** Lateral trunk lean of the neutral calibration pose; runtime lean is reported as the delta from it. */
    torsoLeanRad0: number;
    /** Dominant wrist relative to its shoulder in a body-local frame, normalized by calibrated shoulder width. */
    readyWristLocal: Point3;
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
  /**
   * 'tracked' events carry the video-frame timestamp that confirmed the action; swing also carries its estimated
   * peak-frame timestamp. Control events — emitted because the action's landmarks could not be confirmed — are
   * stamped with the frame that revealed the loss, or the capture-stop time when no frame exists. Injected
   * 'keyboard' events carry their injection time.
   */
  timestampMs: number;
  /** Confidence is the minimum visibility/presence for landmarks used by this action; 0 when no frame contributed. */
  confidence: number;
  /**
   * 'tracked' marks an action measured on a tracked pose; any other state marks a control event emitted because
   * the action's landmarks could not be confirmed — the sprint stop is 'degraded'/'lost' when tracking decays,
   * and 'lost' when calibration is absent (e.g. after a dominant-hand change) or capture stops.
   */
  trackingState: TrackingState;
  /** 'cv' events come from the pose pipeline; 'keyboard' events are injected controls, not pose measurements. */
  source: 'cv' | 'keyboard';
}
