import type {
  PalmBasis,
  RotationalFlickPhase,
  RotationalFlickRejection,
  RotationalHandShape,
} from '@nevergear/spatial-core';

export { rotationBlocksHandInput } from '../kinematics/handCursor';

/** Hand-cursor input contract. The CV pipeline writes it; the UI only reads it. */
export type HandCursorInput = {
  /** A hand is tracked and 'hand' mode is active. */
  visible: boolean;
  /** Pointer position in viewport pixels. */
  x: number;
  y: number;
  /** 0..1 while synchronizing. */
  syncProgress: number;
  synced: boolean;
  /** Pinch is held in this frame. */
  pinching: boolean;
  /** Detector pinch state; candidate does not freeze or click yet. */
  pinchState: 'idle' | 'candidate' | 'active';
  /** Why the cursor is frozen in this sample. */
  freezeReason?: 'pinch' | 'fist' | 'rotation';
  /** The pinch just confirmed a click. */
  pinchRelease: boolean;
  /** 0..1 progress for the sustained back/close gesture. */
  backProgress: number;
  /** The hand is moving quickly sideways, before or during a swipe pulse. */
  swipeMoving: boolean;
  /** Capture-to-delivery latency for the hand sample, in ms, when measured by the pipeline. */
  handInferenceMs?: number;
  /** Effective hand-worker delivery rate, in fps, when measured by the pipeline. */
  workerFps?: number;
  /** Capture timestamp from the browser's high-resolution clock; used to expire stale samples. */
  capturedAtMs?: number;
  /** Rotation state-machine phase; IDLE when the gesture is disabled or absent. */
  rotationPhase: RotationalFlickPhase;
  /** Resolved velocity ready for the carousel, in deg/s. */
  rotationAngularVelocity: number;
  rotationDirection: -1 | 0 | 1;
  /** Single-sample pulse: wheel step requested by a sideways wave. */
  swipeDirection: -1 | 0 | 1;
  /** Optional diagnostics: filtered/raw speed, curvature, 3D basis, and temporal quality. */
  rotationFilteredAngularVelocity?: number;
  rotationRawAngularVelocity?: number;
  rotationCurvature?: number;
  rotationHandShape?: RotationalHandShape;
  rotationRejectReason?: RotationalFlickRejection;
  rotationDtMs?: number;
  rotationOrientation?: PalmBasis;
};

/** Without hand data, draw and activate nothing. */
export const HAND_IDLE: HandCursorInput = {
  visible: false,
  x: 0,
  y: 0,
  syncProgress: 0,
  synced: false,
  pinching: false,
  pinchState: 'idle',
  pinchRelease: false,
  backProgress: 0,
  swipeMoving: false,
  rotationPhase: 'IDLE',
  rotationAngularVelocity: 0,
  rotationDirection: 0,
  swipeDirection: 0,
};
