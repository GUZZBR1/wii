import type { Sport } from './GameCanvas';
import type { Bilingual } from '../i18n';

export const HUD_TEXT: Record<Sport, { score: Bilingual; speed: Bilingual; controls: Bilingual }> = {
  track: {
    score: { pt: 'PONTOS', en: 'SCORE' },
    speed: { pt: 'RITMO', en: 'PACE' },
    controls: { pt: '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar', en: '← → change lanes  ·  ↑ / Space jump  ·  ↓ walk / run / stop' },
  },
  athletics: {
    score: { pt: 'TEMPO', en: 'TIME' },
    speed: { pt: 'INTENSIDADE', en: 'EFFORT' },
    controls: { pt: 'corra no lugar, mexendo os braços', en: 'run in place and swing your arms' },
  },
  tennis: {
    score: { pt: 'PONTOS', en: 'POINTS' },
    speed: { pt: 'MIRA', en: 'AIM' },
    controls: { pt: 'raquetada no tempo da bola: cedo cruza, tarde vai reto', en: 'time your swing to the ball: early goes cross-court, late goes down the line' },
  },
  boxing: {
    score: { pt: 'HP', en: 'HP' },
    speed: { pt: 'RITMO', en: 'PACE' },
    controls: { pt: 'W A S D mover  ·  E socar  ·  segure Q para defender  ·  ← → esquivar', en: 'W A S D move  ·  E punch  ·  hold Q to block  ·  ← → dodge' },
  },
};
export const BOXING_TRAINING_CONTROLS: Record<'bag' | 'dodge', Bilingual> = {
  bag: { pt: 'E ou socos no ritmo  ·  W A S D mover', en: 'E or punch in rhythm  ·  W A S D move' },
  dodge: { pt: '← → esquivar  ·  A / D circular para sair da linha  ·  W / S ajustar distância', en: '← → dodge  ·  A / D circle out of the line  ·  W / S adjust distance' },
} as const;
