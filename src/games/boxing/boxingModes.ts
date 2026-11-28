export const BOXING_MODES = [
  { id: 'tutorial', label: 'Tutorial', labelEn: 'Tutorial' },
  { id: 'fight', label: 'Luta', labelEn: 'Fight' },
  { id: 'bag', label: 'Saco de Pancada', labelEn: 'Punching Bag' },
  { id: 'dodge', label: 'Esquiva', labelEn: 'Dodge' },
] as const;

export type BoxingMode = (typeof BOXING_MODES)[number]['id'];
