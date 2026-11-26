import type { PoseSnapshot } from '../cv/protocol';

/** A nose this close to the top edge means the head is leaving the picture. */
const HEAD_MARGIN = 0.02;

/**
 * BlazePose finds a person through the face and assumes the head is visible
 * (https://arxiv.org/abs/2006.10204). With it cut off, a running player is lost or drawn upside down.
 */
export function headOutOfFrame(snapshot: PoseSnapshot): boolean {
  const nose = snapshot.landmarks[0];
  return nose !== undefined && nose.y < HEAD_MARGIN;
}

/** Hips above shoulders cannot be a standing player: the tracker is hallucinating. */
export function upsideDown(snapshot: PoseSnapshot): boolean {
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [11, 12, 23, 24].map((index) => snapshot.landmarks[index]);
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return false;
  return leftHip.y + rightHip.y < leftShoulder.y + rightShoulder.y;
}
