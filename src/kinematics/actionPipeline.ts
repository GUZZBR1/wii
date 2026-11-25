import type { CalibrationProfile, ContinuousControls, PoseSnapshot, SportActionEvent, TrackingState } from '../cv/protocol';
import { CadenceTracker } from './cadenceTracker';
import { JumpDetector } from './jumpDetector';
import { LaneLeanDetector } from './postureSignals';
import { SwingDetector } from './swingDetector';
import { TrackingGate } from './trackingGate';

export class ActionPipeline {
  private readonly bodyGate = new TrackingGate();
  private readonly cadenceGate = new TrackingGate([23, 24, 25, 26]);
  private readonly jumpGate = new TrackingGate([23, 24]);
  private readonly laneGate = new TrackingGate([11, 12, 23, 24], 'world');
  private readonly cadence = new CadenceTracker();
  private readonly jump = new JumpDetector();
  private readonly lean = new LaneLeanDetector();
  /** One detector per wrist: whichever arm swings is the racket hand. */
  private readonly swings = ([['right', 16], ['left', 15]] as const).map(([hand, wrist]) => (
    { wrist, gate: new TrackingGate([], 'world'), detector: new SwingDetector(hand) }
  ));
  private lastSwingAt = Number.NEGATIVE_INFINITY;
  private nextId = 1;
  /** True while the last emitted sprint event left the game moving. */
  private sprinting = false;

  update(snapshot: PoseSnapshot, calibration?: CalibrationProfile): { snapshot: PoseSnapshot; events: SportActionEvent[]; controls: ContinuousControls; kinematicsMs: number } {
    const start = performance.now();
    const body = this.bodyGate.evaluate(snapshot);
    const current = { ...snapshot, trackingState: body.state, bodyConfidence: body.confidence };
    if (!calibration) {
      const stopped = this.stopSprint(snapshot.timestampMs, body.confidence, 'lost');
      this.resetDetectors();
      return {
        snapshot: current, events: stopped,
        controls: { sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' },
        kinematicsMs: performance.now() - start,
      };
    }
    const events: SportActionEvent[] = [];
    let controls: ContinuousControls = { sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' };

    const cadenceTracking = this.cadenceGate.evaluate(snapshot);
    controls = { ...controls, trackingState: cadenceTracking.state };
    if (cadenceTracking.state === 'tracked') {
      const cadence = this.cadence.update(current, calibration);
      controls = { sprintSpeed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm, trackingState: 'tracked' };
      const base = this.eventBase(snapshot, cadenceTracking.confidence);
      events.push({ ...base, id: this.nextId++, type: 'sprint', speed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm });
      this.sprinting = cadence.speed01 > 0;
      if (cadence.step) events.push({ ...base, id: this.nextId++, type: 'step', side: cadence.step });
    } else {
      events.push(...this.stopSprint(snapshot.timestampMs, cadenceTracking.confidence, cadenceTracking.state));
      if (cadenceTracking.state === 'lost') this.cadence.reset();
    }

    const jumpTracking = this.jumpGate.evaluate(snapshot);
    if (jumpTracking.state === 'tracked') {
      if (this.jump.update(current, calibration)) events.push({ ...this.eventBase(snapshot, jumpTracking.confidence), id: this.nextId++, type: 'jump' });
    } else if (jumpTracking.state === 'lost') this.jump.reset();

    const laneTracking = this.laneGate.evaluate(snapshot);
    if (laneTracking.state === 'tracked') {
      const lane = this.lean.update(current, calibration);
      if (lane) events.push({ ...this.eventBase(snapshot, laneTracking.confidence), id: this.nextId++, type: 'lane', direction: lane });
    } else if (laneTracking.state === 'lost') this.lean.reset();

    const candidates = this.swings.flatMap(({ wrist, gate, detector }) => {
      const tracking = gate.evaluate(snapshot, [11, 12, 23, 24, wrist], 'world');
      if (tracking.state === 'lost') detector.reset();
      const swing = tracking.state === 'tracked' ? detector.update(current, calibration) : undefined;
      return swing ? [swing] : [];
    });
    const [swing] = candidates.sort((a, b) => b.power01 - a.power01);
    if (swing && snapshot.timestampMs - this.lastSwingAt >= 400) {
      this.lastSwingAt = snapshot.timestampMs;
      const { confidence, peakTimestampMs, ...action } = swing;
      events.push({ ...this.eventBase(snapshot, confidence), id: this.nextId++, type: 'swing', ...action, peakTimestampMs });
    }

    return { snapshot: current, events, controls, kinematicsMs: performance.now() - start };
  }

  /** Returns the events the game still needs, such as stopping a sprint in progress. */
  reset(): SportActionEvent[] {
    const stopped = this.stopSprint(performance.now(), 0, 'lost');
    this.bodyGate.reset(); this.cadenceGate.reset(); this.jumpGate.reset(); this.laneGate.reset(); this.swings.forEach(({ gate }) => { gate.reset(); });
    this.resetDetectors();
    return stopped;
  }

  private stopSprint(timestampMs: number, confidence: number, trackingState: TrackingState): SportActionEvent[] {
    if (!this.sprinting) return [];
    this.sprinting = false;
    return [{ timestampMs, confidence, trackingState, source: 'cv', id: this.nextId++, type: 'sprint', speed01: 0, cadenceSpm: 0 }];
  }

  private eventBase(snapshot: PoseSnapshot, confidence: number) {
    return { timestampMs: snapshot.timestampMs, confidence, trackingState: 'tracked' as const, source: 'cv' as const };
  }

  private resetDetectors(): void { this.cadence.reset(); this.jump.reset(); this.lean.reset(); this.swings.forEach(({ detector }) => { detector.reset(); }); this.lastSwingAt = Number.NEGATIVE_INFINITY; }
}
