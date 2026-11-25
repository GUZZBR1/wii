import { createPoseRecording, parsePoseRecording } from '@wii/spatial-core';
import type { Point3, PoseRecording, PoseSnapshot, WorkerReply, WorkerRequest } from '@wii/spatial-core';
import { MEDIAPIPE_WASM_VERSION, POSE_MODEL_SHA8 } from '../src/cv/mediapipeAssets';

const SAMPLE_STEP_MS = 100;
const MAX_CLIP_BYTES = 256 * 1024 * 1024;
const videoInput = document.querySelector<HTMLInputElement>('#video-file')!;
const referenceInput = document.querySelector<HTMLInputElement>('#reference-file')!;
const delegateInput = document.querySelector<HTMLSelectElement>('#delegate')!;
const imageToleranceInput = document.querySelector<HTMLInputElement>('#image-tolerance')!;
const worldToleranceInput = document.querySelector<HTMLInputElement>('#world-tolerance')!;
const confidenceToleranceInput = document.querySelector<HTMLInputElement>('#confidence-tolerance')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download')!;
const video = document.querySelector<HTMLVideoElement>('#video')!;
const report = document.querySelector<HTMLPreElement>('#report')!;

let currentRecording: PoseRecording | undefined;
let activeWorker: Worker | undefined;
let currentUrl: string | undefined;

interface PendingFrame {
  resolve: (reply: Extract<WorkerReply, { type: 'POSE' }>) => void;
  reject: (error: Error) => void;
  timeout: number;
}

class PoseWorkerSession {
  private readonly pending = new Map<number, PendingFrame>();
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private requestId = 1;
  private effectiveDelegate: 'CPU' | 'GPU';

  constructor(private readonly worker: Worker, preferredDelegate: 'CPU' | 'GPU') {
    this.effectiveDelegate = preferredDelegate;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => this.onMessage(data);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'Pose worker failed.'));
  }

  async initialize(wasmBaseUrl: string, modelUrl: string): Promise<'CPU' | 'GPU'> {
    this.worker.postMessage({ type: 'INIT', delegate: this.effectiveDelegate, wasmBaseUrl, modelUrl } satisfies WorkerRequest);
    let timeout: number | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Pose worker initialization timed out.')), 30_000); }),
      ]);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
    return this.effectiveDelegate;
  }

  detect(bitmap: ImageBitmap, timestampMs: number): Promise<Extract<WorkerReply, { type: 'POSE' }>> {
    const requestId = this.requestId++;
    const captureEpoch = 1;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Pose inference timed out at ${timestampMs} ms.`));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.worker.postMessage({ type: 'FRAME', requestId, captureEpoch, timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(requestId);
        bitmap.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.worker.postMessage({ type: 'DISPOSE' } satisfies WorkerRequest);
    this.worker.terminate();
    this.failAll(new Error('Pose worker was disposed.'));
  }

  private onMessage(message: WorkerReply): void {
    if (message.type === 'READY') {
      this.effectiveDelegate = message.delegate;
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
    } else if (message.type === 'FALLBACK') {
      this.effectiveDelegate = message.to;
    } else if (message.type === 'ERROR') {
      const error = new Error(message.message);
      if (message.stage === 'init') this.readyReject?.(error);
      else {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          window.clearTimeout(pending.timeout);
          this.pending.delete(message.requestId);
          pending.reject(error);
        }
      }
    } else if (message.type === 'POSE') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
    }
  }

  private failAll(error: Error): void {
    this.readyReject?.(error);
    this.readyReject = undefined;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function confidence(points: readonly Point3[]): number {
  const indices = [11, 12, 23, 24];
  if (indices.some((index) => !points[index])) return 0;
  return Math.min(...indices.map((index) => {
    const point = points[index]!;
    return Math.min(point.visibility ?? point.presence ?? 0, point.presence ?? point.visibility ?? 0);
  }));
}

function snapshotFromReply(reply: Extract<WorkerReply, { type: 'POSE' }>): PoseSnapshot {
  return {
    timestampMs: reply.timestampMs,
    landmarks: reply.landmarks,
    worldLandmarks: reply.worldLandmarks,
    trackingState: 'degraded',
    bodyConfidence: confidence(reply.landmarks),
  };
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function modelAssets() {
  const sumsResponse = await fetch('/mediapipe/models/SHA256SUMS');
  if (!sumsResponse.ok) throw new Error('Could not read the local MediaPipe model checksum manifest.');
  const sums = await sumsResponse.text();
  const modelName = `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`;
  const expectedHash = sums.split(/\r?\n/).find((line) => line.trim().endsWith(modelName))?.trim().split(/\s+/)[0];
  if (!expectedHash) throw new Error(`Model ${modelName} is not listed in SHA256SUMS.`);
  const modelUrl = new URL(`/mediapipe/models/${modelName}`, location.origin).href;
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) throw new Error(`Could not fetch local model (${modelResponse.status}).`);
  const actualHash = await sha256(await modelResponse.arrayBuffer());
  if (actualHash !== expectedHash) throw new Error('Local pose model does not match SHA256SUMS.');
  return {
    wasmBaseUrl: new URL(`/mediapipe/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href,
    modelUrl,
    modelSha256: actualHash,
  };
}

function loadVideo(file: File): Promise<void> {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  video.src = currentUrl;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Video metadata did not load within 15 seconds.')), 15_000);
    video.onloadedmetadata = () => { window.clearTimeout(timeout); resolve(); };
    video.onerror = () => { window.clearTimeout(timeout); reject(new Error('Browser could not decode this video.')); };
    video.load();
  });
}

async function seekTo(seconds: number): Promise<void> {
  if (Math.abs(video.currentTime - seconds) < 0.001) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Video seek timed out at ${seconds.toFixed(3)} s.`)), 10_000);
    video.onseeked = () => { window.clearTimeout(timeout); resolve(); };
    video.onerror = () => { window.clearTimeout(timeout); reject(new Error('Video seek failed.')); };
    video.currentTime = seconds;
  });
}

async function readReference(file: File): Promise<PoseRecording> {
  return parsePoseRecording(await file.text());
}

function incompatibleReasons(reference: PoseRecording, actual: PoseRecording): string[] {
  const reasons: string[] = [];
  const expectedSource = reference.source;
  const actualSource = actual.source;
  if (expectedSource.kind !== 'mediapipe') reasons.push('reference source is not MediaPipe');
  if (expectedSource.tasksVisionVersion !== actualSource.tasksVisionVersion) reasons.push('MediaPipe Tasks version differs');
  if (expectedSource.modelSha256 !== actualSource.modelSha256) reasons.push('pose model checksum differs');
  if (expectedSource.delegate !== actualSource.delegate) reasons.push('delegate differs');
  if (expectedSource.runningMode !== 'VIDEO') reasons.push('reference was not captured in VIDEO mode');
  if (reference.timestampClock !== actual.timestampClock) reasons.push('timestamp clock domain differs');
  if (expectedSource.runtime?.userAgent !== actualSource.runtime?.userAgent) reasons.push('browser user agent differs');
  if (expectedSource.runtime?.platform !== actualSource.runtime?.platform) reasons.push('browser platform differs');
  if (expectedSource.input?.sha256 !== actualSource.input?.sha256) reasons.push('input video checksum differs');
  if (expectedSource.input?.width !== actualSource.input?.width || expectedSource.input?.height !== actualSource.input?.height) {
    reasons.push('input video dimensions differ');
  }
  if (reference.frameCount !== actual.frameCount) reasons.push('sampled frame count differs');
  if (reference.frames.some((frame, index) => frame.snapshot.timestampMs !== actual.frames[index]?.snapshot.timestampMs)) {
    reasons.push('sampled frame timestamps differ');
  }
  return reasons;
}

function errors(reference: PoseRecording, actual: PoseRecording) {
  const image: number[] = [];
  const world: number[] = [];
  const confidence: number[] = [];
  let topologyMismatch = false;
  let trackingStateMismatch = false;
  for (let frameIndex = 0; frameIndex < Math.min(reference.frames.length, actual.frames.length); frameIndex += 1) {
    const expected = reference.frames[frameIndex]!.snapshot;
    const observed = actual.frames[frameIndex]!.snapshot;
    confidence.push(Math.abs(expected.bodyConfidence - observed.bodyConfidence));
    trackingStateMismatch ||= expected.trackingState !== observed.trackingState;
    if (expected.landmarks.length !== observed.landmarks.length || expected.worldLandmarks.length !== observed.worldLandmarks.length) {
      topologyMismatch = true;
      continue;
    }
    for (let pointIndex = 0; pointIndex < expected.landmarks.length; pointIndex += 1) {
      for (const axis of ['x', 'y', 'z'] as const) {
        image.push(Math.abs(expected.landmarks[pointIndex]![axis] - observed.landmarks[pointIndex]![axis]));
        world.push(Math.abs(expected.worldLandmarks[pointIndex]![axis] - observed.worldLandmarks[pointIndex]![axis]));
      }
      for (const key of ['visibility', 'presence'] as const) {
        const expectedImageConfidence = expected.landmarks[pointIndex]![key];
        const actualImageConfidence = observed.landmarks[pointIndex]![key];
        const expectedWorldConfidence = expected.worldLandmarks[pointIndex]![key];
        const actualWorldConfidence = observed.worldLandmarks[pointIndex]![key];
        if (expectedImageConfidence !== undefined && actualImageConfidence !== undefined) {
          confidence.push(Math.abs(expectedImageConfidence - actualImageConfidence));
        } else if (expectedImageConfidence !== actualImageConfidence) topologyMismatch = true;
        if (expectedWorldConfidence !== undefined && actualWorldConfidence !== undefined) {
          confidence.push(Math.abs(expectedWorldConfidence - actualWorldConfidence));
        } else if (expectedWorldConfidence !== actualWorldConfidence) topologyMismatch = true;
      }
    }
  }
  const stats = (values: number[]) => {
    if (!values.length) return { comparedValues: 0, maxAbsError: null, p95AbsError: null };
    const sorted = [...values].sort((a, b) => a - b);
    return {
      comparedValues: sorted.length,
      maxAbsError: sorted.at(-1)!,
      p95AbsError: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    };
  };
  return { topologyMismatch, trackingStateMismatch, image: stats(image), world: stats(world), confidence: stats(confidence) };
}

async function run(): Promise<void> {
  const videoFile = videoInput.files?.[0];
  const referenceFile = referenceInput.files?.[0];
  if (!videoFile) throw new Error('Choose a local video clip.');
  if (videoFile.size > MAX_CLIP_BYTES) throw new RangeError('The local harness accepts clips up to 256 MiB.');
  const imageTolerance = Number(imageToleranceInput.value);
  const worldTolerance = Number(worldToleranceInput.value);
  const confidenceTolerance = Number(confidenceToleranceInput.value);
  if (![imageTolerance, worldTolerance, confidenceTolerance].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('Coordinate tolerances must be finite, non-negative numbers.');
  }

  const reference = referenceFile ? await readReference(referenceFile) : undefined;
  await loadVideo(videoFile);
  const videoHash = await sha256(await videoFile.arrayBuffer());
  const model = await modelAssets();
  const worker = new Worker(new URL('../packages/core/src/providers/pose.worker.ts', import.meta.url), { type: 'module' });
  activeWorker = worker;
  const requestedDelegate = delegateInput.value as 'CPU' | 'GPU';
  const session = new PoseWorkerSession(worker, requestedDelegate);
  const effectiveDelegate = await session.initialize(model.wasmBaseUrl, model.modelUrl);
  const snapshots: PoseSnapshot[] = [];
  const frameCount = Math.floor((video.duration * 1000) / SAMPLE_STEP_MS) + 1;

  for (let sequence = 0; sequence < frameCount; sequence += 1) {
    const timestampMs = sequence * SAMPLE_STEP_MS;
    await seekTo(timestampMs / 1000);
    const bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'low' });
    const reply = await session.detect(bitmap, timestampMs);
    snapshots.push(snapshotFromReply(reply));
    report.textContent = `Processed ${sequence + 1}/${frameCount} sampled frames…`;
  }

  session.dispose();
  activeWorker = undefined;
  currentRecording = createPoseRecording(snapshots, {
    kind: 'mediapipe',
    tasksVisionVersion: MEDIAPIPE_WASM_VERSION,
    modelSha256: model.modelSha256,
    delegate: effectiveDelegate,
    runningMode: 'VIDEO',
    droppedFrameCount: 0,
    runtime: { userAgent: navigator.userAgent, platform: navigator.platform },
    input: {
      width: video.videoWidth,
      height: video.videoHeight,
      rotationDegrees: 0,
      mirrored: false,
      sha256: videoHash,
    },
  }, 'media-time');
  downloadButton.disabled = false;

  if (!reference) {
    const result = {
      status: 'recorded',
      message: 'This run can be downloaded as a reference. Re-run with that JSON selected to compare future inference.',
      sampling: { stepMs: SAMPLE_STEP_MS, frameCount, videoDurationMs: video.duration * 1000 },
      runtime: currentRecording.source,
    };
    (window as Window & { POSE_REGRESSION?: unknown }).POSE_REGRESSION = result;
    report.textContent = JSON.stringify(result, null, 2);
    console.log('POSE_REGRESSION', result);
    return;
  }

  const reasons = incompatibleReasons(reference, currentRecording);
  const difference = errors(reference, currentRecording);
  const hasValues = difference.image.comparedValues > 0 && difference.world.comparedValues > 0;
  const passed = reasons.length === 0 && hasValues && !difference.topologyMismatch && !difference.trackingStateMismatch &&
    difference.image.maxAbsError! <= imageTolerance && difference.world.maxAbsError! <= worldTolerance &&
    difference.confidence.maxAbsError! <= confidenceTolerance;
  const result = {
    status: reasons.length > 0 ? 'incomparable' : !hasValues ? 'inconclusive' : passed ? 'pass' : 'fail',
    comparison: reasons,
    sampling: { stepMs: SAMPLE_STEP_MS, frameCount, videoDurationMs: video.duration * 1000 },
    tolerance: {
      imageCoordinateMaxAbs: imageTolerance,
      worldCoordinateMaxAbsMeters: worldTolerance,
      confidenceMaxAbs: confidenceTolerance,
    },
    differences: difference,
    runtime: currentRecording.source,
  };
  (window as Window & { POSE_REGRESSION?: unknown }).POSE_REGRESSION = result;
  report.textContent = JSON.stringify(result, null, 2);
  console.log('POSE_REGRESSION', result);
}

runButton.addEventListener('click', () => {
  runButton.disabled = true;
  downloadButton.disabled = true;
  currentRecording = undefined;
  report.textContent = 'Starting local Pose inference…';
  void run().catch((error: unknown) => {
    report.textContent = JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : String(error) }, null, 2);
    activeWorker?.terminate();
    activeWorker = undefined;
  }).finally(() => { runButton.disabled = false; });
});

downloadButton.addEventListener('click', () => {
  if (!currentRecording) return;
  const blob = new Blob([JSON.stringify(currentRecording, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pose-recording-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

window.addEventListener('beforeunload', () => {
  activeWorker?.terminate();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
});
