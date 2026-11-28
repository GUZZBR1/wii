# PR Review — lifecycle races in the camera/vision pipeline

Date: November 24, 2026 · Commit reviewed: `3319e38` (branch `fix/cv-pipeline-bottlenecks`) · Scope: `src/App.tsx`, `src/cv/poseClient.ts`, `src/cv/pose.worker.ts`, `src/cv/protocol.ts`, `src/ui/CameraPip.tsx` — lifecycle introduced in commit `e5d9bf0` ("Split PoseClient lifecycle and slim the worker protocol").

---

## Design context

The PR's stated intent is to separate **Landmarker lifecycle** from **capture lifecycle** (`e5d9bf0`, commit message): `init()` starts the worker in parallel with `getUserMedia` (`src/App.tsx:104-108`), the worker stays warm across camera stop/start (`stopCamera` calls only `pauseCapture`, `src/App.tsx:70-71`), and `dispose()` runs only on a fatal error or unmount (`poseClient.ts:113-116`, `poseClient.ts:123-127`, `src/App.tsx:40`). The design itself is sound and addresses bottleneck #5 in `docs/analise-de-gargalos.md`. The findings below are **edge races** in this new lifecycle — not flaws in the design itself, but missing an "attempt" identifier to invalidate late continuations.

This review used primary sources: the code itself and, where external behavior matters, the specifications (W3C Media Capture, HTML Standard) and MDN — see **Sources** at the end.

## Executive summary

| # | Finding | Verdict | Severity |
|---|--------|----------|-----------|
| 1 | **Leaked stream**: init error (missing WASM/model or 30 s timeout) while the permission prompt is open → `stopCamera` runs before the stream exists → user clicks "Allow" → `getUserMedia` resolves late and the stream remains **attached to `<video>` with live tracks (LED on), `cameraOn=true`, but no capture**. Variants: a second `getUserMedia` overwrites `streamRef` without stopping the first stream's tracks; unmount cleanup never stops tracks. | **Confirmed** | High |
| 2 | Restarting the camera with a warm worker emits no `onStatus` → the PiP says **'Camera off' ("Camera off") while TRACKING works**. | **Confirmed** | Medium |
| 3 | `pauseCapture` resets `busy` while a FRAME is still in the worker → resume posts a second frame → the "one frame in flight" invariant degrades (and worsens on every toggle); a late POSE reply runs `onPose` while the camera is off (feeding the gate/detectors; could escalate to gameplay events if replies accumulate). | **Confirmed** | Medium |
| A | Adjacent issues: `await loadeddata` can hang if `srcObject` is cleared mid-wait; `worker.onerror` during capture kills the warm worker (correct, but `busy` must be reset in `dispose`); concurrent `init()` deduplicates correctly; `visionReady` can cause an `unhandledrejection` if `init()` rejects early. | Confirmed (various) | Low–Medium |

---

## Finding 1 — camera on without tracking if init fails while permission is pending

**Verdict: confirmed**, including every part: the second click (leak from overwriting the stream) and unmount (no `track.stop()` in cleanup).

### What happens

`startCamera` starts `client.init(callbacks)` **in parallel** with `await getUserMedia(...)` (`src/App.tsx:104-108`). The permission prompt can remain open for an arbitrary amount of time — the `getUserMedia` algorithm in the specification stalls if the user never responds: *"If the user never responds, this algorithm stalls on this step."* (w3c.github.io/mediacapture-main, step 11.5.1 of the `getUserMedia` method). During that interval, two paths can produce `onStatus('error')` in the client:

1. **Fatal init ERROR** (`pose.worker.ts:63`) — for example, fetching `.wasm`/`.task` fails → the `ERROR` branch in `worker.onmessage` has `fatal: true` (`poseClient.ts:113-116`) → `onStatus('error', …)` → `onReady?.()` → `dispose()` (terminates the worker, sets `ready=false`, clears `initPromise`, `poseClient.ts:87-97`).
2. **30 s `spawn` timeout** (`poseClient.ts:130-137`) — `Promise.race` wins without `READY` → `onStatus('error', 'MediaPipe initialization timed out after 30 seconds.')` → `dispose()`.

In the app, the handler (`src/App.tsx:87-90`) calls `setCameraStatus(detail)` → `status === 'error'` → `setTracking('SEM POSE')` → **`stopCamera()`** → calls `setCameraStatus(detail)` again (the second write is intentional; it preserves the error message over `stopCamera`'s `'Camera off'`, `src/App.tsx:77`).

### The race, step by step

1. `stopCamera()` runs while `getUserMedia` is pending → `streamRef.current` is still `undefined` → `streamRef.current?.getTracks()` (`src/App.tsx:72`) **stops nothing**; `video.srcObject = null`, `setCameraOn(false)`.
2. The user clicks "Allow" → `getUserMedia` resolves with a live `MediaStream` → `streamRef.current = stream` (`src/App.tsx:109`) → `video.srcObject = stream` (`src/App.tsx:112`) → `await video.play()` → `loadeddata` → `setCameraOn(true)` (`src/App.tsx:118`).
3. `await visionReady` (`src/App.tsx:119`) has already resolved (`onReady` ran on the error path) → `if (!client.isReady || streamRef.current !== stream) return;` (`src/App.tsx:120`) → `client.isReady === false` (`dispose` reset `ready`) → **silent return**.

### Exact final UI state

- `cameraOn === true` → `CameraPip` renders the live `<video>`, the `'SEM POSE'` tracking chip (`src/ui/CameraPip.tsx:26`) and the bar with `⏻`, L/R selector and disabled `CALIBRAR` (`src/ui/CameraPip.tsx:29-37`) — **not** the ENABLE button.
- Status line (`src/ui/CameraPip.tsx:40`): the **init error message** (for example, `GPU failed (...); CPU fallback also failed (...).`) — the second `setCameraStatus(detail)` at `src/App.tsx:89` wins over `'Camera off'`.
- **Tracks remain live and the webcam LED stays on** — the stream is attached and feeding `<video>`; nothing consumes the frames because `beginCapture` never ran and the worker was terminated.
- The leak is resolved only when the user presses `⏻` (`stopCamera` then stops the tracks in `streamRef`) — or never, if they simply leave the page thinking that "the camera failed".

Specification basis: a camera `MediaStreamTrack` releases the device only when **all** tracks for that source stop/end — *"A source that is notified of a track ending will be stopped, unless other MediaStreamTrack objects depend on it."* (w3c.github.io/mediacapture-main, `stop()` method). The specification explicitly encourages calling `stop()` because the resource is costly and affects privacy indicators (the MediaStreamTrack "Garbage Collection" section).

### Case 1 — clicking ENABLE again / double-clicking

Two scenarios, both confirmed:

- **After the leaked state**, the visible button is `⏻`, not ENABLE — the user has to stop first (at which point `stopCamera` cleans up the leaked stream). But the real overwrite case does exist:
- **Double-clicking ENABLE while startup is in progress** — `cameraOn` only becomes `true` on line 118, near the end; throughout `getUserMedia`, the ENABLE button remains visible and clickable (`src/ui/CameraPip.tsx:29`). Two concurrent `startCamera` calls make two `getUserMedia` calls — and each call creates **a new `MediaStreamTrack` for the same source** (w3c.github.io/mediacapture-main: *"Several MediaStreamTrack objects can represent the same media source, e.g., when the user chooses the same camera in the UI shown by two consecutive calls to getUserMedia()."*). The attempt that resolves last assigns `streamRef.current = stream2` (`src/App.tsx:109`) **without stopping the tracks in `stream1`**, which then become unreachable. Since the source stops only when all tracks end, the **webcam LED stays on even after `⏻`** (which only stops `stream2`). The only race guard currently present, `streamRef.current !== stream` (`src/App.tsx:120`), makes the losing attempt return — but does not stop its tracks.
- **Concurrent `init()` calls are safe on their own**: `initPromise ??=` deduplicates them (`poseClient.ts:46`), and `this.callbacks = callbacks` (`poseClient.ts:44`) is assigned before any early return, so the **last** caller receives `READY`/errors — correctly, because it belongs to the current attempt.

### Case 2 — unmount during `getUserMedia`

The mount effect's cleanup is `return () => { clientRef.current?.dispose(); };` (`src/App.tsx:40`) — **it never touches `streamRef`**, either for a camera that is already on or for a late resolution: if the component unmounts while the prompt is pending and the user later grants permission, `streamRef.current = stream` runs in a dead component, `setCameraOn(true)` updates state after unmount, and the stream leaks until page navigation. Verified: no line in the file stops tracks outside `stopCamera` (`src/App.tsx:72`).

### Root cause

`startCamera` has no way to know that "the attempt has already ended" **between** `await getUserMedia` and `streamRef.current = stream`. All existing abort conditions (`streamRef.current !== stream`, `!client.isReady`) are checked only **after** the stream has already been attached to `<video>` and `setCameraOn(true)` has run — and none stops the tracks on the way out. `stopCamera` can only stop `streamRef.current`, so by design it cannot reach a stream that has not yet been assigned.

### Proposed fix — attempt generation counter

Treat **init + permission + attachment as one attempt**: increment an `attemptRef` in `stopCamera` and in the unmount cleanup; `startCamera` captures the ID at the beginning and revalidates after every `await` — including **before** `streamRef.current = stream`. Pseudodiff:

```ts
const attemptRef = useRef(0);

// mount effect — cleanup also stops tracks and invalidates in-flight attempts
return () => {
  attemptRef.current += 1;
  clientRef.current?.dispose();
  streamRef.current?.getTracks().forEach((t) => { t.stop(); });
  streamRef.current = undefined;
};

const stopCamera = useCallback(() => {
  attemptRef.current += 1;                 // invalidate any in-flight startCamera call
  clientRef.current?.pauseCapture();
  streamRef.current?.getTracks().forEach((t) => { t.stop(); });
  streamRef.current = undefined;
  /* ...restante unchanged... */
}, []);

const startCamera = useCallback(async () => {
  stopCamera();                            // cancel the previous attempt and stop pending tracks
  const attempt = ++attemptRef.current;
  const isStale = () => attemptRef.current !== attempt;
  const callbacks: PoseClientCallbacks = {
    onStatus: (status, detail) => {
      if (isStale()) return;               // a dead attempt must not overwrite the UI status
      setCameraStatus(detail);
      if (status === 'error') { setTracking('SEM POSE'); stopCamera(); setCameraStatus(detail); }
    },
    onPose: (raw) => { if (isStale()) return; /* unchanged */ },
  };
  try {
    await audioRef.current.unlock();
    if (isStale()) return;
    clientRef.current ??= new PoseClient();
    const client = clientRef.current;
    const visionReady = client.init(callbacks);
    const stream = await navigator.mediaDevices.getUserMedia({ /* unchanged */ });
    if (isStale()) {                       // erro/stop chegou durante o prompt
      stream.getTracks().forEach((t) => { t.stop(); });
      return;
    }
    streamRef.current = stream;
    /* video.srcObject = stream; await video.play(); */
    if (isStale()) return;
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) resolve();
      else {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('emptied', () => resolve(), { once: true }); // ver achado A
      }
    });
    if (isStale()) return;
    setCameraOn(true);
    await visionReady;
    if (!client.isReady || isStale() || streamRef.current !== stream) return;
    client.beginCapture(video, callbacks);
  } catch (error) {
    if (isStale()) return;                 // e.g. play aborted by stop
    stopCamera();
    setCameraStatus(error instanceof Error ? error.message : 'Could not start the camera.');
  }
}, [stopCamera, dispatchEvent]);
```

Design notes:

- **Incrementing in `stopCamera` and on unmount** makes `isStale()` true in exactly the bug scenarios — every fatal init path goes through `onStatus('error')` → `stopCamera` → `attemptRef++`, so any late continuation of `getUserMedia`/`play()`/`visionReady` is detected.
- **Calling `stopCamera()` at the top of `startCamera`** resolves the double-click case: it stops a pending `streamRef`, stops tracks from a previously attached attempt, and resets the pipeline/calibrator — all things the new attempt needs anyway. Cost: a brief `'Camera off'` flash before `'Carregando…'`; if that is distracting, extract only the track cleanup instead of calling the full `stopCamera`.
- **`if (isStale()) return` in `catch`** prevents an `AbortError` — inevitable when `stopCamera` clears `video.srcObject` during `await video.play()` (see adjacent finding A) — from replacing the original error message with *"The play() request was interrupted…"*.
- **Why not `AbortSignal`?** `getUserMedia` does not accept a cancellation signal (the API has no such parameter in the specification), so a counter is needed anyway — and it also determines what to do with a stream that has **already resolved** (stop its tracks), which abort alone would not do.
- **Preserving the error status:** confirmed — `src/App.tsx:89` already writes `setCameraStatus(detail)` again after `stopCamera()`; with the `isStale` gate, errors from dead attempts do not reach the UI. The other mid-attempt effects of `stopCamera` (`pauseCapture`, `pipeline.reset()`, `calibrator.reset()`, `drawPose` without a snapshot) are harmless or desirable.

### Edge cases covered by this design

- Error **before** `getUserMedia` resolves → the new stream is stopped by the post-await `isStale()` check; the LED does not stay on.
- Error **after** `streamRef` is assigned → `stopCamera` has already stopped the tracks; subsequent `isStale()` checks abort before `setCameraOn(true)`/`beginCapture`.
- Two quick ENABLE clicks → the second call invalidates the first; when the first resolves, it stops its own stream and exits early.
- Unmount mid-flight → cleanup increments the counter and stops `streamRef`; a late resolution stops its new tracks and returns before touching `<video>` or state.
- 30-second timeout **after** the user has manually turned the camera off → callbacks from the dead attempt are discarded by the `isStale` gate → status remains `'Camera off'` (the client's internal `dispose()` still runs — correctly, the stuck worker should not stay warm).
- Late `READY` while the camera is off (init completes after stop) → `onStatus('ready')` is filtered by the gate → it does not overwrite `'Camera off'`.

### Verification

There is no automated coverage for the camera path (AGENTS.md). Manual reproduction: `npm run dev` → DevTools → Network → *Request blocking* for `**/mediapipe/models/*.task` (or `*.wasm`) → ENABLE CAMERA → **leave the permission prompt unanswered** for a few seconds (init fails quickly on fetch) → click "Allow" → current behavior: LED on + live video + 'SEM POSE' + error in status + tracking never starts; with the fix: the LED turns off as soon as permission is granted, the status retains the error message, and `cameraOn` remains `false`.

---

## Finding 2 — status remains 'Camera off' ("Camera off") when restarting with a warm worker

**Verdict: confirmed.**

### What happens

On a second start with the worker warm, `init(callbacks)` runs `this.callbacks = callbacks; if (this.ready) return;` (`poseClient.ts:44-45`) — it returns immediately, **without** re-emitting `onStatus('loading')` or `onStatus('ready')` (the entire `spawn` is skipped — the `READY` message exists only once per worker, `poseClient.ts:107-110`). The flow continues: `getUserMedia` (permission already granted), `play()`, `loadeddata`, `setCameraOn(true)`, `await visionReady` (already resolved), `beginCapture(video, callbacks)` (`src/App.tsx:121`) — but `beginCapture` **does not emit `onStatus` on any path** (`poseClient.ts:50-75`). The last write to `cameraStatus` was therefore `'Camera off'` from `stopCamera` (`src/App.tsx:77`), and it remains in the PiP status line while the chip changes to `TRACKING` — an inconsistent UI: live video and flowing poses, but a status that says the camera is off.

### Proposed fix

The review suggests calling `setCameraStatus('MediaPipe ready · capturing')` before `beginCapture` — that works, but **loses the delegate** (`GPU`/`CPU`) carried by the `READY` label (`poseClient.ts:110`). Better: emit the status from `beginCapture`, the only place that knows capture has actually started (the early returns at `poseClient.ts:52` mean "it did not start"):

```ts
private delegate: Delegate = 'GPU';

// spawn — READY (poseClient.ts:107-110):
this.ready = true;
this.delegate = message.delegate;                       // NOVO
this.onReady?.();
this.callbacks?.onStatus('ready', `MediaPipe ready · ${message.delegate}`);

// spawn — FALLBACK (poseClient.ts:111-112): keep the label correct after fallback
this.delegate = message.to;                             // NOVO
this.callbacks?.onStatus('fallback', 'GPU unavailable; using CPU.');

// beginCapture — after this.capturing = true:
this.callbacks?.onStatus('ready', `MediaPipe ready · ${this.delegate} · capturing`);
```

This keeps **all** vision status transitions inside `PoseClient` (one emission point, consistent with `loading`/`ready`/`fallback`/`error`) and works both on the first start and on restarts. A smaller alternative is to expose `get delegate()` and compose the label in the app — more coupling for less benefit.

### Ordering of late `onStatus('ready')`

Review question: is a `READY` arriving **after** a stop ordered correctly? Current behavior: init is still in flight → user turns the camera off → init completes → `READY` → `onStatus('ready', 'MediaPipe ready · GPU')` (`poseClient.ts:110`) overwrites `'Camera off'` → PiP shows NO SIGNAL + "MediaPipe ready". Nothing breaks (the warm worker is intentional), but the UI is cosmetically inconsistent; the `isStale` gate from Finding 1 resolves it at no extra cost — `READY` from a dead attempt is discarded, and the next ENABLE shows `'… · capturing'` through `beginCapture`.

---

## Finding 3 — `pauseCapture` breaks the "one frame in flight" invariant and delivers poses while the camera is off

**Verdict: confirmed**, with one additional aggravating factor that the review did not mention: excess in-flight frames **accumulate with each pause/resume cycle**; this is not just transient.

### What happens

`pauseCapture` (`poseClient.ts:77-85`) sets `this.busy = false` (line 84) while the worker may still be processing the last posted `FRAME` (`poseClient.ts:148`). On resume, `capture()` sees `busy === false` and posts a **second** frame. When the first frame's response arrives, `this.busy = false` is set again (`poseClient.ts:118`) while the second is still in flight — in practice, after a toggle the "one frame in flight" invariant now allows **two** frames permanently. It gets worse: each `pauseCapture` while N frames are in flight adds +1 to the next cycle's ceiling — the latency debt (an old frame queued behind the current one) grows with every off/on cycle.

The other half: a `POSE` response arriving during the pause unconditionally calls `this.callbacks?.onPose(...)` (`poseClient.ts:117-121`) → in the app this runs `pipeline.update`, `setTracking`, `drawPose`, and the `dispatchEvent` loop (`src/App.tsx:91-98`), which triggers `engine.onAction` and **sounds** (`audioRef.hit/jump/step`, `src/App.tsx:65-67`) — while the camera is off.

**Practical impact today:** `stopCamera` runs `pipelineRef.current.reset()` (`src/App.tsx:78`), `TrackingGate` needs 3 consecutive good frames to become `tracked` (`src/kinematics/trackingGate.ts:13-17`), and `ActionPipeline.update` emits events only when tracking and calibration are both active — so **one** isolated late response reaches `'degraded'`: no event or sound, only an invisible `setTracking` (the chip is not rendered while `cameraOn=false`, `src/ui/CameraPip.tsx:26`), an invisible `drawPose`, and **pollution of gate state** that leaks into the next session (the next start does not reset the pipeline — an old frame counts as a "good frame" in the new session). Actual events/sounds require at least 3 accumulated late responses — possible precisely because the invariant degrades. In other words, direct damage is limited today, but the two halves together make the actual damage cumulative. **Dropping is correct; delivering is wrong** — a pose from a frame captured before stop should not drive the game or overlay.

The response is guaranteed to arrive (so `busy` does not remain stuck): the worker responds **exactly once** for each `FRAME` — `!landmarker` → `bitmap.close()` + `ERROR` (`pose.worker.ts:75-78`); `try` → `POSE` (`pose.worker.ts:82-86`); `catch` → fatal or non-fatal `ERROR` (`pose.worker.ts:87-94`); `finally` → `bitmap.close()` (`pose.worker.ts:95-97`). Exception: `worker.terminate()` — the specification empties the port's message queue ("*empty the port message queue of the port that the worker's implicit port is entangled with*", html.spec.whatwg.org/multipage/workers.html#terminate-a-worker), so a posted but undelivered response **is lost** — but in that case the client is dead too; therefore the correct reset belongs in `dispose` (below).

### Proposed fix

```ts
pauseCapture(): void {
  this.capturing = false;
  if (this.callbackId !== undefined) this.video?.cancelVideoFrameCallback?.(this.callbackId);
  this.callbackId = undefined;
  if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
  this.rafId = undefined;
  this.video = undefined;
  // Do not clear busy: the worker may still be processing a FRAME;
  // the response (POSE or ERROR) clears it, preserving the one-frame-in-flight invariant.
}

// POSE handler (poseClient.ts:117-121):
} else if (message.type === 'POSE') {
  this.busy = false;                       // sempre: sinaliza que o worker terminou o frame
  if (!this.capturing) return;             // NOVO: discard a pose captured before the camera stopped
  const { type: _type, ...data } = message;
  this.callbacks?.onPose({ /* unchanged */ });
}

// dispose (poseClient.ts:87-97): ADICIONAR
this.busy = false;                         // worker terminado: resposta nunca chega (terminate esvazia a fila)
```

Design notes:

- **`busy=false` must move from `pauseCapture` to `dispose`** — this is required: the same `PoseClient` is reused (`clientRef.current ??=`, `src/App.tsx:102`) after `dispose` (which clears `initPromise`, allowing a respawn). If `busy` remains `true` after a dispose during capture, the next `beginCapture` → `capture()` exits early at `if (this.busy) return` (`poseClient.ts:141`) and **never sends another frame** — a silent tracking deadlock.
- `beginCapture` **must not** reset `busy` — that would be the same bug as `pauseCapture` under another name (the pending response would clear it later, reopening the two-in-flight window).
- Timestamps remain monotonic even with extra frames in flight — they come from the increasing rVFC `now`, and `Math.max(now, lastTimestamp + 0.01)` (`poseClient.ts:143-144`) guarantees strict monotonicity, as required by MediaPipe's `VIDEO` mode (ai.google.dev/mediapipe/solutions/vision/pose_landmarker/web_js: "monotonic timestamps"). In other words, the bug degrades latency/throughput rather than causing an exception — which is why it went unnoticed.
- **Optional hardening:** to also discard poses from a **previous session** (pause → quick resume: the old response arrives while `capturing === true`), store `this.busyEpoch` when posting the FRAME and increment a `captureEpoch` in `pauseCapture`; compare them in the handler. Today, that stale pose only adds a frame with an unusual `dt` to the detectors — acceptable.

### Edge cases

- Pause during `await createImageBitmap` (`poseClient.ts:146-147`): the existing `!this.capturing` check closes the bitmap and clears `busy` — correct, since nothing was posted; no change needed.
- Pause → resume before the response: with the fix, `capture()` skips frames while `busy` is `true`; when the response arrives, `busy` clears and the next rVFC sends a frame — exactly one in flight at all times.
- Non-fatal `ERROR` during pause → `busy=false` (correct, it is the frame's response) + `onStatus('fallback')` — cosmetic status while the camera is off; the worker survives for the next session.
- `worker.onerror` → `dispose` → with the fix, `busy` clears in `dispose`; without it, reactivation silently deadlocks.

### Verification

- **Unit-testable** (see the next section): with fake `Worker`/`createImageBitmap`/rVFC, Vitest can assert that after `pauseCapture` + `beginCapture` there is **at most 1 FRAME without a response** and that `onPose` is not called for responses received during a pause.
- Manual: start tracking → quickly toggle ⏻/ENABLE several times → count `FRAME` versus `POSE`/`ERROR` in `onmessage` (a temporary `console.debug` is enough); before the fix, the difference grows with each cycle.

---

## Adjacent findings

1. **Unmount does not stop tracks** — already covered in Finding 1 (Case 2): `src/App.tsx:40` must stop `streamRef` in cleanup, not just call `dispose()` on the client.
2. **Hang while awaiting `loadeddata`** (`src/App.tsx:114-117`): if `stopCamera` runs during the wait, `video.srcObject = null` invokes the *media element load algorithm* (srcObject setter → "Invoke this's media element load algorithm", html.spec.whatwg.org/multipage/media.html), which fires `emptied` and resets `readyState` → `loadeddata` never fires again → `startCamera` hangs forever (no track leak — `stopCamera` already stopped them — but the function never finishes). The patch in Finding 1 adds an `emptied` listener alongside `loadeddata`, covering this case. In parallel, `await video.play()` does **not** hang in this window — the load algorithm immediately resolves/rejects pending play promises ("reject pending play promises with AbortError"), which becomes the `AbortError` "The play() request was interrupted by a new load request" in Chrome — hence the importance of `if (isStale()) return` in `catch`.
3. **`worker.onerror` during capture** (`poseClient.ts:123-127`): status `error` + `dispose` — it kills the warm worker and turns off the camera. This is consistent with "dispose only on fatal" (a worker script error is fatal for that instance), but reinforces the need for `busy=false` in `dispose`.
4. **Concurrent `init()` calls**: deduplication via `initPromise ??=` is correct and the last caller's callbacks win — with the attempt counter, the behavior is fully correct.
5. **Potential `unhandledrejection`**: `const visionReady = client.init(callbacks)` (`src/App.tsx:104`) is not awaited until line 119 — if `init()` rejects early (e.g., `new Worker` throws `SecurityError`), the gap between those lines can produce `Uncaught (in promise)` in the console. Cheap mitigation: `const visionReady = client.init(callbacks); visionReady.catch(() => {});` or await via `Promise.all([visionReady, getUserMedia...])` — optional.
6. **`stopCamera` inside `onStatus('error')`**: `pipeline.reset()`, `calibrator.reset()`, `drawPose` — harmless mid-attempt (a reset is desirable anyway); `'Camera off'` does not clobber the error because `src/App.tsx:89` rewrites `detail` afterward — verified.

---

## What can be tested in this repo

`npm test` runs Vitest in a **Node environment** (`vite.config.ts`, `test.environment: 'node'`, `include: tests/**/*.test.ts`), and AGENTS.md states that the worker/camera path has no automated coverage — verify it manually with `npm run dev` → ENABLE CAMERA → TRACKING.

**Unit-testable in plain Node** (proposal: `tests/poseClient.test.ts` + global stubs):

- `vi.stubGlobal('Worker', FakeWorker)` — a fake class records `postMessage` and exposes `emit(reply)` to inject `READY`/`POSE`/`ERROR`/`FALLBACK` on demand;
- `vi.stubGlobal('createImageBitmap', async () => ({ close: vi.fn() }))`, fake `requestAnimationFrame`/`cancelAnimationFrame`, `vi.stubGlobal('window', { setTimeout })`, `vi.stubGlobal('location', { origin: 'http://localhost' })` (`mediapipeAssetUrls` uses `location.origin`, `poseClient.ts:11-16`); `import.meta.env.BASE_URL` comes from Vitest's (Vite) transform — `'/'` due to `base: '/'`;
- fake video `{ readyState: 4, requestVideoFrameCallback: (cb) => id, cancelVideoFrameCallback: vi.fn() }`.

This setup can **deterministically** cover: `init()` deduplication (two calls → one `Worker` constructed, both resolve), the one-in-flight invariant after `pauseCapture` + `beginCapture`, dropping `POSE` when `!capturing`, `busy=false` guaranteed by `dispose`, a 30-second timeout with `vi.useFakeTimers()`, and the `delegate` exposed/emitted after `READY`/`FALLBACK`. It does not cover real `getUserMedia` behavior, real rVFC, or `MediaStreamTrack` — those remain part of the manual verification described for each finding. An alternative requiring new dependencies is `happy-dom`/`jsdom` + `@testing-library/react` for `App` — probably disproportionate for this project.

---

## Sources

**Code (path:line):**

- `src/App.tsx:36-41` — mount effect: `warmVisionAssets` + cleanup that only calls `dispose()`.
- `src/App.tsx:70-83` — `stopCamera`: `pauseCapture` (71), `getTracks().stop()` (72), `srcObject = null` (74), `'Camera off'` (77), resets (78-82).
- `src/App.tsx:85-126` — `startCamera`: callbacks (86-99, error at 89), parallel `init` (104), `getUserMedia` (105-108), `streamRef` (109), `srcObject`/`play`/`loadeddata` (112-117), `setCameraOn` (118), `await visionReady` + bail-out (119-120), `beginCapture` (121), `catch` (122-125).
- `src/cv/poseClient.ts:43-48` — `init`/`initPromise` deduplication; `50-75` — `beginCapture` (no `onStatus`); `77-85` — `pauseCapture` (`busy=false` at 84); `87-97` — `dispose`; `99-138` — `spawn` (`READY` 107-110, `FALLBACK` 111-112, `ERROR` 113-116, `POSE` 117-121, `onerror` 123-127, race/timeout 130-137); `140-153` — `capture`.
- `src/cv/pose.worker.ts:48-66` — `INIT` → `READY`/`ERROR`; `68-72` — `DISPOSE`; `74-98` — `FRAME` → `POSE`/`ERROR` + `bitmap.close()` without `finally`.
- `src/cv/protocol.ts:49-60` — `WorkerRequest`/`WorkerReply`.
- `src/ui/CameraPip.tsx:25-40` — NO SIGNAL (25), tracking chip (26), ENABLE vs controls (29-39), status line (40).
- `src/kinematics/trackingGate.ts:13-27` — 3 good frames → `tracked`, 4 bad frames → `lost`, `reset()`.
- `src/kinematics/actionPipeline.ts` — events only when tracking and calibration are active.
- `src/App.tsx:63-68` — `dispatchEvent` → `engine.onAction` + `audio.hit/jump/step`.

**Specifications/docs (URL):**

- https://w3c.github.io/mediacapture-main/#dom-mediadevices-getusermedia — `getUserMedia` algorithm: *"If the user never responds, this algorithm stalls on this step."* (permission may remain pending indefinitely); a new `MediaStreamTrack` is created per call (step 9.5).
- https://w3c.github.io/mediacapture-main/#mediastreamtrack — *"Several MediaStreamTrack objects can represent the same media source, e.g., when the user chooses the same camera in the UI shown by two consecutive calls to getUserMedia()."*
- https://w3c.github.io/mediacapture-main/#dom-mediastreamtrack-stop — `stop()`: *"A source that is notified of a track ending will be stopped, unless other MediaStreamTrack objects depend on it."*
- https://w3c.github.io/mediacapture-main/#life-cycle-and-media-flow — *"Authors are encouraged to call stop() on MediaStreamTrack, especially capture tracks since the underlying resource are costly and it can have effects on the privacy indicators presented to the user."* (track garbage collection does not guarantee `stop()`).
- https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker — termination discards queued tasks and *"empty the port message queue of the port that the worker's implicit port is entangled with"* (an in-flight response is lost).
- https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate — *"the worker is terminated immediately without any chance to complete its ongoing operations."*
- https://html.spec.whatwg.org/multipage/media.html — the `srcObject` setter → *"Invoke this's media element load algorithm"*; the load algorithm immediately resolves/rejects pending play promises (AbortError) and fires `emptied` when the provider is removed; `loadeddata` fires only when `readyState` first reaches `HAVE_CURRENT_DATA` after each load.
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play — `play()` returns a Promise rejected on playback failure.
- https://ai.google.dev/mediapipe/solutions/vision/pose_landmarker/web_js — `VIDEO` mode: *"Synchronous tracking across decoded video frames with monotonic timestamps."*
