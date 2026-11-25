import type { Vector2 } from '../geometry/handFeatures';

export type SpatialInputSource = 'hand' | 'pose' | 'replay';
export type SpatialButton = 'select' | 'grab' | 'sprint' | 'jump';
export type SpatialAxis = 'x' | 'y' | 'zoom' | 'explode';

interface SpatialInputBase {
  source: SpatialInputSource;
  timestampMs: number;
}

export type SpatialInputEvent =
  | (SpatialInputBase & { type: 'tracking'; state: 'tracked' | 'neutral' })
  | (SpatialInputBase & { type: 'pointer'; position: Vector2 })
  | (SpatialInputBase & { type: 'button'; action: SpatialButton; pressed: boolean })
  | (SpatialInputBase & { type: 'axis'; axis: SpatialAxis; value: number })
  | (SpatialInputBase & { type: 'gesture'; name: string; confidence: number });

export type SpatialInputListener = (event: SpatialInputEvent) => void;

/** Synchronous typed fan-out. Listener add/remove operations take effect on the next published event. */
export class SpatialInputBus {
  private readonly listeners = new Set<SpatialInputListener>();

  subscribe(listener: SpatialInputListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  publish(event: SpatialInputEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  publishAll(events: readonly SpatialInputEvent[]): void {
    for (const event of events) this.publish(event);
  }
}
