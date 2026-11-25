import type { CalibrationProfile, PoseSnapshot, SportActionEvent } from '../cv/protocol';
import { CadenceTracker } from './cadenceTracker';
import { JumpDetector } from './jumpDetector';
import { LaneLeanDetector } from './postureSignals';
import { SwingDetector } from './swingDetector';
import { TrackingGate } from './trackingGate';
import { landmarkConfidence } from './math';

export class ActionPipeline {
  private readonly gate = new TrackingGate();
  private readonly cadence = new CadenceTracker();
  private readonly jump = new JumpDetector();
  private readonly lean = new LaneLeanDetector();
  private readonly swing = new SwingDetector();
  private nextId = 1;

  update(snapshot: PoseSnapshot, calibration?: CalibrationProfile): { snapshot: PoseSnapshot; events: SportActionEvent[] } {
    const trackingState = this.gate.update(snapshot);
    const required = [11, 12, 15, 16, 23, 24, 25, 26].map((i) => snapshot.landmarks[i]!).filter(Boolean);
    const current = { ...snapshot, trackingState, bodyConfidence: Math.min(snapshot.bodyConfidence, landmarkConfidence(...required)) };
    if (trackingState !== 'tracked' || !calibration) {
      this.resetDetectors();
      return { snapshot: current, events: [] };
    }
    const base = { timestampMs: snapshot.timestampMs, confidence: current.bodyConfidence, trackingState: 'tracked' as const, source: 'cv' as const };
    const events: SportActionEvent[] = [];
    const cadence = this.cadence.update(current, calibration);
    events.push({ ...base, id: this.nextId++, type: 'sprint', speed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm });
    if (cadence.step) events.push({ ...base, id: this.nextId++, type: 'step', side: cadence.step });
    if (this.jump.update(current, calibration)) events.push({ ...base, id: this.nextId++, type: 'jump' });
    const lane = this.lean.update(current, calibration);
    if (lane) events.push({ ...base, id: this.nextId++, type: 'lane', direction: lane });
    const swing = this.swing.update(current, calibration);
    if (swing) events.push({ ...base, id: this.nextId++, type: 'swing', ...swing });
    return { snapshot: current, events };
  }

  reset(): void { this.gate.reset(); this.resetDetectors(); }
  private resetDetectors(): void { this.cadence.reset(); this.jump.reset(); this.lean.reset(); this.swing.reset(); }
}
