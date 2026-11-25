export class TrackScore {
  private value = 0;
  private streak = 0;

  get combo(): number {
    return this.streak;
  }

  advance(dt: number, speed01: number): void {
    if (!Number.isFinite(speed01)) return;
    this.value += dt * speed01 * 50;
  }

  hurdleCleared(): void {
    this.streak += 1;
    this.value += 100;
  }

  hurdleHit(): void {
    this.streak = 0;
    this.value = Math.max(0, this.value - 35);
  }

  get display(): number {
    return Math.floor(this.value);
  }
}
