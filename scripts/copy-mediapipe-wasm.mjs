import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'));
if (packageJson.version !== '1.2.3') throw new Error(`Unexpected tasks-vision version: ${packageJson.version}`);
const source = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const destination = resolve(root, 'public/mediapipe/wasm');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const files = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];
for (const file of files) await copyFile(resolve(source, file), resolve(destination, file));

const modelPath = resolve(root, 'public/mediapipe/models/pose_landmarker_lite.task');
const digest = createHash('sha256').update(await readFile(modelPath)).digest('hex');
const manifestPath = resolve(root, 'public/mediapipe/models/SHA256SUMS');
const expected = (await readFile(manifestPath, 'utf8')).trim().split(/\s+/)[0];
if (digest !== expected) throw new Error(`Pose model checksum mismatch. Expected ${expected}, got ${digest}`);
console.log(`MediaPipe ${packageJson.version}: module WASM copied; Lite model SHA-256 verified.`);
