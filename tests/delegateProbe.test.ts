import { describe, expect, it } from 'vitest';
import { GPU_PROBE_BUDGET_MS, shouldFallbackForLatency } from '@nevergear/spatial-core';

describe('shouldFallbackForLatency', () => {
  it('falls back when the warmed median exceeds the frame budget — the software-GL case', () => {
    // Measured in docs/pesquisa-pipeline-cv.md §7.5: the GPU delegate on SwiftShader takes ~96-243 ms/frame.
    expect(shouldFallbackForLatency([2016, 110, 96, 243, 105, 120])).toBe(true);
  });

  it('stays on GPU for genuinely accelerated inference', () => {
    expect(shouldFallbackForLatency([300, 8, 9, 8, 10, 9])).toBe(false);
  });

  it('stays on GPU for a CPU-class median under the budget', () => {
    // CPU takes ~16-21 ms on this machine, below budget even if a mid-range GPU comes close.
    expect(shouldFallbackForLatency([200, 18, 20, 17, 21, 19])).toBe(false);
  });

  it('discards the first inference, which carries lazy compile/allocation warmup', () => {
    // A 2 s warmup spike on the first frame must not reject a healthy delegate.
    expect(shouldFallbackForLatency([2000, 10, 11, 10, 9, 10])).toBe(false);
  });

  it('ignores a single slow outlier frame — the median decides', () => {
    const samples = [100, 10, GPU_PROBE_BUDGET_MS + 30, 11, 10, 12];
    expect(shouldFallbackForLatency(samples)).toBe(false);
  });

  it('does not decide with fewer than four samples', () => {
    expect(shouldFallbackForLatency([])).toBe(false);
    expect(shouldFallbackForLatency([500])).toBe(false);
    expect(shouldFallbackForLatency([500, 200, 180])).toBe(false);
  });

  it('respects the budget boundary exactly', () => {
    expect(shouldFallbackForLatency([50, GPU_PROBE_BUDGET_MS, GPU_PROBE_BUDGET_MS, GPU_PROBE_BUDGET_MS, GPU_PROBE_BUDGET_MS])).toBe(false);
    expect(shouldFallbackForLatency([50, GPU_PROBE_BUDGET_MS + 1, GPU_PROBE_BUDGET_MS + 1, GPU_PROBE_BUDGET_MS + 1, GPU_PROBE_BUDGET_MS + 1])).toBe(true);
  });
});
