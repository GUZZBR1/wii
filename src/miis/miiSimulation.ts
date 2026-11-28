/** Passeio dos Miis em coordenadas da página (px, y cresce para baixo). Puro: sem DOM nem Three.js. */
export interface Walker {
  x: number;
  y: number;
  /** Direção atual em radianos (0 = para a direita, π/2 = para baixo). */
  heading: number;
  /** Segundos até a próxima decisão. */
  timer: number;
  walking: boolean;
  /** Segundos até aparecer; enquanto > 0 o Mii não é desenhado. */
  delay: number;
  /** Pixels que ainda faltam andar para dentro da página; > 0 enquanto entra pela borda. */
  entering: number;
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

/** Perspectiva do passeio: no alto da janela o Mii está longe (menor), embaixo está perto (maior). */
export const depthScale = (screenY: number, viewHeight: number) => 0.7 + 0.5 * clamp(screenY / viewHeight, 0, 1);

export function createWalkers(count: number, bounds: Bounds, rng: () => number = Math.random): Walker[] {
  return Array.from({ length: count }, () => ({
    x: SIDE_MARGIN + rng() * Math.max(0, bounds.width - SIDE_MARGIN * 2),
    y: TOP_MARGIN + rng() * Math.max(0, bounds.height - TOP_MARGIN - BOTTOM_MARGIN),
    heading: rng() * Math.PI * 2,
    timer: rng() * 4,
    walking: rng() > 0.3,
    delay: 0,
    entering: 0,
  }));
}

/** Quanto fora da borda o Mii nasce. */
export const OFFSTAGE = 40;
/** Menor intervalo entre uma chegada e outra; o maior é quase o dobro. */
export const ARRIVAL_GAP = 1;

/** Portas de entrada, em rodízio: lado e posição (0..1) ao longo dele. */
const ENTRIES = [
  ['left', 0.1],
  ['right', 0.9],
  ['bottom', 0.2],
  ['right', 0.15],
  ['left', 0.85],
  ['bottom', 0.8],
  ['left', 0.5],
  ['bottom', 0.5],
  ['right', 0.55],
] as const;

/**
 * Põe o Mii logo fora da janela visível (`viewTop`..`viewTop + viewHeight`), por um lado, um canto
 * ou por baixo, para entrar andando.
 */
export function enterFromEdge(
  walker: Walker,
  index: number,
  bounds: Bounds,
  viewTop: number,
  viewHeight: number,
  rng: () => number = Math.random,
): void {
  const [edge, spot] = ENTRIES[index % ENTRIES.length];
  const along = clamp(spot + (rng() - 0.5) * 0.15, 0.02, 0.98);
  // Rumo ao meio da janela, com alguma folga.
  const wobble = (rng() - 0.5) * 0.4;
  if (edge === 'bottom') {
    walker.x = clamp(along * bounds.width, SIDE_MARGIN, bounds.width - SIDE_MARGIN);
    walker.y = viewTop + viewHeight + OFFSTAGE + 30;
    walker.heading = -Math.PI / 2 + (0.5 - along) + wobble;
  } else {
    const slope = (0.5 - along) * 1.2 + wobble;
    walker.x = edge === 'left' ? -OFFSTAGE : bounds.width + OFFSTAGE;
    walker.y = clamp(viewTop + along * viewHeight, TOP_MARGIN, bounds.height - BOTTOM_MARGIN);
    walker.heading = edge === 'left' ? slope : Math.PI - slope;
  }
  walker.walking = true;
  walker.delay = index === 0 ? 0 : index * ARRIVAL_GAP + rng() * ARRIVAL_GAP * 0.8;
  walker.entering = OFFSTAGE + 90 + rng() * 220;
}

/** Quanto dura a cara de incomodado, em segundos. */
export const GRUMP_SECONDS = 1.1;

/** Pose de incomodado após `t` segundos: pulo (px, para cima), inclinação e cabeça que nega (rad). */
export function grumpPose(t: number) {
  const left = clamp(1 - t / GRUMP_SECONDS, 0, 1);
  return {
    hop: Math.abs(Math.sin(t * 12)) * 12 * left,
    tilt: Math.sin(t * 30) * 0.22 * left,
    yaw: Math.sin(t * 18) * 0.9 * left,
  };
}

export function stepWalker(walker: Walker, dt: number, bounds: Bounds, rng: () => number = Math.random): void {
  if (walker.delay > 0) {
    walker.delay -= dt;
    return;
  }
  if (walker.entering > 0) {
    // Entrando: segue reto, sem a trava das bordas, até estar dentro da página.
    walker.entering -= WALK_SPEED * 2 * dt;
    walker.x += Math.cos(walker.heading) * WALK_SPEED * 2 * dt;
    walker.y += Math.sin(walker.heading) * WALK_SPEED * 2 * dt;
    return;
  }
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
