import type { Bilingual } from '../i18n';

// Nomes na ordem dos índices de MiiFaceSpec (os mesmos do editor da arena).
export const FACE_STYLES: readonly (readonly [
  'head' | 'hair' | 'eyes' | 'brows' | 'nose' | 'mouth' | 'beard' | 'glasses',
  Bilingual,
  readonly Bilingual[],
])[] = [
  ['head', { pt: 'Rosto', en: 'Face' }, [{ pt: 'Redondo', en: 'Round' }, { pt: 'Oval', en: 'Oval' }, { pt: 'Largo', en: 'Wide' }, { pt: 'Comprido', en: 'Long' }, { pt: 'Cheio', en: 'Full' }, { pt: 'Estreito', en: 'Narrow' }, { pt: 'Baixo', en: 'Short' }, { pt: 'Profundo', en: 'Deep' }]],
  ['hair', { pt: 'Cabelo', en: 'Hair' }, [{ pt: 'Careca', en: 'Bald' }, { pt: 'Curto', en: 'Short' }, { pt: 'Topete', en: 'Quiff' }, { pt: 'Espetado', en: 'Spiky' }, { pt: 'Chanel', en: 'Bob' }, { pt: 'Rabo', en: 'Ponytail' }, { pt: 'Moicano', en: 'Mohawk' }, { pt: 'Cachos', en: 'Curls' }, { pt: 'Raspado', en: 'Buzz' }, { pt: 'Longo', en: 'Long hair' }, { pt: 'Franja', en: 'Fringe' }, { pt: 'Afro', en: 'Afro' }]],
  ['eyes', { pt: 'Olhos', en: 'Eyes' }, [{ pt: 'Oval', en: 'Oval' }, { pt: 'Redondo', en: 'Round' }, { pt: 'Amêndoa', en: 'Almond' }, { pt: 'Feliz', en: 'Happy' }, { pt: 'Sonolento', en: 'Sleepy' }, { pt: 'Ponto', en: 'Dot' }, { pt: 'Angular', en: 'Angular' }, { pt: 'Cílios', en: 'Lashes' }, { pt: 'Aberto', en: 'Open' }, { pt: 'Calmo', en: 'Calm' }, { pt: 'Apertado', en: 'Narrow' }, { pt: 'Firme', en: 'Firm' }]],
  ['brows', { pt: 'Sobrancelhas', en: 'Eyebrows' }, [{ pt: 'Sem', en: 'None' }, { pt: 'Reta', en: 'Straight' }, { pt: 'Inclinada', en: 'Slanted' }, { pt: 'Curva', en: 'Curved' }, { pt: 'Cheia', en: 'Thick' }, { pt: 'Fina', en: 'Thin' }, { pt: 'Preocupada', en: 'Worried' }, { pt: 'Curta', en: 'Short brow' }]],
  ['nose', { pt: 'Nariz', en: 'Nose' }, [{ pt: 'Pequeno', en: 'Small' }, { pt: 'Redondo', en: 'Round' }, { pt: 'Pontudo', en: 'Pointed' }, { pt: 'Largo', en: 'Wide' }, { pt: 'Comprido', en: 'Long' }, { pt: 'Empinado', en: 'Upturned' }, { pt: 'Achatado', en: 'Flat' }, { pt: 'Forte', en: 'Strong' }]],
  ['mouth', { pt: 'Boca', en: 'Mouth' }, [{ pt: 'Sorriso', en: 'Smile' }, { pt: 'Neutra', en: 'Neutral' }, { pt: 'Aberto', en: 'Open' }, { pt: 'Triste', en: 'Sad' }, { pt: 'Lábios', en: 'Full lips' }, { pt: 'Dentes', en: 'Teeth' }, { pt: 'Onda', en: 'Wave' }, { pt: 'Redonda', en: 'Round' }, { pt: 'Grande', en: 'Big' }, { pt: 'Canto', en: 'Smirk' }, { pt: 'Dupla', en: 'Double' }, { pt: 'Linha', en: 'Line' }]],
  ['beard', { pt: 'Barba', en: 'Facial hair' }, [{ pt: 'Sem', en: 'None' }, { pt: 'Por fazer', en: 'Stubble' }, { pt: 'Cavanhaque', en: 'Goatee' }, { pt: 'Bigode', en: 'Mustache' }, { pt: 'Cheia', en: 'Full beard' }, { pt: 'Contorno', en: 'Outline' }]],
  ['glasses', { pt: 'Óculos', en: 'Glasses' }, [{ pt: 'Sem', en: 'None' }, { pt: 'Redondos', en: 'Round' }, { pt: 'Quadrados', en: 'Square' }, { pt: 'Esportivos', en: 'Sport' }, { pt: 'Finos', en: 'Thin' }, { pt: 'Grossos', en: 'Thick' }]],
];

/**
 * Every name the two Mii editors show, in the order of the `MiiFaceSpec` indices. The 3D editors
 * label their style buttons from here; keep the order in step with `MII_STYLE_COUNT`.
 */
export const FACE_STYLE_NAMES = Object.fromEntries(
  FACE_STYLES.map(([key, , options]) => [key, options.map((option) => option.pt)]),
) as unknown as Record<(typeof FACE_STYLES)[number][0], readonly string[]>;

export const FACE_SLIDERS = [
  ['eyeY', { pt: 'Altura dos olhos', en: 'Eye height' }, 42, 62],
  ['eyeSpacing', { pt: 'Espaço entre olhos', en: 'Eye spacing' }, 12, 26],
  ['eyeScale', { pt: 'Tamanho dos olhos', en: 'Eye size' }, 7, 14],
  ['eyeTilt', { pt: 'Inclinação dos olhos', en: 'Eye tilt' }, -14, 14],
  ['browY', { pt: 'Altura da sobrancelha', en: 'Brow height' }, 54, 78],
  ['browTilt', { pt: 'Inclinação da sobrancelha', en: 'Brow tilt' }, -16, 16],
  ['noseY', { pt: 'Altura do nariz', en: 'Nose height' }, 30, 50],
  ['mouthY', { pt: 'Altura da boca', en: 'Mouth height' }, 18, 34],
  ['mouthWidth', { pt: 'Largura da boca', en: 'Mouth width' }, 16, 36],
  ['mouthCurve', { pt: 'Curva da boca', en: 'Mouth curve' }, -10, 10],
] as const;
