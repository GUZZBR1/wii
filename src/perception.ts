import type { PoseSnapshot, SportActionEvent } from './cv/protocol';
import { AdaptiveCalibrator } from './cv/adaptiveCalibrator';
import { diagnosticsEnabled } from './cv/diagnostics/flags';
import { preferredDelegate } from './cv/delegate';
import { ActionPipeline } from './kinematics/actionPipeline';
import { hipsHidden } from './kinematics/bodyDodge';
import { ContextClassifier, type ActivityKind } from './kinematics/contextClassifier';
import {
  armsCrossed,
  framingAdvice,
  handsHidden,
  handsRaised,
  HeadWarning,
  raisedTossHand,
} from './kinematics/framing';
import { visibleImagePoint } from './kinematics/math';
import { EXIT_DODGE_SW } from './kinematics/postureSignals';
import type { GestureSample } from './games/core/restartGesture';
import type { GameEngineHandle, Sport } from './ui/GameCanvas';
import { drawPose } from './ui/PoseOverlay';

export interface PerceptionFrame {
  atMs: number;
  /** The camera/HUD label, with the activity and diagnostics suffixes when tracked. */
  trackingLabel: string;
  headCut: boolean;
  crossedPose: GestureSample | null;
  events: SportActionEvent[];
}

export interface PoseIntake {
  /** The engine this frame drives; `null` between games. */
  engine(): GameEngineHandle | null;
  /** Where the 2D skeleton is drawn: the preview canvas over the video frame. */
  overlay(): { canvas: HTMLCanvasElement | null; video: HTMLVideoElement | null };
}

/**
 * The frame-to-game chain: calibration, action detection, context, the tracking label, the 2D
 * skeleton and every engine setter live here. `App` keeps the camera, the screens and the DOM; it
 * hands each snapshot in and decides what only it can do with the result (audio, recordings, state).
 */
export class Perception {
  private readonly actions = new ActionPipeline();
  private readonly context = new ContextClassifier();
  private readonly calibrator = new AdaptiveCalibrator();
  private readonly headWarning = new HeadWarning();
  private poseTimes: number[] = [];
  /** The profile the action pipeline last ran with; it already owns the adaptive calibration. */
  private profile: ReturnType<AdaptiveCalibrator['update']> = undefined;

  recenterLane = () => this.actions.recenterLane();
  setStrokeTravel = (travel: number) => this.actions.setStrokeTravel(travel);
  setPunchTravel = (travel: number) => this.actions.setPunchTravel(travel);
  resetSwings = () => this.actions.resetSwings();

  get laneZone() {
    return this.actions.laneZone;
  }

  get dodgeZone() {
    return this.actions.dodgeZone;
  }

  /**
   * Forgets every detector and the calibration, releasing the inputs the old run held: used when the
   * camera stops and when a recording starts, so a replay begins from the same cold state as the run.
   */
  reset(intake: PoseIntake): SportActionEvent[] {
    this.calibrator.reset();
    this.profile = undefined;
    this.context.reset();
    this.headWarning.reset();
    const released = this.actions.reset(performance.now());
    drawPose(intake.overlay().canvas, intake.overlay().video);
    return released;
  }

  update(raw: PoseSnapshot, sport: Sport, intake: PoseIntake): PerceptionFrame {
    const atMs = raw.timestampMs;
    this.trackRate(atMs);
    // Implicit calibration: every observed frame is evidence. The profile is a continuously
    // improving estimate, never a mode the player has to enter or watch.
    const calibrated = sport === 'boxing'
      ? this.calibrator.update(raw, this.actions.dodgeZone, EXIT_DODGE_SW)
      : this.calibrator.update(raw, this.actions.laneZone);
    this.profile = calibrated ?? this.profile;
    const result = this.actions.update(raw, this.profile);
    const snapshot = result.snapshot;
    const decision = this.context.update(snapshot, this.profile);

    const trackingText =
      snapshot.trackingState === 'tracked' ? 'TRACKING' : snapshot.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO';
    // In development the label also says how many poses a second this machine delivers, and on what.
    const rate = diagnosticsEnabled() ? ` · ${Math.round(this.poseTimes.length / 2)} q/s ${preferredDelegate()}` : '';
    const activity = decision.confidence01 > 0.4 ? ` · ${ACTIVITY_LABEL[decision.activity]}` : '';
    const trackingLabel = trackingText === 'TRACKING' ? `TRACKING${activity}${rate}` : trackingText;

    const engine = intake.engine();
    const overlay = intake.overlay();
    engine?.setPoseTracking?.(trackingLabel, atMs);
    drawPose(overlay.canvas, overlay.video, snapshot);

    const gestureAtMs =
      snapshot.trackingState === 'tracked' &&
      [11, 12].every((index) => visibleImagePoint(snapshot.landmarks[index], 0.5))
        ? atMs
        : null;
    const wristsVisible = [15, 16].every((index) => visibleImagePoint(snapshot.landmarks[index], 0.5));
    const raised = gestureAtMs !== null && wristsVisible && handsRaised(snapshot);

    engine?.setLaneZone?.(result.controls.laneZone);
    engine?.setEffort?.(result.rawEffort, result.effortSampleAtMs);
    engine?.setFraming?.(framingAdvice(raw), handsHidden(raw));
    engine?.setHandsRaised?.(raised, gestureAtMs);
    engine?.setTossHand?.(raisedTossHand(snapshot), atMs);
    engine?.setArmMotions?.(result.armMotions);
    engine?.setSwingTracking?.(result.swingTracking);
    engine?.setDodgeZone?.(result.controls.dodgeZone, atMs);
    engine?.setGuard?.(result.controls.guard, atMs);
    engine?.setDuck?.(result.controls.duck, atMs);
    engine?.setHipsHidden?.(hipsHidden(raw), atMs);
    engine?.setDepthMove?.(result.controls.ringDepthMove, atMs);
    engine?.setDepthSpeed?.(result.controls.ringDepth01, atMs);
    engine?.setLateralDash?.(result.controls.lateralDash);

    return {
      atMs,
      trackingLabel,
      headCut: this.headWarning.update(raw),
      crossedPose: gestureAtMs === null ? null : { active: wristsVisible && armsCrossed(snapshot), atMs: gestureAtMs },
      events: result.events,
    };
  }

  private trackRate(atMs: number): void {
    this.poseTimes.push(atMs);
    while (atMs - this.poseTimes[0]! > 2000) this.poseTimes.shift();
  }
}

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  idle: 'PARADO',
  running: 'CORRIDA',
  swinging: 'RAQUETE',
  striking: 'LUTA',
};
