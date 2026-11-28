export type MiiHeadShape = 'oval' | 'round' | 'square' | 'tapered';
export type MiiHairStyle =
  | 'short'
  | 'spiky'
  | 'bob'
  | 'long'
  | 'bald'
  | 'ponytail'
  | 'curly'
  | 'parted'
  | 'mohawk'
  | 'buns'
  | 'sideSweep'
  | 'buzz';
export type MiiEyebrowStyle = 'classic' | 'arched' | 'thick' | 'flat' | 'raised';
export type MiiEyeStyle = 'classic' | 'wide' | 'relaxed' | 'wink' | 'sharp' | 'sparkle';
export type MiiNoseStyle = 'button' | 'straight' | 'wide' | 'pointed';
export type MiiMouthStyle = 'smile' | 'grin' | 'neutral' | 'open' | 'smirk' | 'cat';
export type MiiFacialHairStyle = 'none' | 'stubble' | 'mustache' | 'goatee' | 'beard';
export type MiiGlassesStyle = 'none' | 'round' | 'square' | 'halfRim' | 'sunglasses';

export interface MiiProfile {
  readonly id: string;
  readonly name: string;
  readonly isCpu: boolean;
  readonly skill: number;
  readonly headShape: MiiHeadShape;
  readonly skinTone: string;
  readonly hairStyle: MiiHairStyle;
  readonly hairColor: string;
  readonly eyebrowStyle: MiiEyebrowStyle;
  readonly eyeStyle: MiiEyeStyle;
  readonly eyeColor: string;
  readonly noseStyle: MiiNoseStyle;
  readonly mouthStyle: MiiMouthStyle;
  readonly facialHair: MiiFacialHairStyle;
  readonly glasses: MiiGlassesStyle;
  readonly height: number;
  readonly build: number;
  readonly shirtColor: string;
}

export const MII_NAME_MAX_LENGTH = 14;
export const DEFAULT_MII_NAME = 'Você';

export const SKIN_TONES = ['#FDE2C8', '#F4C7A1', '#E0A370', '#B87444', '#7C4828', '#54301A'] as const;
export const HAIR_COLORS = [
  '#1E1B18',
  '#5B3A29',
  '#B97A3C',
  '#E6C25A',
  '#A83226',
  '#9CA3AF',
  '#F3F4F6',
  '#0F766E',
] as const;
export const EYE_COLORS = ['#1F2937', '#2563EB', '#15803D', '#78350F', '#6B21A8'] as const;
export const SHIRT_COLORS = [
  '#0096D6',
  '#E11D48',
  '#16A34A',
  '#F59E0B',
  '#7C3AED',
  '#0F172A',
  '#EC4899',
  '#EA580C',
  '#14B8A6',
  '#64748B',
] as const;

export const HEAD_SHAPES: readonly MiiHeadShape[] = ['oval', 'round', 'square', 'tapered'];
export const HAIR_STYLES: readonly MiiHairStyle[] = [
  'short',
  'spiky',
  'bob',
  'long',
  'ponytail',
  'bald',
  'curly',
  'parted',
  'mohawk',
  'buns',
  'sideSweep',
  'buzz',
];
export const EYEBROW_STYLES: readonly MiiEyebrowStyle[] = ['classic', 'arched', 'thick', 'flat', 'raised'];
export const EYE_STYLES: readonly MiiEyeStyle[] = ['classic', 'wide', 'relaxed', 'wink', 'sharp', 'sparkle'];
export const NOSE_STYLES: readonly MiiNoseStyle[] = ['button', 'straight', 'wide', 'pointed'];
export const MOUTH_STYLES: readonly MiiMouthStyle[] = ['smile', 'grin', 'neutral', 'open', 'smirk', 'cat'];
export const FACIAL_HAIR_STYLES: readonly MiiFacialHairStyle[] = ['none', 'stubble', 'mustache', 'goatee', 'beard'];
export const GLASSES_STYLES: readonly MiiGlassesStyle[] = ['none', 'round', 'square', 'halfRim', 'sunglasses'];
