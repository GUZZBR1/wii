/**
 * Color science behind the photo-to-Mii suggestion: sRGB/Lab conversion, palette proximity, pixel
 * sampling and the per-region samples (skin, hair, iris, glasses, facial hair, shirt). Pure functions
 * over a pixel buffer — no DOM, no canvas, no clock.
 */

export interface FacePoint {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface HairExtentSample {
  readonly topCoverage: number;
  readonly sideEarCoverage: number;
  readonly lowerNeckCoverage: number;
  readonly sideAsymmetry: number;
  readonly centerSpikeRatio: number;
}

export interface GlassesCueSample {
  readonly bridgeEdgeStrength: number;
  readonly eyeTintDelta: number;
  readonly lowerRimEdgeStrength: number;
  readonly cornerRoundness?: number;
}

export interface FacialHairCueSample {
  readonly upperLipDarkness: number;
  readonly chinDarkness: number;
  readonly jawDarkness: number;
}

export interface FaceColorSamples {
  readonly skinRgb?: RgbColor;
  readonly hairRgb?: RgbColor;
  readonly crownSkinSimilarity?: number;
  readonly crownTexture?: number;
  readonly hairExtent?: HairExtentSample;
  readonly irisRgb?: RgbColor;
  readonly glassesCue?: GlassesCueSample;
  readonly facialHairCue?: FacialHairCueSample;
  readonly shirtRgb?: RgbColor;
}

export interface PixelBuffer {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

interface LabColor {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** Landmarks the classifier cannot work without; a photo missing any of them gets no suggestion. */
export const REQUIRED_ANCHORS = [
  0, 2, 4, 10, 13, 14, 21, 33, 37, 46, 52, 55, 58, 61, 70, 102, 105, 107, 133, 144, 145, 149, 152, 153, 158, 159, 160,
  168, 234, 251, 263, 267, 276, 282, 285, 288, 291, 300, 331, 334, 336, 362, 373, 374, 378, 380, 385, 386, 387, 454,
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string): RgbColor {
  const clean = hex.trim().replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => `${c}${c}`)
          .join('')
      : clean;
  const num = Number.parseInt(full, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function srgbChannelToLinear(channel255: number): number {
  const c = clamp(channel255 / 255, 0, 1);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(rgb: RgbColor): LabColor {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);

  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / 1.0;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function deltaE76(a: LabColor, b: LabColor): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

export function nearestPaletteColor(rgb: RgbColor, palette: readonly string[]): string {
  const target = rgbToLab(rgb);
  let best = palette[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const hex of palette) {
    const dist = deltaE76(target, rgbToLab(hexToRgb(hex)));
    if (dist < bestDist) {
      bestDist = dist;
      best = hex;
    }
  }
  return best;
}

function luma(rgb: RgbColor): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function readPixel(pixels: PixelBuffer, px: number, py: number): RgbColor | null {
  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return null;
  const idx = (py * pixels.width + px) * 4;
  if (idx + 3 >= pixels.data.length) return null;
  if (pixels.data[idx + 3]! < 32) return null;
  return {
    r: pixels.data[idx]!,
    g: pixels.data[idx + 1]!,
    b: pixels.data[idx + 2]!,
  };
}

interface PatchStats {
  readonly rgb: RgbColor;
  readonly lumaMean: number;
  readonly lumaStd: number;
  readonly edgeEnergy: number;
  readonly count: number;
}

function samplePatch(pixels: PixelBuffer, nx: number, ny: number, radiusPx: number): PatchStats | null {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  const cx = Math.round(nx * (pixels.width - 1));
  const cy = Math.round(ny * (pixels.height - 1));
  const r = Math.max(1, Math.round(radiusPx));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const lumas: number[] = [];
  let edgeSum = 0;
  let edgeCount = 0;

  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      const c = readPixel(pixels, x, y);
      if (!c) continue;
      sumR += c.r;
      sumG += c.g;
      sumB += c.b;
      const yLuma = luma(c);
      lumas.push(yLuma);
      count += 1;

      const right = readPixel(pixels, x + 1, y);
      const down = readPixel(pixels, x, y + 1);
      if (right) {
        edgeSum += Math.abs(luma(right) - yLuma);
        edgeCount += 1;
      }
      if (down) {
        edgeSum += Math.abs(luma(down) - yLuma);
        edgeCount += 1;
      }
    }
  }

  if (count === 0) return null;
  const lumaMean = lumas.reduce((acc, v) => acc + v, 0) / count;
  const variance = lumas.reduce((acc, v) => acc + (v - lumaMean) ** 2, 0) / count;

  return {
    rgb: {
      r: Math.round(sumR / count),
      g: Math.round(sumG / count),
      b: Math.round(sumB / count),
    },
    lumaMean,
    lumaStd: Math.sqrt(variance),
    edgeEnergy: edgeCount > 0 ? edgeSum / (edgeCount * 255) : 0,
    count,
  };
}

function averageRgb(colors: readonly RgbColor[]): RgbColor | undefined {
  if (colors.length === 0) return undefined;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    r += c.r;
    g += c.g;
    b += c.b;
  }
  return {
    r: Math.round(r / colors.length),
    g: Math.round(g / colors.length),
    b: Math.round(b / colors.length),
  };
}

function sampleIrisRgb(pixels: PixelBuffer, center: FacePoint | undefined, radiusPx: number): RgbColor | undefined {
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return undefined;
  const cx = Math.round(center.x * (pixels.width - 1));
  const cy = Math.round(center.y * (pixels.height - 1));
  const r = Math.max(1, Math.round(radiusPx));
  const filtered: RgbColor[] = [];
  const fallback: RgbColor[] = [];

  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      const c = readPixel(pixels, x, y);
      if (!c) continue;
      fallback.push(c);
      const yLuma = luma(c);
      if (yLuma >= 18 && yLuma <= 215) {
        filtered.push(c);
      }
    }
  }
  return averageRgb(filtered.length > 0 ? filtered : fallback);
}

function isHairLikePixel(sample: RgbColor, hairLab: LabColor, skinLab: LabColor): boolean {
  const sampleLab = rgbToLab(sample);
  const dHair = deltaE76(sampleLab, hairLab);
  const dSkin = deltaE76(sampleLab, skinLab);
  return dHair <= 26 && dHair + 4 < dSkin;
}

export function extractFaceColorSamples(pixels: PixelBuffer, landmarks: readonly FacePoint[]): FaceColorSamples {
  if (
    pixels.width <= 0 ||
    pixels.height <= 0 ||
    pixels.data.length < pixels.width * pixels.height * 4 ||
    landmarks.length < 468
  ) {
    return {};
  }

  const top = landmarks[10]!;
  const chin = landmarks[152]!;
  const noseTip = landmarks[4]!;
  const rightCheekOuter = landmarks[234]!;
  const leftCheekOuter = landmarks[454]!;
  const rightTemple = landmarks[21]!;
  const leftTemple = landmarks[251]!;
  const rightJaw = landmarks[58]!;
  const leftJaw = landmarks[288]!;
  const bridge = landmarks[168]!;
  const rightEyeLower = landmarks[145]!;
  const leftEyeLower = landmarks[374]!;
  const noseBase = landmarks[2]!;
  const upperLipTop = landmarks[0]!;
  const lowerLipBottom = landmarks[17]!;

  const faceH = Math.max(0.05, Math.abs(chin.y - top.y));
  const faceW = Math.max(0.05, Math.abs(leftCheekOuter.x - rightCheekOuter.x));
  const patchR = Math.max(2, Math.round(Math.min(pixels.width, pixels.height) * faceW * 0.06));

  // Skin sampling: interior cheeks + center forehead below hairline
  const skinPatches = [
    samplePatch(
      pixels,
      rightCheekOuter.x * 0.42 + noseTip.x * 0.58,
      rightCheekOuter.y * 0.45 + noseTip.y * 0.55,
      patchR,
    ),
    samplePatch(pixels, leftCheekOuter.x * 0.42 + noseTip.x * 0.58, leftCheekOuter.y * 0.45 + noseTip.y * 0.55, patchR),
    samplePatch(pixels, top.x, top.y + 0.14 * faceH, patchR),
  ].filter((p): p is PatchStats => p !== null);

  const skinRgb = averageRgb(skinPatches.map((p) => p.rgb));
  const skinLab = skinRgb ? rgbToLab(skinRgb) : undefined;
  const skinLuma = skinRgb ? luma(skinRgb) : 160;

  // Crown & hair sampling
  const crownCenter = samplePatch(pixels, top.x, top.y - 0.16 * faceH, patchR);
  const crownLeft = samplePatch(pixels, top.x - 0.24 * faceW, top.y - 0.12 * faceH, patchR);
  const crownRight = samplePatch(pixels, top.x + 0.24 * faceW, top.y - 0.12 * faceH, patchR);
  const crownPatches = [crownCenter, crownLeft, crownRight].filter((p): p is PatchStats => p !== null);

  const earLeft = samplePatch(pixels, rightCheekOuter.x - 0.12 * faceW, rightCheekOuter.y, patchR);
  const earRight = samplePatch(pixels, leftCheekOuter.x + 0.12 * faceW, leftCheekOuter.y, patchR);
  const templeLeft = samplePatch(pixels, rightTemple.x - 0.08 * faceW, rightTemple.y, patchR);
  const templeRight = samplePatch(pixels, leftTemple.x + 0.08 * faceW, leftTemple.y, patchR);
  const neckLeft = samplePatch(pixels, rightJaw.x - 0.15 * faceW, chin.y + 0.04 * faceH, patchR);
  const neckRight = samplePatch(pixels, leftJaw.x + 0.15 * faceW, chin.y + 0.04 * faceH, patchR);

  let hairRgb = crownCenter?.rgb ?? averageRgb(crownPatches.map((p) => p.rgb));
  let crownSkinSimilarity: number | undefined;
  let crownTexture: number | undefined;
  let hairExtent: HairExtentSample | undefined;

  if (crownCenter && skinLab) {
    const crownLab = rgbToLab(crownCenter.rgb);
    crownSkinSimilarity = Number(Math.exp(-deltaE76(crownLab, skinLab) / 18).toFixed(3));
    crownTexture = clamp(crownCenter.lumaStd / 48, 0, 1);

    const hairRefLab = crownSkinSimilarity < 0.85 ? crownLab : undefined;
    if (hairRefLab) {
      const topCandidates = [crownCenter, crownLeft, crownRight].filter((p): p is PatchStats => p !== null);
      const topHits = topCandidates.filter((p) => isHairLikePixel(p.rgb, hairRefLab, skinLab)).length;
      const topCoverage = topCandidates.length > 0 ? topHits / topCandidates.length : 0;

      const sideCandidates = [earLeft, earRight, templeLeft, templeRight].filter((p): p is PatchStats => p !== null);
      const sideHits = sideCandidates.filter((p) => isHairLikePixel(p.rgb, hairRefLab, skinLab)).length;
      const sideEarCoverage = sideCandidates.length > 0 ? sideHits / sideCandidates.length : 0;

      const neckCandidates = [neckLeft, neckRight].filter((p): p is PatchStats => p !== null);
      const neckHits = neckCandidates.filter((p) => isHairLikePixel(p.rgb, hairRefLab, skinLab)).length;
      const lowerNeckCoverage = neckCandidates.length > 0 ? neckHits / neckCandidates.length : 0;

      const leftSideCov =
        [earLeft, templeLeft].filter((p): p is PatchStats => p !== null && isHairLikePixel(p.rgb, hairRefLab, skinLab))
          .length / 2;
      const rightSideCov =
        [earRight, templeRight].filter(
          (p): p is PatchStats => p !== null && isHairLikePixel(p.rgb, hairRefLab, skinLab),
        ).length / 2;
      const sideAsymmetry = Math.abs(leftSideCov - rightSideCov);

      const sideCrownDiff =
        crownLeft && crownRight
          ? (deltaE76(rgbToLab(crownLeft.rgb), hairRefLab) + deltaE76(rgbToLab(crownRight.rgb), hairRefLab)) / 2
          : 0;
      const centerSpikeRatio = crownLeft && crownRight ? clamp(1 + sideCrownDiff / 24, 1, 2.5) : 1;

      hairExtent = {
        topCoverage,
        sideEarCoverage,
        lowerNeckCoverage,
        sideAsymmetry,
        centerSpikeRatio,
      };
    }
  } else if (!hairRgb && skinLab) {
    const sideHair = [templeLeft, templeRight, earLeft, earRight].find(
      (p): p is PatchStats => p !== null && deltaE76(rgbToLab(p.rgb), skinLab) > 18,
    );
    if (sideHair) hairRgb = sideHair.rgb;
  }

  // Iris RGB (landmarks 468, 473 when present)
  const irisRadius = Math.max(1, Math.round(Math.min(pixels.width, pixels.height) * faceW * 0.02));
  const rightIris = landmarks.length >= 473 ? sampleIrisRgb(pixels, landmarks[468], irisRadius) : undefined;
  const leftIris = landmarks.length >= 478 ? sampleIrisRgb(pixels, landmarks[473], irisRadius) : undefined;
  const irisRgb = averageRgb([rightIris, leftIris].filter((c): c is RgbColor => c !== undefined));

  // Glasses cues
  const bridgePatch = samplePatch(pixels, bridge.x, bridge.y, Math.max(2, Math.round(patchR * 0.7)));
  const rightRimPatch = samplePatch(
    pixels,
    rightEyeLower.x,
    rightEyeLower.y + 0.05 * faceH,
    Math.max(2, Math.round(patchR * 0.7)),
  );
  const leftRimPatch = samplePatch(
    pixels,
    leftEyeLower.x,
    leftEyeLower.y + 0.05 * faceH,
    Math.max(2, Math.round(patchR * 0.7)),
  );
  const rightEyeCenter = samplePatch(
    pixels,
    (landmarks[33]!.x + landmarks[133]!.x) / 2,
    (landmarks[159]!.y + landmarks[145]!.y) / 2,
    Math.max(2, Math.round(patchR * 0.7)),
  );
  const leftEyeCenter = samplePatch(
    pixels,
    (landmarks[362]!.x + landmarks[263]!.x) / 2,
    (landmarks[386]!.y + landmarks[374]!.y) / 2,
    Math.max(2, Math.round(patchR * 0.7)),
  );

  let glassesCue: GlassesCueSample | undefined;
  if (bridgePatch) {
    const rimEnergies = [rightRimPatch?.edgeEnergy, leftRimPatch?.edgeEnergy].filter(
      (v): v is number => v !== undefined,
    );
    const lowerRimEdgeStrength =
      rimEnergies.length > 0 ? rimEnergies.reduce((a, b) => a + b, 0) / rimEnergies.length : 0;
    const eyeLumas = [rightEyeCenter?.lumaMean, leftEyeCenter?.lumaMean].filter((v): v is number => v !== undefined);
    const meanEyeLuma = eyeLumas.length > 0 ? eyeLumas.reduce((a, b) => a + b, 0) / eyeLumas.length : skinLuma;
    const eyeTintDelta = clamp((skinLuma - meanEyeLuma) / 255, 0, 1);

    glassesCue = {
      bridgeEdgeStrength: bridgePatch.edgeEnergy,
      eyeTintDelta,
      lowerRimEdgeStrength,
      cornerRoundness: 0.4,
    };
  }

  // Facial hair cues
  const upperLipPatch = samplePatch(
    pixels,
    (noseBase.x + upperLipTop.x) / 2,
    (noseBase.y + upperLipTop.y) / 2,
    Math.max(2, Math.round(patchR * 0.75)),
  );
  const chinPatch = samplePatch(
    pixels,
    chin.x,
    (lowerLipBottom.y + chin.y) / 2,
    Math.max(2, Math.round(patchR * 0.85)),
  );
  const rightJawPatch = samplePatch(
    pixels,
    landmarks[172]!.x,
    landmarks[172]!.y,
    Math.max(2, Math.round(patchR * 0.75)),
  );
  const leftJawPatch = samplePatch(
    pixels,
    landmarks[397]!.x,
    landmarks[397]!.y,
    Math.max(2, Math.round(patchR * 0.75)),
  );

  let facialHairCue: FacialHairCueSample | undefined;
  if (skinRgb && (upperLipPatch || chinPatch || rightJawPatch || leftJawPatch)) {
    const darkness = (p: PatchStats | null) => (p ? clamp((skinLuma - p.lumaMean) / Math.max(40, skinLuma), 0, 1) : 0);
    const jawVals = [rightJawPatch, leftJawPatch].filter((p): p is PatchStats => p !== null).map(darkness);
    facialHairCue = {
      upperLipDarkness: darkness(upperLipPatch),
      chinDarkness: darkness(chinPatch),
      jawDarkness: jawVals.length > 0 ? jawVals.reduce((a, b) => a + b, 0) / jawVals.length : 0,
    };
  }

  // Shirt sampling below chin
  const shirtY = chin.y + 0.25 * faceH;
  const shirtPatch = shirtY < 0.99 ? samplePatch(pixels, chin.x, shirtY, patchR) : null;

  return {
    skinRgb,
    hairRgb,
    crownSkinSimilarity,
    crownTexture,
    hairExtent,
    irisRgb,
    glassesCue,
    facialHairCue,
    shirtRgb: shirtPatch?.rgb,
  };
}
