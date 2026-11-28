import type { DodgeLabel } from '../../kinematics/personal/dodgeModel';

/** No progress for this long and the step explains itself; longer still and it moves on. */
export const HINT_AFTER_S = 9;
export const GIVE_UP_AFTER_S = 22;
/** The guard is shown, not depended on: no detector of it is reliable enough to hold anyone back. */
const GUARD_GIVE_UP_S = 8;
/** Time to read the instruction and leave the previous pose before anything is taken. */
export const SETTLE_S = 1.2;
export const NEUTRAL_S = 2;
const GUARD_S = 0.8;
export const PUNCHES_NEEDED = 5;
export const DODGE_HOLD_S = 1.6;
/** The closing test: warned attacks, each answered by any dodge inside its window. */
export const PROOF_ATTACKS = 3;
export const PROOF_NEEDED = 2;
export const PROOF_WARN_S = 1.6;
export const PROOF_WINDOW_S = 1;
const PROOF_CYCLE_S = PROOF_WARN_S + PROOF_WINDOW_S + 0.6;
/** While teaching, even a compact punch should confirm — the floor is generous on purpose. */
export const LEARNING_PUNCH_TRAVEL = 0.15;
/** Adapted travel never goes below noise or above the untuned default. */
const MIN_ADAPTED_TRAVEL = 0.15;
const MAX_ADAPTED_TRAVEL = 0.25;
/** Players punch a bit shorter in a fight than when demonstrating, like the tennis warm-up. */
const TRAVEL_FACTOR = 0.75;

export type BoxingStepKind = 'neutral' | 'guard' | 'punch' | 'left' | 'right' | 'duck' | 'proof';

const STEPS: readonly { kind: BoxingStepKind; title: string; hint: string }[] = [
  { kind: 'neutral', title: 'Fique à vontade', hint: 'De frente, com a cabeça e os ombros na câmera' },
  { kind: 'guard', title: 'Defesa: punhos no rosto', hint: 'Levante os dois punhos até o queixo' },
  { kind: 'punch', title: 'Soco: 5 para a frente', hint: 'Estique o braço na direção da tela, rápido' },
  { kind: 'left', title: 'Esquiva: incline para a esquerda', hint: 'Leve a cabeça e os ombros mais para o lado' },
  { kind: 'right', title: 'Agora para a direita', hint: 'Leve a cabeça e os ombros mais para o lado' },
  { kind: 'duck', title: 'Agora abaixe', hint: 'Dobre os joelhos e leve a cabeça para baixo' },
  { kind: 'proof', title: 'Prova: desvie dos socos', hint: 'Qualquer esquiva vale' },
];

/** Continuous inputs sampled once per frame while the tutorial runs. */
export interface TutorialFrame {
  readonly dtS: number;
  readonly seen: boolean;
  readonly guard: boolean;
  readonly zone: -1 | 0 | 1;
  readonly ducked: boolean;
  /** How far toward counting the pose being taught is, 0..1. */
  readonly reach: number;
}

const isDodgeStep = (kind: BoxingStepKind | undefined): kind is 'left' | 'right' | 'duck' => kind === 'left' || kind === 'right' || kind === 'duck';

/**
 * The boxing warm-up: defense, punch and dodge, one at a time, taking examples of how this player
 * does each and closing with a short test. Pure.
 */
export class BoxingTutorial {
  private index = 0;
  private stepS = 0;
  private heldS = 0;
  private punches = 0;
  private reach = 0;
  private proofDodged = 0;
  private proofJudged = 0;
  private dodgedThisAttack = false;
  private retried = false;
  private readonly travels: number[] = [];
  /** Steps completed by doing them, not by giving up. */
  learned = 0;

  get done(): boolean { return this.index >= STEPS.length; }
  get step(): BoxingStepKind | undefined { return STEPS[this.index]?.kind; }
  get stepCount(): number { return STEPS.length; }
  get stepIndex(): number { return Math.min(this.index, STEPS.length - 1); }

  /** What the camera frames are examples of right now. */
  get teaching(): DodgeLabel | undefined {
    const step = this.step;
    if (this.stepS < SETTLE_S) return undefined;
    return step === 'neutral' || isDodgeStep(step) ? step : undefined;
  }

  /** Seconds until the test punch lands; undefined when none is on its way. */
  get attackInS(): number | undefined {
    if (this.step !== 'proof' || this.stepS < SETTLE_S) return undefined;
    const left = PROOF_WARN_S - ((this.stepS - SETTLE_S) % PROOF_CYCLE_S);
    return left > -PROOF_WINDOW_S ? Math.max(0, left) : undefined;
  }

  get progress01(): number {
    const step = this.step;
    if (step === 'neutral') return Math.min(1, this.heldS / NEUTRAL_S);
    if (step === 'guard') return Math.min(1, this.heldS / GUARD_S);
    if (step === 'punch') return this.punches / PUNCHES_NEEDED;
    if (step === 'proof') return this.proofDodged / PROOF_NEEDED;
    // Mostly the hold; a movement still too small already shows how close it is.
    return step === undefined ? 1 : Math.min(1, this.heldS / DODGE_HOLD_S + (this.heldS === 0 ? this.reach * 0.15 : 0));
  }

  /**
   * Forward travel the detector should require for this player: three quarters of the median
   * demonstrated reach, clamped so it never gets stricter than the untuned default.
   */
  get punchTravel(): number | undefined {
    const sorted = [...this.travels].sort((a, b) => a - b);
    const center = sorted[sorted.length >> 1];
    return center === undefined ? undefined : Math.min(MAX_ADAPTED_TRAVEL, Math.max(MIN_ADAPTED_TRAVEL, center * TRAVEL_FACTOR));
  }

  get text(): { title: string; detail: string } {
    const step = STEPS[this.index];
    if (!step) return { title: 'Pronto!', detail: 'Agora é pra valer' };
    let detail = 'Levante as duas mãos para pular';
    if (step.kind === 'punch') detail = `${this.punches} de ${PUNCHES_NEEDED}`;
    else if (step.kind === 'proof') detail = this.attackInS !== undefined ? 'ESQUIVE!' : `${this.proofDodged} de ${PROOF_NEEDED}`;
    else if (isDodgeStep(step.kind) && this.stepS >= SETTLE_S) detail = this.heldS > 0 ? 'Isso, segure!' : this.reach > 0.4 ? 'Quase! Um pouco mais' : step.hint;
    return { title: step.title, detail: this.stepS >= HINT_AFTER_S && !isDodgeStep(step.kind) ? step.hint : detail };
  }

  /** Frame inputs only count while the camera can see the player. */
  tick(frame: TutorialFrame): void {
    if (this.done || !frame.seen) return;
    const step = this.step;
    this.stepS += frame.dtS;
    this.reach = frame.reach;
    if (this.stepS < SETTLE_S) return;
    if (step === 'proof') {
      this.tickProof(frame);
      return;
    }
    if (step === 'neutral' || (step === 'guard' && frame.guard) || (isDodgeStep(step) && frame.reach >= 1)) {
      this.heldS += frame.dtS;
      if (this.heldS >= (step === 'neutral' ? NEUTRAL_S : step === 'guard' ? GUARD_S : DODGE_HOLD_S)) {
        this.advance(true);
        return;
      }
    }
    if (this.stepS >= (step === 'guard' ? GUARD_GIVE_UP_S : GIVE_UP_AFTER_S)) this.advance(false);
  }

  /** A confirmed punch; returns true when it counted. */
  punch(travelSw?: number): boolean {
    if (this.step !== 'punch') return false;
    if (travelSw !== undefined && Number.isFinite(travelSw)) this.travels.push(travelSw);
    this.punches += 1;
    if (this.punches >= PUNCHES_NEEDED) this.advance(true);
    return true;
  }

  skip(): void { this.index = STEPS.length; }

  private tickProof(frame: TutorialFrame): void {
    const into = (this.stepS - SETTLE_S) % PROOF_CYCLE_S;
    const inWindow = into >= PROOF_WARN_S - 0.4 && into <= PROOF_WARN_S + PROOF_WINDOW_S;
    if (inWindow && (frame.zone !== 0 || frame.ducked)) this.dodgedThisAttack = true;
    const judged = Math.floor((this.stepS - SETTLE_S + PROOF_CYCLE_S - PROOF_WARN_S - PROOF_WINDOW_S) / PROOF_CYCLE_S);
    if (judged <= this.proofJudged) return;
    this.proofJudged = judged;
    if (this.dodgedThisAttack) this.proofDodged += 1;
    this.dodgedThisAttack = false;
    if (this.proofDodged >= PROOF_NEEDED) this.advance(true);
    else if (this.proofJudged >= PROOF_ATTACKS) {
      if (this.retried) this.advance(false);
      else {
        // The dodges did not carry over: take their examples once more.
        this.retried = true;
        this.index = STEPS.findIndex(({ kind }) => kind === 'left');
        this.resetStep();
      }
    }
  }

  private advance(learned: boolean): void {
    if (learned) this.learned += 1;
    this.index += 1;
    this.resetStep();
  }

  private resetStep(): void {
    this.stepS = this.heldS = this.reach = 0;
    this.proofDodged = this.proofJudged = this.punches = 0;
    this.dodgedThisAttack = false;
  }
}
