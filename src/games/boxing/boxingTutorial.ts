import type { Lang } from '../../i18n';
/** No progress for this long and the step explains itself; longer still and it moves on. */
export const HINT_AFTER_S = 9;
export const GIVE_UP_AFTER_S = 22;
/** The guard is shown, not depended on: no detector of it is reliable enough to hold anyone back. */
const GUARD_GIVE_UP_S = 8;
/** Time to read the instruction and leave the previous pose before anything is taken. */
export const SETTLE_S = 1.2;
const GUARD_S = 0.8;
export const PUNCHES_NEEDED = 5;
export const DODGE_HOLD_S = 0.4;
/** The closing test: warned attacks, each answered by any dodge inside its window. */
export const PROOF_ATTACKS = 3;
export const PROOF_NEEDED = 2;
export const PROOF_WARN_S = 1.6;
export const PROOF_WINDOW_S = 1;
const PROOF_CYCLE_S = PROOF_WARN_S + PROOF_WINDOW_S + 0.6;
/** While teaching, even a compact punch should confirm; the fight goes back to the default. */
export const LEARNING_PUNCH_TRAVEL = 0.15;

export type BoxingStepKind = 'guard' | 'punch' | 'left' | 'right' | 'duck' | 'proof';

const STEPS: readonly { kind: BoxingStepKind; title: { pt: string; en: string }; hint: { pt: string; en: string } }[] = [
  { kind: 'guard', title: { pt: 'Defesa: punhos no rosto', en: 'Guard: fists by your face' }, hint: { pt: 'Levante os dois punhos até o queixo', en: 'Raise both fists to your chin' } },
  { kind: 'punch', title: { pt: 'Soco: 5 para a frente', en: 'Punch: 5 straight ahead' }, hint: { pt: 'Estique o braço na direção da tela, rápido', en: 'Quickly extend your arm toward the screen' } },
  { kind: 'left', title: { pt: 'Esquiva: incline para a esquerda', en: 'Dodge: lean left' }, hint: { pt: 'Incline o tronco, sem tirar os pés do lugar', en: 'Lean your torso without moving your feet' } },
  { kind: 'right', title: { pt: 'Agora para a direita', en: 'Now to the right' }, hint: { pt: 'Incline o tronco, sem tirar os pés do lugar', en: 'Lean your torso without moving your feet' } },
  { kind: 'duck', title: { pt: 'Agora abaixe', en: 'Now duck' }, hint: { pt: 'Dobre os joelhos e leve a cabeça para baixo', en: 'Bend your knees and lower your head' } },
  { kind: 'proof', title: { pt: 'Prova: desvie dos socos', en: 'Test: dodge the punches' }, hint: { pt: 'Qualquer esquiva vale', en: 'Any dodge counts' } },
];

/** Continuous inputs sampled once per frame while the tutorial runs. */
export interface TutorialFrame {
  readonly dtS: number;
  readonly seen: boolean;
  readonly guard: boolean;
  readonly zone: -1 | 0 | 1;
  readonly ducked: boolean;
}


/**
 * The boxing warm-up: defense, punch and dodge, one at a time, closing with a short test. It only
 * teaches the player; the detectors follow whoever is in front of the camera on their own. Pure.
 */
export class BoxingTutorial {
  private language: Lang;
  private index = 0;
  private stepS = 0;
  private heldS = 0;
  private punches = 0;
  private proofDodged = 0;
  private proofJudged = 0;
  private dodgedThisAttack = false;
  private retried = false;
  /** Steps completed by doing them, not by giving up. */
  learned = 0;

  constructor(language: Lang = 'pt') { this.language = language; }

  setLanguage(language: Lang): void { this.language = language; }

  get done(): boolean { return this.index >= STEPS.length; }
  get step(): BoxingStepKind | undefined { return STEPS[this.index]?.kind; }
  get stepCount(): number { return STEPS.length; }
  get stepIndex(): number { return Math.min(this.index, STEPS.length - 1); }

  /** Seconds until the test punch lands; undefined when none is on its way. */
  get attackInS(): number | undefined {
    if (this.step !== 'proof' || this.stepS < SETTLE_S) return undefined;
    const left = PROOF_WARN_S - ((this.stepS - SETTLE_S) % PROOF_CYCLE_S);
    return left > -PROOF_WINDOW_S ? Math.max(0, left) : undefined;
  }

  get progress01(): number {
    const step = this.step;
    if (step === undefined) return 1;
    if (step === 'guard') return Math.min(1, this.heldS / GUARD_S);
    if (step === 'punch') return this.punches / PUNCHES_NEEDED;
    if (step === 'proof') return this.proofDodged / PROOF_NEEDED;
    return Math.min(1, this.heldS / DODGE_HOLD_S);
  }

  get text(): { title: string; detail: string } {
    const step = STEPS[this.index];
    if (!step) return this.language === 'en'
      ? { title: 'Ready!', detail: 'Now the real fight begins' }
      : { title: 'Pronto!', detail: 'Agora é pra valer' };
    const title = step.title[this.language];
    const hint = step.hint[this.language];
    let detail = this.language === 'en' ? 'Raise both hands to skip' : 'Levante as duas mãos para pular';
    if (step.kind === 'punch') detail = `${this.punches} ${this.language === 'en' ? 'of' : 'de'} ${PUNCHES_NEEDED}`;
    else if (step.kind === 'proof') detail = this.attackInS !== undefined
      ? (this.language === 'en' ? 'DODGE!' : 'ESQUIVE!')
      : `${this.proofDodged} ${this.language === 'en' ? 'of' : 'de'} ${PROOF_NEEDED}`;
    return { title, detail: this.stepS >= HINT_AFTER_S ? hint : detail };
  }

  /** Frame inputs only count while the camera can see the player. */
  tick(frame: TutorialFrame): void {
    if (this.done || !frame.seen) return;
    const step = this.step;
    this.stepS += frame.dtS;
    if (this.stepS < SETTLE_S) return;
    if (step === 'proof') {
      this.tickProof(frame);
      return;
    }
    const doing = (step === 'guard' && frame.guard) || (step === 'left' && frame.zone === -1)
      || (step === 'right' && frame.zone === 1) || (step === 'duck' && frame.ducked);
    if (doing) {
      this.heldS += frame.dtS;
      if (this.heldS >= (step === 'guard' ? GUARD_S : DODGE_HOLD_S)) {
        this.advance(true);
        return;
      }
    }
    if (this.stepS >= (step === 'guard' ? GUARD_GIVE_UP_S : GIVE_UP_AFTER_S)) this.advance(false);
  }

  /** A confirmed punch; returns true when it counted. */
  punch(): boolean {
    if (this.step !== 'punch') return false;
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
        // The dodges did not carry over: practise them once more.
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
    this.stepS = this.heldS = 0;
    this.proofDodged = this.proofJudged = this.punches = 0;
    this.dodgedThisAttack = false;
  }
}
