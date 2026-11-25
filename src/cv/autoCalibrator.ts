import type { CalibrationProfile, Point3, PoseSnapshot } from './protocol';
import { Calibrator } from './calibrator';
import { distance2, distance3, isFinitePoint, landmarkConfidence } from '../kinematics/math';

const SETTLE_MS = 1000;
const COLLECT_MS = 3000;
/** Movimento máximo em coordenadas normalizadas da imagem para os joints usados no perfil. */
const STILL_TOLERANCE = 0.04;
/** Movimento 3D máximo relativo à largura do ombro; piso para não amplificar escalas degeneradas. */
const WORLD_STILL_FRACTION = 0.2;
const MIN_WORLD_STILL_METERS = 0.08;
/** Ombros, punhos, quadris e joelhos: o que o Calibrator precisa enxergar. */
const REQUIRED = [11, 12, 15, 16, 23, 24, 25, 26] as const;
/** A postura em pé (salto e raia) só se verifica com os tornozelos: a corrida não abre mão dela. */
const REQUIRED_STANCE = [...REQUIRED, 27, 28] as const;
/** Todas as articulações que podem entrar nos valores de referência do perfil. */
const CALIBRATION_LANDMARKS = [11, 12, 15, 16, 23, 24, 25, 26, 27, 28] as const;

export type CalibrationPhase = 'framing' | 'settling' | 'collecting' | 'done';
export interface CalibrationStep { phase: CalibrationPhase; progress: number; profile?: CalibrationProfile }

/** Calibra sozinho: espera o corpo enquadrado e parado, coleta e tenta de novo se falhar. */
export class AutoCalibrator {
  private readonly calibrator = new Calibrator();
  private anchor?: {
    imageLandmarks: Map<number, Point3>;
    worldLandmarks: Map<number, Point3>;
    worldMovementTolerance: number;
    since: number;
  };

  update(snapshot: PoseSnapshot, needsStance = false): CalibrationStep {
    const required = needsStance ? REQUIRED_STANCE : REQUIRED;
    const visible = required.every((index) => snapshot.landmarks[index]) && landmarkConfidence(...required.map((index) => snapshot.landmarks[index]!)) >= 0.55;
    // Sem âncora não há investimento a proteger: quadro ruim é só enquadramento.
    if (!this.anchor && (snapshot.trackingState !== 'tracked' || !visible)) {
      return { phase: 'framing', progress: 0 };
    }
    // Ancorado, todo quadro ruim conta no denominador de cobertura e no prazo — inclusive no
    // repouso, porque com a fusão o investimento começa na âncora, não na coleta. Um frame
    // visível prova onde o corpo está mesmo sem o gate ter voltado a 'tracked': antes de entrar
    // na cobertura ele re-verifica a imobilidade — flapping após um blecaute não pode esconder
    // um deslocamento que contaminaria as medianas. Só um frame 'tracked' prova estabilidade
    // para re-ancorar; aqui, mover derruba a tentativa.
    if (snapshot.trackingState !== 'tracked' || !visible) {
      if (visible && this.moved(snapshot)) {
        this.reset();
        return { phase: 'framing', progress: 0 };
      }
      this.calibrator.add(snapshot);
      return this.advance(snapshot, needsStance);
    }

    if (!this.anchor || this.moved(snapshot)) {
      this.reset();
      this.anchor = this.createAnchor(snapshot);
      // A coleta começa na âncora, não no fim do repouso: os frames do settling já são
      // verificados como parados, então contam como sinal válido — a invariante de
      // qualidade é tempo de sinal válido, e o repouso é o trecho mais estável da janela.
      this.calibrator.start(snapshot.timestampMs, SETTLE_MS);
    }
    this.calibrator.add(snapshot);
    return this.advance(snapshot, needsStance);
  }

  /** Fase pelo tempo desde a âncora e sonda a convergência a cada frame: o finish() decide sozinho quando a qualidade fecha — condições boas terminam cedo, degradadas esticam até o prazo. */
  private advance(snapshot: PoseSnapshot, needsStance: boolean): CalibrationStep {
    const stillMs = snapshot.timestampMs - this.anchor!.since;
    if (stillMs < SETTLE_MS) return { phase: 'settling', progress: 0 };
    const probe = this.calibrator.finish();
    if (probe && (!needsStance || probe.world.leanUp0)) {
      this.reset();
      return { phase: 'done', progress: 1, profile: probe };
    }
    const progress = Math.min(1, (stillMs - SETTLE_MS) / COLLECT_MS);
    if (progress < 1) return { phase: 'collecting', progress };
    return this.conclude(needsStance);
  }

  /** Alguma articulação usada no perfil mudou em imagem ou em espaço mundial. */
  private moved(snapshot: PoseSnapshot): boolean {
    for (const index of CALIBRATION_LANDMARKS) {
      const imagePoint = this.confidentPoint(snapshot.landmarks, index);
      const anchoredImagePoint = this.anchor!.imageLandmarks.get(index);
      if (!anchoredImagePoint && imagePoint) return true;
      if (anchoredImagePoint && imagePoint && distance2(imagePoint, anchoredImagePoint) > STILL_TOLERANCE) return true;

      const worldPoint = this.confidentPoint(snapshot.worldLandmarks, index);
      const anchoredWorldPoint = this.anchor!.worldLandmarks.get(index);
      if (!anchoredWorldPoint && worldPoint) return true;
      if (anchoredWorldPoint && worldPoint && distance3(worldPoint, anchoredWorldPoint) > this.anchor!.worldMovementTolerance) return true;
    }
    return false;
  }

  private createAnchor(snapshot: PoseSnapshot) {
    const imageLandmarks = new Map<number, Point3>();
    const worldLandmarks = new Map<number, Point3>();
    for (const index of CALIBRATION_LANDMARKS) {
      const imagePoint = this.confidentPoint(snapshot.landmarks, index);
      if (imagePoint) imageLandmarks.set(index, imagePoint);
      const worldPoint = this.confidentPoint(snapshot.worldLandmarks, index);
      if (worldPoint) worldLandmarks.set(index, worldPoint);
    }
    const leftShoulder = worldLandmarks.get(11);
    const rightShoulder = worldLandmarks.get(12);
    const shoulderWidth = leftShoulder && rightShoulder ? distance3(leftShoulder, rightShoulder) : 0;
    return {
      imageLandmarks,
      worldLandmarks,
      worldMovementTolerance: Math.max(MIN_WORLD_STILL_METERS, shoulderWidth * WORLD_STILL_FRACTION),
      since: snapshot.timestampMs,
    };
  }

  private confidentPoint(points: readonly (Point3 | undefined)[], index: number): Point3 | undefined {
    const point = points[index];
    return isFinitePoint(point) && landmarkConfidence(point) >= 0.55 ? point : undefined;
  }

  private conclude(needsStance: boolean): CalibrationStep {
    const profile = this.calibrator.finish();
    this.reset();
    // Sem a vertical das pernas não há salto nem raia: na corrida isso é calibração incompleta,
    // não parcial — volta ao enquadramento. No tênis o perfil sem stance segue útil.
    if (profile && (!needsStance || profile.world.leanUp0)) return { phase: 'done', progress: 1, profile };
    return { phase: 'framing', progress: 0 };
  }

  reset(): void { this.calibrator.reset(); this.anchor = undefined; }
}
