import type { Lang } from './i18n';

export function gameText(lang: Lang, portuguese: string, english: string): string {
  return lang === 'pt' ? portuguese : english;
}

const FRAMING_ADVICE: Record<string, string> = {
  'Apareça na câmera': 'Step into the camera view',
  'Afaste-se da câmera': 'Move farther from the camera',
  'Incline a câmera para cima ou afaste-se': 'Tilt the camera up or move farther away',
  'Chegue mais perto': 'Move closer to the camera',
  'Vá para o meio da imagem': 'Move to the center of the frame',
};

export function localizedFramingAdvice(lang: Lang, advice: string | undefined): string | undefined {
  if (lang === 'pt' || advice === undefined) return advice;
  return FRAMING_ADVICE[advice] ?? advice;
}

export function placeLabel(place: number, lang: Lang): string {
  if (lang === 'pt') return `${place}º lugar`;
  const suffix = place % 100 >= 11 && place % 100 <= 13
    ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[place % 10] ?? 'th';
  return `${place}${suffix}`;
}
