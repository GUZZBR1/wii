import type { CalibrationProfile, Point3, PoseSnapshot } from './protocol';
import { Calibrator } from './calibrator';
import { distance2, landmarkConfidence, midpoint } from '../kinematics/math';

const SETTLE_MS = 1000;
const COLLECT_MS = 3000;
/** Quanto ombros ou quadris podem andar na imagem (0–1) e ainda contar como parado. */
const STILL_TOLERANCE = 0.04;
/** Ombros, punhos, quadris e joelhos: o que o Calibrator precisa enxergar. */
const REQUIRED = [11, 12, 15, 16, 23, 24, 25, 26] as const;

export type CalibrationPhase = 'framing' | 'settling' | 'collecting' | 'done';
export interface CalibrationStep { phase: CalibrationPhase; progress: number; profile?: CalibrationProfile }

/** Calibra sozinho: espera o corpo enquadrado e parado, coleta e tenta de novo se falhar. */
export class AutoCalibrator {
  private readonly calibrator = new Calibrator();
  private anchor?: { shoulders: Point3; hips: Point3; since: number };
  private collecting = false;

  update(snapshot: PoseSnapshot): CalibrationStep {
    const visible = REQUIRED.every((index) => snapshot.landmarks[index]) && landmarkConfidence(...REQUIRED.map((index) => snapshot.landmarks[index]!)) >= 0.55;
    if (snapshot.trackingState === 'lost' || (!visible && !this.collecting)) {
      this.reset();
      return { phase: 'framing', progress: 0 };
    }
    // Um quadro ruim isolado não reinicia a contagem — mas durante a coleta ele conta no
    // denominador de cobertura: o Calibrator ignora quadros inválidos nas medianas, não no total.
    if (snapshot.trackingState !== 'tracked' || !visible) {
      if (this.collecting) {
        this.calibrator.add(snapshot);
        const progress = Math.min(1, (snapshot.timestampMs - this.anchor!.since - SETTLE_MS) / COLLECT_MS);
        return { phase: 'collecting', progress: Math.max(0, progress) };
      }
      return { phase: this.anchor ? 'settling' : 'framing', progress: 0 };
    }

    const l = snapshot.landmarks;
    const shoulders = midpoint(l[11]!, l[12]!);
    const hips = midpoint(l[23]!, l[24]!);
    if (!this.anchor || distance2(shoulders, this.anchor.shoulders) > STILL_TOLERANCE || distance2(hips, this.anchor.hips) > STILL_TOLERANCE) {
      this.reset();
      this.anchor = { shoulders, hips, since: snapshot.timestampMs };
    }
    const stillMs = snapshot.timestampMs - this.anchor.since;
    if (stillMs < SETTLE_MS) return { phase: 'settling', progress: 0 };
    if (!this.collecting) {
      this.calibrator.start(snapshot.timestampMs);
      this.collecting = true;
    }
    this.calibrator.add(snapshot);
    const progress = Math.min(1, (stillMs - SETTLE_MS) / COLLECT_MS);
    if (progress < 1) return { phase: 'collecting', progress };
    const profile = this.calibrator.finish();
    this.reset();
    return profile ? { phase: 'done', progress: 1, profile } : { phase: 'framing', progress: 0 };
  }

  reset(): void { this.calibrator.reset(); this.anchor = undefined; this.collecting = false; }
}
