import { HandFeatureExtractor, handGestureVector } from '@wii/spatial-core';
import { handSnapshot } from './syntheticHand';

export type SyntheticGesture = 'pinch-right' | 'pinch-left' | 'open-right' | 'near-miss' | 'rest' | 'random';

export interface SyntheticGestureOptions {
  frameCount?: number;
  frameIntervalMs?: number;
  noise?: number;
  seed?: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** Creates deterministic, timestamped hand features for gesture accuracy and rejection checks. */
export function syntheticGestureSequence(
  kind: SyntheticGesture,
  options: SyntheticGestureOptions = {},
): number[][] {
  const frameCount = options.frameCount ?? 20;
  const frameIntervalMs = options.frameIntervalMs ?? 33;
  const noise = options.noise ?? 0;
  if (!Number.isInteger(frameCount) || frameCount < 2) throw new RangeError('frameCount must be at least 2.');
  if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
    throw new RangeError('frameIntervalMs must be finite and positive.');
  }
  if (!Number.isFinite(noise) || noise < 0) throw new RangeError('noise must be finite and non-negative.');

  const random = seededRandom(options.seed ?? 1);
  const extractor = new HandFeatureExtractor();
  const result: number[][] = [];
  let randomPosition = 0.5;

  for (let index = 0; index < frameCount; index += 1) {
    const progress = index / (frameCount - 1);
    const sampleNoise = () => (random() * 2 - 1) * noise;
    let screenX = 0.5;
    let pinchRatio = 0.8;

    if (kind === 'pinch-right' || kind === 'open-right') {
      screenX = 0.36 + progress * 0.28;
      if (kind === 'pinch-right' && progress >= 0.2 && progress <= 0.8) pinchRatio = 0.2;
    } else if (kind === 'pinch-left') {
      screenX = 0.64 - progress * 0.28;
      if (progress >= 0.2 && progress <= 0.8) pinchRatio = 0.2;
    } else if (kind === 'near-miss') {
      screenX = 0.36 + progress * 0.28;
      if (progress >= 0.05 && progress <= 0.25) pinchRatio = 0.2;
    } else if (kind === 'rest') {
      screenX = 0.5 + sampleNoise();
      pinchRatio = 0.8 + sampleNoise();
    } else {
      randomPosition = Math.max(0.25, Math.min(0.75, randomPosition + (random() * 2 - 1) * 0.08));
      screenX = randomPosition;
      pinchRatio = random() < 0.5 ? 0.2 : 0.8;
    }

    const snapshot = handSnapshot(index * frameIntervalMs, {
      screenX: screenX + sampleNoise(),
      pinchRatio: Math.max(0.05, Math.min(1, pinchRatio + sampleNoise() * 0.25)),
    });
    const features = extractor.extract(snapshot)[0];
    if (!features) throw new Error(`Synthetic ${kind} frame did not produce hand features.`);
    result.push(handGestureVector(features));
  }

  return result;
}
