import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { Calibrator, type CalibrationStability } from './calibrator';
import { distance2, distance3, isFinitePoint, landmarkConfidence } from '../kinematics/math';

const SETTLE_MS = 1000;
const COLLECT_MS = 3000;
/** Movimento máximo em coordenadas normalizadas da imagem para os joints usados no perfil. */
const STILL_TOLERANCE = 0.04;
/** Movimento 3D máximo relativo à largura do ombro; piso para não amplificar escalas degeneradas. */
const WORLD_STILL_FRACTION = 0.2;
const MIN_WORLD_STILL_METERS = 0.08;
/** Movimento sustentado muda de postura; movimento mais curto é excluído sem jogar fora o trecho estável. */
const SUSTAINED_MOVEMENT_MS = 300;
/** Ombros e quadris formam o núcleo necessário para todos os esportes. */
const REQUIRED_CORE = [11, 12, 23, 24] as const;
const WRIST_INDEX: Record<Hand, 15 | 16> = { left: 15, right: 16 };

export type CalibrationPhase = 'framing' | 'settling' | 'collecting' | 'done';
export interface CalibrationStep { phase: CalibrationPhase; progress: number; profile?: CalibrationProfile }

interface FeatureAnchor {
  imageLandmarks: Map<number, Point3>;
  worldLandmarks: Map<number, Point3>;
}

interface CoreAnchor extends FeatureAnchor {
  worldMovementTolerance: number;
  since: number;
}

/** Calibra sozinho: espera o torso enquadrado e parado, coleta evidência e invalida seletivamente o que se moveu. */
export class AutoCalibrator {
  private readonly calibrator = new Calibrator();
  private coreAnchor?: CoreAnchor;
  private wristAnchors: Partial<Record<Hand, FeatureAnchor>> = {};
  private coreUnstableSince?: number;
  private wristUnstableSince: Partial<Record<Hand, number>> = {};

  update(snapshot: PoseSnapshot, options: { needsWrists?: boolean } = {}): CalibrationStep {
    const coreVisible = REQUIRED_CORE.every((index) => snapshot.landmarks[index])
      && landmarkConfidence(...REQUIRED_CORE.map((index) => snapshot.landmarks[index]!)) >= 0.55;
    const wristVisible = (hand: Hand) => {
      const point = snapshot.landmarks[WRIST_INDEX[hand]];
      return point !== undefined && landmarkConfidence(point) >= 0.55;
    };
    const enoughWrists = !options.needsWrists || wristVisible('left') || wristVisible('right');

    if (!this.coreAnchor) {
      if (snapshot.trackingState !== 'tracked' || !coreVisible || !enoughWrists) {
        return { phase: 'framing', progress: 0 };
      }
      this.coreAnchor = this.createCoreAnchor(snapshot);
      // A coleta começa na âncora, não no fim do repouso: os frames do settling já são
      // verificados como parados, então contam como sinal válido.
      this.calibrator.start(snapshot.timestampMs, SETTLE_MS);
    }

    const stability = this.assessStability(snapshot, options, { coreVisible, wristVisible });
    this.calibrator.add(snapshot, stability);
    return this.advance(snapshot, options);
  }

  /** Marca evidência ruim como instável; invalida retroativamente só quando o movimento é sustentado. */
  private assessStability(
    snapshot: PoseSnapshot,
    options: { needsWrists?: boolean },
    visibility: { coreVisible: boolean; wristVisible: (hand: Hand) => boolean },
  ): CalibrationStability {
    const stability: CalibrationStability = { core: true, wrists: {} };

    if (visibility.coreVisible) {
      const coreMoved = this.featureMoved(snapshot, this.coreAnchor!, REQUIRED_CORE, this.coreAnchor!.worldMovementTolerance);
      if (coreMoved) {
        stability.core = false;
        this.coreUnstableSince ??= snapshot.timestampMs;
        if (snapshot.timestampMs - this.coreUnstableSince >= SUSTAINED_MOVEMENT_MS) {
          this.calibrator.invalidateCore(snapshot.timestampMs);
          this.coreAnchor = this.createCoreAnchor(snapshot);
          this.coreUnstableSince = undefined;
        }
      } else this.coreUnstableSince = undefined;
    } else {
      stability.core = false;
    }

    if (!options.needsWrists) return stability;

    for (const hand of ['left', 'right'] as const) {
      const index = WRIST_INDEX[hand];
      if (!visibility.wristVisible(hand)) {
        stability.wrists![hand] = false;
        continue;
      }
      this.wristAnchors[hand] ??= this.createFeatureAnchor(snapshot, [index]);
      const anchor = this.wristAnchors[hand]!;
      const moved = this.featureMoved(snapshot, anchor, [index], this.coreAnchor!.worldMovementTolerance);
      if (!moved) {
        this.wristUnstableSince[hand] = undefined;
        stability.wrists![hand] = true;
        continue;
      }
      stability.wrists![hand] = false;
      this.wristUnstableSince[hand] ??= snapshot.timestampMs;
      if (snapshot.timestampMs - this.wristUnstableSince[hand]! >= SUSTAINED_MOVEMENT_MS) {
        this.calibrator.invalidateWrist(hand, snapshot.timestampMs);
        this.wristAnchors[hand] = this.createFeatureAnchor(snapshot, [index]);
        this.wristUnstableSince[hand] = undefined;
      }
    }
    return stability;
  }

  /** Sonda a convergência em cada frame; cobertura boa encerra cedo e gaps estendem até o prazo. */
  private advance(snapshot: PoseSnapshot, options: { needsWrists?: boolean }): CalibrationStep {
    const stillMs = snapshot.timestampMs - this.coreAnchor!.since;
    if (stillMs < SETTLE_MS) return { phase: 'settling', progress: 0 };
    const probe = this.calibrator.finish();
    if (probe && (!options.needsWrists || probe.world.readyWristLocal)) return this.complete(probe, options);
    const progress = Math.min(1, (stillMs - SETTLE_MS) / COLLECT_MS);
    if (progress < 1) return { phase: 'collecting', progress };
    return this.conclude(options);
  }

  /** Alguma articulação da característica mudou em imagem ou em espaço mundial. */
  private featureMoved(
    snapshot: PoseSnapshot,
    anchor: FeatureAnchor,
    indices: readonly number[],
    worldMovementTolerance: number,
  ): boolean {
    for (const index of indices) {
      const imagePoint = this.confidentPoint(snapshot.landmarks, index);
      const anchoredImagePoint = anchor.imageLandmarks.get(index);
      if (anchoredImagePoint && imagePoint && distance2(imagePoint, anchoredImagePoint) > STILL_TOLERANCE) return true;

      const worldPoint = this.confidentPoint(snapshot.worldLandmarks, index);
      const anchoredWorldPoint = anchor.worldLandmarks.get(index);
      if (anchoredWorldPoint && worldPoint && distance3(worldPoint, anchoredWorldPoint) > worldMovementTolerance) return true;
    }
    return false;
  }

  private createCoreAnchor(snapshot: PoseSnapshot): CoreAnchor {
    const feature = this.createFeatureAnchor(snapshot, REQUIRED_CORE);
    const leftShoulder = feature.worldLandmarks.get(11);
    const rightShoulder = feature.worldLandmarks.get(12);
    const shoulderWidth = leftShoulder && rightShoulder ? distance3(leftShoulder, rightShoulder) : 0;
    return {
      ...feature,
      worldMovementTolerance: Math.max(MIN_WORLD_STILL_METERS, shoulderWidth * WORLD_STILL_FRACTION),
      since: snapshot.timestampMs,
    };
  }

  private createFeatureAnchor(snapshot: PoseSnapshot, indices: readonly number[]): FeatureAnchor {
    const imageLandmarks = new Map<number, Point3>();
    const worldLandmarks = new Map<number, Point3>();
    for (const index of indices) {
      const imagePoint = this.confidentPoint(snapshot.landmarks, index);
      if (imagePoint) imageLandmarks.set(index, imagePoint);
      const worldPoint = this.confidentPoint(snapshot.worldLandmarks, index);
      if (worldPoint) worldLandmarks.set(index, worldPoint);
    }
    return { imageLandmarks, worldLandmarks };
  }

  private confidentPoint(points: readonly (Point3 | undefined)[], index: number): Point3 | undefined {
    const point = points[index];
    return isFinitePoint(point) && landmarkConfidence(point) >= 0.55 ? point : undefined;
  }

  private conclude(options: { needsWrists?: boolean }): CalibrationStep {
    const profile = this.calibrator.finish();
    // Para tênis basta uma referência de punho convergida; a outra mão pode ser refinada depois.
    if (profile && (!options.needsWrists || profile.world.readyWristLocal)) return this.complete(profile, options);
    this.reset();
    return { phase: 'framing', progress: 0 };
  }

  private complete(profile: CalibrationProfile, options: { needsWrists?: boolean }): CalibrationStep {
    this.reset();
    // Corrida não pede mãos estáticas. Omitir uma referência incidental faz o tênis solicitar
    // a calibração de punhos quando o usuário trocar de modalidade.
    const completed = options.needsWrists
      ? profile
      : { ...profile, world: { ...profile.world, readyWristLocal: undefined } };
    return { phase: 'done', progress: 1, profile: completed };
  }

  reset(): void {
    this.calibrator.reset();
    this.coreAnchor = undefined;
    this.wristAnchors = {};
    this.coreUnstableSince = undefined;
    this.wristUnstableSince = {};
  }
}
