# Viabilidade Técnica e Benchmark — Geração de Mii por Foto/Webcam vs. Criação Manual

Data: 28 de novembro de 2026 · Pacote CV analisado: `@mediapipe/tasks-vision@1.2.3`

## 1. Contexto e Pergunta Técnica

O pedido era substituir o antigo protótipo de canvas de desenho da página inicial por um criador completo no estilo **Mii Channel** (rosto, cabelo, sobrancelhas, olhos, nariz, boca, barba/bigode, óculos, altura, porte, cores e nome) com pré-visualização 3D em tempo real, precedido de análise objetiva sobre incluir ou descartar geração inicial de Mii por foto/webcam.

Critérios de produção avaliados:
1. **Peso do bundle inicial (`dist/assets/index-*.js`)**: a página inicial do site é estática com Three.js; não pode carregar runtimes de ML nem modelos na carga inicial.
2. **Taxa de quadros (FPS) em execução contínua**: o site terá dezenas de Miis 3D circulando pelo viewport; detecção facial contínua por frame competiria por CPU/WebGL e degradaria o FPS.
3. **Memória e descarte de recursos**: contextos WebGL, `ImageBitmap`, heaps WASM e faixas `MediaStream` da webcam não podem vazar após uso.
4. **Compatibilidade e fallback**: Safari `< 17` (`OffscreenCanvas` sem WebGL em worker), máquinas sem WebGL ou com GL de software (SwiftShader), iluminação ruim e oclusão parcial.
5. **Privacidade**: processamento 100% on-device, sem envio de fotos a servidores.

---

## 2. Inventário Medido no Repositório e no Build

Tamanhos medidos nos arquivos do repositório e em `npm run build`. O Three.js e o código dos Miis entram em chunks carregados sob demanda.

| Artefato | Bruto (bytes) | Gzip (bytes) | Papel e Observação |
| --- | --- | --- | --- |
| `dist/assets/index-*.js` | `525.63 kB` | `174.16 kB` | Entry principal. Sem `FaceLandmarker`. |
| `dist/assets/faceSuggestClient-*.js` | `14.17 kB` | `6.33 kB` | Carregado só ao pedir sugestão por foto/webcam. |
| `dist/assets/face.worker-*.js` | `156.94 kB` | n/d | Worker efêmero da sugestão. |
| `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` | `155,990` B | `44,958` B | Runtime JS da biblioteca; carregado somente sob demanda (no `face.worker.ts` ou fallback dinâmico). |
| `public/mediapipe/wasm-1.2.3/vision_wasm_module_internal.js` | `336,662` B | `81,289` B | Loader ES module do Emscripten (**já compartilhado** pelo projeto; cache `immutable`). |
| `public/mediapipe/wasm-1.2.3/vision_wasm_module_internal.wasm` | `14,665,738` B (`14.67 MB`) | `4,165,889` B (`4.17 MB`) | Binário WASM SIMD128 único para todas as tasks de visão (**já contém** `FaceLandmarkerGraphOptions`; zero WASM adicional para usuários que já usaram `/app`). |
| `dist/mediapipe/models/face_landmarker.64184e22.task` | `3,758,596` B (`3.76 MB`) | `3,332,902` B (`3.33 MB`) | Modelo `float16` oficial verificado via `SHA256SUMS` (`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`). Baixado **apenas** quando o usuário aciona sugestão por foto/webcam. |

---

## 3. Comparativo das 5 Abordagens no Navegador

Latência e memória abaixo são **estimativas**, não medições do `FaceLandmarker`: partem do runtime `@mediapipe/tasks-vision@1.2.3` e dos benchmarks locais medidos neste repositório (`docs/pesquisa-pipeline-cv.md` §7.5 e `docs/auditoria-mediapipe.md`) com o porte do modelo `face_landmarker.64184e22.task` (`3.76 MB` vs. `5.78 MB` do `pose_landmarker_lite.59929e1d.task`).

| Critério | 1. Manual Mii Channel (puro) | 2. Lazy Single-Shot `FaceLandmarker` (`tasks-vision`) | 3. Lazy `FaceDetector` (`tasks-vision`) | 4. Canvas Heuristics / `window.FaceDetector` | 5. ML Pesado (`face-api.js` / `@tensorflow/tfjs` / Reconstrução 3D) |
| --- | --- | --- | --- | --- | --- |
| **JS no bundle inicial** | `+2–4 kB` gzip (schema/UI) | **`0 kB`** (worker efêmero + `import()` dinâmico) | **`0 kB`** (worker efêmero) | `0–3 kB` | `+400 kB – 1.5 MB` JS (ou `+500 kB` se lazy) |
| **WASM sob demanda** | `0 MB` | `14.67 MB` bruto / `4.17 MB` gz (**compartilhado** com `/app`) | `14.67 MB` bruto / `4.17 MB` gz (compartilhado) | `0 MB` | TF.js WebGL/WASM (`1.5–4 MB`) + backends |
| **Modelo sob demanda** | `0 MB` | `3.76 MB` (`3.33 MB` gz, `face_landmarker.64184e22.task`) | `~230 kB` (BlazeFace short-range) | `0 MB` | `6.5–25 MB` (múltiplos shards `face_api` / FLAME/DECA) |
| **Latência de init (cold)** | `0 ms` | `~250–350 ms` (CPU XNNPACK + compile WASM em cache) | `~200–300 ms` | `< 5 ms` | `800–3,000 ms` (download shards + shaders TF.js) |
| **Latência de inferência** | `0 ms` | **Single-shot**: `~140 ms` 1ª chamada CPU (`~20 ms` se aquecido); **`0 FPS` após fechar** | `~15–40 ms` (só caixa + 6 pontos) | `< 10 ms` (heurística) / variável (Shape Detection API) | `250–1,500+ ms` por foto (ou contínuo caro) |
| **Memória (RAM/VRAM)** | `< 1 MB` | Pico efêmero `~25–45 MB` durante o shot; **liberada ao chamar `close()` + `worker.terminate()`** | Pico efêmero `~22–35 MB` | `< 5 MB` | `80–250+ MB` em tensores WebGL/CPU |
| **Qualidade para Mii** | **Controle exato (100%)** | **Alta**: 478 marcos (oval facial, EAR olhos, inclinação cantal, sobrancelhas, nariz, boca, íris) + amostragem colorimétrica CIE Lab | **Insuficiente**: apenas 6 keypoints (sem contorno mandibular, pálpebras, sobrancelhas ou íris) | **Inviável**: `window.FaceDetector` só existe atrás de flag/macOS-Android parciais (sem Firefox/Safari estável) e não dá formato de olhos/boca/nariz | Alta para 3D genérico, mas estilização Wii é discreta (enums Mii) — overengineering severo |
| **Compatibilidade** | 100% navegadores | Chrome 91+, Firefox 89+, Safari 16.4+ (WASM SIMD128); **requer WebGL** para `texImage2D`; Safari `< 17` usa fallback em main thread | Igual ao #2 | `window.FaceDetector` sem suporte padrão multi-browser | Requer WebGL2 ou WASM pesado; falha frequente em mobile de entrada |
| **Privacidade** | 100% local | **On-device** (foto nunca sai do dispositivo; telemetria de desempenho ODML do MediaPipe documentada em `THIRD_PARTY_NOTICES.md`) | Igual ao #2 | 100% local | On-device (mas peso desencoraja uso web) |

---

## 4. Decisão Arquitetural Adotada: Híbrido Manual-First + Worker Efêmero Single-Shot

Adotamos a arquitetura **Híbrida Manual-First + `FaceLandmarker` Single-Shot sob demanda**:

1. **O criador manual completo é o fluxo primário**: zero dependência de câmera, modelo ou WebGL para criar, personalizar, randomizar e salvar o Mii do jogador (`wii-mii-face-v1` para o rosto, `wii-player-mii-v1` para nome, roupa e porte).
2. **A sugestão por foto/webcam é 100% lazy e efêmera (`src/miis/faceSuggestClient.ts` + `src/miis/face.worker.ts`)**:
   - **0 KB no bundle inicial**: `@mediapipe/tasks-vision` é importado dinamicamente (`await import('@mediapipe/tasks-vision')`) apenas dentro de `face.worker.ts` (ou no fallback dinâmico em main thread), jamais no `index-*.js`.
   - **0 FPS de impacto contínuo**: usa `runningMode: 'IMAGE'` e `numFaces: 1`. Após uma única chamada `detect(bitmap)`, executa imediatamente `landmarker.close()`, `bitmap.close()`, `worker.terminate()` e (no fluxo de webcam) `track.stop()`.
   - **Reuso de infraestrutura do repo**: reaproveita `public/mediapipe/wasm-1.2.3/` já cacheado com `Cache-Control: immutable` no `vercel.json` e adiciona verificação SHA-256 obrigatória de `face_landmarker.64184e22.task` em `scripts/copy-mediapipe-wasm.mjs`.

### 4.1 Justificativa do Delegate `CPU` Padrão

Conforme medido em `docs/pesquisa-pipeline-cv.md` §7.5 (Chromium 159) e `src/cv/delegate.ts`:
- Em ambientes com GL de software (SwiftShader/llvmpipe/VMs) ou drivers bloqueados, o delegate `GPU` do MediaPipe paga **`~2,016 ms`** apenas para compilar shaders no primeiro frame e roda a `~96–197 ms/frame`.
- O delegate `CPU` (XNNPACK + SIMD128) inicia em **`~250–300 ms`** com primeiro frame em **`~142 ms`**, sem compilar shaders de inferência e **sem disputar a GPU integrada com o `WebGLRenderer` do Three.js** que anima os Miis na Home.
- Por isso `faceSuggestClient.ts` usa `preferredDelegate()` (`'CPU'` por padrão; `?delegate=gpu` opcional com fallback automático para `'CPU'` no worker).

### 4.2 Requisito de WebGL e Fallback para Safari `< 17`

Conforme verificado em `node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` (`docs/auditoria-mediapipe.md` achados #2 e #3):
- **WebGL obrigatório mesmo no delegate `CPU`**: toda imagem de entrada passa por `$h()` → `gl.texImage2D` em um canvas WebGL interno antes de descer para o grafo XNNPACK. Por isso `face.worker.ts` e o fallback verificam `getContext('webgl2') ?? getContext('webgl')` antes de baixar o `.task` de `3.76 MB`, falhando de forma limpa com `FaceSuggestError('WEBGL_UNAVAILABLE', ...)`.
- **Safari `< 17` (`Oh()` em `vision_bundle.mjs`)**: a função interna `Oh()` rejeita `OffscreenCanvas` quando o User-Agent é Safari `< 17` (inclusive Safari 16.4, que expõe `OffscreenCanvas` sem WebGL), fazendo o `GraphRunner` chamar `document.createElement('canvas')` — o que lança `ReferenceError` dentro de Web Workers. `canUseFaceWorker()` em `faceSuggestClient.ts` espelha exatamente `Oh()` e redireciona Safari `< 17` (ou ausência de `OffscreenCanvas`/`Worker`) para um fallback single-shot em main thread via `import('@mediapipe/tasks-vision')`, fechando `landmarker.close()` em `finally`.

### 4.3 Mapeamento Geométrico e Colorimétrico Puro (`src/miis/photoToMii.ts`)

Para garantir testabilidade determinística em Vitest (`environment: 'node'`) e desacoplamento total de DOM/Three.js/MediaPipe:
- `faceSuggestClient.ts` redimensiona a foto/frame para no máximo `512 px` em um `<canvas>` 2D, lê `ImageData` na main thread e transfere o `ImageBitmap` zero-copy para o worker.
- `photoToMii.ts` aplica:
  1. **Correção isotrópica de aspect ratio** (`x * aspectRatio`) para impedir distorção de `cheekW / faceH` em webcams `16:9` ou retratos `3:4`.
  2. **De-rotação de roll** alinhando a linha interocular (`33` → `263`) antes de classificar `headShape`, `eyeStyle`, `eyebrowStyle`, `noseStyle` e `mouthStyle`.
  3. **Quantização perceptiva CIE Lab (`ΔE76`)** para mapear amostras de pele, cabelo, íris e roupa nas paletas oficiais de `src/miis/miiTypes.ts`.
  4. **Degradação graciosa**:
     - `< 468` marcos ou rosto minúsculo (`faceH < 0.08`) → `FaceSuggestError('NO_FACE_DETECTED', ...)` sem corromper o rascunho atual.
     - Testa cortada no topo (`L[10].y < 0.08`) → preserva `baseProfile.hairStyle` com aviso em vez de classificar incorretamente como careca.
     - Inclinação lateral severa (`yawBalance < 0.6`) → reduz `confidence` e emite aviso.
     - Olho fechado/piscando (`wink`) ou óculos escuros (`sunglasses`) → preserva `baseProfile.eyeColor`.

---

## 5. Conclusão e Critérios de Reavaliação

A abordagem **Híbrida Manual-First + Lazy Single-Shot `FaceLandmarker`** atende ao pedido:
- **Custo zero** no carregamento inicial da Home (`0 kB` de `@mediapipe/tasks-vision` em `index-*.js`) e **custo zero** de FPS durante a circulação dos Miis 3D.
- **Sugestão real por foto/webcam** com rascunho editável no criador Mii Channel quando o usuário opta pelo recurso, e **criador manual completo** sempre disponível quando WebGL estiver ausente, o modelo falhar ou nenhum rosto for detectado.
- Se no futuro o site adotar CSP restritiva, `connect-src` precisará contemplar o endpoint de telemetria ODML embutido no MediaPipe (`odml.pa.googleapis.com/v1/log`, já documentado em `THIRD_PARTY_NOTICES.md`).
