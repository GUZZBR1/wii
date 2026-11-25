import type { CanonicalHandFeatures } from '../geometry/handFeatures';

export interface PosePrototypeOptions {
  /** Starting rejection threshold. Tune this with examples from the target camera and user population. */
  minSimilarity?: number;
  /** Best-versus-runner-up gap required when more than one class exists. */
  minMargin?: number;
  /** Bounds memory and keeps the few-shot training set explicit. */
  maxExamplesPerLabel?: number;
}

export interface PosePrediction {
  label: string;
  similarity: number;
  margin: number;
}

const DEFAULT_MIN_SIMILARITY = 0.82;
const DEFAULT_MIN_MARGIN = 0.08;
const DEFAULT_MAX_EXAMPLES = 32;
const GROUP_WEIGHT = Math.SQRT1_2;
const MIN_NORM = 1e-10;

function normalize(values: readonly number[]): number[] | undefined {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return undefined;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm <= MIN_NORM) return undefined;
  return values.map((value) => value / norm);
}

function normalizeOrZero(values: readonly number[]): number[] | undefined {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return undefined;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm <= MIN_NORM) return values.map(() => 0);
  return values.map((value) => value / norm);
}

function poseVector(features: CanonicalHandFeatures): number[] | undefined {
  if (features.landmarks.length !== 21 || features.jointCosines.length !== 15) return undefined;
  const coordinates = normalize(features.landmarks.flatMap(({ x, y, z }) => [x, y, z]));
  const angles = normalizeOrZero(features.jointCosines);
  if (!coordinates || !angles) return undefined;
  return [...coordinates.map((value) => value * GROUP_WEIGHT), ...angles.map((value) => value * GROUP_WEIGHT)];
}

function normalizeMean(vectors: readonly (readonly number[])[]): number[] | undefined {
  if (vectors.length === 0) return undefined;
  const mean = Array.from(
    { length: vectors[0]!.length },
    (_, index) => vectors.reduce((sum, vector) => sum + vector[index]!, 0) / vectors.length,
  );
  return normalize(mean);
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0);
}

/** Few-shot static hand-pose classifier using one cosine-similarity prototype per label. */
export class PosePrototypeClassifier {
  private readonly minSimilarity: number;
  private readonly minMargin: number;
  private readonly maxExamplesPerLabel: number;
  private readonly examples = new Map<string, number[][]>();
  private readonly prototypes = new Map<string, number[]>();

  constructor(options: PosePrototypeOptions = {}) {
    this.minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
    this.maxExamplesPerLabel = options.maxExamplesPerLabel ?? DEFAULT_MAX_EXAMPLES;
    if (this.minSimilarity < -1 || this.minSimilarity > 1 || !Number.isFinite(this.minSimilarity)) {
      throw new RangeError('minSimilarity must be between -1 and 1.');
    }
    if (this.minMargin < 0 || this.minMargin > 2 || !Number.isFinite(this.minMargin)) {
      throw new RangeError('minMargin must be between 0 and 2.');
    }
    if (!Number.isInteger(this.maxExamplesPerLabel) || this.maxExamplesPerLabel < 1) {
      throw new RangeError('maxExamplesPerLabel must be a positive integer.');
    }
  }

  get labels(): readonly string[] {
    return [...this.prototypes.keys()];
  }

  addExample(label: string, features: CanonicalHandFeatures): number {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) throw new RangeError('Pose label cannot be empty.');
    const vector = poseVector(features);
    if (!vector) throw new RangeError('Pose features must contain 21 finite landmarks and 15 finite joint angles.');

    const examples = this.examples.get(normalizedLabel) ?? [];
    examples.push(vector);
    if (examples.length > this.maxExamplesPerLabel) examples.shift();
    this.examples.set(normalizedLabel, examples);
    const prototype = normalizeMean(examples);
    if (prototype) this.prototypes.set(normalizedLabel, prototype);
    else this.prototypes.delete(normalizedLabel);
    return examples.length;
  }

  classify(features: CanonicalHandFeatures): PosePrediction | undefined {
    const vector = poseVector(features);
    if (!vector) return undefined;
    const ranked = [...this.prototypes.entries()]
      .map(([label, prototype]) => ({ label, similarity: cosineSimilarity(vector, prototype) }))
      .sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0];
    if (!best || best.similarity < this.minSimilarity) return undefined;
    const margin = ranked.length > 1 ? best.similarity - ranked[1]!.similarity : 2;
    if (ranked.length > 1 && margin < this.minMargin) return undefined;
    return { ...best, margin };
  }

  exampleCount(label: string): number {
    return this.examples.get(label.trim())?.length ?? 0;
  }

  removeLabel(label: string): boolean {
    const normalizedLabel = label.trim();
    this.prototypes.delete(normalizedLabel);
    return this.examples.delete(normalizedLabel);
  }

  clear(): void {
    this.examples.clear();
    this.prototypes.clear();
  }
}
