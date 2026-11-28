import type { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { preferredDelegate } from '../cv/delegate';
import { faceModelUrl, visionWasmUrl } from '../cv/mediapipeAssets';
import type { FaceWorkerDelegate, FaceWorkerErrorCode, FaceWorkerReply, FaceWorkerRequest } from './face.worker';
import { DEFAULT_PLAYER_MII, sanitizeMiiProfile } from './miiCatalog';
import type { MiiProfile } from './miiTypes';
import { extractFaceColorSamples, type FacePoint, mapFaceToMii } from './photoToMii';

export type FaceSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

export type FaceSuggestErrorCode = 'INVALID_SOURCE' | FaceWorkerErrorCode;

export class FaceSuggestError extends Error {
  readonly code: FaceSuggestErrorCode;

  constructor(code: FaceSuggestErrorCode, message: string) {
    super(message);
    this.name = 'FaceSuggestError';
    this.code = code;
  }
}

export interface FaceSuggestResult {
  readonly draft: MiiProfile;
  readonly confidence: number;
  readonly warning?: string;
}

const MAX_EDGE_PX = 512;
const WORKER_TIMEOUT_MS = 25_000;

interface FaceAssets {
  readonly wasmBaseUrl: string;
  readonly modelUrl: string;
}

/**
 * Off the page there is no `location.origin`; the worker then resolves the paths itself. The worker
 * receives the same pinned pair any other task uses, so no caller builds MediaPipe URLs by hand.
 */
function defaultFaceAssets(): FaceAssets {
  return { wasmBaseUrl: visionWasmUrl(), modelUrl: faceModelUrl() };
}

/**
 * Mirrors MediaPipe's `Oh()` gate in `vision_bundle.mjs`: Safari < 17 defines
 * `OffscreenCanvas` without WebGL, causing `document.createElement` inside a worker.
 */
export function canUseFaceWorker(nav: { readonly userAgent?: string } | undefined = globalThis.navigator): boolean {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  const ua = nav?.userAgent ?? '';
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome');
  if (!isSafari) return true;
  const match = ua.match(/Version\/([\d]+).*Safari/);
  return Boolean(match && Number(match[1]) >= 17);
}

function readSourceDimensions(source: FaceSource): { width: number; height: number } {
  if ('videoWidth' in source && typeof source.videoWidth === 'number') {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if ('naturalWidth' in source && typeof source.naturalWidth === 'number') {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

function rasterizeSource(source: FaceSource): {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  width: number;
  height: number;
} {
  const { width: srcW, height: srcH } = readSourceDimensions(source);
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    throw new FaceSuggestError('INVALID_SOURCE', 'Image or video frame dimensions are invalid.');
  }
  if (typeof document === 'undefined') {
    throw new FaceSuggestError('DETECTION_FAILED', 'The DOM is unavailable to prepare the image.');
  }

  const scale = Math.min(1, MAX_EDGE_PX / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new FaceSuggestError('DETECTION_FAILED', 'Could not create a 2D context to read the image.');
  }
  ctx.drawImage(source, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { canvas, imageData, width, height };
}

function runWorkerDetection(
  bitmap: ImageBitmap,
  assets: FaceAssets,
  delegate: FaceWorkerDelegate,
): Promise<readonly FacePoint[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./face.worker.ts', import.meta.url), { type: 'module' });
    const requestId = 1;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    const fail = (err: FaceSuggestError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new FaceSuggestError('DETECTION_FAILED', 'Timed out while analyzing the face in the image.'));
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = ({ data }: MessageEvent<FaceWorkerReply>) => {
      if (!data || data.requestId !== requestId) return;
      if (data.type === 'ERROR') {
        fail(new FaceSuggestError(data.code, data.message));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data.landmarks);
    };

    worker.onerror = (event) => {
      const msg = event instanceof ErrorEvent && event.message ? event.message : 'Face detection worker failed.';
      fail(new FaceSuggestError('DETECTION_FAILED', msg));
    };

    try {
      const request: FaceWorkerRequest = {
        type: 'DETECT_FACE',
        requestId,
        bitmap,
        wasmBaseUrl: assets.wasmBaseUrl,
        modelUrl: assets.modelUrl,
        delegate,
      };
      worker.postMessage(request, [bitmap]);
    } catch (error) {
      try {
        bitmap.close();
      } catch {
        // Ignore if already neutered.
      }
      fail(new FaceSuggestError('DETECTION_FAILED', error instanceof Error ? error.message : String(error)));
    }
  });
}

async function runMainThreadFallback(
  canvas: HTMLCanvasElement,
  assets: FaceAssets,
  delegate: FaceWorkerDelegate,
): Promise<readonly FacePoint[]> {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') ?? probe.getContext('webgl'))) {
    throw new FaceSuggestError('WEBGL_UNAVAILABLE', 'WebGL is unavailable in this browser for face detection.');
  }

  const response = await fetch(assets.modelUrl);
  if (!response.ok) {
    throw new FaceSuggestError('MODEL_MISSING', `Face model is unavailable (${response.status}).`);
  }
  const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
  const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');

  let landmarker: FaceLandmarker | undefined;
  try {
    const createAndDetect = async (activeDelegate: FaceWorkerDelegate, instanceIndex: number) => {
      const vision = await FilesetResolver.forVisionTasks(assets.wasmBaseUrl, true);
      if (instanceIndex > 0) {
        const loaderUrl = new URL(vision.wasmLoaderPath, globalThis.location?.href ?? 'http://localhost');
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
      return task.detect(canvas);
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

    const points = (result.faceLandmarks[0] ?? []).map(({ x, y, z }) => ({ x, y, z }));
    if (points.length < 468) {
      throw new FaceSuggestError('NO_FACE_DETECTED', 'Nenhum rosto detectado na imagem enviada.');
    }
    return points;
  } finally {
    try {
      landmarker?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

export async function suggestMiiFromImage(
  source: FaceSource,
  baseProfile: MiiProfile = DEFAULT_PLAYER_MII,
): Promise<FaceSuggestResult> {
  const safeBase = sanitizeMiiProfile(baseProfile, DEFAULT_PLAYER_MII);
  const { canvas, imageData, width, height } = rasterizeSource(source);
  const assets = defaultFaceAssets();
  const delegate: FaceWorkerDelegate = preferredDelegate() === 'GPU' ? 'GPU' : 'CPU';

  let landmarks: readonly FacePoint[];
  if (canUseFaceWorker()) {
    if (typeof createImageBitmap !== 'function') {
      throw new FaceSuggestError('DETECTION_FAILED', 'createImageBitmap is unavailable in this browser.');
    }
    const bitmap = await createImageBitmap(canvas);
    landmarks = await runWorkerDetection(bitmap, assets, delegate);
  } else {
    landmarks = await runMainThreadFallback(canvas, assets, delegate);
  }

  if (landmarks.length < 468) {
    throw new FaceSuggestError('NO_FACE_DETECTED', 'Nenhum rosto detectado na imagem enviada.');
  }

  const colors = extractFaceColorSamples({ data: imageData.data, width, height }, landmarks);
  const mapped = mapFaceToMii({
    landmarks,
    colors,
    aspectRatio: width / height,
    baseProfile: safeBase,
  });

  if (mapped.confidence <= 0) {
    throw new FaceSuggestError('NO_FACE_DETECTED', mapped.warnings[0] ?? 'Nenhum rosto detectado na imagem enviada.');
  }

  return {
    draft: mapped.draft,
    confidence: mapped.confidence,
    warning: mapped.warnings.length > 0 ? mapped.warnings.join(' ') : undefined,
  };
}
