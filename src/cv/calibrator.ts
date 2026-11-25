import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { distance2, distance3, landmarkConfidence, median, midpoint } from '../kinematics/math';
import { bodyLocalPoint, legsVertical, torsoLeanRad } from '../kinematics/bodyFrame';

const IDX = { leftShoulder: 11, rightShoulder: 12, leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26 } as const;

function point(points: readonly Point3[], index: number): Point3 | undefined { return points[index]; }

// O piso de qualidade é tempo de sinal válido, não contagem de frames: a oscilação
// postural dominante tem período de 2–5 s, então uma janela mais curta amostra a postura
// num extremo do balanço — erro sistemático que a mediana não remove. O pior caso que o
// design anterior aprovava (65% × 2800 ms ≈ 1,8 s válidos) vira aqui a invariante
// explícita; ver docs/pesquisa-exposicao-minima-calibracao.md.
const MIN_SPAN_MS = 2000;
const VALID_SIGNAL_MS = 1800;
const MIN_COVERAGE = 0.65;

export class Calibrator {
  private startedAt?: number;
  private collectionAt?: number;
  private samples: PoseSnapshot[] = [];

  /** `settleMs` separa a cobertura de blecaute (medida só na coleta) do tempo de sinal válido (medido desde o início). */
  start(timestampMs: number, settleMs = 0): void {
    this.startedAt = timestampMs;
    this.collectionAt = timestampMs + settleMs;
    this.samples = [];
  }

  add(snapshot: PoseSnapshot): void {
    if (this.startedAt !== undefined) this.samples.push(snapshot);
  }

  /** Não destrutivo: avalia o acumulado sem limpar, para que o chamador possa sondar a convergência e continuar coletando. */
  finish(): CalibrationProfile | null {
    if (this.startedAt === undefined || this.samples.length < 12) return null;
    const first = this.samples[0]!.timestampMs;
    const last = this.samples.at(-1)!.timestampMs;
    if (last - first < MIN_SPAN_MS) return null;

    // The stance gate needs body geometry only; the racket gate adds both wrists
    // (the dominant hand is detected at runtime, so each side needs its own
    // reference). They are counted separately — frames where the wrists and the
    // ankles drop out on different frames must not sink both references.
    const stance: { up: Point3; hipY: number; sample: PoseSnapshot }[] = [];
    const valid: {
      torsoHeight: number;
      shoulderWidth: number;
      kneeLeft: number;
      kneeRight: number;
      worldShoulderWidth: number;
      left: Point3;
      right: Point3;
      confidence: number;
    }[] = [];
    let collectedTotal = 0;
    let collectedValid = 0;
    let collectedStance = 0;
    for (const sample of this.samples) {
      const inCollection = sample.timestampMs >= (this.collectionAt ?? sample.timestampMs);
      if (inCollection) collectedTotal += 1;
      const l = sample.landmarks;
      const w = sample.worldLandmarks;
      const leftShoulder = point(l, IDX.leftShoulder);
      const rightShoulder = point(l, IDX.rightShoulder);
      const leftHip = point(l, IDX.leftHip);
      const rightHip = point(l, IDX.rightHip);
      const leftKnee = point(l, IDX.leftKnee);
      const rightKnee = point(l, IDX.rightKnee);
      const leftWrist = point(w, IDX.leftWrist);
      const rightWrist = point(w, IDX.rightWrist);
      const worldLeftShoulder = point(w, IDX.leftShoulder);
      const worldRightShoulder = point(w, IDX.rightShoulder);
      const worldLeftHip = point(w, IDX.leftHip);
      const worldRightHip = point(w, IDX.rightHip);
      if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !leftKnee || !rightKnee || !worldLeftShoulder || !worldRightShoulder || !worldLeftHip || !worldRightHip) continue;
      const bodyConfidence = landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip, leftKnee, rightKnee, worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip);
      if (bodyConfidence < 0.55) continue;
      const shoulderCenter = midpoint(leftShoulder, rightShoulder);
      const hipCenter = midpoint(leftHip, rightHip);
      const shoulderWidth = distance2(leftShoulder, rightShoulder);
      const torsoHeight = Math.abs(hipCenter.y - shoulderCenter.y);
      const worldShoulderWidth = distance3(worldLeftShoulder, worldRightShoulder);
      if (torsoHeight < 0.03 || shoulderWidth < 0.03 || worldShoulderWidth < 0.03) continue;
      const up = legsVertical(sample);
      if (up) {
        stance.push({ up, hipY: hipCenter.y, sample });
        if (inCollection) collectedStance += 1;
      }
      if (!leftWrist || !rightWrist || landmarkConfidence(leftWrist, rightWrist) < 0.55) continue;
      const confidence = Math.min(bodyConfidence, landmarkConfidence(leftWrist, rightWrist));
      const left = bodyLocalPoint(leftWrist, worldLeftShoulder, worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip, 1);
      const right = bodyLocalPoint(rightWrist, worldRightShoulder, worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip, 1);
      if (!left || !right) continue;
      valid.push({ torsoHeight, shoulderWidth, kneeLeft: (hipCenter.y - leftKnee.y) / torsoHeight, kneeRight: (hipCenter.y - rightKnee.y) / torsoHeight, worldShoulderWidth, left, right, confidence });
      if (inCollection) collectedValid += 1;
    }
    // Duas medidas distintas: o tempo de sinal válido (cobertura sobre tudo, inclusive o
    // repouso fundido) garante o piso estatístico; a razão de cobertura da janela de coleta
    // limita blecautes sem deixar o repouso — quase sempre válido — diluir a perda.
    const validRatio = valid.length / this.samples.length;
    if (validRatio * (last - first) < VALID_SIGNAL_MS) return null;
    if (collectedTotal === 0 || collectedValid < collectedTotal * MIN_COVERAGE) return null;
    // The lean and jump references are only trusted when the leg geometry verified an extended,
    // fully visible stance — a trunk-direction or bent-stance fallback would store the player's
    // posture and replay it as ghost lean or a jump baseline that never re-arms, so those
    // detectors simply stay disabled instead.
    const stanceVerified = collectedTotal > 0 && collectedStance >= collectedTotal * MIN_COVERAGE;
    let leanUp0: Point3 | undefined;
    let torsoLeanRad0 = 0;
    if (stanceVerified) {
      const upMedian = {
        x: median(stance.map((v) => v.up.x)),
        y: median(stance.map((v) => v.up.y)),
        z: median(stance.map((v) => v.up.z)),
      };
      const upMagnitude = Math.hypot(upMedian.x, upMedian.y, upMedian.z);
      if (upMagnitude >= 1e-6) {
        leanUp0 = { x: upMedian.x / upMagnitude, y: upMedian.y / upMagnitude, z: upMedian.z / upMagnitude };
        torsoLeanRad0 = median(stance.map((v) => torsoLeanRad(v.sample, leanUp0!) ?? 0));
      }
    }
    const values = <K extends keyof (typeof valid)[number]>(key: K): number[] => valid.map((item) => item[key] as number);
    const worldShoulderWidth = median(values('worldShoulderWidth'));
    const readyWrist = (hand: Hand): Point3 => ({
      x: median(valid.map((v) => v[hand].x)) / worldShoulderWidth,
      y: median(valid.map((v) => v[hand].y)) / worldShoulderWidth,
      z: median(valid.map((v) => v[hand].z)) / worldShoulderWidth,
    });
    const profile: CalibrationProfile = {
      version: 1,
      completedAtMs: last,
      image: {
        torsoHeight: median(values('torsoHeight')),
        hipY0: stanceVerified ? median(stance.map((v) => v.hipY)) : undefined,
        kneeToHipY0: { left: median(values('kneeLeft')), right: median(values('kneeRight')) },
        shoulderWidth: median(values('shoulderWidth')),
      },
      world: { shoulderWidth: worldShoulderWidth, leanUp0, torsoLeanRad0, readyWristLocal: { left: readyWrist('left'), right: readyWrist('right') } },
      quality: { validFrameRatio: valid.length / this.samples.length, medianConfidence: median(values('confidence')) },
    };
    return profile;
  }

  reset(): void { this.startedAt = undefined; this.collectionAt = undefined; this.samples = []; }
}
