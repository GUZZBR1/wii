/**
 * Latency-based GPU delegate evaluation. Measured baseline (pesquisa-pipeline-cv §7.5, Chromium
 * headless 25/nov/2026): real CPU inference is ~16-21 ms/frame, while the GPU delegate on
 * software GL (SwiftShader/llvmpipe — GPU blocklists, VMs, RDP) costs ~96-243 ms/frame and never
 * throws, so the exception-only fallback never fires. 45 ms sits safely between the two regimes.
 */
export const GPU_PROBE_BUDGET_MS = 45;

/** Warmed inferences required before the median is trusted. */
const MIN_WARMED_SAMPLES = 3;

/**
 * Decides from real per-frame inference times measured on the GPU delegate. The first sample is
 * always discarded: the inaugural `detectForVideo` carries lazy allocation and shader compilation
 * (~140 ms CPU, ~2 s on software GL) that says nothing about steady state. The median, not the
 * mean, decides — a single slow frame (GC pause, tab contention) must not cost the GPU delegate.
 */
export function shouldFallbackForLatency(inferenceTimesMs: readonly number[]): boolean {
  const warmed = inferenceTimesMs.slice(1);
  if (warmed.length < MIN_WARMED_SAMPLES) return false;
  const sorted = [...warmed].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median > GPU_PROBE_BUDGET_MS;
}
