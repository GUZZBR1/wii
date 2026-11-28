import { type Delegate, HandClient as CoreHandClient, type HandClientAssets, type HandClientCallbacks } from '@nevergear/spatial-core';
import { preferredDelegate } from './delegate';
import { handModelUrl, visionWasmUrl, warmVisionAssets } from './mediapipeAssets';

export type { HandClientCallbacks } from '@nevergear/spatial-core';

const handAssets = (): HandClientAssets => ({ wasmBaseUrl: visionWasmUrl(), modelUrl: handModelUrl() });

export class HandClient extends CoreHandClient {
  constructor(assets: HandClientAssets = handAssets()) {
    super(assets);
  }

  override init(callbacks: HandClientCallbacks, preferred: Delegate = preferredDelegate()): Promise<void> {
    return super.init(callbacks, preferred);
  }

  static warmVisionAssets(): void {
    warmVisionAssets('hand');
  }
}
