/** Passeio dos Miis em coordenadas da página (px, y cresce para baixo). Puro: sem DOM nem Three.js. */
export interface Walker {
  x: number;
  y: number;
  /** Direção atual em radianos (0 = para a direita, π/2 = para baixo). */
  heading: number;
  /** Segundos até a próxima decisão. */
  timer: number;
  walking: boolean;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

export const WALK_SPEED = 34;
export const SIDE_MARGIN = 28;
export const TOP_MARGIN = 120;
export const BOTTOM_MARGIN = 12;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function createWalkers(count: number, bounds: Bounds, rng: () => number = Math.random): Walker[] {
  return Array.from({ length: count }, () => ({
    x: SIDE_MARGIN + rng() * Math.max(0, bounds.width - SIDE_MARGIN * 2),
    y: TOP_MARGIN + rng() * Math.max(0, bounds.height - TOP_MARGIN - BOTTOM_MARGIN),
    heading: rng() * Math.PI * 2,
    timer: rng() * 4,
    walking: rng() > 0.3,
  }));
}

export function stepWalker(walker: Walker, dt: number, bounds: Bounds, rng: () => number = Math.random): void {
  walker.timer -= dt;
  if (walker.timer <= 0) {
    walker.walking = rng() > 0.3;
    walker.heading = rng() * Math.PI * 2;
    walker.timer = 1.5 + rng() * 4;
  }
  if (walker.walking) {
    walker.x += Math.cos(walker.heading) * WALK_SPEED * dt;
    walker.y += Math.sin(walker.heading) * WALK_SPEED * dt;
  }
  const x = clamp(walker.x, SIDE_MARGIN, bounds.width - SIDE_MARGIN);
  const y = clamp(walker.y, TOP_MARGIN, bounds.height - BOTTOM_MARGIN);
  // Bateu na borda: reflete a direção em vez de ficar empurrando a parede.
  if (x !== walker.x) walker.heading = Math.PI - walker.heading;
  if (y !== walker.y) walker.heading = -walker.heading;
  walker.x = x;
  walker.y = y;
}
