import { PoseClient as CorePoseClient } from '@wii/spatial-core';
import type { Delegate, PoseClientAssets, PoseClientCallbacks as CoreCallbacks } from '@wii/spatial-core';
import { preferredDelegate } from './delegate';
import { poseAssets, warmVisionAssets } from './mediapipeAssets';

export type { PoseClientCallbacks } from '@wii/spatial-core';

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
