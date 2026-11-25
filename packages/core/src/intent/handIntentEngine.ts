import type { HandSnapshot } from '../providers/handProtocol';
import type { Hand } from '../types';
import { OneEuroFilter } from '../filters/oneEuroFilter';
import type { OneEuroOptions } from '../filters/oneEuroFilter';
import { HandFeatureExtractor } from '../geometry/handFeatures';
import { PinchClutch, pinchDistanceRatio } from './pinchClutch';
import type { SpatialInputEvent } from '../runtime/spatialInputBus';

export interface HandIntentOptions {
  /** If omitted, the first valid hand in each snapshot controls the pointer and clutch. */
  preferredHand?: Hand;
  pointerFilter?: OneEuroOptions;
  maxVelocityGapMs?: number;
}

/** Converts canonical hand frames into stable pointer, tracking, and grab signals. */
export class HandIntentEngine {
  private readonly featureExtractor: HandFeatureExtractor;
  private readonly pinchClutch = new PinchClutch();
  private readonly xFilter: OneEuroFilter;
  private readonly yFilter: OneEuroFilter;
  private readonly preferredHand?: Hand;
  private tracking = false;
  private activeHand?: Hand | 'unknown';

  constructor(options: HandIntentOptions = {}) {
    this.featureExtractor = new HandFeatureExtractor({ maxVelocityGapMs: options.maxVelocityGapMs });
    this.xFilter = new OneEuroFilter(options.pointerFilter);
    this.yFilter = new OneEuroFilter(options.pointerFilter);
    this.preferredHand = options.preferredHand;
  }

  update(snapshot: HandSnapshot): SpatialInputEvent[] {
    const features = this.featureExtractor.extract(snapshot);
    const hand = this.preferredHand
      ? features.find((feature) => feature.handedness === this.preferredHand)
      : features[0];
    if (!hand) return this.returnToNeutral(snapshot.timestampMs);

    const events: SpatialInputEvent[] = [];
    const handKey = hand.handedness ?? 'unknown';
    if (this.activeHand !== undefined && this.activeHand !== handKey) {
      this.releaseGrab(snapshot.timestampMs, events);
      this.resetPointerFilters();
    }
    this.activeHand = handKey;
    if (!this.tracking) {
      this.tracking = true;
      events.push({ type: 'tracking', source: 'hand', timestampMs: snapshot.timestampMs, state: 'tracked' });
    }

    if (hand.imagePosition) {
      events.push({
        type: 'pointer',
        source: 'hand',
        timestampMs: snapshot.timestampMs,
        position: {
          x: this.xFilter.filter(hand.imagePosition.x, snapshot.timestampMs),
          y: this.yFilter.filter(hand.imagePosition.y, snapshot.timestampMs),
        },
      });
    } else {
      this.resetPointerFilters();
    }

    const wasEngaged = this.pinchClutch.isEngaged;
    const isEngaged = this.pinchClutch.update(pinchDistanceRatio(hand.landmarks));
    if (wasEngaged !== isEngaged) {
      events.push({
        type: 'button',
        source: 'hand',
        timestampMs: snapshot.timestampMs,
        action: 'grab',
        pressed: isEngaged,
      });
    }
    return events;
  }

  reset(timestampMs: number): SpatialInputEvent[] {
    this.featureExtractor.reset();
    return this.returnToNeutral(timestampMs);
  }

  private returnToNeutral(timestampMs: number): SpatialInputEvent[] {
    const events: SpatialInputEvent[] = [];
    this.releaseGrab(timestampMs, events);
    if (this.tracking) {
      this.tracking = false;
      events.push({ type: 'tracking', source: 'hand', timestampMs, state: 'neutral' });
    }
    this.activeHand = undefined;
    this.resetPointerFilters();
    return events;
  }

  private releaseGrab(timestampMs: number, events: SpatialInputEvent[]): void {
    if (!this.pinchClutch.isEngaged) return;
    this.pinchClutch.reset();
    events.push({ type: 'button', source: 'hand', timestampMs, action: 'grab', pressed: false });
  }

  private resetPointerFilters(): void {
    this.xFilter.reset();
    this.yFilter.reset();
  }
}
