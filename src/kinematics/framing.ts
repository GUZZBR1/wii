import type { PoseSnapshot } from '../cv/protocol';

/** The warning waits this long: a head that dips out during a hop or a stride is not worth a word. */
const HEAD_OUT_AFTER_MS = 1500;
/** Once shown, the head has to come clearly back inside. */
const HEAD_BACK_MARGIN = 0.02;

/**
 * BlazePose finds a person through the face and assumes the head is visible
 * (https://arxiv.org/abs/2006.10204). With it cut off, a running player is lost or drawn upside down.
 */
export class HeadWarning {
  private outSince?: number;
  private shown = false;

  /** Whether to ask the player to get their head back into the picture. */
  update(snapshot: PoseSnapshot): boolean {
    const nose = snapshot.landmarks[0];
    // No body at all says nothing new: keep whatever was being shown.
    if (!nose) return this.shown;
    if (nose.y >= (this.shown ? HEAD_BACK_MARGIN : 0)) {
      this.outSince = undefined;
      this.shown = false;
    } else {
      this.outSince ??= snapshot.timestampMs;
      if (snapshot.timestampMs - this.outSince >= HEAD_OUT_AFTER_MS) this.shown = true;
    }
    return this.shown;
  }

  reset(): void { this.outSince = undefined; this.shown = false; }
}

/** Hips above shoulders cannot be a standing player: the tracker is hallucinating. */
export function upsideDown(snapshot: PoseSnapshot): boolean {
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [11, 12, 23, 24].map((index) => snapshot.landmarks[index]);
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return false;
  return leftHip.y + rightHip.y < leftShoulder.y + rightShoulder.y;
}
