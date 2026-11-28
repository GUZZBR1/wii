# PR Review — year-long caching without versioned MediaPipe URLs

Date: November 24, 2026 · Branch: `fix/cv-pipeline-bottlenecks` · Commit reviewed: `3319e38`

**Review comment:** "Year-long caching without versioned MediaPipe URLs — the version and checksum are verified at build time, but are not part of the file URLs. Use URLs tied to the WASM version and model hash before relying on `immutable`."

**Verdict: substantiated — fix before merging while keeping `immutable`.** This PR's `vercel.json` applies `Cache-Control: public, max-age=31536000, immutable` to `/mediapipe/(.*)` and `/assets/(.*)` (`vercel.json:5-14`). For `/assets/*`, the header is correct (content-hashed filenames, §3). For `/mediapipe/*`, it is not: the three served files (`vision_wasm_module_internal.js`, ~337 KB; `.wasm`, ~14.7 MB; `pose_landmarker_lite.task`, ~5.8 MB) have fixed URLs and content that changes when the dependency is updated. This is exactly the anti-pattern that the documentation for `immutable` warns against — MDN says that `immutable` avoids unnecessary conditional requests **when you use a cache-busting pattern** for the resources — and Vercel itself recommends it for "Content-hashed assets" in its `Cache-Control` recommendations. The risk is real but limited: it affects users who return after a legitimate content change (a `tasks-vision` upgrade or model replacement); the failure is likely to be noisy (CV initialization fails rather than silently using incorrect poses in most scenarios); and the fix is inexpensive because the script that generates the files already knows both required identifiers (version and SHA-256).

---

## 1. How real is the risk?

### 1.1 What is at stake — three fixed URLs, mutable content

`mediapipeAssetUrls()` (`src/cv/poseClient.ts:8-18`) currently builds:

- `wasmBaseUrl` = `…/mediapipe/wasm/` → o worker passa a `FilesetResolver.forVisionTasks(wasmBaseUrl, true)` (`src/cv/pose.worker.ts:12`);
- `modelUrl` = `…/mediapipe/models/pose_landmarker_lite.task` → `fetch()` direto no worker (`pose.worker.ts:13`);
- `wasmModuleUrls` (loader + binary) for the `warmVisionAssets()` prefetch (`poseClient.ts:34-37`).

Inside the dependency bundle, `forVisionTasks` is just a URL builder: `nh("vision", basePath, useModule)` returns `{ wasmLoaderPath: `${base}/vision_wasm_module_internal.js`, wasmBinaryPath: `${base}/vision_wasm_module_internal.wasm` }` (`vision_bundle.mjs`, `nh()` at approximately character 49305; signature `forVisionTasks(basePath?, useModule?)` in `vision.d.ts:819`). `basePath` can be **any directory** — it is interpolated literally — while the filename is fixed by contract: `vision.d.ts:733` says that "the returned filesets require that the Wasm files are published **without renaming**" (which rules out versioning the WASM filename, but not its directory — see §2a).

### 1.2 Concrete version-skew scenarios

The stale state lives in the browser's **HTTP cache** (and in intermediate proxies), not at Vercel — see §1.4. Assume a user visited before deployment:

**Scenario A — upgrading `@mediapipe/tasks-vision` (e.g., 1.2.3 → 1.2.x).**
The `packageJson.version !== '1.2.3'` pin (`copy-mediapipe-wasm.mjs:8`) makes an upgrade a deliberate PR action (whoever upgrades the dependency updates the pin in the script). In that deployment: new `index.html` → bundle and worker with **new dependency glue code** → worker requests the **same** URLs `/mediapipe/wasm/vision_wasm_module_internal.{js,wasm}` → browser serves the **old** loader from cache → `await import(loaderAntigo)` registers the old `self.ModuleFactory` → `locateFile` maps to the old `.wasm`, also from cache. Result: **new glue + old loader/WASM**. The coupling is in fact three-way:

- loader ↔ binary are an Emscripten pair: the loader is generated with `MODULARIZE` and runs `wasmExports = await createWasm()` against the imports/exports specific to that `.wasm` (visible in `vision_wasm_module_internal.js`);
- bundle ↔ loader: the bundle calls `self.ModuleFactory(self.Module || i)` and then uses the `Module`'s private surface (`_changeBinaryGraph`, `_processFrame`, `_malloc`… — `vision.d.ts:2941+`), through `Wh()` in `vision_bundle.mjs` at approximately character 66900;
- all files come from the **same versioned npm tarball** (`node_modules/@mediapipe/tasks-vision/wasm/`), so they are artifacts from one release.

Cross-version assets may initialize by accident (the MediaPipe graph API is serialized through protos and reasonably stable) or fail noisily (missing export, incompatible `ModuleFactory`, or an abort during graph initialization). Either way, the failure mode is nondeterministic and can affect **all** returning users within the one-year cache window. The visible symptom is a fatal init `ERROR` (`pose.worker.ts:62-64` → `poseClient.ts:113-116`) or a 30-second timeout (`poseClient.ts:129-137`) — CV remains unusable until the user performs a hard refresh, which users are unlikely to know to do.

**Scenario B — replacing the `.task` model at the same URL** (`SHA256SUMS` updated, `copy-mediapipe-wasm.mjs:16-20`).
A returning user downloads the model's **old** bytes: if the format remains compatible, the app silently runs the outdated model; if it differs from the expected graph, initialization fails. The outcome varies by user and is invisible during deployment.

**Scenario C — mismatch after partial eviction.**
The browser's HTTP cache evicts entries individually under pressure (LRU/size). A 14.7 MB `.wasm` is a prime candidate for eviction, while the 337 KB loader and 5.8 MB model may survive — or any inverse combination may occur. After deployment, the mix could be `new loader + new WASM + old model`, `old loader + new model`, and so on — any of the 2³ states, including mutually inconsistent combinations.

**What does NOT cause version skew:** within one session — all three assets are loaded once per `INIT`; and the app code (`/assets/*`, `index.html`) — see §3.

### 1.3 Does stale cache survive deployments? Yes — and `immutable` is almost irrelevant here

- **`max-age=31536000` is the real problem.** While the entry is "fresh", the browser reuses it without any network request — for up to a year. web.dev (Grigorik/Posnick): "How do you notify browsers to update the 'stale' cached copy? You can't, at least not without changing the URL" and "different users might end up using **different versions of the file when the page is constructed**" — an exact description of the version skew above.
- **A normal reload does not help in any modern browser.** Since Chrome 56 (2017, the Chromium blog post "Reload, reloaded"), a regular reload revalidates **only the main resource** — subresources within `max-age` are served from cache without revalidation. In Chrome, then, `immutable` changes nothing because this is already the default behavior for subresources.
- **Chrome does not support `immutable`** (`version_added: false`, crbug.com/41253661 — mdn/browser-compat-data). Supported in Firefox ≥ 49 and Safari ≥ 11; legacy Edge 15–79 lost support when it became Chromium-based; **Firefox for Android does not support it**. Where supported, `immutable` only suppresses subresource revalidation on reload — making stale entries even "stickier" in desktop Firefox/Safari.
- **An escape hatch exists but is unreliable:** a hard reload (Ctrl+Shift+R / "Empty cache and hard reload") bypasses everything in all browsers, but it is a manual action that affected users do not know they need to take.

### 1.4 Where the risk is NOT: Vercel's CDN

Two guarantees in Vercel's documentation limit the problem to the client side:

- The CDN cache key includes "**the unique deployment URL**" (see vercel.com/docs/caching/cdn-cache/purge) → each deployment has a new cache namespace; old entries do not leak into the next deployment;
- "Static files are automatically cached on Vercel's global network **for the lifetime of the deployment**" (cdn-cache), and "Vercel doesn't allow bypassing the cache for static files by design" — that is, within a deployment the response always comes from the current build; between deployments, the namespace changes.

Conclusion: the stale cache described by the review comment is the **browser's** (plus transparent proxies/antivirus software along the way). The browser is exactly where `immutable` + `max-age` without versioning causes problems.

---

## 2. Fix design — URLs addressed by version/content

### 2.a Versioned directory for WASM: `/mediapipe/wasm-1.2.3/`

This is feasible without changing the MediaPipe contract: `nh()` interpolates `${base}/vision_wasm_module_internal.{js,wasm}` with a fixed filename and **arbitrary directory** (`vision.d.ts:733` only requires that the files not be renamed). Copy them to `public/mediapipe/wasm-${version}/` and pass the corresponding base path.

**How the client can learn the version without hardcoding — three options:**

1. **`import pkg from '@mediapipe/tasks-vision/package.json'`** — ❌ not viable. The package's `exports` map (`node_modules/@mediapipe/tasks-vision/package.json`) lists only `"."`, `"./vision_bundle.js"`, and the four WASM paths — it **does not export `./package.json`**. Verified in Node 24: `import('@mediapipe/tasks-vision/package.json')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`. Vite resolves dependency specifiers through the same `exports` map → the same error in dev/build; and `tsc` with `moduleResolution: "Bundler"` (`tsconfig.json:14`) also fails at compile time — verified: `TS2307: Cannot find module '@mediapipe/tasks-vision/package.json'`, even with `resolveJsonModule: true` (`tsconfig.json:10`). In other words, this option fails at all three layers (typecheck, dev, build).
2. **Fetch `manifest.json` from `public/mediapipe/` at runtime** — ❌ worse. It would match `/mediapipe/(.*)` → inherit `immutable` → the manifest itself would become stale (self-defeating), or require a header exception plus an extra round trip before `INIT`. More complexity with no benefit.
3. **Generate a TypeScript module at build time** — ✅ recommended. `copy-mediapipe-wasm.mjs` already runs in `predev`/`prebuild` (`package.json`), already reads the dependency's `package.json` by filesystem path (line 7 — direct filesystem access bypasses `exports`, as the pin does), and already computes the model's SHA-256 (line 17). Writing `src/cv/mediapipe-assets.ts` (gitignored, following the same convention as generated `public/mediapipe/wasm/`) takes about 10 lines and puts the version + hash **inside the content-hashed bundle** — always consistent with the code, with no extra RTT or special header.

   - Equivalent alternative: use `define` in `vite.config.ts` to read `package.json` through fs — it works, but duplicates the read/SHA logic already in the script and requires `declare global` for `tsc`. More moving parts; the generated file provides a single source of truth.

### 2.b Content-addressed model URL

- **`?v=<sha8>` — ❌ rejected.** Vercel's CDN cache key ignores query strings for static files (docs: "The request URL (**query strings are ignored for static files**)"). It would work in the browser (the full URI is the key), but query-based versioning depends on each intermediary including the query in its cache key — a weak signal and inconsistent with the other assets. A versioned path is unambiguous.
- **Hashed directory** `/mediapipe/m-<sha8>/pose_landmarker_lite.task` — valid, symmetric with `wasm-<ver>/`.
- **Filename suffix** `/mediapipe/models/pose_landmarker_lite.<sha8>.task` — ✅ recommended. It mirrors Vite's own `[name]-[hash]` convention, keeps the name self-descriptive, and the final `.task` extension preserves the content type (irrelevant here — octet-stream is not compressed anyway, §4). `<sha8>` = the first 8 hex characters of the already-verified SHA-256 (`59929e1d…` in `SHA256SUMS`). Generate and gitignore the copy; keep the unsuffixed original tracked as the source of truth.

### 2.c Alternative considered: keep fixed URLs and remove `immutable`

Rejected, though it is not disastrous: the real danger is `max-age=31536000` (not `immutable`, which is a no-op in Chrome). Returning to the default `public, max-age=0, must-revalidate` makes the browser revalidate all three assets by ETag on every visit — the 304 responses are small (roughly header bytes), not "20 MB of 304s" — but they add serial RTTs to CV startup (loader → import → WASM → model), which already takes seconds; the cost repeats on every visit, including on high-latency mobile connections. An intermediate `max-age` (e.g., one day) only *limits* version skew without eliminating it — a day of broken CV is still a day of broken CV. web.dev summarizes the trade-off: for unversioned URLs, "you need to admit defeat" and revalidate. Since versioning is inexpensive here (§2.a/2.b), it resolves both sides of the trade-off — long-lived caching AND correctness — and is what the review requests. **Keep `immutable`.**

### 2.d Final recommendation — per-file outline

**`scripts/copy-mediapipe-wasm.mjs`** — keep the two existing checks; change the destination and emit the module:

```js
const version = packageJson.version; // already validated as '1.2.3'
const wasmDir = `wasm-${version}`;
const destination = resolve(root, 'public/mediapipe', wasmDir);
// rm + mkdir + copyFile for both files (as it does today, lines 11–14)

const sha8 = digest.slice(0, 8); // digest already calculated and verified (lines 17–20)
const modelVersioned = `pose_landmarker_lite.${sha8}.task`;
// Optional: remove old copies `pose_landmarker_lite.*.task` before copying
await copyFile(modelPath, resolve(root, 'public/mediapipe/models', modelVersioned));

await writeFile(resolve(root, 'src/cv/mediapipe-assets.ts'),
  `// GENERATED by scripts/copy-mediapipe-wasm.mjs — do not edit.\n` +
  `export const MEDIAPIPE_WASM_DIR = '${wasmDir}';\n` +
  `export const POSE_MODEL_FILE = 'models/${modelVersioned}';\n`);
```

**`src/cv/mediapipe-assets.ts`** (new, generated, gitignored):

```ts
export const MEDIAPIPE_WASM_DIR = 'wasm-1.2.3';
export const POSE_MODEL_FILE = 'models/pose_landmarker_lite.59929e1d.task';
```

**`src/cv/poseClient.ts:8-18`** — `mediapipeAssetUrls()`:

```ts
import { MEDIAPIPE_WASM_DIR, POSE_MODEL_FILE } from './mediapipe-assets';
function mediapipeAssetUrls() {
  const base = `${import.meta.env.BASE_URL}mediapipe/`;
  const wasmDir = `${base}${MEDIAPIPE_WASM_DIR}`;
  return {
    // No trailing slash: nh() appends `${base}/vision_...` — see §4 (the `//`)
    wasmBaseUrl: new URL(wasmDir, location.origin).href,
    wasmModuleUrls: [
      new URL(`${wasmDir}/vision_wasm_module_internal.js`, location.origin).href,
      new URL(`${wasmDir}/vision_wasm_module_internal.wasm`, location.origin).href,
    ],
    modelUrl: new URL(`${base}${POSE_MODEL_FILE}`, location.origin).href,
  };
}
```

**`.gitignore`** — replace `public/mediapipe/wasm/` with `public/mediapipe/wasm*/` (covers `wasm/` and `wasm-*/`), and add `public/mediapipe/models/pose_landmarker_lite.*.task` and `src/cv/mediapipe-assets.ts`.
**`biome.json:5`** — replace `!public/mediapipe/wasm` with `!public/mediapipe/wasm*` (plus `!src/cv/mediapipe-assets.ts` if generated files should be excluded from lint).
**`vercel.json`** — **unchanged**: `/mediapipe/(.*)` matches the new paths (`wasm-1.2.3/x`, `models/*.sha8.task`) without edits, making `immutable` correct.
**`protocol.ts`/`pose.worker.ts`** — unchanged: `INIT` still carries the resolved `wasmBaseUrl` + `modelUrl` (`protocol.ts:36-41`).

Bonus side effect: a `tasks-vision` upgrade or model replacement produces a **new directory/file** → no cache overlap → rollbacks become trivial, and older deployments do not overwrite anything.

**One candid caveat about the generated file:** running `npx tsc -b`/`npx vite build` directly in a clean clone fails (`mediapipe-assets.ts` does not exist yet) — `predev`/`prebuild` must have run once. This is the same trade-off as today's `public/mediapipe/wasm/` (which fails at runtime with a 404 instead of failing compilation). It can be mitigated by documenting this in README/AGENTS; if that is undesirable, commit a stub — although gitignored-and-regenerated files are already the repo convention.

---

## 3. Does `/assets/*` have the same issue? No.

Vite emits content-hashed filenames by default — confirmed in `dist/`: `index-oZyQnFfm.js`, `pose.worker-CmI72EtI.js`, `index-BQHEvAr3.css`, `GameLoop-ERi9XfyV.js`, etc. `index.html` is regenerated with the current hashes on every build (`dist/index.html:11-12`) and has no custom header → it gets Vercel's default `public, max-age=0, must-revalidate` (docs: "The default value is `cache-control: public, max-age=0, must-revalidate`") → HTML is revalidated on every visit → under normal navigation, old HTML does not survive a deployment. Vite's own documentation prescribes exactly this: "make sure to set `Cache-Control: no-cache` on the HTML file, otherwise the old assets will be still referenced" (vite.dev/guide/build, *Load Error Handling*) — Vercel's default is equivalent.

Known orthogonal residual issue: a user with the page open during deployment may get a 404 from an old dynamic `import()` (the old chunk disappears with the previous deployment) — this is the `vite:preloadError` scenario documented by Vite; an optional mitigation would be a `location.reload()` handler, unrelated to the header. Conclusion: `/assets/(.*)` + `immutable` is **correct as-is**.

---

## 4. Other observations about the `headers` block in `vercel.json`

- **`source: "/mediapipe/(.*)"` is correct for nested paths.** `(.*)` is Vercel's documented wildcard syntax (the official example uses `"/(.*)"` for all routes); `source` matches the *pathname* (excluding the query string), and `.*` crosses `/` — covering `wasm-*/x.wasm`, `models/*.task`, and any future nesting. The alternative `:path*` would be `/mediapipe/:path*`; equivalent, with no benefit.
- **Headers apply to files in `public/`** — confirmed: the documentation's example says it configures "custom response headers for **static files**"; `public/` is copied byte-for-byte to `dist/` (vite.dev/guide/assets), and the rules match by pathname in the final response.
- **Compression: `.task` is excluded, and renaming it is not worthwhile.** Vercel's compressed MIME allowlist includes `application/wasm` → `.wasm` is compressed (measured: 14,665,738 B → ~4,165,889 B gzip, −72%), as is the JS loader (336,662 → ~81,289 B). `.task` resolves to `application/octet-stream`, which is absent from the list → no gzip/brotli, confirming the previous report's finding. Renaming it to a compressible extension is not worthwhile: `.task` is a dense flatbuffer (gzip saves only ~14%, measured: 5,777,746 → 4,970,219 B), and serving the model as `.wasm`/`.js` would misrepresent its content type. Keep `.task` uncompressed.
- **Not issues:** the 10 MB cacheable-response limit applies to *Function responses*; static files are cached per deployment, so it does not apply. `proxy-revalidate` is unsupported — irrelevant here.
- **Adjacent bug found (in the same line touched by the fix):** `wasmBaseUrl` ends in `/` (`poseClient.ts:11`), and `nh()` concatenates `${base}/vision_...` → the actual loader URL is `…/mediapipe/wasm//vision_wasm_module_internal.js` (**double slash**; `new URL()` preserves `//` in the path — verified). Meanwhile, `warmVisionAssets()` prefetches `…/wasm/vision_…` with a single slash (`poseClient.ts:13-14`) — a **different HTTP cache key** → warm-up likely does not warm the entry that `FilesetResolver` will use (and might even duplicate the 15 MB download on the first visit). The §2.d outline removes the `//` by dropping the trailing slash — verify with `curl -I` on deployment that `/mediapipe/wasm//vision_wasm_module_internal.js` is actually served today (Vercel should normalize it; the app presumably works in production).

---

## 5. Pre-release checklist

1. Run `npm run build` (generates `wasm-1.2.3/`, the suffixed `.task`, and `mediapipe-assets.ts`) and check that all three versioned paths appear in `dist/`.
2. Run `npm run dev` → ENABLE CAMERA → TRACKING (AGENTS.md requires manual verification of the CV flow); in DevTools, confirm that the loader URL uses a **single slash** under `…/wasm-1.2.3/` and that warm-up hits the same URL (`x-vercel-cache`/from disk cache).
3. In production: `curl -sI https://<deploy>/mediapipe/wasm-1.2.3/vision_wasm_module_internal.wasm` → expect `cache-control: public, max-age=31536000, immutable` + `content-encoding: br|gzip` (with `Accept-Encoding`); likewise for the versioned `.task` → immutable header, **no** content encoding (octet-stream).
4. Simulate version skew: build with a different `wasmDir`/sha8 value → confirm that the URLs change and the app requests the new paths (no old cached paths are requested).
5. Confirm that generated files leave `git status` clean (`wasm-*/`, `pose_landmarker_lite.*.task`, and `mediapipe-assets.ts` are ignored) and that `npm run lint` passes with the new globs in `biome.json`.

### Claims I could not verify (stated for transparency)

- Whether the `.wasm` bytes actually differ across `tasks-vision` versions (very likely — it is a MediaPipe graph compiled for each release — but only 1.2.3 is installed; verify by diffing `wasm/` across two packages).
- Whether Vercel currently normalizes `/mediapipe/wasm//…` — checklist item 2 covers this; if it does not, the app should already be broken in production (which would make the `//` bug the primary issue, not merely a cache-key issue).
- The exact reload revalidation semantics for `fetch()`/`import()` *inside workers* (the Chrome 56 change covers page subresources; I treated the cache path as identical).
- Behavior of third-party caches (corporate proxy, ISP, antivirus) — standard RFC 9111 behavior is assumed (the full URI, including the query, is the key).

---

## Sources

- **Repository code:** `src/cv/poseClient.ts:8-18,34-37,99-128` · `src/cv/pose.worker.ts:12-15` · `scripts/copy-mediapipe-wasm.mjs:7-20` · `vercel.json:5-14` · `public/mediapipe/models/SHA256SUMS` · `.gitignore` · `biome.json:5` · `dist/index.html`, `dist/assets/` (actual build hashes).
- **`@mediapipe/tasks-vision` 1.2.3 (`node_modules`):** `vision_bundle.mjs` — `nh()` builds `${base}/vision_wasm_module_internal.{js,wasm}` (any base directory), `Mh()` loads the loader through `importScripts` → `import()` or `<script>`, and `Wh()` consumes `wasmLoaderPath`/`wasmBinaryPath` with `locateFile`; `vision.d.ts:819` (signature `forVisionTasks(basePath?, useModule?)`), `:731-733` ("the Wasm files [must be] published **without renaming**"), `:2941` (`WasmFileset`); `package.json` — `exports` does **not** include `"./package.json"` → `ERR_PACKAGE_PATH_NOT_EXPORTED` (verified in Node 24).
- **MDN Cache-Control** — `immutable` only applies "when you use a **cache-busting pattern**": https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control#immutable · compatibility from **mdn/browser-compat-data** (`http/headers/Cache-Control.json` → `immutable`): unsupported in Chrome (crbug.com/41253661), Firefox ≥49, Safari ≥11; unsupported in Firefox for Android.
- **web.dev — Prevent unnecessary network requests with the HTTP Cache** (Grigorik/Posnick): version skew from unversioned URLs ("different users might end up using different versions of the file") and "admit defeat" + revalidation for unversioned URLs: https://web.dev/articles/http-cache
- **Chromium Blog — "Reload, reloaded" (Jan. 2017):** since Chrome 56, a normal reload validates **only the main resource**; subresources within `max-age` are not revalidated: https://blog.chromium.org/2017/01/reload-reloaded-faster-and-leaner-page_26.html
- **Vercel — Cache-Control headers:** default `public, max-age=0, must-revalidate`; `max-age=31536000, immutable` recommended only for "**Content-hashed assets**": https://vercel.com/docs/caching/cache-control-headers
- **Vercel — CDN Cache:** static files are cached "for the lifetime of the deployment"; "Vercel doesn't allow bypassing the cache for static files by design": https://vercel.com/docs/caching/cdn-cache
- **Vercel — Purging CDN Cache:** cache key = method + URL "**(query strings are ignored for static files)**" + host + **deployment URL** + scheme: https://vercel.com/docs/caching/cdn-cache/purge
- **Vercel — `vercel.json` `headers`:** `source` matches the pathname (excluding the query string); official example `"/(.*)"`; "configures custom response headers for **static files**": https://vercel.com/docs/project-configuration/vercel-json#headers
- **Vercel — Compression:** compressed MIME allowlist includes `application/wasm`; `application/octet-stream` is absent: https://vercel.com/docs/how-vercel-cdn-works/compression
- **Vite — Building for Production / Static Asset Handling:** content-hashed filenames by default; `public/` copied without hashes; "make sure to set `Cache-Control: no-cache` on the HTML file, otherwise the old assets will be still referenced" (Load Error Handling): https://vite.dev/guide/build · https://vite.dev/guide/assets
- **Local measurements:** gzip `.wasm` 14,665,738→~4,165,889 B (−72%) · loader JS 336,662→81,289 B · `.task` 5,777,746→4,970,219 B (−14%) · `new URL()` preserves `//` in the pathname (Node 24).
