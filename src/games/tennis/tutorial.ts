import type { Hand } from '../../cv/protocol';
import type { Lang } from '../../i18n';

/** No progress for this long and the step explains itself; longer still and it moves on. */
export const HINT_AFTER_S = 10;
export const GIVE_UP_AFTER_S = 22;
/** Strokes are accepted shorter than usual while learning them. */
export const LEARNING_TRAVEL = 1.6;
const DEFAULT_TRAVEL = 1.9;

type Side = 'forehand' | 'backhand';
export type StepKind = 'swings' | 'other-side' | 'toss' | 'serve';

const STEPS: readonly { kind: StepKind; needed: number; title: { pt: string; en: string }; hint: { pt: string; en: string } }[] = [
  { kind: 'swings', needed: 3, title: { pt: 'Dê 3 raquetadas', en: 'Swing the racket 3 times' }, hint: { pt: 'Mostre o braço inteiro e bata de um lado ao outro', en: 'Show your whole arm and swing from side to side' } },
  { kind: 'other-side', needed: 2, title: { pt: 'Agora do outro lado', en: 'Now from the other side' }, hint: { pt: 'Comece com o braço do lado contrário', en: 'Start with the arm on the opposite side' } },
  { kind: 'toss', needed: 2, title: { pt: 'Lance a bola com a mão livre', en: 'Toss the ball with your free hand' }, hint: { pt: 'Suba a mão sem raquete até a altura do rosto', en: 'Raise your racket-free hand to face height' } },
  { kind: 'serve', needed: 2, title: { pt: 'Saque: lance e bata', en: 'Serve: toss and hit' }, hint: { pt: 'Uma mão lança, a outra bate', en: 'Toss with one hand and hit with the other' } },
];

/**
 * The on-court warm-up: no opponent, one instruction at a time, advancing as each movement is
 * recognised. It learns which arm holds the racket and how short this player's strokes are. Pure.
 */
export class TennisTutorial {
  private language: Lang;
  private index = 0;
  private count = 0;
  private idleS = 0;
  private tossed = false;
  private readonly travels: number[] = [];
  private readonly hands: Hand[] = [];
  private readonly sides: Side[] = [];

  constructor(language: Lang = 'pt') { this.language = language; }

  setLanguage(language: Lang): void { this.language = language; }

  get done(): boolean { return this.index >= STEPS.length; }
  get step(): StepKind | undefined { return STEPS[this.index]?.kind; }
  get racketHand(): Hand {
    const left = this.hands.filter((hand) => hand === 'left').length;
    return left * 2 > this.hands.length ? 'left' : 'right';
  }

  /** Most of this player's stroke length, never stricter than the default nor loose enough to misfire. */
  get strokeTravel(): number {
    if (this.travels.length < 3) return DEFAULT_TRAVEL;
    const sorted = [...this.travels].sort((a, b) => a - b);
    return Math.min(DEFAULT_TRAVEL, Math.max(LEARNING_TRAVEL, sorted[sorted.length >> 1]! * 0.75));
  }

  get text(): { title: string; detail: string } {
    const step = STEPS[this.index];
    if (!step) return this.language === 'en' ? { title: 'Ready!', detail: "Let's play" } : { title: 'Pronto!', detail: 'Vamos jogar' };
    return {
      title: step.title[this.language],
      detail: `${this.count} ${this.language === 'en' ? 'of' : 'de'} ${step.needed}${this.idleS >= HINT_AFTER_S ? ` · ${step.hint[this.language]}` : this.language === 'en' ? ' · raise both hands to skip' : ' · levante as duas mãos para pular'}`,
    };
  }

  swing(swing: { hand: Hand; side: Side; travel?: number }): boolean {
    const step = this.step;
    if (step === 'swings' || step === 'other-side') {
      // The second step wants the side the first one saw less of.
      const usual: Side = this.sides.filter((side) => side === 'forehand').length * 2 >= this.sides.length ? 'forehand' : 'backhand';
      if (step === 'other-side' && swing.side === usual) return false;
      if (step === 'swings') this.sides.push(swing.side);
      this.hands.push(swing.hand);
      if (swing.travel !== undefined) this.travels.push(swing.travel);
      return this.advance();
    }
    if (step === 'serve' && this.tossed && swing.hand === this.racketHand) {
      this.tossed = false;
      return this.advance();
    }
    return false;
  }

  toss(): boolean {
    if (this.step === 'toss') return this.advance();
    if (this.step !== 'serve') return false;
    this.tossed = true;
    return true;
  }

  /** Time only counts while the camera can see the player. */
  tick(dt: number, seen: boolean): void {
    if (this.done || !seen) return;
    this.idleS += dt;
    if (this.idleS >= GIVE_UP_AFTER_S) this.nextStep();
  }

  skip(): void { this.index = STEPS.length; }

  private advance(): boolean {
    this.count += 1;
    this.idleS = 0;
    if (this.count >= STEPS[this.index]!.needed) this.nextStep();
    return true;
  }

  private nextStep(): void {
    this.index += 1;
    this.count = 0;
    this.idleS = 0;
    this.tossed = false;
  }
}
