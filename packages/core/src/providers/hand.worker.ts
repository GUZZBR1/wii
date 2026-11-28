/// <reference lib="webworker" />
import { HandLandmarker } from '@mediapipe/tasks-vision';
import type { Delegate, Hand, Point3 } from '../types';
import type { HandObservation, HandWorkerFrame, HandWorkerReply, HandWorkerRequest } from './handProtocol';
import { createDelegateTask, type DelegateTask, loadModelBytes, type VisionFileset } from './mediaPipeTask';

const WARMUP_SIZE = 64;
/** MediaPipe timestamp consumed by the warm-up inference. */
const WARMUP_TIMESTAMP_MS = 0;
/**
 * VIDEO mode requires strictly increasing timestamps, and callers may start at 0.
 * Shifting every real frame keeps all of them above the warm-up and preserves their spacing.
 */
const GRAPH_TIMESTAMP_OFFSET_MS = 1;

let session: DelegateTask<HandLandmarker> | undefined;
let modelUrl = '';

function simplify(
  points: readonly { x: number; y: number; z: number; visibility?: number; presence?: number }[] | undefined,
): Point3[] {
  return (points ?? []).map(({ x, y, z, visibility, presence }) => ({ x, y, z, visibility, presence }));
}

function handedness(value: string | undefined): Hand | undefined {
  const normalized = value?.toLowerCase();
  return normalized === 'left' || normalized === 'right' ? normalized : undefined;
}

function observations(result: ReturnType<HandLandmarker['detectForVideo']>): HandObservation[] {
  return result.landmarks.map((landmarks, index) => {
    const category = result.handedness[index]?.[0];
    return {
      landmarks: simplify(landmarks),
      worldLandmarks: simplify(result.worldLandmarks[index]),
      handedness: handedness(category?.categoryName),
      handednessScore: category?.score,
    };
  });
}

/** Pays the first-inference setup cost (shader compilation, buffers) before the first real frame. */
function warmUp(landmarker: HandLandmarker): void {
  if (typeof OffscreenCanvas === 'undefined') return;
  try {
    const canvas = new OffscreenCanvas(WARMUP_SIZE, WARMUP_SIZE);
    // A canvas without a rendering context is not a usable image source everywhere.
    canvas.getContext('2d')?.fillRect(0, 0, WARMUP_SIZE, WARMUP_SIZE);
    landmarker.detectForVideo(canvas, WARMUP_TIMESTAMP_MS);
  } catch {
    // Best effort: a real GPU failure surfaces on the first real frame, which owns fallback.
  }
}

async function createHandTask(fileset: VisionFileset, delegate: Delegate) {
  const modelBytes = await loadModelBytes(modelUrl, 'Hand');
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBytes, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
    // Low presence/tracking floors keep a moving, blurred or tilted hand on the cheap tracking
    // path instead of re-running the palm detector.
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  });
}

async function processFrame({ bitmap, timestampMs, requestId }: HandWorkerFrame): Promise<void> {
  const landmarker = session?.task;
  if (!session || !landmarker) {
    // During a delegate re-init the missing landmarker is expected — the frame is dropped so the
    // client releases its one-in-flight slot, but the session survives. Outside a transition it is
    // the fatal invariant violation it always was.
    self.postMessage({
      type: 'ERROR',
      stage: 'detect',
      fatal: !session?.switching,
      requestId,
      message: session?.switching ? 'Reinicializando em CPU; frame descartado.' : 'HandLandmarker is not initialized',
    } satisfies HandWorkerReply);
    return;
  }
  try {
    const inferenceStart = performance.now();
    const result = landmarker.detectForVideo(bitmap, timestampMs + GRAPH_TIMESTAMP_OFFSET_MS);
    const hands = observations(result);
    // The reply waits for a delegate switch: the client keeps its one-in-flight slot, so no frame
    // is sent into the re-init, and a failed switch can still be reported against this request.
    const verdict = await session.judgeLatency(performance.now() - inferenceStart);
    self.postMessage(
      verdict.ok
        ? ({ type: 'HAND', requestId, timestampMs, hands } satisfies HandWorkerReply)
        : ({
            type: 'ERROR',
            stage: 'detect',
            fatal: true,
            requestId,
            message: verdict.message,
          } satisfies HandWorkerReply),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const outcome = await session.fallback(reason);
    self.postMessage({
      type: 'ERROR',
      stage: 'detect',
      fatal: !outcome.ok,
      requestId,
      message: outcome.ok ? 'GPU falhou; próxima captura será processada em CPU.' : outcome.message,
    } satisfies HandWorkerReply);
  }
}

self.onmessage = async ({ data }: MessageEvent<HandWorkerRequest>) => {
  if (data.type === 'INIT') {
    modelUrl = data.modelUrl;
    const active = createDelegateTask<HandLandmarker>({
      wasmBaseUrl: data.wasmBaseUrl,
      create: createHandTask,
      warmUp,
    });
    session = active;
    try {
      const delegate = await active.init(data.delegate);
      self.postMessage({ type: 'READY', delegate } satisfies HandWorkerReply);
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        stage: 'init',
        fatal: true,
        message: error instanceof Error ? error.message : String(error),
      } satisfies HandWorkerReply);
    }
    return;
  }

  if (data.type === 'DISPOSE') {
    session?.dispose();
    session = undefined;
    return;
  }

  // The transferred frame is owned here; this is its only close, on every path.
  try {
    await processFrame(data);
  } finally {
    data.bitmap.close();
  }
};
