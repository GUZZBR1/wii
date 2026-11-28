import type { Sport } from './GameCanvas';

export const HUD_TEXT: Record<Sport, { score: string; speed: string; controls: string }> = {
  track: { score: 'SCORE', speed: 'RITMO', controls: '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar' },
  athletics: { score: 'TEMPO', speed: 'INTENSIDADE', controls: 'corra no lugar, mexendo os braços' },
  tennis: { score: 'PONTOS', speed: 'MIRA', controls: 'raquetada no tempo da bola: cedo cruza, tarde vai reto' },
  boxing: { score: 'HP', speed: 'RITMO', controls: 'W A S D mover  ·  E socar  ·  segure Q para defender  ·  ← → esquivar' },
};
export const BOXING_TRAINING_CONTROLS = {
  bag: 'E ou socos no ritmo  ·  W A S D mover',
  dodge: '← → esquivar  ·  A / D circular para sair da linha  ·  W / S ajustar distância',
} as const;
