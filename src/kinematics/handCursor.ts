import {
  OneEuroFilter,
  RotationalFlickDetector,
  type Hand,
  type OneEuroOptions,
  type PalmBasis,
  type Point3,
  type RotationalFlickOptions,
  type RotationalFlickPhase,
  type RotationalFlickRejection,
  type RotationalFlickState,
  type RotationalHandShape,
} from '@nevergear/spatial-core';
import { HandSwipeDetector } from './handSwipe';
import { clamp } from './math';

export interface MenuHandSnapshot {
  timestampMs: number;
  landmarks: readonly Point3[];
  handedness?: Hand | 'Left' | 'Right';
  /** bitmap.height / bitmap.width; corrects normalized distances for non-square frames. */
  aspectY?: number;
  /** 3D hand metrics in camera space, needed only for rotational flicks. */
  worldLandmarks?: readonly Point3[];
  /** Feed the rotational gesture only when HomeMenu exposes the interactive wheel. */
  rotationEnabled?: boolean;
  /** Capture-to-delivery diagnostic calculated by the sample publisher, in ms. */
  handInferenceMs?: number;
  /** Effective worker delivery-rate diagnostic calculated by the sample publisher. */
  workerFps?: number;
}

export interface HandCursorZone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface HandCursorOptions {
  activeZone?: HandCursorZone;
  syncDurationMs?: number;
  maxFrameGapMs?: number;
  lossGraceMs?: number;
  pointerAnchor?: 'tip' | 'midIndex' | 'middleMcp';
  smoothing?: OneEuroOptions;
  pinchOnRatio?: number;
  pinchOffRatio?: number;
  pinchCooldownMs?: number;
  /** Minimum time with fingers together before confirming a click. */
  pinchPressMs?: number;
  /** Also click when only the index finger bends, like a trigger. Disabled by default (arena). */
  indexTapClick?: boolean;
  /** Minimum time with the index finger bent before confirming a click. */
  tapPressMs?: number;
  backHoldMs?: number;
  fistEnterStraightness?: number;
  fistReleaseStraightness?: number;
  rotation?: RotationalFlickOptions;
}

export interface HandCursorState {
  visible: boolean;
  /** Normalized horizontal screen position; the UI multiplies it by the viewport width. */
  x: number;
  /** Normalized vertical screen position; the UI multiplies it by the viewport height. */
  y: number;
  syncProgress: number;
  synced: boolean;
  pinching: boolean;
  /** Internal pinch state, used to diagnose confirmation waits without exposing counters. */
  pinchState: 'idle' | 'candidate' | 'active';
  /** Why the cursor is frozen in this sample; absent when it follows the hand. */
  freezeReason?: 'pinch' | 'fist' | 'rotation';
  /** Confirmed click pulse on pinch activation; it does not indicate that the fingers physically opened. */
  pinchRelease: boolean;
  backProgress: number;
  /** The hand is moving quickly sideways, before or during a swipe pulse. */
  swipeMoving: boolean;
  /** Capture-to-delivery diagnostic forwarded from the input sample. */
  handInferenceMs?: number;
  /** Effective delivery-rate diagnostic forwarded from the input sample. */
  workerFps?: number;
  activeZone: HandCursorZone;
  rotationPhase: RotationalFlickPhase;
  /** Sanitized velocity the carousel can consume, in deg/s. */
  rotationAngularVelocity: number;
  /** Filtered physical speed after sensitivity, in deg/s; diagnostic only. */
  rotationFilteredAngularVelocity: number;
  rotationRawAngularVelocity: number;
  rotationDirection: -1 | 0 | 1;
  /** Single-sample pulse: wheel step requested by a sideways wave. */
  swipeDirection: -1 | 0 | 1;
  rotationCurvature: number;
  rotationHandShape: RotationalHandShape;
  rotationRejectReason?: RotationalFlickRejection;
  rotationDtMs?: number;
  rotationOrientation?: PalmBasis;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const FINGERS = [
  [INDEX_MCP, INDEX_PIP, 7, INDEX_TIP],
  [MIDDLE_MCP, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
] as const;
const DEFAULT_ZONE: HandCursorZone = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
/** Light on purpose: MediaPipe's VIDEO mode already smooths the landmarks. */
const DEFAULT_HAND_SMOOTHING: OneEuroOptions = { minCutoff: 2.2, beta: 2.0, derivativeCutoff: 1.0 };
const SCALE_MIN = 0.1;
const SCALE_MAX = 0.3;
const MAX_MARGIN = 0.27;
const SCALE_TAU_MS = 1200;
/** Smaller scale changes leave the active zone alone, so tilting the palm does not move the cursor. */
const SCALE_DEADBAND = 0.015;
/** Shorter observation gaps keep the pointer filters and hand scale: late inference, not a new hand. */
const FILTER_RESET_GAP_MS = 500;

/** A sync survives missing frames this short: they neither hide the cursor nor stop its count. */
const PRESENCE_GAP_MS = 150;

// Index-finger flex-click straightness: arm when straight, fire when bent, rearm when nearly straight.
const TAP_ARM = 0.86;
const TAP_REARM = 0.83;
const TAP_FIRE = 0.78;
/** Palm cosine drop that counts as a tap at the base of the finger, plus the rearm margin. */
const TAP_DROP_FIRE = 0.25;
const TAP_DROP_REARM = 0.1;
/** After a touch, a finger held straight in another direction for this long establishes a new reference. */
const TAP_REBASE_MS = 600;
/** Middle/ring finger drop during a bend that indicates a closing fist rather than a tap. */
const TAP_OTHERS_DROP = 0.14;
/** Time spent pointing before an index bend stops counting as a fist. */
const TAP_POINTING_MS = 150;
const TAP_COOLDOWN_MS = 300;
/** Release the aim after this duration if a partial bend never fires. */
const TAP_ABANDON_MS = 400;
/** Wrist speed, in palm widths per second, above which a bend is considered accidental. */
const TAP_MAX_WRIST_SPEED = 2.8;

/**
 * True once a rotation is committed: the cursor freezes and hover, click, back and swipe are
 * suspended. A mere candidate or a cancelled one takes nothing away from the hand.
 */
export function rotationBlocksHandInput(phase: RotationalFlickPhase): boolean {
  return phase !== 'IDLE' && phase !== 'ROTATION_CANDIDATE' && phase !== 'CANCELLED';
}

function finite(point: Point3 | undefined): point is Point3 {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function imageDistance(a: Point3, b: Point3, aspectY: number): number {
  return Math.hypot(a.x - b.x, (a.y - b.y) * aspectY);
}

function usableHand(points: readonly Point3[], aspectY: number): boolean {
  if (points.length < 21) return false;
  for (let index = 0; index < 21; index++) if (!finite(points[index])) return false;
  if (imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY) < 0.03) return false;
  const xs = points.slice(0, 21).map((point) => point.x);
  const ys = points.slice(0, 21).map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = (Math.max(...ys) - Math.min(...ys)) * aspectY;
  const boxRatio = width / Math.max(height, 1e-6);
  return boxRatio >= 0.25 && boxRatio <= 3.5;
}

function pinchRatio(points: readonly Point3[], aspectY: number): number {
  const scale = imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY);
  if (scale <= 1e-6) return Number.POSITIVE_INFINITY;
  return imageDistance(points[THUMB_TIP]!, points[INDEX_TIP]!, aspectY) / scale;
}

function worldDistance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function fingerStraightness(
  points: readonly Point3[],
  chain: readonly [number, number, number, number],
  aspectY: number,
  distance: (a: Point3, b: Point3, aspectY: number) => number = imageDistance,
): number | undefined {
  const [mcp, pip, dip, tip] = chain;
  const segments =
    distance(points[mcp]!, points[pip]!, aspectY) +
    distance(points[pip]!, points[dip]!, aspectY) +
    distance(points[dip]!, points[tip]!, aspectY);
  if (segments <= 1e-6) return undefined;
  return distance(points[mcp]!, points[tip]!, aspectY) / segments;
}

/** Points and metric for measuring fingers: use 3D worldLandmarks because the image foreshortens a pointing finger. */
interface FingerShape {
  points: readonly Point3[];
  aspectY: number;
  distance: (a: Point3, b: Point3, aspectY: number) => number;
}

function imageShape(points: readonly Point3[], aspectY: number): FingerShape {
  return { points, aspectY, distance: imageDistance };
}

function bestShape(snapshot: MenuHandSnapshot, aspectY: number): FingerShape {
  const world = snapshot.worldLandmarks;
  if (world?.length !== 21 || !world.every((point) => finite(point) && Number.isFinite(point.z)))
    return imageShape(snapshot.landmarks, aspectY);
  return { points: world, aspectY: 1, distance: worldDistance };
}

function maxFingerStraightness({ points, aspectY, distance }: FingerShape): number | undefined {
  const values = FINGERS.map((chain) => fingerStraightness(points, chain, aspectY, distance));
  if (values.some((value) => value === undefined)) return undefined;
  return Math.max(...(values as number[]));
}

function closedFist(
  shape: FingerShape,
  active: boolean,
  enterStraightness: number,
  releaseStraightness: number,
): boolean {
  const straightness = maxFingerStraightness(shape);
  if (straightness === undefined) return false;
  if (active) return straightness < releaseStraightness;
  return straightness < enterStraightness;
}

/**
 * Straightness of the index, middle, and ring fingers, and how closely the index follows the palm axis
 * (cosine between MCP-to-tip and wrist-to-middle-MCP): lowering a straight finger at its base changes only the latter.
 */
function tapFingers({ points, aspectY, distance }: FingerShape) {
  const [index, middle, ring] = FINGERS.slice(0, 3).map((chain) => fingerStraightness(points, chain, aspectY, distance));
  // Only world landmarks have comparable depth; ignore image-space z.
  const depth = distance === worldDistance ? 1 : 0;
  const direction = (from: number, to: number) => {
    const a = points[from]!;
    const b = points[to]!;
    const x = b.x - a.x;
    const y = (b.y - a.y) * aspectY;
    const z = (b.z - a.z) * depth;
    const length = Math.hypot(x, y, z) || 1;
    return { x: x / length, y: y / length, z: z / length };
  };
  const finger = direction(INDEX_MCP, INDEX_TIP);
  const palm = direction(WRIST, MIDDLE_MCP);
  const dot = finger.x * palm.x + finger.y * palm.y + finger.z * palm.z;
  return { index, others: Math.max(middle ?? 0, ring ?? 0), dot };
}

function validZone(zone: HandCursorZone): boolean {
  return (
    zone.minX >= 0 &&
    zone.minX < zone.maxX &&
    zone.maxX <= 1 &&
    zone.minY >= 0 &&
    zone.minY < zone.maxY &&
    zone.maxY <= 1
  );
}

export class HandCursorDetector {
  private readonly initialZone: HandCursorZone;
  private activeZone: HandCursorZone;
  private readonly fixedZone: boolean;
  private smoothedScale?: number;
  private zoneScale?: number;
  private readonly syncDurationMs: number;
  private readonly maxFrameGapMs: number;
  private readonly lossGraceMs: number;
  private readonly pointerAnchor: 'tip' | 'midIndex' | 'middleMcp';
  private readonly backHoldMs: number;
  private readonly fistEnterStraightness: number;
  private readonly fistReleaseStraightness: number;
  private readonly xFilter: OneEuroFilter;
  private readonly yFilter: OneEuroFilter;
  private readonly pinchOnRatio: number;
  private readonly pinchOffRatio: number;
  private readonly pinchCooldownMs: number;
  private readonly pinchPressMs: number;
  private readonly indexTapClick: boolean;
  private readonly tapPressMs: number;
  private tapArmed = false;
  private tapActive = false;
  private tapNeedsRelease = false;
  private tapFlexSinceMs?: number;
  private tapDownSinceMs?: number;
  /** Middle/ring finger values from the last frame with the index finger extended. */
  private tapArmOthers = 0;
  private tapArmDot = 0;
  private tapStraightSinceMs?: number;
  private tapPointingSinceMs?: number;
  private lastWrist?: { point: Point3; timestampMs: number };
  private readonly rotationDetector: RotationalFlickDetector;
  private readonly swipeDetector = new HandSwipeDetector();
  private pinchActive = false;
  private pinchCandidateSinceMs?: number;
  private presenceMs = 0;
  private synced = false;
  private lostSinceMs?: number;
  private missingSinceMs?: number;
  private lastTimestampMs?: number;
  private frozenPosition?: { x: number; y: number };
  private lastFreePosition?: { x: number; y: number };
  private lastPosition?: { x: number; y: number };
  private backSinceMs?: number;
  private fistActive = false;
  private pinchNeedsRelease = false;
  private fistNeedsOpen = false;
  private lastPinchClickAt = Number.NEGATIVE_INFINITY;

  constructor(options: HandCursorOptions = {}) {
    this.initialZone = { ...(options.activeZone ?? DEFAULT_ZONE) };
    if (!validZone(this.initialZone)) throw new Error('Hand cursor active zone must be inside 0..1 with min < max');
    this.activeZone = { ...this.initialZone };
    this.fixedZone = options.activeZone !== undefined;
    this.syncDurationMs = options.syncDurationMs ?? 200;
    this.maxFrameGapMs = options.maxFrameGapMs ?? 250;
    this.lossGraceMs = options.lossGraceMs ?? 650;
    this.pointerAnchor = options.pointerAnchor ?? 'middleMcp';
    this.backHoldMs = options.backHoldMs ?? 500;
    this.fistEnterStraightness = options.fistEnterStraightness ?? 0.65;
    this.fistReleaseStraightness = options.fistReleaseStraightness ?? 0.8;
    if (this.fistEnterStraightness >= this.fistReleaseStraightness)
      throw new Error('Fist enter straightness must be below release straightness');
    this.pinchOnRatio = options.pinchOnRatio ?? 0.25;
    this.pinchOffRatio = options.pinchOffRatio ?? 0.45;
    if (this.pinchOnRatio >= this.pinchOffRatio) throw new Error('Pinch on-ratio must be below the off-ratio');
    this.pinchCooldownMs = options.pinchCooldownMs ?? 250;
    this.pinchPressMs = options.pinchPressMs ?? 90;
    this.indexTapClick = options.indexTapClick ?? false;
    this.tapPressMs = options.tapPressMs ?? 35;
    this.xFilter = new OneEuroFilter(options.smoothing ?? DEFAULT_HAND_SMOOTHING);
    this.yFilter = new OneEuroFilter(options.smoothing ?? DEFAULT_HAND_SMOOTHING);
    // The inferred image is not mirrored, but the preview and cursor are. The negative sign makes
    // positive velocity mean clockwise rotation from the user's visual perspective.
    this.rotationDetector = new RotationalFlickDetector({ sensitivity: -1, ...(options.rotation ?? {}) });
  }

  update(snapshot: MenuHandSnapshot): HandCursorState {
    const aspectY = snapshot.aspectY ?? 1;
    // The handedness score is not a landmark confidence (it drops as the hand turns or closes),
    // so geometry alone decides whether the hand is usable.
    if (!usableHand(snapshot.landmarks, aspectY)) return this.missing(snapshot);

    const points = snapshot.landmarks;
    const timestampMs = snapshot.timestampMs;
    if (this.lostSinceMs !== undefined && timestampMs - this.lostSinceMs >= this.lossGraceMs) {
      this.synced = false;
      this.presenceMs = 0;
      this.smoothedScale = undefined;
    }
    const raw = this.pointer(points);
    const gap = this.lastTimestampMs === undefined ? 0 : timestampMs - this.lastTimestampMs;
    const absenceMs = this.missingSinceMs === undefined ? 0 : timestampMs - this.missingSinceMs;
    const countedPresenceGap = absenceMs > PRESENCE_GAP_MS ? 0 : gap;
    const brokenTimeline = this.lastTimestampMs !== undefined && (gap < 0 || gap > this.maxFrameGapMs);
    if (gap < 0 || gap > Math.max(FILTER_RESET_GAP_MS, this.maxFrameGapMs)) {
      this.xFilter.reset();
      this.yFilter.reset();
      this.smoothedScale = undefined;
    }
    // Held gestures rearm much sooner than the filters reset: unobserved time must never
    // complete a click or a back gesture.
    if (brokenTimeline) {
      if (gap < 0) this.presenceMs = 0;
      this.lastFreePosition = undefined;
      this.pinchActive = false;
      this.pinchCandidateSinceMs = undefined;
      this.pinchNeedsRelease = true;
      this.fistActive = false;
      this.fistNeedsOpen = true;
      this.backSinceMs = undefined;
      this.resetTap();
    }
    this.lastTimestampMs = timestampMs;
    this.lostSinceMs = undefined;
    this.missingSinceMs = undefined;

    const justSynced = !this.synced && this.updateSync(countedPresenceGap);
    if (justSynced) {
      this.xFilter.reset();
      this.yFilter.reset();
    }

    if (!this.fixedZone) {
      const rawScale = Math.max(
        imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY),
        imageDistance(points[INDEX_MCP]!, points[PINKY_MCP]!, aspectY),
      );
      if (this.smoothedScale === undefined) {
        this.smoothedScale = rawScale;
        this.zoneScale = rawScale;
      } else {
        const alpha = 1 - Math.exp(-Math.max(gap, 0) / SCALE_TAU_MS);
        this.smoothedScale += alpha * (rawScale - this.smoothedScale);
      }
      if (this.zoneScale === undefined || Math.abs(this.smoothedScale - this.zoneScale) > SCALE_DEADBAND)
        this.zoneScale = this.smoothedScale;
      const margin = clamp((this.zoneScale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * MAX_MARGIN;
      this.activeZone = { minX: margin, maxX: 1 - margin, minY: margin, maxY: 1 - margin };
    }

    const mapped = this.mapToScreen(raw);
    const smoothX = this.xFilter.filter(mapped.x, timestampMs);
    const smoothY = this.yFilter.filter(mapped.y, timestampMs);

    // Only a gesture that already owns the hand disables rotation. A pinch candidate is just
    // finger proximity noise until the press timer confirms it.
    const gestureEngaged = this.pinchActive || this.fistActive;
    const rotation = this.updateRotation(
      gestureEngaged ? { ...snapshot, rotationEnabled: false } : snapshot,
      true,
    );
    const rotationBlocking = rotationBlocksHandInput(rotation.phase);

    // The arena follows the image; with tap enabled, measure the wrist in 3D.
    const shape = this.indexTapClick ? bestShape(snapshot, aspectY) : imageShape(points, aspectY);
    const straightness = maxFingerStraightness(shape);
    if (straightness !== undefined && straightness >= this.fistReleaseStraightness) this.fistNeedsOpen = false;

    let pinching = false;
    let pinchCandidate = false;
    let pinchRelease = false;
    let backProgress = 0;
    let fist = false;
    // When the other fingers are already folded, bending the index would look like a fist; treat that pose as a tap.
    const pointing =
      this.tapArmed &&
      this.tapPointingSinceMs !== undefined &&
      (this.tapFlexSinceMs ?? timestampMs) - this.tapPointingSinceMs >= TAP_POINTING_MS;
    // Judged on the raw anchor in camera space, so neither smoothing nor the active zone delays it.
    const swipe = this.swipeDetector.update({
      timestampMs,
      x: raw.x,
      y: raw.y * aspectY,
      blocked:
        !this.synced ||
        rotationBlocking ||
        this.pinchActive ||
        this.fistActive ||
        closedFist(imageShape(points, aspectY), false, this.fistEnterStraightness, this.fistReleaseStraightness),
    });
    // Fingers touching mid-swipe, or right after it, must not click: they have to part again first.
    if (swipe.moving) this.pinchNeedsRelease = true;
    if (this.synced) {
      const updatePinch = () => {
        const ratio = pinchRatio(points, aspectY);
        if (this.pinchNeedsRelease) {
          this.pinchActive = false;
          this.pinchCandidateSinceMs = undefined;
          // Fingers seen apart mid-swipe do not count: the release has to happen once the hand slows.
          if (ratio >= this.pinchOffRatio && !swipe.moving) this.pinchNeedsRelease = false;
          return;
        }
        if (this.pinchActive) {
          if (ratio >= this.pinchOffRatio) this.pinchActive = false;
          pinching = this.pinchActive;
          return;
        }
        if (ratio > this.pinchOnRatio) {
          this.pinchCandidateSinceMs = undefined;
          return;
        }
        this.pinchCandidateSinceMs ??= timestampMs;
        if (timestampMs - this.pinchCandidateSinceMs < this.pinchPressMs) {
          pinchCandidate = true;
          return;
        }
        this.pinchCandidateSinceMs = undefined;
        this.pinchActive = true;
        pinching = true;
        if (timestampMs - this.lastPinchClickAt >= this.pinchCooldownMs) {
          this.lastPinchClickAt = timestampMs;
          pinchRelease = true;
        }
      };
      if (rotationBlocking) {
        this.pinchActive = false;
        this.pinchCandidateSinceMs = undefined;
        this.pinchNeedsRelease = true;
        this.fistActive = false;
        this.fistNeedsOpen = true;
        this.backSinceMs = undefined;
      } else if (this.fistActive) {
        this.fistActive = closedFist(shape, true, this.fistEnterStraightness, this.fistReleaseStraightness);
        fist = this.fistActive;
        if (fist) {
          this.pinchActive = false;
          this.pinchCandidateSinceMs = undefined;
          this.pinchNeedsRelease = true;
          this.backSinceMs ??= timestampMs;
          backProgress = clamp((timestampMs - this.backSinceMs) / this.backHoldMs);
        } else {
          this.backSinceMs = undefined;
          updatePinch();
        }
      } else {
        const pinchWasActive = this.pinchActive;
        updatePinch();
        this.backSinceMs = undefined;
        if (
          !pointing &&
          pinching &&
          !pinchWasActive &&
          closedFist(shape, false, this.fistEnterStraightness, this.fistReleaseStraightness)
        ) {
          pinching = false;
          pinchRelease = false;
          this.pinchActive = false;
          this.pinchCandidateSinceMs = undefined;
          this.pinchNeedsRelease = true;
          this.fistActive = true;
          fist = true;
          this.backSinceMs = timestampMs;
        }
        if (!pointing && !pinching && !fist && !this.fistNeedsOpen) {
          this.fistActive = closedFist(shape, false, this.fistEnterStraightness, this.fistReleaseStraightness);
          fist = this.fistActive;
          if (fist) {
            this.pinchActive = false;
            this.pinchCandidateSinceMs = undefined;
            this.pinchNeedsRelease = true;
            this.backSinceMs = timestampMs;
          }
        }
      }
    } else {
      this.pinchActive = false;
      this.pinchCandidateSinceMs = undefined;
      this.pinchNeedsRelease = true;
      this.fistNeedsOpen = true;
      this.backSinceMs = undefined;
      this.fistActive = false;
    }

    let tapping = false;
    let tapCandidate = false;
    if (this.indexTapClick) {
      const speed = this.wristSpeed(points, timestampMs, aspectY);
      const blocked =
        !this.synced ||
        rotationBlocking ||
        fist ||
        pinching ||
        pinchCandidate ||
        speed > TAP_MAX_WRIST_SPEED;
      const tap = this.updateTap(snapshot.timestampMs, shape, blocked);
      tapping = tap.active;
      tapCandidate = tap.candidate;
      if (tap.click) pinchRelease = true;
      // Do not also treat the same movement as a back gesture or a second pinch.
      if (tap.active) {
        this.fistNeedsOpen = true;
        this.pinchNeedsRelease = true;
      }
    }

    const candidate = { x: clamp(smoothX), y: clamp(smoothY) };
    const frozen = pinching || tapping || tapCandidate || fist || rotationBlocking;
    if (frozen) this.frozenPosition ??= this.lastFreePosition ?? candidate;
    else this.frozenPosition = undefined;
    const position = this.frozenPosition ?? candidate;
    if (!frozen) this.lastFreePosition = candidate;
    this.lastPosition = position;
    return {
      // Visible while still syncing, so the progress ring can be seen.
      visible: true,
      x: position.x,
      y: position.y,
      syncProgress: this.synced ? 1 : this.syncProgress(),
      synced: this.synced,
      pinching: pinching || tapping,
      pinchState: pinching || tapping ? 'active' : pinchCandidate || tapCandidate ? 'candidate' : 'idle',
      freezeReason: pinching || tapping || tapCandidate ? 'pinch' : fist ? 'fist' : rotationBlocking ? 'rotation' : undefined,
      pinchRelease,
      backProgress,
      swipeDirection: swipe.direction,
      swipeMoving: swipe.moving,
      handInferenceMs: snapshot.handInferenceMs,
      workerFps: snapshot.workerFps,
      activeZone: { ...this.activeZone },
      ...this.rotationOutput(rotation),
    };
  }

  reset(): void {
    this.synced = false;
    this.presenceMs = 0;
    this.activeZone = { ...this.initialZone };
    this.smoothedScale = undefined;
    this.lostSinceMs = undefined;
    this.missingSinceMs = undefined;
    this.lastTimestampMs = undefined;
    this.frozenPosition = undefined;
    this.lastFreePosition = undefined;
    this.lastPosition = undefined;
    this.backSinceMs = undefined;
    this.fistActive = false;
    this.pinchNeedsRelease = false;
    this.fistNeedsOpen = false;
    this.lastPinchClickAt = Number.NEGATIVE_INFINITY;
    this.xFilter.reset();
    this.yFilter.reset();
    this.pinchActive = false;
    this.pinchCandidateSinceMs = undefined;
    this.resetTap();
    this.rotationDetector.reset();
    this.swipeDetector.reset();
  }

  private resetTap(): void {
    this.tapArmed = false;
    this.tapActive = false;
    this.tapNeedsRelease = false;
    this.tapFlexSinceMs = undefined;
    this.tapDownSinceMs = undefined;
    this.tapPointingSinceMs = undefined;
    this.tapStraightSinceMs = undefined;
    this.lastWrist = undefined;
  }

  private wristSpeed(points: readonly Point3[], timestampMs: number, aspectY: number): number {
    const previous = this.lastWrist;
    this.lastWrist = { point: points[WRIST]!, timestampMs };
    const elapsed = previous ? timestampMs - previous.timestampMs : 0;
    if (!previous || elapsed <= 0) return 0;
    const palm = imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY);
    return imageDistance(previous.point, points[WRIST]!, aspectY) / palm / (elapsed / 1000);
  }

  /** Click by bending the index finger or lowering it straight at the base. `active` lasts from firing until the finger returns. */
  private updateTap(timestampMs: number, shape: FingerShape, blocked: boolean) {
    const { index, others, dot } = tapFingers(shape);
    const idle = { active: false, candidate: false, click: false };
    const drop = this.tapArmDot - dot;
    const flexing = index !== undefined && (index < TAP_REARM || drop > TAP_DROP_REARM);
    const closing = this.tapArmed && flexing && this.tapArmOthers - others > TAP_OTHERS_DROP;
    if (blocked || index === undefined || closing) {
      this.tapArmed = false;
      this.tapActive = false;
      this.tapFlexSinceMs = undefined;
      this.tapDownSinceMs = undefined;
      this.tapPointingSinceMs = undefined;
      this.tapStraightSinceMs = undefined;
      return idle;
    }

    if (!this.tapArmed) {
      if (index < TAP_ARM) this.tapStraightSinceMs = undefined;
      else this.tapStraightSinceMs ??= timestampMs;
      const rebased = this.tapStraightSinceMs !== undefined && timestampMs - this.tapStraightSinceMs >= TAP_REBASE_MS;
      const ready = this.tapNeedsRelease
        ? (index >= TAP_REARM && drop <= TAP_DROP_REARM) || rebased
        : index >= TAP_ARM;
      if (!ready) return { ...idle, active: this.tapActive && flexing };
      this.tapArmed = true;
      this.tapNeedsRelease = false;
      this.tapActive = false;
      this.tapArmDot = dot;
    }

    if (index >= TAP_REARM && this.tapArmDot - dot <= TAP_DROP_REARM) {
      // The reference only moves upward: gradually lowering the finger continues from its pointing direction.
      this.tapArmDot = Math.max(this.tapArmDot, dot);
      this.tapArmOthers = others;
      if (others >= this.fistEnterStraightness) this.tapPointingSinceMs = undefined;
      else this.tapPointingSinceMs ??= timestampMs;
      this.tapFlexSinceMs = undefined;
      this.tapDownSinceMs = undefined;
      return idle;
    }

    this.tapFlexSinceMs ??= timestampMs;
    if (index > TAP_FIRE && this.tapArmDot - dot < TAP_DROP_FIRE) {
      this.tapDownSinceMs = undefined;
      if (timestampMs - this.tapFlexSinceMs > TAP_ABANDON_MS) {
        this.tapArmed = false;
        return idle;
      }
      return { ...idle, candidate: true };
    }
    this.tapDownSinceMs ??= timestampMs;
    if (timestampMs - this.tapDownSinceMs < this.tapPressMs) return { ...idle, candidate: true };
    this.tapArmed = false;
    this.tapNeedsRelease = true;
    this.tapActive = true;
    this.tapStraightSinceMs = undefined;
    const click = timestampMs - this.lastPinchClickAt >= TAP_COOLDOWN_MS;
    if (click) this.lastPinchClickAt = timestampMs;
    return { active: true, candidate: false, click };
  }

  private missing(snapshot: MenuHandSnapshot): HandCursorState {
    const timestampMs = snapshot.timestampMs;
    const rotation = this.updateRotation(snapshot, false);
    this.missingSinceMs ??= timestampMs;
    if (this.synced) {
      this.lostSinceMs ??= timestampMs;
      if (timestampMs - this.lostSinceMs >= this.lossGraceMs) {
        this.synced = false;
        this.presenceMs = 0;
        this.smoothedScale = undefined;
      }
    }
    this.pinchActive = false;
    this.pinchCandidateSinceMs = undefined;
    this.pinchNeedsRelease = true;
    this.fistNeedsOpen = true;
    this.resetTap();
    this.frozenPosition = undefined;
    this.lastFreePosition = undefined;
    this.backSinceMs = undefined;
    this.fistActive = false;
    this.swipeDetector.disarm();
    const position = this.lastPosition ?? { x: 0, y: 0 };
    const stillSyncing =
      !this.synced && this.lastPosition !== undefined && timestampMs - this.missingSinceMs <= PRESENCE_GAP_MS;
    return {
      visible: this.synced || stillSyncing,
      x: position.x,
      y: position.y,
      syncProgress: this.synced ? 1 : stillSyncing ? this.syncProgress() : 0,
      synced: this.synced,
      pinching: false,
      pinchState: 'idle',
      pinchRelease: false,
      backProgress: 0,
      swipeDirection: 0,
      swipeMoving: false,
      handInferenceMs: snapshot.handInferenceMs,
      workerFps: snapshot.workerFps,
      activeZone: { ...this.activeZone },
      ...this.rotationOutput(rotation),
    };
  }

  private updateRotation(snapshot: MenuHandSnapshot, useWorldLandmarks: boolean): RotationalFlickState {
    if (snapshot.rotationEnabled !== true) {
      return this.rotationDetector.update({ timestampMs: snapshot.timestampMs, enabled: false });
    }
    return this.rotationDetector.update({
      timestampMs: snapshot.timestampMs,
      worldLandmarks: useWorldLandmarks ? snapshot.worldLandmarks : undefined,
      handedness: snapshot.handedness,
    });
  }

  private rotationOutput(rotation: RotationalFlickState) {
    return {
      rotationPhase: rotation.phase,
      rotationAngularVelocity: rotation.controlAngularVelocityDegPerSec,
      rotationFilteredAngularVelocity: rotation.angularVelocityDegPerSec,
      rotationRawAngularVelocity: rotation.rawAngularVelocityDegPerSec,
      rotationDirection: rotation.direction,
      rotationCurvature: rotation.curvature,
      rotationHandShape: rotation.handShape,
      rotationRejectReason: rotation.rejectionReason,
      rotationDtMs: rotation.dtMs,
      rotationOrientation: rotation.orientation,
    };
  }

  private pointer(points: readonly Point3[]): { x: number; y: number } {
    if (this.pointerAnchor === 'middleMcp') return { x: 1 - points[MIDDLE_MCP]!.x, y: points[MIDDLE_MCP]!.y };
    const tip = points[INDEX_TIP]!;
    const base = points[INDEX_MCP]!;
    const cameraX = this.pointerAnchor === 'tip' ? tip.x : (tip.x + base.x) / 2;
    const cameraY = this.pointerAnchor === 'tip' ? tip.y : (tip.y + base.y) / 2;
    return { x: 1 - cameraX, y: cameraY };
  }

  private mapToScreen(point: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (point.x - this.activeZone.minX) / (this.activeZone.maxX - this.activeZone.minX),
      y: (point.y - this.activeZone.minY) / (this.activeZone.maxY - this.activeZone.minY),
    };
  }

  private syncProgress(): number {
    return clamp(this.presenceMs / this.syncDurationMs);
  }

  private updateSync(frameGapMs: number): boolean {
    this.presenceMs += Math.min(Math.max(frameGapMs, 0), 100);
    if (this.presenceMs < this.syncDurationMs) return false;
    this.synced = true;
    return true;
  }
}
