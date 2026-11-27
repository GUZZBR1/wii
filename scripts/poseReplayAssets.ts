import type { Delegate } from '@wii/spatial-core';
import { POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from '../src/cv/mediapipeAssets';

export function poseReplayModelFiles(delegate: Delegate): { modelFile: string; cpuModelFile: string } {
  const lite = `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`;
  return {
    modelFile: delegate === 'GPU' ? `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task` : lite,
    cpuModelFile: lite,
  };
}
