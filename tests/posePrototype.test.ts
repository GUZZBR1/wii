import { describe, expect, it } from 'vitest';
import { HandFeatureExtractor, PosePrototypeClassifier } from '@nevergear/spatial-core';
import { handSnapshot } from './fixtures/syntheticHand';

function features(timestampMs: number, options: Parameters<typeof handSnapshot>[1] = {}) {
  return new HandFeatureExtractor().extract(handSnapshot(timestampMs, options))[0]!;
}

describe('pose prototype classifier', () => {
  it('learns cosine prototypes from a few examples and stays invariant to camera translation, scale, and rotation', () => {
    const classifier = new PosePrototypeClassifier();
    const openExamples = [
      features(0),
      features(0, { scale: 0.7, rotationRad: 0.2, translate: [1, 2, 3], screenX: 0.2 }),
      features(0, { scale: 2.3, rotationRad: -0.5, translate: [-2, 1, 0], screenX: 0.8 }),
    ];
    const fistExamples = [
      features(0, { pose: 'fist' }),
      features(0, { pose: 'fist', scale: 1.8, rotationRad: 0.35 }),
      features(0, { pose: 'fist', scale: 0.8, rotationRad: -0.55 }),
    ];
    openExamples.forEach((example) => {
      classifier.addExample('open', example);
    });
    fistExamples.forEach((example) => {
      classifier.addExample('fist', example);
    });

    const transformedOpen = features(10, { scale: 1.7, rotationRad: 0.9, translate: [3, -4, 1] });
    expect(classifier.classify(transformedOpen)?.label).toBe('open');
    expect(classifier.classify(features(10, { pose: 'fist', scale: 1.2, rotationRad: 0.8 }))?.label).toBe('fist');
    expect(classifier.exampleCount('open')).toBe(3);
    expect(classifier.labels).toEqual(['open', 'fist']);
  });

  it('rejects ambiguous labels, bounds stored examples, and removes classes cleanly', () => {
    const sample = features(0);
    const classifier = new PosePrototypeClassifier({ maxExamplesPerLabel: 2 });
    classifier.addExample('open', sample);
    classifier.addExample('other', sample);
    classifier.addExample('open', features(1, { screenX: 0.7 }));
    classifier.addExample('open', features(2, { screenX: 0.3 }));

    expect(classifier.classify(sample)).toBeUndefined();
    expect(classifier.exampleCount('open')).toBe(2);
    expect(classifier.removeLabel('other')).toBe(true);
    expect(classifier.classify(sample)?.label).toBe('open');
    classifier.clear();
    expect(classifier.labels).toEqual([]);
  });
});
