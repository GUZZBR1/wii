/// <reference lib="webworker" />
import { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createDelegateTask, loadModelBytes, type VisionFileset } from './mediaPipeTask';
import type { Delegate, Point3, WorkerReply, WorkerRequest } from './poseProtocol';

let session: ReturnType<typeof createDelegateTask<PoseLandmarker>> | undefined;
let modelUrl = '';
let cpuModelUrl = '';

function simplify(
  points: readonly { x: number; y: number; z: number; visibility?: number; presence?: number }[] | undefined,
): Point3[] {
  return (points ?? []).map(({ x, y, z, visibility, presence }) => ({ x, y, z, visibility, presence }));
}

async function createPoseTask(fileset: VisionFileset, delegate: Delegate) {
  const activeModelUrl = delegate === 'CPU' && cpuModelUrl ? cpuModelUrl : modelUrl;
  const modelBytes = await loadModelBytes(activeModelUrl, 'Pose');
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBytes, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    outputSegmentationMasks: false,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.38,
    minTrackingConfidence: 0.38,
  });
}

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'INIT') {
    modelUrl = data.modelUrl;
    cpuModelUrl = data.cpuModelUrl ?? data.modelUrl;
    const active = createDelegateTask<PoseLandmarker>({
      wasmBaseUrl: data.wasmBaseUrl,
      create: createPoseTask,
    });
    session = active;
    try {
      // What actually came up: init falls back to CPU on its own, and the client sizes frames and
      // reports the delegate from this reply.
      const delegate = await active.init(data.delegate);
      self.postMessage({ type: 'READY', delegate } satisfies WorkerReply);
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        stage: 'init',
        fatal: true,
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerReply);
    }
    return;
  }

  if (data.type === 'DISPOSE') {
    session?.dispose();
    session = undefined;
    return;
  }

  const { bitmap, timestampMs, requestId, captureEpoch } = data;
  const landmarker = session?.task;
  if (!session || !landmarker) {
    bitmap.close();
    // During a delegate re-init the missing landmarker is expected — the frame is dropped so the
    // client releases its one-in-flight slot, but the session survives. Outside a transition it is
    // the fatal invariant violation it always was.
    self.postMessage(
      session?.switching
        ? ({
            type: 'ERROR',
            stage: 'detect',
            fatal: false,
            requestId,
            captureEpoch,
            message: 'Reinicializando em CPU; frame descartado.',
          } satisfies WorkerReply)
        : ({
            type: 'ERROR',
            stage: 'detect',
            fatal: true,
            requestId,
            captureEpoch,
            message: 'PoseLandmarker is not initialized',
          } satisfies WorkerReply),
    );
    return;
  }
  try {
    const inferenceStart = performance.now();
    const result = landmarker.detectForVideo(bitmap, timestampMs);
    // The verdict runs on real frames — the GPU delegate over software GL is slow without ever
    // throwing — and BEFORE the POSE reply: one terminal reply per frame. The client releases its
    // in-flight slot on POSE, so a fatal ERROR posted after it is dropped as stale and the failure
    // would only surface, misattributed, on the next frame.
    const verdict = await session.judgeLatency(performance.now() - inferenceStart);
    self.postMessage(
      verdict.ok
        ? ({
            type: 'POSE',
            requestId,
            captureEpoch,
            timestampMs,
            landmarks: simplify(result.landmarks[0]),
            worldLandmarks: simplify(result.worldLandmarks[0]),
            frameWidth: bitmap.width,
            frameHeight: bitmap.height,
          } satisfies WorkerReply)
        : ({
            type: 'ERROR',
            stage: 'detect',
            fatal: true,
            requestId,
            captureEpoch,
            message: verdict.message,
          } satisfies WorkerReply),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const outcome = await session.fallback(reason);
    self.postMessage(
      outcome.ok
        ? ({
            type: 'ERROR',
            stage: 'detect',
            fatal: false,
            requestId,
            captureEpoch,
            message: 'GPU falhou; próxima captura será processada em CPU.',
          } satisfies WorkerReply)
        : ({
            type: 'ERROR',
            stage: 'detect',
            fatal: true,
            requestId,
            captureEpoch,
            message: outcome.message,
          } satisfies WorkerReply),
    );
  } finally {
    bitmap.close();
  }
};
