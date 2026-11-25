import type { AimZone, CalibrationProfile, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '../cv/oneEuroFilter';
import { clamp, distance3 } from './math';

export interface SwingSignal { side: 'forehand' | 'backhand'; power01: number; aimZone: AimZone; confidence: number }

export class SwingDetector {
  private readonly xFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private readonly yFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private readonly zFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private previous?: { x: number; y: number; z: number; time: number };
  private mode: 'ready' | 'swing' | 'return' = 'ready';
  private lastSwingAt = Number.NEGATIVE_INFINITY;
  private readySince?: number;
  private softSpeed = 2;
  private strongSpeed = 7;

  setPowerAnchors(softSpeed: number, strongSpeed: number): void {
    this.softSpeed = Math.max(0.2, softSpeed);
    this.strongSpeed = Math.max(this.softSpeed + 0.2, strongSpeed);
  }

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): SwingSignal | undefined {
    const hand = calibration.dominantHand;
    const wrist = snapshot.worldLandmarks[hand === 'right' ? 16 : 15]!;
    const shoulder = snapshot.worldLandmarks[hand === 'right' ? 12 : 11]!;
    const leftShoulder = snapshot.worldLandmarks[11]!;
    const rightShoulder = snapshot.worldLandmarks[12]!;
    const lateral = { x: rightShoulder.x - leftShoulder.x, y: rightShoulder.y - leftShoulder.y, z: rightShoulder.z - leftShoulder.z };
    const width = Math.hypot(lateral.x, lateral.y, lateral.z) || calibration.world.shoulderWidth;
    const current = {
      x: this.xFilter.filter((wrist.x - shoulder.x) / width, snapshot.timestampMs),
      y: this.yFilter.filter((wrist.y - shoulder.y) / width, snapshot.timestampMs),
      z: this.zFilter.filter((wrist.z - shoulder.z) / width, snapshot.timestampMs),
      time: snapshot.timestampMs,
    };
    if (!this.previous) { this.previous = current; return undefined; }
    const dt = Math.max((current.time - this.previous.time) / 1000, 1 / 120);
    const vx = (current.x - this.previous.x) / dt;
    const vy = (current.y - this.previous.y) / dt;
    const vz = (current.z - this.previous.z) / dt;
    const speed = Math.hypot(vx, vy, vz);
    const lateralSpeed = (vx * lateral.x + vy * lateral.y + vz * lateral.z) / width;
    const readyDistance = distance3(current, calibration.world.readyWristLocal);
    this.previous = current;

    if (this.mode === 'ready' && speed >= 2 && snapshot.timestampMs - this.lastSwingAt >= 400) {
      this.mode = 'swing';
      this.lastSwingAt = snapshot.timestampMs;
      const forehandDirection = hand === 'right' ? lateralSpeed < 0 : lateralSpeed > 0;
      const aimValue = (current.x - calibration.world.readyWristLocal.x) * (hand === 'right' ? -1 : 1);
      const aimZone: AimZone = aimValue < -0.2 ? 'cross' : aimValue > 0.2 ? 'line' : 'center';
      return {
        side: forehandDirection ? 'forehand' : 'backhand',
        power01: clamp((speed - this.softSpeed) / (this.strongSpeed - this.softSpeed)),
        aimZone,
        confidence: Math.min(wrist.visibility ?? 0.8, shoulder.visibility ?? 0.8),
      };
    }
    if (this.mode === 'swing') this.mode = 'return';
    if (this.mode === 'return') {
      if (readyDistance < 0.35 && speed < 1.2) {
        this.readySince ??= snapshot.timestampMs;
        if (snapshot.timestampMs - this.readySince >= 180) this.mode = 'ready';
      } else this.readySince = undefined;
    }
    return undefined;
  }

  reset(): void { this.xFilter.reset(); this.yFilter.reset(); this.zFilter.reset(); this.previous = undefined; this.mode = 'ready'; this.lastSwingAt = Number.NEGATIVE_INFINITY; this.readySince = undefined; }
}
