# @wii/spatial-core

A headless browser package for MediaPipe Pose and Hand perception, hand geometry, input intents, and
typed spatial events. It has no React or Three.js dependency.

The host owns the video element and camera stream. Supply versioned WASM and model URLs when creating
a runtime. The runtime owns worker lifetimes and runs one perception provider at a time:

- Pose uses the fixed Pose Landmarker pipeline.
- Hand uses the Hand Landmarker provider and emits normalized hand snapshots.
- SpatialInputBus fans typed pointer, button, axis, and gesture events to subscribers.

In this repository, the hand model is tracked under public/mediapipe/models/ and checked against
SHA256SUMS before dev or build.
