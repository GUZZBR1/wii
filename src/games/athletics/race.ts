export const SPLIT_METERS = 100;
export const MAX_SPEED_MPS = 9;
export const GOALS = [100, 400, 800] as const;
export type Goal = (typeof GOALS)[number];
/** Best time in seconds, keyed by distance in metres. */
export type Records = Record<string, number>;

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
    const speed = speed01 * MAX_SPEED_MPS;
    const from = this.distance;
    const mark = Math.min(this.goal, (this.splits.length + 1) * SPLIT_METERS);
    this.distance += speed * dt;
    if (this.distance < mark) {
      this.seconds += dt;
      return undefined;
    }
    // Time the crossing inside the step rather than at its end.
    const split = { meters: mark, seconds: this.seconds + (mark - from) / speed };
    this.splits.push(split);
    this.seconds += dt;
    if (mark === this.goal) {
      this.distance = this.goal;
      this.seconds = split.seconds;
    }
    return split;
  }
}

/** Finishing position against rivals that may still be running. */
export function placeAmong(seconds: number, rivals: readonly Race[]): number {
  return 1 + rivals.filter((rival) => rival.finished && rival.seconds < seconds).length;
}

/** Stored data is untrusted: anything that is not a positive time is dropped. */
export function parseRecords(raw: string | null): Records {
  try {
    const data: unknown = JSON.parse(raw ?? '{}');
    if (!data || typeof data !== 'object') return {};
    return Object.fromEntries(
      Object.entries(data).filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0),
    );
  } catch {
    return {};
  }
}

export function recordTime(records: Records, goal: number, seconds: number) {
  const previous = records[goal];
  const isNew = previous === undefined || seconds < previous;
  const best = isNew ? seconds : previous;
  return { records: { ...records, [goal]: best }, best, isNew };
}

export function formatTime(seconds: number): string {
  const tenths = Math.floor(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}
