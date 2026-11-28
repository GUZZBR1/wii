/** Face landmark ratios -> Mii choices. Pure: every input comes from `faceSamples.ts` or the caller. */
import type {
  MiiEyebrowStyle,
  MiiEyeStyle,
  MiiFacialHairStyle,
  MiiGlassesStyle,
  MiiHairStyle,
  MiiHeadShape,
  MiiMouthStyle,
  MiiNoseStyle,
  MiiProfile,
} from './miiTypes';
import {
  type FaceColorSamples,
  type FacePoint,
  type FacialHairCueSample,
  type GlassesCueSample,
  nearestPaletteColor,
  REQUIRED_ANCHORS,
} from './faceSamples';
import { EYE_COLORS, HAIR_COLORS, SHIRT_COLORS, SKIN_TONES } from './miiTypes';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export type {
  FaceColorSamples,
  FacePoint,
  FacialHairCueSample,
  GlassesCueSample,
  HairExtentSample,
  PixelBuffer,
  RgbColor,
} from './faceSamples';
export { extractFaceColorSamples } from './faceSamples';

export interface MapFaceToMiiInput {
  readonly landmarks: readonly FacePoint[];
  readonly colors?: FaceColorSamples;
  readonly aspectRatio?: number;
  readonly baseProfile: MiiProfile;
}

export interface MapFaceToMiiOutput {
  readonly draft: MiiProfile;
  readonly confidence: number;
  readonly warnings: readonly string[];
}

function classifyHeadShape(
  whRatio: number,
  jawToCheek: number,
  chinTaper: number,
  foreheadToJaw: number,
): MiiHeadShape {
  if (jawToCheek >= 0.86 && chinTaper >= 0.58) return 'square';
  if (whRatio >= 0.84 && jawToCheek >= 0.78) return 'round';
  if (chinTaper <= 0.48 || (jawToCheek <= 0.74 && foreheadToJaw >= 1.12)) return 'tapered';
  return 'oval';
}

function classifyEyeStyle(
  meanEAR: number,
  rEAR: number,
  lEAR: number,
  meanEyeRatio: number,
  meanTilt: number,
): MiiEyeStyle {
  if (Math.max(rEAR, lEAR) >= 0.24 && Math.min(rEAR, lEAR) <= 0.14 && Math.abs(rEAR - lEAR) >= 0.12) {
    return 'wink';
  }
  if (meanEAR >= 0.36) {
    return meanEyeRatio >= 0.22 ? 'sparkle' : 'wide';
  }
  if (meanEAR <= 0.23) {
    return meanTilt >= 0.06 ? 'sharp' : 'relaxed';
  }
  return meanTilt >= 0.08 ? 'sharp' : 'classic';
}

function classifyEyebrowStyle(
  browElevation: number,
  thickness: number,
  archHeight: number,
  slope: number,
): MiiEyebrowStyle {
  if (browElevation >= 0.62) return 'raised';
  if (thickness >= 0.2) return 'thick';
  if (archHeight >= 0.14) return 'arched';
  if (archHeight <= 0.05 && Math.abs(slope) <= 0.08) return 'flat';
  return 'classic';
}

function classifyNoseStyle(noseWidthToIO: number, noseLengthToFace: number, tipProjection: number): MiiNoseStyle {
  if (noseWidthToIO >= 0.44) return 'wide';
  if (noseLengthToFace <= 0.25 && noseWidthToIO <= 0.36) return 'button';
  if (tipProjection >= 0.075 && noseWidthToIO <= 0.37) return 'pointed';
  return 'straight';
}

function classifyMouthStyle(
  mouthOpen: number,
  smileLift: number,
  cornerAsym: number,
  mouthToCheek: number,
  cupidDip: number,
): MiiMouthStyle {
  if (mouthOpen >= 0.2 && smileLift >= 0.04) return 'grin';
  if (mouthOpen >= 0.18) return 'open';
  if (cornerAsym >= 0.055) return 'smirk';
  if (smileLift >= 0.05 && mouthToCheek >= 0.4) return 'grin';
  if (smileLift >= 0.025) return 'smile';
  if (cupidDip >= 0.045 && mouthToCheek <= 0.34) return 'cat';
  return 'neutral';
}

function classifyHairStyle(
  colors: FaceColorSamples | undefined,
  foreheadTopY: number,
  fallback: MiiHairStyle,
  warnings: string[],
): MiiHairStyle {
  if (foreheadTopY < 0.08) {
    warnings.push('Topo da testa cortado na foto; estilo de cabelo mantido.');
    return fallback;
  }
  if (!colors || colors.crownSkinSimilarity === undefined) {
    return fallback;
  }
  if (colors.crownSkinSimilarity > 0.85) {
    return (colors.crownTexture ?? 0) > 0.25 ? 'buzz' : 'bald';
  }
  const ext = colors.hairExtent;
  if (!ext) return 'short';
  if (ext.lowerNeckCoverage >= 0.45) return 'long';
  if (ext.sideEarCoverage >= 0.55) return (colors.crownTexture ?? 0) >= 0.45 ? 'curly' : 'bob';
  if (ext.centerSpikeRatio >= 1.55) return ext.topCoverage >= 0.5 ? 'mohawk' : 'spiky';
  if (ext.sideAsymmetry >= 0.35) return 'sideSweep';
  if (ext.topCoverage >= 0.45 && ext.sideEarCoverage >= 0.25) return 'parted';
  return 'short';
}

function classifyGlasses(cue: GlassesCueSample | undefined): MiiGlassesStyle {
  if (!cue) return 'none';
  if (cue.eyeTintDelta >= 0.32 && cue.bridgeEdgeStrength >= 0.12) return 'sunglasses';
  if (cue.bridgeEdgeStrength >= 0.18 && cue.lowerRimEdgeStrength >= 0.16) {
    return (cue.cornerRoundness ?? 0.3) >= 0.55 ? 'round' : 'square';
  }
  if (cue.bridgeEdgeStrength >= 0.18 && cue.lowerRimEdgeStrength < 0.16) return 'halfRim';
  return 'none';
}

function classifyFacialHair(cue: FacialHairCueSample | undefined): MiiFacialHairStyle {
  if (!cue) return 'none';
  if (cue.chinDarkness >= 0.26 && cue.jawDarkness >= 0.22) return 'beard';
  if (cue.chinDarkness >= 0.24 && cue.upperLipDarkness >= 0.18) return 'goatee';
  if (cue.upperLipDarkness >= 0.22 && cue.chinDarkness < 0.18) return 'mustache';
  if (cue.jawDarkness >= 0.14 && cue.chinDarkness >= 0.12) return 'stubble';
  return 'none';
}

export function mapFaceToMii(input: MapFaceToMiiInput): MapFaceToMiiOutput {
  const { landmarks, colors, baseProfile } = input;
  const aspectRatio =
    input.aspectRatio && Number.isFinite(input.aspectRatio) && input.aspectRatio > 0 ? input.aspectRatio : 1;
  const warnings: string[] = [];

  if (landmarks.length < 468) {
    return {
      draft: { ...baseProfile },
      confidence: 0,
      warnings: ['No valid face was detected in the image.'],
    };
  }

  for (const idx of REQUIRED_ANCHORS) {
    const p = landmarks[idx];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return {
        draft: { ...baseProfile },
        confidence: 0,
        warnings: ['Face landmarks are incomplete, so a suggestion could not be generated.'],
      };
    }
  }

  // Isotropic scaling + roll de-rotation around eye midpoint
  const rawX = (idx: number) => landmarks[idx]!.x * aspectRatio;
  const rawY = (idx: number) => landmarks[idx]!.y;

  const mx = (rawX(33) + rawX(263)) / 2;
  const my = (rawY(33) + rawY(263)) / 2;
  const theta = Math.atan2(rawY(263) - rawY(33), rawX(263) - rawX(33));
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);

  const pt = (idx: number): { readonly x: number; readonly y: number } => {
    const dx = rawX(idx) - mx;
    const dy = rawY(idx) - my;
    return {
      x: mx + dx * cos - dy * sin,
      y: my + dx * sin + dy * cos,
    };
  };

  const dist = (a: number, b: number): number => {
    const pa = pt(a);
    const pb = pt(b);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  };

  const faceH = Math.abs(pt(152).y - pt(10).y);
  const cheekW = Math.abs(pt(454).x - pt(234).x);
  const interOcular = dist(33, 263);

  if (faceH < 0.08 || cheekW < 0.04 || interOcular < 0.04) {
    return {
      draft: { ...baseProfile },
      confidence: 0,
      warnings: ['Rosto muito pequeno ou distante para sugerir atributos.'],
    };
  }

  const dLeft = dist(168, 454);
  const dRight = dist(168, 234);
  const yawBalance = Math.min(dLeft, dRight) / Math.max(dLeft, dRight, 1e-6);
  if (yawBalance < 0.6) {
    warnings.push('The face is tilted sideways; accuracy may be reduced.');
  }

  // Head shape
  const jawW = Math.abs(pt(288).x - pt(58).x);
  const foreheadW = Math.abs(pt(251).x - pt(21).x);
  const chinW = Math.abs(pt(378).x - pt(149).x);
  const headShape = classifyHeadShape(cheekW / faceH, jawW / cheekW, chinW / cheekW, foreheadW / Math.max(jawW, 1e-6));

  // Eyes
  const rEyeW = Math.max(dist(33, 133), 1e-6);
  const lEyeW = Math.max(dist(362, 263), 1e-6);
  const rEAR = (dist(159, 145) + dist(160, 144) + dist(158, 153)) / (3 * rEyeW);
  const lEAR = (dist(386, 374) + dist(385, 373) + dist(387, 380)) / (3 * lEyeW);
  const meanEAR = (rEAR + lEAR) / 2;
  const meanEyeWidth = (rEyeW + lEyeW) / 2;
  const meanTilt = ((pt(133).y - pt(33).y) / rEyeW + (pt(362).y - pt(263).y) / lEyeW) / 2;
  const eyeStyle = classifyEyeStyle(meanEAR, rEAR, lEAR, meanEyeWidth / cheekW, meanTilt);

  // Eyebrows
  const rBrowSpan = Math.max(dist(70, 107), 1e-6);
  const lBrowSpan = Math.max(dist(300, 336), 1e-6);
  const browSpan = (rBrowSpan + lBrowSpan) / 2;
  const browElevation = ((pt(159).y - pt(52).y) / rEyeW + (pt(386).y - pt(282).y) / lEyeW) / 2;
  const thickness = ((pt(52).y - pt(105).y) / rEyeW + (pt(282).y - pt(334).y) / lEyeW) / 2;
  const rTipMidY = (pt(70).y + pt(107).y) / 2;
  const lTipMidY = (pt(300).y + pt(336).y) / 2;
  const archHeight = (rTipMidY - pt(105).y + (lTipMidY - pt(334).y)) / (2 * Math.max(browSpan, 1e-6));
  const slope = ((pt(107).y - pt(70).y) / rBrowSpan + (pt(336).y - pt(300).y) / lBrowSpan) / 2;
  const eyebrowStyle = classifyEyebrowStyle(browElevation, thickness, archHeight, slope);

  // Nose
  const noseWidth = dist(102, 331);
  const noseLength = pt(2).y - pt(168).y;
  const tipProjection = ((landmarks[168]!.z ?? 0) - (landmarks[4]!.z ?? 0)) / Math.max(cheekW / aspectRatio, 1e-6);
  const noseStyle = classifyNoseStyle(noseWidth / interOcular, noseLength / faceH, tipProjection);

  // Mouth
  const mouthWidth = Math.max(dist(61, 291), 1e-6);
  const mouthOpen = dist(13, 14) / mouthWidth;
  const smileLift = ((pt(13).y + pt(14).y) / 2 - (pt(61).y + pt(291).y) / 2) / mouthWidth;
  const cornerAsym = Math.abs(pt(61).y - pt(291).y) / mouthWidth;
  const cupidDip = (pt(0).y - (pt(37).y + pt(267).y) / 2) / mouthWidth;
  const mouthStyle = classifyMouthStyle(mouthOpen, smileLift, cornerAsym, mouthWidth / cheekW, cupidDip);

  // Color & appearance cues
  const glasses = classifyGlasses(colors?.glassesCue);
  const facialHair = classifyFacialHair(colors?.facialHairCue);
  const hairStyle = classifyHairStyle(colors, landmarks[10]!.y, baseProfile.hairStyle, warnings);

  const skinTone = colors?.skinRgb ? nearestPaletteColor(colors.skinRgb, SKIN_TONES) : baseProfile.skinTone;
  const hairColor = colors?.hairRgb ? nearestPaletteColor(colors.hairRgb, HAIR_COLORS) : baseProfile.hairColor;
  const eyeColor =
    colors?.irisRgb && eyeStyle !== 'wink' && meanEAR > 0.16 && glasses !== 'sunglasses'
      ? nearestPaletteColor(colors.irisRgb, EYE_COLORS)
      : baseProfile.eyeColor;
  const shirtColor = colors?.shirtRgb ? nearestPaletteColor(colors.shirtRgb, SHIRT_COLORS) : baseProfile.shirtColor;

  const baseConfidence =
    0.42 + 0.36 * yawBalance + (colors?.skinRgb ? 0.14 : 0) + (landmarks[10]!.y >= 0.08 ? 0.06 : 0);
  const confidence = Number(clamp(yawBalance < 0.6 ? baseConfidence * 0.65 : baseConfidence, 0.15, 0.98).toFixed(3));

  return {
    draft: {
      ...baseProfile,
      headShape,
      skinTone,
      hairStyle,
      hairColor,
      eyebrowStyle,
      eyeStyle,
      eyeColor,
      noseStyle,
      mouthStyle,
      facialHair,
      glasses,
      shirtColor,
    },
    confidence,
    warnings,
  };
}

