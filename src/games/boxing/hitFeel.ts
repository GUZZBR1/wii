/**
 * What makes a blow felt: how long the picture freezes, how hard the view shakes and punches in,
 * how far the struck body recoils and how long a knockout plays slowed down. One table, so every
 * kind of contact keeps its place in the scale. Visual only: rules and fight clock never see it.
 */
export type HitKind = 'hit' | 'heavy' | 'counter' | 'blocked' | 'taken' | 'ko';

export interface HitFeel {
  /** Animation freeze at contact. */
  stopS: number;
  /** Peak camera shake, metres. */
  shakeM: number;
  /** Field of view taken away at contact, degrees. */
  zoomDeg: number;
  /** How far the struck boxer is thrown back, metres. */
  recoilM: number;
  /** Wall time the animation runs slowed after the freeze. */
  slowS: number;
}

export const HIT_FEEL: Readonly<Record<HitKind, Readonly<HitFeel>>> = {
  blocked: { stopS: 0.035, shakeM: 0.015, zoomDeg: 0.5, recoilM: 0.05, slowS: 0 },
  hit: { stopS: 0.06, shakeM: 0.035, zoomDeg: 1.8, recoilM: 0.16, slowS: 0 },
  heavy: { stopS: 0.11, shakeM: 0.075, zoomDeg: 4, recoilM: 0.32, slowS: 0 },
  counter: { stopS: 0.13, shakeM: 0.085, zoomDeg: 5, recoilM: 0.36, slowS: 0 },
  taken: { stopS: 0.08, shakeM: 0.11, zoomDeg: 2.5, recoilM: 0.22, slowS: 0 },
  ko: { stopS: 0.2, shakeM: 0.13, zoomDeg: 7, recoilM: 0.5, slowS: 1.4 },
};

/** From this power on a clean punch lands as a heavy one. */
export const HEAVY_POWER01 = 0.7;
export const SLOW_MOTION_RATE = 0.35;
const SETTLE_S = 0.28;

export function playerHitKind(damage: number, power01: number, counter: boolean, ko: boolean): HitKind {
  if (damage <= 0) return 'blocked';
  if (ko) return 'ko';
  if (counter) return 'counter';
  return power01 >= HEAVY_POWER01 ? 'heavy' : 'hit';
}

/** The decaying aftermath of the latest contact. Advance it with unfrozen wall time. */
export class HitImpulse {
  private feel: HitFeel = HIT_FEEL.blocked;
  private ageS = SETTLE_S;
  private slowLeftS = 0;
  struck: 'opponent' | 'player' = 'opponent';

  /** `reducedMotion` drops what moves the whole view and keeps what happens inside it. */
  constructor(private readonly reducedMotion = false) {}

  trigger(kind: HitKind, struck: 'opponent' | 'player'): void {
    this.feel = HIT_FEEL[kind];
    this.struck = struck;
    this.ageS = 0;
    this.slowLeftS = this.feel.slowS;
  }

  step(dtS: number): void {
    this.ageS = Math.min(SETTLE_S, this.ageS + dtS);
    this.slowLeftS = Math.max(0, this.slowLeftS - dtS);
  }

  private get fade(): number {
    return (1 - this.ageS / SETTLE_S) ** 2;
  }

  get animationRate(): number { return this.slowLeftS > 0 ? SLOW_MOTION_RATE : 1; }
  get recoilM(): number { return this.feel.recoilM * this.fade; }
  get zoomDeg(): number { return this.reducedMotion ? 0 : this.feel.zoomDeg * this.fade; }

  get shake(): { x: number; y: number } {
    const amount = this.reducedMotion ? 0 : this.feel.shakeM * this.fade;
    return { x: Math.sin(this.ageS * 190) * amount, y: Math.sin(this.ageS * 150) * amount * 0.7 };
  }
}
