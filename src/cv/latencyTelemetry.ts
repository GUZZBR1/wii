import type { Delegate, LatencyTelemetry, Percentiles } from './protocol';

class SampleWindow {
  private values: number[] = [];
  add(value: number): void { if (Number.isFinite(value)) { this.values.push(value); if (this.values.length > 240) this.values.shift(); } }
  percentiles(): Percentiles {
    if (!this.values.length) return { p50Ms: 0, p95Ms: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    return { p50Ms: this.pick(sorted, 0.5), p95Ms: this.pick(sorted, 0.95) };
  }
  private pick(values: number[], quantile: number): number { return values[Math.min(values.length - 1, Math.ceil(quantile * values.length) - 1)]!; }
  get size(): number { return this.values.length; }
}

export class LatencyTelemetryStore {
  private readonly roundtrip = new SampleWindow();
  private readonly inference = new SampleWindow();
  private readonly kinematics = new SampleWindow();
  private readonly eventToRender = new SampleWindow();
  private captureTimes: number[] = [];
  private resultTimes: number[] = [];
  private renderTimes: number[] = [];
  private droppedFrames = 0;
  private delegate: Delegate = 'GPU';
  private eventTimes = new Map<number, number>();

  recordFrame(capturedAtMs: number, resultAtMs: number, inferenceMs: number, kinematicsMs: number, delegate: Delegate): void {
    this.roundtrip.add(resultAtMs - capturedAtMs);
    this.inference.add(inferenceMs);
    this.kinematics.add(kinematicsMs);
    this.captureTimes.push(capturedAtMs); this.resultTimes.push(resultAtMs);
    this.captureTimes = this.captureTimes.slice(-120); this.resultTimes = this.resultTimes.slice(-120);
    this.delegate = delegate;
  }

  dropped(): void { this.droppedFrames += 1; }
  markEvent(eventId: number, timestampMs: number): void { this.eventTimes.set(eventId, timestampMs); }
  recordRender(nowMs: number): void {
    this.renderTimes.push(nowMs); this.renderTimes = this.renderTimes.slice(-120);
    for (const [id, at] of this.eventTimes) {
      this.eventToRender.add(nowMs - at);
      this.eventTimes.delete(id);
    }
  }

  snapshot(): LatencyTelemetry {
    return {
      captureToResult: this.roundtrip.percentiles(), inference: this.inference.percentiles(),
      kinematics: this.kinematics.percentiles(), eventToRender: this.eventToRender.percentiles(),
      cameraFps: this.fps(this.captureTimes), cvFps: this.fps(this.resultTimes), renderFps: this.fps(this.renderTimes),
      droppedFrames: this.droppedFrames, delegate: this.delegate,
      sampleCount: Math.min(this.roundtrip.size, this.inference.size, this.kinematics.size),
    };
  }

  private fps(times: number[]): number {
    if (times.length < 2) return 0;
    const elapsed = times.at(-1)! - times[0]!;
    return elapsed > 0 ? ((times.length - 1) * 1000) / elapsed : 0;
  }
}
