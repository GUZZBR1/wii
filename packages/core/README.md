# @wii/spatial-core

Headless MediaPipe Pose provider, pose contracts, and a pure 1€ filter for browser applications.
The package has no React or Three.js dependency.

The host supplies wasmBaseUrl and modelUrl to PoseClient; the package owns its module worker and
frame processing. Use the root app's versioned model and WASM URLs when embedding it in this repo.
