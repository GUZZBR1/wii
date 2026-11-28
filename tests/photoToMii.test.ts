import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYER_MII } from '../src/miis/miiCatalog';
import { EYE_COLORS, HAIR_COLORS, SHIRT_COLORS, SKIN_TONES } from '../src/miis/miiTypes';
import {
  extractFaceColorSamples,
  type FacePoint,
  mapFaceToMii,
  type PixelBuffer,
  type RgbColor,
} from '../src/miis/photoToMii';

function makeBaseLandmarks(): FacePoint[] {
  const pts: FacePoint[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));

  const set = (idx: number, x: number, y: number, z = 0) => {
    pts[idx] = { x, y, z };
  };

  // Face oval (oval default: faceH = 0.56, cheekW = 0.38 -> whRatio ~0.68, jawToCheek ~0.79, chinTaper ~0.53)
  set(10, 0.5, 0.22);
  set(152, 0.5, 0.78);
  set(234, 0.31, 0.5);
  set(454, 0.69, 0.5);
  set(21, 0.34, 0.32);
  set(251, 0.66, 0.32);
  set(58, 0.35, 0.65);
  set(288, 0.65, 0.65);
  set(149, 0.4, 0.75);
  set(378, 0.6, 0.75);
  set(172, 0.37, 0.69);
  set(397, 0.63, 0.69);

  // Right eye (viewer left): width 0.06, default EAR ~0.29 (classic)
  set(33, 0.37, 0.44);
  set(133, 0.43, 0.44);
  set(159, 0.4, 0.431);
  set(145, 0.4, 0.449);
  set(160, 0.388, 0.432);
  set(144, 0.388, 0.448);
  set(158, 0.412, 0.432);
  set(153, 0.412, 0.448);
  set(468, 0.4, 0.44);

  // Left eye (viewer right): width 0.06, default EAR ~0.29 (classic)
  set(362, 0.57, 0.44);
  set(263, 0.63, 0.44);
  set(386, 0.6, 0.431);
  set(374, 0.6, 0.449);
  set(385, 0.588, 0.432);
  set(373, 0.588, 0.448);
  set(387, 0.612, 0.432);
  set(380, 0.612, 0.448);
  set(473, 0.6, 0.44);

  // Eyebrows (classic default: elevation ~0.48, thickness ~0.13, arch ~0.09)
  set(70, 0.365, 0.394);
  set(105, 0.4, 0.388);
  set(107, 0.435, 0.394);
  set(46, 0.365, 0.402);
  set(52, 0.4, 0.396);
  set(55, 0.435, 0.402);

  set(300, 0.635, 0.394);
  set(334, 0.6, 0.388);
  set(336, 0.565, 0.394);
  set(276, 0.635, 0.402);
  set(282, 0.6, 0.396);
  set(285, 0.565, 0.402);

  // Nose (straight default: noseWidth = 0.10 -> ratio 0.385, noseLength = 0.17 -> ratio 0.30, proj = 0.03)
  set(168, 0.5, 0.43, 0);
  set(4, 0.5, 0.56, -0.01);
  set(2, 0.5, 0.6, 0);
  set(102, 0.45, 0.58);
  set(331, 0.55, 0.58);

  // Mouth (neutral default: width = 0.14)
  set(61, 0.43, 0.67);
  set(291, 0.57, 0.67);
  set(13, 0.5, 0.668);
  set(14, 0.5, 0.672);
  set(0, 0.5, 0.655);
  set(37, 0.485, 0.655);
  set(267, 0.515, 0.655);
  set(17, 0.5, 0.695);

  return pts;
}

function rotateLandmarks(landmarks: readonly FacePoint[], degrees: number): FacePoint[] {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return landmarks.map((p) => {
    const dx = p.x - 0.5;
    const dy = p.y - 0.5;
    return {
      x: 0.5 + dx * cos - dy * sin,
      y: 0.5 + dx * sin + dy * cos,
      z: p.z,
    };
  });
}

function makeSolidBuffer(width: number, height: number, bg: RgbColor): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = bg.r;
    data[i * 4 + 1] = bg.g;
    data[i * 4 + 2] = bg.b;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function paintRect(buf: PixelBuffer, nx0: number, ny0: number, nx1: number, ny1: number, color: RgbColor): void {
  const x0 = Math.max(0, Math.floor(nx0 * buf.width));
  const y0 = Math.max(0, Math.floor(ny0 * buf.height));
  const x1 = Math.min(buf.width - 1, Math.ceil(nx1 * buf.width));
  const y1 = Math.min(buf.height - 1, Math.ceil(ny1 * buf.height));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const idx = (y * buf.width + x) * 4;
      buf.data[idx] = color.r;
      buf.data[idx + 1] = color.g;
      buf.data[idx + 2] = color.b;
      buf.data[idx + 3] = 255;
    }
  }
}

function hexToRgb(hex: string): RgbColor {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

describe('photoToMii — geometry classification', () => {
  it('classifies headShape across oval, square, round, and tapered faces', () => {
    const oval = makeBaseLandmarks();
    expect(mapFaceToMii({ landmarks: oval, baseProfile: DEFAULT_PLAYER_MII }).draft.headShape).toBe('oval');

    const square = makeBaseLandmarks();
    square[58] = { x: 0.33, y: 0.65 };
    square[288] = { x: 0.67, y: 0.65 };
    square[149] = { x: 0.38, y: 0.75 };
    square[378] = { x: 0.62, y: 0.75 };
    expect(mapFaceToMii({ landmarks: square, baseProfile: DEFAULT_PLAYER_MII }).draft.headShape).toBe('square');

    const round = makeBaseLandmarks();
    round[10] = { x: 0.5, y: 0.29 };
    round[152] = { x: 0.5, y: 0.71 }; // faceH = 0.42
    round[234] = { x: 0.31, y: 0.5 };
    round[454] = { x: 0.69, y: 0.5 }; // cheekW = 0.38 -> whRatio = 0.90
    round[58] = { x: 0.35, y: 0.62 };
    round[288] = { x: 0.65, y: 0.62 }; // jawToCheek = 0.79
    round[149] = { x: 0.42, y: 0.69 };
    round[378] = { x: 0.58, y: 0.69 }; // chinTaper = 0.42 (wait: let's keep chinTaper > 0.50 & jawToCheek < 0.86)
    round[149] = { x: 0.4, y: 0.69 };
    round[378] = { x: 0.6, y: 0.69 }; // chinTaper = 0.53
    expect(mapFaceToMii({ landmarks: round, baseProfile: DEFAULT_PLAYER_MII }).draft.headShape).toBe('round');

    const tapered = makeBaseLandmarks();
    tapered[58] = { x: 0.38, y: 0.65 };
    tapered[288] = { x: 0.62, y: 0.65 };
    tapered[149] = { x: 0.43, y: 0.75 };
    tapered[378] = { x: 0.57, y: 0.75 }; // chinTaper = 0.37
    expect(mapFaceToMii({ landmarks: tapered, baseProfile: DEFAULT_PLAYER_MII }).draft.headShape).toBe('tapered');
  });

  it('is invariant to aspect ratio (16:9 vs 1:1) and roll rotation (+/- 15 deg)', () => {
    const base = makeBaseLandmarks();
    // Smile + wide jaw so all detectors exercise ratios
    base[61] = { x: 0.43, y: 0.675 };
    base[291] = { x: 0.57, y: 0.675 };
    base[13] = { x: 0.5, y: 0.668 };
    base[14] = { x: 0.5, y: 0.671 };

    const canonical = mapFaceToMii({ landmarks: base, aspectRatio: 1, baseProfile: DEFAULT_PLAYER_MII }).draft;

    const wide16x9 = base.map((p) => ({ x: 0.5 + (p.x - 0.5) / (16 / 9), y: p.y, z: p.z }));
    const from16x9 = mapFaceToMii({ landmarks: wide16x9, aspectRatio: 16 / 9, baseProfile: DEFAULT_PLAYER_MII }).draft;

    expect(from16x9.headShape).toBe(canonical.headShape);
    expect(from16x9.eyeStyle).toBe(canonical.eyeStyle);
    expect(from16x9.eyebrowStyle).toBe(canonical.eyebrowStyle);
    expect(from16x9.noseStyle).toBe(canonical.noseStyle);
    expect(from16x9.mouthStyle).toBe(canonical.mouthStyle);

    for (const deg of [-15, 15]) {
      const rotated = rotateLandmarks(base, deg);
      const fromRotated = mapFaceToMii({ landmarks: rotated, aspectRatio: 1, baseProfile: DEFAULT_PLAYER_MII }).draft;
      expect(fromRotated.headShape).toBe(canonical.headShape);
      expect(fromRotated.eyeStyle).toBe(canonical.eyeStyle);
      expect(fromRotated.eyebrowStyle).toBe(canonical.eyebrowStyle);
      expect(fromRotated.noseStyle).toBe(canonical.noseStyle);
      expect(fromRotated.mouthStyle).toBe(canonical.mouthStyle);
    }
  });

  it('classifies all eyeStyle, eyebrowStyle, noseStyle, and mouthStyle variants', () => {
    // Eye styles
    const wideEyes = makeBaseLandmarks();
    wideEyes[159] = { x: 0.4, y: 0.427 };
    wideEyes[145] = { x: 0.4, y: 0.453 };
    wideEyes[160] = { x: 0.388, y: 0.428 };
    wideEyes[144] = { x: 0.388, y: 0.452 };
    wideEyes[158] = { x: 0.412, y: 0.428 };
    wideEyes[153] = { x: 0.412, y: 0.452 };
    wideEyes[386] = { x: 0.6, y: 0.427 };
    wideEyes[374] = { x: 0.6, y: 0.453 };
    wideEyes[385] = { x: 0.588, y: 0.428 };
    wideEyes[373] = { x: 0.588, y: 0.452 };
    wideEyes[387] = { x: 0.612, y: 0.428 };
    wideEyes[380] = { x: 0.612, y: 0.452 };
    expect(mapFaceToMii({ landmarks: wideEyes, baseProfile: DEFAULT_PLAYER_MII }).draft.eyeStyle).toBe('wide');

    // Sparkle: wide EAR + wide eyes relative to cheekW
    wideEyes[33] = { x: 0.34, y: 0.44 };
    wideEyes[133] = { x: 0.43, y: 0.44 }; // width 0.09 -> 0.09/0.38 = 0.237
    wideEyes[362] = { x: 0.57, y: 0.44 };
    wideEyes[263] = { x: 0.66, y: 0.44 };
    wideEyes[159] = { x: 0.385, y: 0.42 };
    wideEyes[145] = { x: 0.385, y: 0.46 };
    wideEyes[160] = { x: 0.365, y: 0.42 };
    wideEyes[144] = { x: 0.365, y: 0.46 };
    wideEyes[158] = { x: 0.405, y: 0.42 };
    wideEyes[153] = { x: 0.405, y: 0.46 };
    wideEyes[386] = { x: 0.615, y: 0.42 };
    wideEyes[374] = { x: 0.615, y: 0.46 };
    wideEyes[385] = { x: 0.595, y: 0.42 };
    wideEyes[373] = { x: 0.595, y: 0.46 };
    wideEyes[387] = { x: 0.635, y: 0.42 };
    wideEyes[380] = { x: 0.635, y: 0.46 };
    expect(mapFaceToMii({ landmarks: wideEyes, baseProfile: DEFAULT_PLAYER_MII }).draft.eyeStyle).toBe('sparkle');

    // Wink: one eye closed, one open
    const wink = makeBaseLandmarks();
    wink[159] = { x: 0.4, y: 0.438 };
    wink[145] = { x: 0.4, y: 0.442 };
    wink[160] = { x: 0.388, y: 0.438 };
    wink[144] = { x: 0.388, y: 0.442 };
    wink[158] = { x: 0.412, y: 0.438 };
    wink[153] = { x: 0.412, y: 0.442 };
    expect(mapFaceToMii({ landmarks: wink, baseProfile: DEFAULT_PLAYER_MII }).draft.eyeStyle).toBe('wink');

    // Relaxed vs Sharp
    const relaxed = makeBaseLandmarks();
    relaxed[159] = { x: 0.4, y: 0.4345 };
    relaxed[145] = { x: 0.4, y: 0.4455 };
    relaxed[160] = { x: 0.388, y: 0.4345 };
    relaxed[144] = { x: 0.388, y: 0.4455 };
    relaxed[158] = { x: 0.412, y: 0.4345 };
    relaxed[153] = { x: 0.412, y: 0.4455 };
    relaxed[386] = { x: 0.6, y: 0.4345 };
    relaxed[374] = { x: 0.6, y: 0.4455 };
    relaxed[385] = { x: 0.588, y: 0.4345 };
    relaxed[373] = { x: 0.588, y: 0.4455 };
    relaxed[387] = { x: 0.612, y: 0.4345 };
    relaxed[380] = { x: 0.612, y: 0.4455 };
    expect(mapFaceToMii({ landmarks: relaxed, baseProfile: DEFAULT_PLAYER_MII }).draft.eyeStyle).toBe('relaxed');

    const sharp = makeBaseLandmarks();
    sharp[33] = { x: 0.37, y: 0.433 };
    sharp[133] = { x: 0.43, y: 0.44 };
    sharp[362] = { x: 0.57, y: 0.44 };
    sharp[263] = { x: 0.63, y: 0.433 };
    expect(mapFaceToMii({ landmarks: sharp, baseProfile: DEFAULT_PLAYER_MII }).draft.eyeStyle).toBe('sharp');

    // Eyebrows: raised, thick, arched, flat, classic
    const raised = makeBaseLandmarks();
    raised[52] = { x: 0.4, y: 0.388 };
    raised[282] = { x: 0.6, y: 0.388 };
    expect(mapFaceToMii({ landmarks: raised, baseProfile: DEFAULT_PLAYER_MII }).draft.eyebrowStyle).toBe('raised');

    const thick = makeBaseLandmarks();
    thick[105] = { x: 0.4, y: 0.38 };
    thick[334] = { x: 0.6, y: 0.38 };
    expect(mapFaceToMii({ landmarks: thick, baseProfile: DEFAULT_PLAYER_MII }).draft.eyebrowStyle).toBe('thick');

    const arched = makeBaseLandmarks();
    arched[70] = { x: 0.365, y: 0.402 };
    arched[105] = { x: 0.4, y: 0.388 };
    arched[107] = { x: 0.435, y: 0.402 };
    arched[300] = { x: 0.635, y: 0.402 };
    arched[334] = { x: 0.6, y: 0.388 };
    arched[336] = { x: 0.565, y: 0.402 };
    expect(mapFaceToMii({ landmarks: arched, baseProfile: DEFAULT_PLAYER_MII }).draft.eyebrowStyle).toBe('arched');

    const flat = makeBaseLandmarks();
    flat[70] = { x: 0.365, y: 0.391 };
    flat[105] = { x: 0.4, y: 0.389 };
    flat[107] = { x: 0.435, y: 0.391 };
    flat[300] = { x: 0.635, y: 0.391 };
    flat[334] = { x: 0.6, y: 0.389 };
    flat[336] = { x: 0.565, y: 0.391 };
    expect(mapFaceToMii({ landmarks: flat, baseProfile: DEFAULT_PLAYER_MII }).draft.eyebrowStyle).toBe('flat');

    // Noses: wide, button, pointed, straight
    const wideNose = makeBaseLandmarks();
    wideNose[102] = { x: 0.43, y: 0.58 };
    wideNose[331] = { x: 0.57, y: 0.58 };
    expect(mapFaceToMii({ landmarks: wideNose, baseProfile: DEFAULT_PLAYER_MII }).draft.noseStyle).toBe('wide');

    const buttonNose = makeBaseLandmarks();
    buttonNose[102] = { x: 0.465, y: 0.54 };
    buttonNose[331] = { x: 0.535, y: 0.54 };
    buttonNose[2] = { x: 0.5, y: 0.56 };
    expect(mapFaceToMii({ landmarks: buttonNose, baseProfile: DEFAULT_PLAYER_MII }).draft.noseStyle).toBe('button');

    const pointedNose = makeBaseLandmarks();
    pointedNose[102] = { x: 0.46, y: 0.58 };
    pointedNose[331] = { x: 0.54, y: 0.58 };
    pointedNose[168] = { x: 0.5, y: 0.43, z: 0.02 };
    pointedNose[4] = { x: 0.5, y: 0.56, z: -0.02 };
    expect(mapFaceToMii({ landmarks: pointedNose, baseProfile: DEFAULT_PLAYER_MII }).draft.noseStyle).toBe('pointed');

    // Mouths: grin, open, smirk, smile, cat, neutral
    const openMouth = makeBaseLandmarks();
    openMouth[13] = { x: 0.5, y: 0.656 };
    openMouth[14] = { x: 0.5, y: 0.684 };
    expect(mapFaceToMii({ landmarks: openMouth, baseProfile: DEFAULT_PLAYER_MII }).draft.mouthStyle).toBe('open');

    const grinMouth = makeBaseLandmarks();
    grinMouth[61] = { x: 0.42, y: 0.665 };
    grinMouth[291] = { x: 0.58, y: 0.665 };
    grinMouth[13] = { x: 0.5, y: 0.674 };
    grinMouth[14] = { x: 0.5, y: 0.678 };
    expect(mapFaceToMii({ landmarks: grinMouth, baseProfile: DEFAULT_PLAYER_MII }).draft.mouthStyle).toBe('grin');

    const smileMouth = makeBaseLandmarks();
    smileMouth[61] = { x: 0.44, y: 0.665 };
    smileMouth[291] = { x: 0.56, y: 0.665 };
    smileMouth[13] = { x: 0.5, y: 0.669 };
    smileMouth[14] = { x: 0.5, y: 0.672 };
    expect(mapFaceToMii({ landmarks: smileMouth, baseProfile: DEFAULT_PLAYER_MII }).draft.mouthStyle).toBe('smile');

    const smirkMouth = makeBaseLandmarks();
    smirkMouth[61] = { x: 0.43, y: 0.675 };
    smirkMouth[291] = { x: 0.57, y: 0.663 };
    expect(mapFaceToMii({ landmarks: smirkMouth, baseProfile: DEFAULT_PLAYER_MII }).draft.mouthStyle).toBe('smirk');

    const catMouth = makeBaseLandmarks();
    catMouth[61] = { x: 0.44, y: 0.67 };
    catMouth[291] = { x: 0.56, y: 0.67 };
    catMouth[0] = { x: 0.5, y: 0.66 };
    catMouth[37] = { x: 0.485, y: 0.652 };
    catMouth[267] = { x: 0.515, y: 0.652 };
    expect(mapFaceToMii({ landmarks: catMouth, baseProfile: DEFAULT_PLAYER_MII }).draft.mouthStyle).toBe('cat');
  });
});

describe('photoToMii — colorimetry, cues, and edge cases', () => {
  it('samples synthetic RGBA regions and quantizes skin, hair, iris, and shirt to exact palette swatches', () => {
    const landmarks = makeBaseLandmarks();
    const targetSkin = SKIN_TONES[3]; // '#B87444'
    const targetHair = HAIR_COLORS[4]; // '#A83226'
    const targetEye = EYE_COLORS[1]; // '#2563EB'
    const targetShirt = SHIRT_COLORS[2]; // '#16A34A'

    const buf = makeSolidBuffer(128, 128, { r: 235, g: 235, b: 235 });
    // Face skin region
    paintRect(buf, 0.3, 0.22, 0.7, 0.78, hexToRgb(targetSkin));
    // Crown + side hair region
    paintRect(buf, 0.25, 0.04, 0.75, 0.21, hexToRgb(targetHair));
    // Irises
    paintRect(buf, 0.38, 0.42, 0.42, 0.46, hexToRgb(targetEye));
    paintRect(buf, 0.58, 0.42, 0.62, 0.46, hexToRgb(targetEye));
    // Shirt below chin
    paintRect(buf, 0.2, 0.82, 0.8, 0.99, hexToRgb(targetShirt));

    const colors = extractFaceColorSamples(buf, landmarks);
    expect(colors.skinRgb).toBeDefined();
    expect(colors.hairRgb).toBeDefined();
    expect(colors.irisRgb).toBeDefined();
    expect(colors.shirtRgb).toBeDefined();

    const result = mapFaceToMii({
      landmarks,
      colors,
      baseProfile: { ...DEFAULT_PLAYER_MII, name: 'Ana', height: 0.72, build: 0.38 },
    });

    expect(result.draft.skinTone).toBe(targetSkin);
    expect(result.draft.hairColor).toBe(targetHair);
    expect(result.draft.eyeColor).toBe(targetEye);
    expect(result.draft.shirtColor).toBe(targetShirt);
    expect(result.draft.name).toBe('Ana');
    expect(result.draft.height).toBe(0.72);
    expect(result.draft.build).toBe(0.38);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('detects bald/buzz when crown matches skin and preserves baseProfile.hairStyle when forehead is cropped', () => {
    const landmarks = makeBaseLandmarks();
    const skin = SKIN_TONES[1];
    const buf = makeSolidBuffer(128, 128, hexToRgb(skin));
    const samples = extractFaceColorSamples(buf, landmarks);
    expect(samples.crownSkinSimilarity).toBeGreaterThan(0.85);

    const baldResult = mapFaceToMii({
      landmarks,
      colors: samples,
      baseProfile: { ...DEFAULT_PLAYER_MII, hairStyle: 'long' },
    });
    expect(['bald', 'buzz']).toContain(baldResult.draft.hairStyle);

    // Cropped forehead (L[10].y < 0.08) preserves baseProfile.hairStyle with warning
    const cropped = makeBaseLandmarks();
    cropped[10] = { x: 0.5, y: 0.04 };
    const croppedResult = mapFaceToMii({
      landmarks: cropped,
      colors: samples,
      baseProfile: { ...DEFAULT_PLAYER_MII, hairStyle: 'ponytail' },
    });
    expect(croppedResult.draft.hairStyle).toBe('ponytail');
    expect(croppedResult.warnings.length).toBeGreaterThan(0);
  });

  it('maps glasses and facialHair cues conservatively and protects eyeColor under sunglasses/wink', () => {
    const landmarks = makeBaseLandmarks();

    const sunglassesRes = mapFaceToMii({
      landmarks,
      colors: {
        irisRgb: { r: 20, g: 20, b: 20 },
        glassesCue: { bridgeEdgeStrength: 0.25, eyeTintDelta: 0.45, lowerRimEdgeStrength: 0.22 },
      },
      baseProfile: { ...DEFAULT_PLAYER_MII, eyeColor: '#2563EB' },
    });
    expect(sunglassesRes.draft.glasses).toBe('sunglasses');
    expect(sunglassesRes.draft.eyeColor).toBe('#2563EB');

    const squareGlasses = mapFaceToMii({
      landmarks,
      colors: {
        glassesCue: { bridgeEdgeStrength: 0.24, eyeTintDelta: 0.05, lowerRimEdgeStrength: 0.22, cornerRoundness: 0.2 },
        facialHairCue: { upperLipDarkness: 0.28, chinDarkness: 0.34, jawDarkness: 0.3 },
      },
      baseProfile: DEFAULT_PLAYER_MII,
    });
    expect(squareGlasses.draft.glasses).toBe('square');
    expect(squareGlasses.draft.facialHair).toBe('beard');

    const goateeMustache = mapFaceToMii({
      landmarks,
      colors: {
        glassesCue: { bridgeEdgeStrength: 0.22, eyeTintDelta: 0.04, lowerRimEdgeStrength: 0.05 },
        facialHairCue: { upperLipDarkness: 0.25, chinDarkness: 0.08, jawDarkness: 0.05 },
      },
      baseProfile: DEFAULT_PLAYER_MII,
    });
    expect(goateeMustache.draft.glasses).toBe('halfRim');
    expect(goateeMustache.draft.facialHair).toBe('mustache');
  });

  it('returns confidence 0 on < 468 landmarks and emits warning + reduced confidence on heavy yaw', () => {
    const emptyRes = mapFaceToMii({ landmarks: [], baseProfile: DEFAULT_PLAYER_MII });
    expect(emptyRes.confidence).toBe(0);
    expect(emptyRes.warnings.length).toBeGreaterThan(0);

    const yawed = makeBaseLandmarks();
    yawed[168] = { x: 0.36, y: 0.43 }; // bridge shifted strongly toward right cheek (234 @ 0.31)
    const normalRes = mapFaceToMii({ landmarks: makeBaseLandmarks(), baseProfile: DEFAULT_PLAYER_MII });
    const yawedRes = mapFaceToMii({ landmarks: yawed, baseProfile: DEFAULT_PLAYER_MII });
    expect(yawedRes.confidence).toBeLessThan(normalRes.confidence);
    expect(yawedRes.warnings.some((w) => w.includes('tilted sideways'))).toBe(true);
  });
});

describe('faceSuggestClient — worker lifecycle and Safari fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('canUseFaceWorker matches MediaPipe Oh() guard for Safari < 17 vs Chrome/Safari 17+', async () => {
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('OffscreenCanvas', class {});
    const { canUseFaceWorker } = await import('../src/miis/faceSuggestClient');

    expect(
      canUseFaceWorker({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
      }),
    ).toBe(false);
    expect(
      canUseFaceWorker({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      }),
    ).toBe(true);
    expect(
      canUseFaceWorker({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      }),
    ).toBe(true);

    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(canUseFaceWorker({ userAgent: 'Chrome/124.0.0.0' })).toBe(false);
  });

  it('spawns ephemeral worker, transfers bitmap, and always calls worker.terminate() on success, error, and timeout', async () => {
    const terminatedCount = { value: 0 };
    const postedTransfers: unknown[][] = [];
    let workerBehavior: 'success' | 'error-no-face' | 'hang' = 'success';
    const landmarks = makeBaseLandmarks();

    class FakeWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;

      postMessage(data: { requestId: number }, transfer: unknown[]) {
        postedTransfers.push(transfer);
        if (workerBehavior === 'hang') return;
        queueMicrotask(() => {
          if (workerBehavior === 'success') {
            this.onmessage?.({
              data: { type: 'RESULT', requestId: data.requestId, landmarks, frameWidth: 64, frameHeight: 64 },
            } as MessageEvent);
          } else {
            this.onmessage?.({
              data: { type: 'ERROR', requestId: data.requestId, code: 'NO_FACE_DETECTED', message: 'No face' },
            } as MessageEvent);
          }
        });
      }

      terminate() {
        terminatedCount.value += 1;
      }
    }

    const fakeBitmap = { close: vi.fn(), width: 64, height: 64 };
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 })),
    };
    const fakeCanvas = {
      width: 64,
      height: 64,
      getContext: vi.fn(() => fakeCtx),
    };

    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('navigator', { userAgent: 'Chrome/124.0.0.0' });
    vi.stubGlobal('document', { createElement: vi.fn(() => fakeCanvas) });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => fakeBitmap),
    );

    const { FaceSuggestError, suggestMiiFromImage } = await import('../src/miis/faceSuggestClient');
    const source = { width: 1024, height: 1024 } as unknown as HTMLCanvasElement;

    // Success path
    workerBehavior = 'success';
    const ok = await suggestMiiFromImage(source, DEFAULT_PLAYER_MII);
    expect(ok.confidence).toBeGreaterThan(0.5);
    expect(postedTransfers[0]).toEqual([fakeBitmap]);
    expect(terminatedCount.value).toBe(1);

    // Error path
    workerBehavior = 'error-no-face';
    await expect(suggestMiiFromImage(source, DEFAULT_PLAYER_MII)).rejects.toMatchObject({
      name: 'FaceSuggestError',
      code: 'NO_FACE_DETECTED',
    });
    expect(terminatedCount.value).toBe(2);

    // Timeout path (deterministic with fake timers)
    vi.useFakeTimers();
    workerBehavior = 'hang';
    const pending = suggestMiiFromImage(source, DEFAULT_PLAYER_MII);
    const assertion = expect(pending).rejects.toBeInstanceOf(FaceSuggestError);
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(terminatedCount.value).toBe(3);
  });

  it('uses main-thread fallback on Safari < 17 without spawning Worker and closes landmarker in finally', async () => {
    const closeSpy = vi.fn();
    const detectSpy = vi.fn(() => ({ faceLandmarks: [makeBaseLandmarks()] }));
    const workerSpy = vi.fn();
    let webglAvailable = true;

    vi.doMock('@mediapipe/tasks-vision', () => ({
      FilesetResolver: {
        forVisionTasks: vi.fn(async () => ({ wasmLoaderPath: '/mediapipe/wasm-1.2.3/vision_wasm_module_internal.js' })),
      },
      FaceLandmarker: {
        createFromOptions: vi.fn(async () => ({
          detect: detectSpy,
          close: closeSpy,
        })),
      },
    }));

    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 })),
    };
    const fakeCanvas = {
      width: 64,
      height: 64,
      getContext: vi.fn((kind: string) => {
        if (kind === '2d') return fakeCtx;
        return webglAvailable ? {} : null;
      }),
    };

    vi.stubGlobal('Worker', workerSpy);
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
    });
    vi.stubGlobal('document', { createElement: vi.fn(() => fakeCanvas) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const { suggestMiiFromImage } = await import('../src/miis/faceSuggestClient');
    const source = { width: 64, height: 64 } as unknown as HTMLCanvasElement;

    const result = await suggestMiiFromImage(source, DEFAULT_PLAYER_MII);
    expect(workerSpy).not.toHaveBeenCalled();
    expect(detectSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(result.draft.headShape).toBe('oval');

    // WebGL unavailable throws structured WEBGL_UNAVAILABLE
    webglAvailable = false;
    await expect(suggestMiiFromImage(source, DEFAULT_PLAYER_MII)).rejects.toMatchObject({
      code: 'WEBGL_UNAVAILABLE',
    });
  });
});
