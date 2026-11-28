/**
 * Diagnostic recording script. This is the single source of truth: the screen shows these instructions, and replay
 * (tests/recordedTrack.test.ts) uses the same timings to evaluate detector behavior.
 */
import type { Bilingual } from '../../i18n';

export type SegmentKind = 'warmup' | 'still' | 'arms' | 'run' | 'stop' | 'jump' | 'center' | 'left' | 'right' | 'walk' | 'runjump' | 'hops' | 'forehand' | 'backhand' | 'prepare' | 'occlusion' | 'jab' | 'cross' | 'hook' | 'uppercut' | 'bodyshot' | 'slip' | 'duck' | 'guard';

export interface Segment { kind: SegmentKind; seconds: number; prompt: Bilingual }

export const TRACK_RECORDING_SCRIPT: readonly Segment[] = [
  { kind: 'warmup', seconds: 5, prompt: { pt: 'Vá para a sua posição e fique no centro', en: 'Move into position and stand in the center' } },
  { kind: 'still', seconds: 10, prompt: { pt: 'Fique PARADO, respirando normal', en: 'Stand STILL and breathe normally' } },
  { kind: 'arms', seconds: 8, prompt: { pt: 'Balance SÓ OS BRAÇOS, alternando', en: 'Swing ONLY YOUR ARMS, alternating' } },
  { kind: 'run', seconds: 10, prompt: { pt: 'CORRA no lugar', en: 'RUN in place' } },
  { kind: 'stop', seconds: 5, prompt: { pt: 'PARE', en: 'STOP' } },
  { kind: 'jump', seconds: 3, prompt: { pt: 'PULE uma vez (1 de 4)', en: 'JUMP once (1 of 4)' } },
  { kind: 'jump', seconds: 3, prompt: { pt: 'PULE uma vez (2 de 4)', en: 'JUMP once (2 of 4)' } },
  { kind: 'jump', seconds: 3, prompt: { pt: 'PULE uma vez (3 de 4)', en: 'JUMP once (3 of 4)' } },
  { kind: 'jump', seconds: 3, prompt: { pt: 'PULE uma vez (4 de 4)', en: 'JUMP once (4 of 4)' } },
  { kind: 'center', seconds: 4, prompt: { pt: 'Fique no CENTRO', en: 'Stand in the CENTER' } },
  { kind: 'left', seconds: 4, prompt: { pt: 'Vá para a SUA ESQUERDA e fique', en: 'Move to YOUR LEFT and hold' } },
  { kind: 'center', seconds: 4, prompt: { pt: 'Volte ao CENTRO', en: 'Return to the CENTER' } },
  { kind: 'right', seconds: 4, prompt: { pt: 'Vá para a SUA DIREITA e fique', en: 'Move to YOUR RIGHT and hold' } },
  { kind: 'center', seconds: 4, prompt: { pt: 'Volte ao CENTRO', en: 'Return to the CENTER' } },
  // Added later: new segments go at the end, so older recordings keep their timing.
  { kind: 'walk', seconds: 10, prompt: { pt: 'ANDE no lugar, devagar', en: 'WALK slowly in place' } },
  { kind: 'runjump', seconds: 12, prompt: { pt: 'CORRA e pule 3 vezes sem parar de correr', en: 'RUN and jump 3 times without stopping' } },
  { kind: 'hops', seconds: 10, prompt: { pt: 'PULE várias vezes SEGUIDAS, sem correr', en: 'JUMP several times in a row without running' } },
];

export const TENNIS_RECORDING_SCRIPT: readonly Segment[] = [
  { kind: 'still', seconds: 5, prompt: { pt: 'Fique no centro, com os ombros e o braço visíveis', en: 'Stand in the center with your shoulders and arm visible' } },
  ...(['forehand', 'backhand'] as const).flatMap((kind) =>
    Array.from({ length: 3 }, (_, i) => ({
      kind,
      seconds: 4,
      prompt: {
        pt: `Faça um ${kind} (${i + 1} de 3)`,
        en: `Hit a ${kind} (${i + 1} of 3)`,
      },
    })),
  ),
  { kind: 'prepare', seconds: 6, prompt: { pt: 'Prepare a rebatida devagar, sem completar o golpe', en: 'Prepare a slow swing without completing it' } },
  { kind: 'occlusion', seconds: 6, prompt: { pt: 'Tire o pulso do quadro e volte sem rebater', en: 'Move your wrist out of frame and return without swinging' } },
];

/**
 * Boxing recording script: one attempt per window, with punches requested in tutorial order.
 * The final two segments are negative controls: arm movements that are not punches.
 */
export const BOXING_RECORDING_SCRIPT: readonly Segment[] = [
  { kind: 'still', seconds: 5, prompt: { pt: 'Fique no centro, com os ombros e os pulsos visíveis', en: 'Stand in the center with your shoulders and wrists visible' } },
  { kind: 'guard', seconds: 4, prompt: { pt: 'Segure a GUARDA alta, punhos no rosto', en: 'Hold a HIGH GUARD with your fists by your face' } },
  ...(['jab', 'cross', 'hook', 'uppercut', 'bodyshot'] as const).flatMap((kind) => {
    const names: Record<typeof kind, Bilingual> = {
      jab: { pt: 'JAB', en: 'JAB' },
      cross: { pt: 'CRUZADO', en: 'CROSS' },
      hook: { pt: 'GANCHO', en: 'HOOK' },
      uppercut: { pt: 'UPPERCUT', en: 'UPPERCUT' },
      bodyshot: { pt: 'SOCO NO CORPO', en: 'BODY SHOT' },
    };
    const count = kind === 'jab' || kind === 'cross' ? 3 : 2;
    return Array.from({ length: count }, (_, i) => ({
      kind,
      seconds: 4,
      prompt: {
        pt: `${names[kind].pt} (${i + 1} de ${count})`,
        en: `${names[kind].en} (${i + 1} of ${count})`,
      },
    }));
  }),
  { kind: 'slip', seconds: 4, prompt: { pt: 'ESQUIVA para um lado (1 de 2)', en: 'SLIP to one side (1 of 2)' } },
  { kind: 'slip', seconds: 4, prompt: { pt: 'ESQUIVA para o outro lado (2 de 2)', en: 'SLIP to the other side (2 of 2)' } },
  { kind: 'duck', seconds: 4, prompt: { pt: 'AGACHE sob o gancho (1 de 2)', en: 'DUCK under the hook (1 of 2)' } },
  { kind: 'duck', seconds: 4, prompt: { pt: 'AGACHE sob o gancho (2 de 2)', en: 'DUCK under the hook (2 of 2)' } },
  { kind: 'prepare', seconds: 5, prompt: { pt: 'Levante o braço devagar, SEM socar', en: 'Raise your arm slowly WITHOUT punching' } },
  { kind: 'occlusion', seconds: 5, prompt: { pt: 'Tire o pulso do quadro e volte sem socar', en: 'Move your wrist out of frame and return without punching' } },
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
