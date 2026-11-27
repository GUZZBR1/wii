import type { Delegate, Hand, Point3, TrackingState } from '../types';

export type { Delegate, Hand, Point3, PoseSnapshot, TrackingState } from '../types';
export interface CalibrationProfile {
  version: 3;
  completedAtMs: number;
  world: {
    shoulderWidth: number;
    /** Each wrist relative to its own shoulder; each hand has an independent optional reference. */
    readyWristLocal?: Partial<Record<Hand, Point3>>;
  };
  image: {
    /**
     * Neutral shoulder-center x in normalized image coordinates, from the player's dominant
     * posture. Lane control measures lateral displacement against it: in raw camera coordinates
     * the player's own right is toward image left, so displacement rightward is centerX0 − x.
     */
    shoulderCenterX0: number;
    /**
     * Neutral shoulder width as a share of frame width, anchored at the first publication so a
     * step toward or away from the camera stays visible instead of being absorbed.
     */
    shoulderWidth0?: number;
  };
  quality: { validFrameRatio: number; medianConfidence: number };
  /**
   * Per-control convergence, when the profile comes from an online estimator. Missing means
   * a traditionally completed profile, so consumers treat every control as ready.
   */
  readiness?: { scale01: number; neutral01: number };
}

export interface WorkerInit {
  type: 'INIT';
  wasmBaseUrl: string;
  modelUrl: string;
  delegate: Delegate;
}

export interface WorkerFrame {
  type: 'FRAME';
  /** Monotonic within a PoseClient; identifies this inference request. */
  requestId: number;
  /** Changes for each capture session; stale replies must not reach the active session. */
  captureEpoch: number;
  timestampMs: number;
  bitmap: ImageBitmap;
}

export type WorkerRequest = WorkerInit | WorkerFrame | { type: 'DISPOSE' };

export type WorkerReply =
  | { type: 'READY'; delegate: Delegate }
  | {
      type: 'POSE';
      requestId: number;
      captureEpoch: number;
      timestampMs: number;
      landmarks: Point3[];
      worldLandmarks: Point3[];
      /** Pixel dimensions of the frame the normalized landmarks were measured on. */
      frameWidth: number;
      frameHeight: number;
    }
  | { type: 'FALLBACK'; from: 'GPU'; to: 'CPU'; reason: string }
  | { type: 'ERROR'; stage: 'init'; fatal: boolean; message: string }
  | { type: 'ERROR'; stage: 'detect'; fatal: boolean; message: string; requestId: number; captureEpoch: number };

export type SportActionEvent =
  | ActionBase & { type: 'sprint'; speed01: number; cadenceSpm: number }
  | ActionBase & { type: 'step'; side: Hand }
  | ActionBase & { type: 'jump' }
  /**
   * Unconfirmed real-time notice that a wrist crossed the swing onset threshold — emitted on the
   * crossing frame, ~100-400 ms before the swing confirms (if it ever does). Backswings and
   * aborted motions fire it too: use it for animation, never for adjudication.
   */
  | ActionBase & { type: 'swing-start'; hand: Hand }
  | ActionBase & {
      type: 'swing';
      side: 'forehand' | 'backhand';
      power01: number;
      peakTimestampMs?: number;
      /** Frame where the onset threshold was crossed; the stroke's physical start. */
      onsetTimestampMs?: number;
      /** Wrist height relative to its shoulder at the speed peak, in shoulder widths, up positive. */
      contactY: number;
      /** Vertical wrist speed at the peak in shoulder widths/s, up positive — topspin/slice proxy. */
      verticalSpeed: number;
    }
  /**
   * Unconfirmed real-time notice that an arm started extending forward. Feints and aborted
   * punches fire it too: use it for animation, never for adjudication.
   */
  | ActionBase & { type: 'punch-start'; hand: Hand }
  /** Confirmed punch: the arm reached extension with enough forward wrist travel. */
  | ActionBase & {
      type: 'punch';
      hand: Hand;
      /** Peak forward wrist speed mapped to 0..1. */
      power01: number;
      /** Frame with the highest forward wrist speed. */
      peakTimestampMs: number;
      /** Frame where the onset conditions were met; the punch's physical start. */
      onsetTimestampMs: number;
    };

export interface ContinuousControls {
  /**
   * Decays smoothly through brief tracking blackouts (coasting) instead of dropping in a
   * step; neutral only once the coast has run out or the sprint never started.
   */
  sprintSpeed01: number;
  cadenceSpm: number;
  trackingState: TrackingState;
  /**
   * Authoritative body lane zone from camera input: the position the player's torso actually
   * occupies, not a step to interpret. Undefined while the camera has no opinion (unready
   * calibration or untracked torso) — keyboard lane control owns the lane in the meantime.
   * Because the zone is restated every frame, it survives countdowns, pauses and remounts
   * without the dropped-step desync that relative lane events had.
   */
  laneZone?: -1 | 0 | 1;
  /**
   * Both fists are currently raised in front of the upper body. Restated every frame like the lane
   * zone; undefined while the camera has no opinion, which consumers must read as not guarding.
   */
  guard?: boolean;
  /**
   * Step in depth relative to the calibrated distance: 1 toward the camera, -1 away, 0 neutral.
   * Restated every frame; undefined while the camera has no opinion.
   */
  ringDepthMove?: -1 | 0 | 1;
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
   * the action's landmarks could not be confirmed — sprint coasting and the final stop are 'degraded'/'lost'
   * when tracking decays or capture stops. Calibration absence gates calibration-dependent controls, never
   * torso cadence itself.
   */
  trackingState: TrackingState;
  /** 'cv' events come from the pose pipeline; 'keyboard' events are injected controls, not pose measurements. */
  source: 'cv' | 'keyboard';
}
