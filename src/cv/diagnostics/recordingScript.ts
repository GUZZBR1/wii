/**
 * Roteiro da gravação de diagnóstico. Fonte única: a tela mostra estas instruções e o replay
 * (tests/recordedTrack.test.ts) usa os mesmos tempos para julgar o que o detector fez.
 */
export type SegmentKind = 'warmup' | 'still' | 'arms' | 'run' | 'stop' | 'jump' | 'center' | 'left' | 'right' | 'walk' | 'runjump' | 'hops' | 'forehand' | 'backhand' | 'prepare' | 'occlusion';

export interface Segment { kind: SegmentKind; seconds: number; prompt: string }

export const TRACK_RECORDING_SCRIPT: readonly Segment[] = [
  { kind: 'warmup', seconds: 5, prompt: 'Vá para a sua posição e fique no centro' },
  { kind: 'still', seconds: 10, prompt: 'Fique PARADO, respirando normal' },
  { kind: 'arms', seconds: 8, prompt: 'Balance SÓ OS BRAÇOS, alternando' },
  { kind: 'run', seconds: 10, prompt: 'CORRA no lugar' },
  { kind: 'stop', seconds: 5, prompt: 'PARE' },
  { kind: 'jump', seconds: 3, prompt: 'PULE uma vez (1 de 4)' },
  { kind: 'jump', seconds: 3, prompt: 'PULE uma vez (2 de 4)' },
  { kind: 'jump', seconds: 3, prompt: 'PULE uma vez (3 de 4)' },
  { kind: 'jump', seconds: 3, prompt: 'PULE uma vez (4 de 4)' },
  { kind: 'center', seconds: 4, prompt: 'Fique no CENTRO' },
  { kind: 'left', seconds: 4, prompt: 'Vá para a SUA ESQUERDA e fique' },
  { kind: 'center', seconds: 4, prompt: 'Volte ao CENTRO' },
  { kind: 'right', seconds: 4, prompt: 'Vá para a SUA DIREITA e fique' },
  { kind: 'center', seconds: 4, prompt: 'Volte ao CENTRO' },
  // Added later: new segments go at the end, so older recordings keep their timing.
  { kind: 'walk', seconds: 10, prompt: 'ANDE no lugar, devagar' },
  { kind: 'runjump', seconds: 12, prompt: 'CORRA e pule 3 vezes sem parar de correr' },
  { kind: 'hops', seconds: 10, prompt: 'PULE várias vezes SEGUIDAS, sem correr' },
];

export const TENNIS_RECORDING_SCRIPT: readonly Segment[] = [
  { kind: 'still', seconds: 5, prompt: 'Fique no centro, com os ombros e o braço visíveis' },
  ...(['forehand', 'backhand'] as const).flatMap((kind) =>
    Array.from({ length: 3 }, (_, i) => ({ kind, seconds: 4, prompt: `Faça um ${kind} (${i + 1} de 3)` })),
  ),
  { kind: 'prepare', seconds: 6, prompt: 'Prepare a rebatida devagar, sem completar o golpe' },
  { kind: 'occlusion', seconds: 6, prompt: 'Tire o pulso do quadro e volte sem rebater' },
];

/** The segment running `elapsedMs` after the first recorded frame; undefined once the script is over. */
export function segmentAt(elapsedMs: number, script = TRACK_RECORDING_SCRIPT): { segment: Segment; index: number; remainingMs: number } | undefined {
  let end = 0;
  for (const [index, segment] of script.entries()) {
    end += segment.seconds * 1000;
    if (elapsedMs < end) return { segment, index, remainingMs: end - elapsedMs };
  }
  return undefined;
}
