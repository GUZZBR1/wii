export const SPLIT_METERS = 100;
export const MAX_SPEED_MPS = 9;

export interface Split {
  meters: number;
  seconds: number;
}

/** Distance, clock and splits of one run. Pure: speed and time come in from the fixed-step loop. */
export class Race {
  distance = 0;
  seconds = 0;
  readonly splits: Split[] = [];

  constructor(readonly goal = 400) {}

  get finished(): boolean {
    return this.distance >= this.goal;
  }

  /** Returns the split crossed on this step, if any. The goal itself is the last split. */
  advance(dt: number, speed01: number): Split | undefined {
    if (this.finished) return undefined;
    const speed = Math.max(0, speed01) * MAX_SPEED_MPS;
    const from = this.distance;
    const mark = Math.min(this.goal, (this.splits.length + 1) * SPLIT_METERS);
    this.distance += speed * dt;
    this.seconds += dt;
    if (this.distance < mark || speed === 0) return undefined;

    // Time the crossing inside the step rather than at its end.
    const split = { meters: mark, seconds: this.seconds - dt + (mark - from) / speed };
    this.splits.push(split);
    if (mark === this.goal) {
      this.distance = this.goal;
      this.seconds = split.seconds;
    }
    return split;
  }
}

export function formatTime(seconds: number): string {
  const tenths = Math.floor(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}
