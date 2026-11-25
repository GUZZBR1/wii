# @wii/spatial-core

A headless browser package for MediaPipe Pose and Hand perception, pose replay, hand geometry, input
intents, and typed spatial events. It has no React or Three.js dependency.

The host owns the video element and camera stream. Supply versioned WASM and model URLs when creating
a runtime. The runtime owns worker lifetimes and runs one perception provider at a time:

- Pose uses the fixed Pose Landmarker pipeline.
- Hand uses the Hand Landmarker provider and emits normalized hand snapshots.
- SpatialInputBus fans typed pointer, button, axis, and gesture events to subscribers.

The host supplies versioned WASM and model URLs to PoseClient. The package owns its module worker and
frame processing.

## Pose replay

createPoseRecording makes a versioned envelope around pose snapshots. parsePoseRecording validates
recordings before PoseReplayProvider replays them. The replay provider does not access the camera or
MediaPipe; it returns independent snapshots in order so downstream filters and detectors can be
replayed deterministically.

With the root Vite dev server, /scripts/pose-replay.html runs a local video through the real Pose
worker and can download a JSON recording. The video remains in the browser.

In this repository, the hand model is tracked under public/mediapipe/models/ and checked against
SHA256SUMS before dev or build.
