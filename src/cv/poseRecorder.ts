import { createPoseRecording, serializePoseRecording } from '@wii/spatial-core';
import type { Delegate, PoseSnapshot } from './protocol';
import { MEDIAPIPE_WASM_VERSION, POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from './mediapipeAssets';
import { segmentAt } from './recordingScript';

/** Keeps the raw snapshots exactly as the game receives them. Body points only, never video. */
export class PoseRecorder {
  private readonly frames: PoseSnapshot[] = [];

  /** Stores the frame and returns what the player should be doing now; undefined ends the script. */
  push(snapshot: PoseSnapshot): ReturnType<typeof segmentAt> {
    const first = this.frames[0]?.timestampMs ?? snapshot.timestampMs;
    const current = segmentAt(snapshot.timestampMs - first);
    if (current) this.frames.push(snapshot);
    return current;
  }

  get frameCount(): number { return this.frames.length; }

  serialize(delegate: Delegate, modelSha256: string): string {
    return serializePoseRecording(createPoseRecording(this.frames, {
      kind: 'mediapipe',
      tasksVisionVersion: MEDIAPIPE_WASM_VERSION,
      modelSha256,
      delegate,
      runningMode: 'VIDEO',
      runtime: { userAgent: navigator.userAgent, platform: navigator.platform },
    }));
  }
}

/** GPU runs the full model and CPU the lite one; the recording must say which it measured. */
export async function downloadRecording(recorder: PoseRecorder, delegate: Delegate): Promise<void> {
  const modelName = delegate === 'GPU' ? `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task` : `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`;
  const sums = await (await fetch(`${import.meta.env.BASE_URL}mediapipe/models/SHA256SUMS`)).text();
  const sha = sums.split(/\r?\n/).find((line) => line.trim().endsWith(modelName))?.trim().split(/\s+/)[0];
  if (!sha) throw new Error(`Modelo ${modelName} não está no SHA256SUMS.`);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([recorder.serialize(delegate, sha)], { type: 'application/json' }));
  link.download = `corrida-${delegate}-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
