import { PoseClient as CorePoseClient } from '@nevergear/spatial-core';
import type { Delegate, PoseClientAssets, PoseClientCallbacks as CoreCallbacks } from '@nevergear/spatial-core';
import { preferredDelegate } from './delegate';
import { poseAssets, warmVisionAssets } from './mediapipeAssets';

export type { PoseClientCallbacks } from '@nevergear/spatial-core';

export class PoseClient extends CorePoseClient {
  constructor(assets: PoseClientAssets = poseAssets()) {
    super(assets);
  }

  override init(callbacks: CoreCallbacks, preferred: Delegate = preferredDelegate()): Promise<void> {
    return super.init(callbacks, preferred);
  }

  static warmVisionAssets(): void {
    warmVisionAssets('pose');
  }
}
