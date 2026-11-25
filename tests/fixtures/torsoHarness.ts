import type { PoseSnapshot } from '../../src/cv/protocol';
import { CadenceTracker, type CadenceResult } from '../../src/kinematics/cadenceTracker';
import { TorsoVerticalChannel } from '../../src/kinematics/torsoVertical';

/**
 * Pairs a CadenceTracker with the shared vertical channel the way the action pipeline does:
 * the channel conditions the pose, the tracker consumes the sample. Tests feed poses through
 * `feed` so both sides see the same frame sequence.
 */
export function cadenceHarness() {
  const tracker = new CadenceTracker();
  const channel = new TorsoVerticalChannel();
  const feed = (snapshot: PoseSnapshot): CadenceResult => tracker.update(channel.update(snapshot), snapshot.timestampMs);
  return { tracker, feed };
}
