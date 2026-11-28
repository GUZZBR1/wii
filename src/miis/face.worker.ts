/// <reference lib="webworker" />
import type { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { FacePoint } from './photoToMii';

export type FaceWorkerDelegate = 'CPU' | 'GPU';

export type FaceWorkerRequest = {
  readonly type: 'DETECT_FACE';
  readonly requestId: number;
  readonly bitmap: ImageBitmap;
  readonly wasmBaseUrl: string;
  readonly modelUrl: string;
  readonly delegate: FaceWorkerDelegate;
};

export type FaceWorkerErrorCode = 'WEBGL_UNAVAILABLE' | 'MODEL_MISSING' | 'NO_FACE_DETECTED' | 'DETECTION_FAILED';

export type FaceWorkerReply =
  | {
      readonly type: 'RESULT';
      readonly requestId: number;
      readonly landmarks: readonly FacePoint[];
      readonly frameWidth: number;
      readonly frameHeight: number;
    }
  | {
      readonly type: 'ERROR';
      readonly requestId: number;
      readonly code: FaceWorkerErrorCode;
      readonly message: string;
    };

function hasWorkerWebGl(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    const probe = new OffscreenCanvas(1, 1);
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}

function simplifyLandmarks(points: readonly { x: number; y: number; z?: number }[] | undefined): FacePoint[] {
  return (points ?? []).map(({ x, y, z }) => ({ x, y, z }));
}

self.onmessage = async ({ data }: MessageEvent<FaceWorkerRequest>) => {
  if (data.type !== 'DETECT_FACE') return;
  const { requestId, bitmap, wasmBaseUrl, modelUrl, delegate } = data;
  let landmarker: FaceLandmarker | undefined;

  try {
    if (!hasWorkerWebGl()) {
      self.postMessage({
        type: 'ERROR',
        requestId,
        code: 'WEBGL_UNAVAILABLE',
        message: 'WebGL is unavailable in the worker context for face processing.',
      } satisfies FaceWorkerReply);
      return;
    }

    const response = await fetch(modelUrl);
    if (!response.ok) {
      self.postMessage({
        type: 'ERROR',
        requestId,
        code: 'MODEL_MISSING',
        message: `Face model is unavailable (${response.status}).`,
      } satisfies FaceWorkerReply);
      return;
    }
    const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
    const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');

    const createAndDetect = async (activeDelegate: FaceWorkerDelegate, instanceIndex: number) => {
      const vision = await FilesetResolver.forVisionTasks(wasmBaseUrl, true);
      if (instanceIndex > 0) {
        const loaderUrl = new URL(vision.wasmLoaderPath, self.location.href);
        loaderUrl.searchParams.set('instance', String(instanceIndex));
        vision.wasmLoaderPath = loaderUrl.href;
      }
      const task = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetBuffer: instanceIndex > 0 ? modelAssetBuffer.slice() : modelAssetBuffer,
          delegate: activeDelegate,
        },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
      landmarker = task;
      return task.detect(bitmap);
    };

    let result: FaceLandmarkerResult;
    try {
      result = await createAndDetect(delegate, 0);
    } catch (error) {
      if (delegate !== 'GPU') throw error;
      try {
        landmarker?.close();
      } catch {
        // Ignore cleanup failure from failed GPU delegate.
      }
      landmarker = undefined;
      result = await createAndDetect('CPU', 1);
    }

    const landmarks = simplifyLandmarks(result.faceLandmarks[0]);
    if (landmarks.length < 468) {
      self.postMessage({
        type: 'ERROR',
        requestId,
        code: 'NO_FACE_DETECTED',
        message: 'No face was detected in the submitted image.',
      } satisfies FaceWorkerReply);
      return;
    }

    self.postMessage({
      type: 'RESULT',
      requestId,
      landmarks,
      frameWidth: bitmap.width,
      frameHeight: bitmap.height,
    } satisfies FaceWorkerReply);
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      requestId,
      code: 'DETECTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
    } satisfies FaceWorkerReply);
  } finally {
    try {
      landmarker?.close();
    } catch {
      // Ignore close errors.
    }
    bitmap.close();
  }
};
