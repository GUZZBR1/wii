# Análise de gargalos do jogo da corrida — Wii Web Sports Arena

Data: 25 de novembro de 2026 · Commit analisado: `17b6fed` ("resolve merge: main worker protocol + kinematics profile shape") — **merge de rascunho** no branch local `analysis/merged-prs`, representando `main` como se três mudanças já estivessem mergeadas: PR #5 `cv/kinematics-engine`, `feat/camera-auto-calibration` (`eedb6c0`) e PR #6 `feat/running-pace` (`266e042`). Conflitos resolvidos em direção ao formato do PR #5.

> **Nota histórica (2026-11-25):** as descrições de mecanismo ao longo desta nota — cadência por Schmitt de subida de joelho, salto contra `hipY0` calibrado, calibração exigindo joelhos/tornozelos — documentam a implementação **anterior**, analisada no commit citado. Na branch `feat/torso-detection` todos esses mecanismos foram substituídos: cadência pela oscilação vertical do torso, salto contra baseline adaptativa sem calibração, calibração só-de-torso. O valor desta nota hoje é a análise física dos gargalos (que motivou o redesign) e o histórico das alternativas — não como referência do sistema atual. Para o sistema atual ver `docs/pesquisa-deteccao-pelo-torso.md` e o código em `src/kinematics/`.

Esta nota analisa **apenas o jogo da corrida** (Hurdle Rush) de ponta a ponta. Gargalos do pipeline CV genérico — WASM, cadeia de init, cache, teto de throughput de um frame em trânsito, Safari — já foram auditados em `docs/analise-de-gargalos.md` e `docs/pesquisa-pipeline-cv.md`; aqui eles aparecem só no que significam para a corrida. Testes no estado mergeado: **79 passando** (`npm test`, 4 arquivos).

---

## O que é este estado do projeto

O Hurdle Rush mergeado funciona assim (código citado `path:line` na árvore de trabalho):

1. **Captura** — `PoseClient.beginCapture` agenda por `requestVideoFrameCallback` com fallback rAF (`src/cv/poseClient.ts:67-85`), um frame em trânsito (`poseClient.ts:168`), `createImageBitmap` 640px (`poseClient.ts:177`), worker module + `useModule: true` (`src/cv/pose.worker.ts:12`), `detectForVideo` síncrono (`pose.worker.ts:81`). Init do MediaPipe corre **em paralelo** ao `getUserMedia` (`src/App.tsx:102-105`) e os assets são preaquecidos quando a permissão já existe (`App.tsx:31-34`, `poseClient.ts:39-42`). Assets imutáveis com hash (`vercel.json`, `src/cv/mediapipeAssets.ts`).
2. **Calibração automática** — `AutoCalibrator` exige ombros+punhos+quadris+joelhos com confiança ≥0,55, 1 s parado + 3 s de coleta (`src/cv/autoCalibrator.ts:5-10,22-48`); `Calibrator.finish` exige ≥12 amostras, span ≥2,8 s e ≥65% de frames válidos (`src/cv/calibrator.ts:23-57`). Produz `CalibrationProfile` com `dominantHand`, `image.{torsoHeight,hipY0,kneeToHipY0,shoulderWidth}` e `world.{shoulderWidth,torsoUp0,torsoLeanRad0,readyWristLocal}` (`src/cv/protocol.ts:22-45`).
3. **Cinemática por feature** — portões independentes: corpo `[11,12,23,24]` imagem, cadência `[23,24,25,26]` imagem, salto `[23,24]` imagem, raia `[11,12,23,24]` mundo, swing `[11,12,23,24,punho]` mundo (`src/kinematics/actionPipeline.ts:9-13`). Portão: 3 frames bons → `tracked`, 4 ruins → `lost` (`trackingGate.ts:26-36`). Eventos carregam `trackingState` e a confiança do próprio conjunto de landmarks (`protocol.ts:95-114`).
4. **Cadência→velocidade (PR #6)** — Schmitt por perna sobre o sinal filtrado de subida do joelho (limiares 0,1/0,05, cooldown 220 ms), intervalos de passo median-3, `cadenceSpm = 60_000/max(período, decorrido)`, parada após `min(1,6·período, 1600 ms)`, mapa `SPEED_BY_CADENCE` ancorado em 40→0,1 / 100→0,3 / 137,5→0,55 / 200→1 (`cadenceTracker.ts:8-19,59-71`); gait idle/walk/run com histerese 0,55/0,5 (`gait.ts:4-9`).
5. **Jogo** — `TrackGame.onAction` aplica `sprint`/`jump`/`lane` a estado (`TrackGame.ts:86-90`); simulação em passo fixo 1/60 (`GameLoop.ts:43-56`); velocidade exibida suavizada τ≈167 ms (`TrackGame.ts:104`); salto é sempre um arco fixo de 0,72 s/1,35 u (`TrackGame.ts:95,120-123`); obstáculo cruza a checagem em `z>0,2` e é limpo se outra raia OU salto recente (`jumpTime>0,15`) OU altura >0,45 (`TrackGame.ts:128-132`); spawn a cada ~26 u percorridas em `z=-48-rand5` (`TrackGame.ts:139-142`); score `dt·speed·50` +100/−35 por obstáculo (`trackScore.ts:4-15`); HUD a 5 Hz (`TrackGame.ts:39`).
6. **Dispatch** — `App.tsx:82-95` roda `pipeline.update` por POSE e despacha `result.events` para `engineRef.current?.onAction` no mesmo task. **`result.controls` e `result.kinematicsMs` não têm consumidor** — superfície devolvida pelo PR #5 sem uso (o próprio autor do PR notou isso no corpo do PR #5).

O que os merges resolvem do relatório anterior: bug do `useModule` (#1), cache/compressão (#3), respawn do worker (#5), WASM morto no deploy (#6) e init serial (#2, parcialmente — WASM+modelo agora aquecem em paralelo à permissão). **Permanece relevante para a corrida**: o teto de throughput de um frame em trânsito (#7 da auditoria) e a latência fóton→tela nunca medida.

---

## Resumo executivo

| # | Gargalo | Gravidade | Confiança |
|---|---------|-----------|-----------|
| 1 | **Teto de poses/s vira teto de cadência**: a mecânica de ritmo exige ~2–3 amostras por subida de joelho; a ~15 poses/s o próprio autor mede subcontagem a 170 spm e perda a 190; a ~5–10 poses/s (GPU-delegate sobre GL de software, **que nunca cai para CPU** — medido 96–243 ms/frame em `docs/pesquisa-pipeline-cv.md` §7.5) nem a marcha de ~138 spm para "correr" é alcançável. Nada na UI revela a degradação. | **Alta–Crítica (em hardware fraco)** | Mecanismo certo; taxas medidas localmente; frequência em usuários reais desconhecida |
| 2 | **Salto × bounce da corrida no mesmo sinal de quadril**: armar/liberar exige `rise ≤ 0,03` por 160 ms e disparo exige `rise ≥ 0,08` a ≥0,5 torso/s por 30 ms (`jumpDetector.ts:5-7,24-55`). A oscilação vertical real correndo (~7–9 cm p-p ≈ 0,07–0,18 torso) cai exatamente na faixa marginal: pode disparar falsos (~2,5/s dado o refratário de 400 ms) ou travar `airborne` e nunca mais detectar salto — o gesto obrigatório para passar obstáculos. | Alta | Mecanismo verificado no código; desfecho **não verificado em hardware real** — só o teste com bob de 0,05 existe |
| 3 | **Engasgo de um frame**: um único frame `degraded` na portaria da cadência emite `sprint` com speed 0 na hora (`actionPipeline.ts:47-50`) — é o contrato escrito (`protocol.ts:89-90`), mas a ~30 poses/s cada dip de confiança nos joelhos (o landmark mais borrado justamente durante passada rápida) derruba `speed01` por ~100–500 ms; a ~7 poses/s o dip dura ~0,4–0,9 s (3 frames bons para recuperar). | Média–Alta | Verificado no código e em teste (`kinematics.test.ts:407-420`); frequência real depende de hardware |
| 4 | **Latência de parada 2–3× acima da meta citada**: parada leva `min(1,6·período, 1600 ms)` ≈ 0,5–1,6 s na faixa jogável; o GUD WIP que o PR #6 cita para "latency goals" para ~500 ms após o último passo. Partida análoga: exige 2 eventos de passo (~1 período) + pipeline ≈ 0,7–1,3 s até o primeiro movimento. | Média | Verificado (conta); percepção atenuada pelo decaimento contínuo entre passos |
| 5 | **Janela de salto × latência fim-a-fim**: o evento precisa chegar ≤~642 ms antes do cruzamento do obstáculo (união de `jumpTime>0,15` e `y>0,45`); latência física→aplicação ≈ 60–150 ms típica → o take-off físico precisa acontecer ~0,5–0,6 s antes do obstáculo chegar; pular "cedo" falha (arco fixo) e teclado é instantâneo — paridade quebrada. | Média | Conta verificada; latência real fóton→ação nunca medida |
| 6 | **Ruído de raia durante a marcha**: `legsVertical` estima a vertical pelo ponto médio dos joelhos, que oscila lateralmente a cada passada → a referência pendula ~±7–12° por passo, perto do limiar de disparo 0,15 rad. Fixture nunca move os joelhos de mundo → caminho sem teste. | Média–Baixa | Mecanismo plausível; não verificado com poses reais |
| 7 | **Portão de calibração exige corpo inteiro parado 4 s** (ombros+punhos+quadris+joelhos ≥0,55): a corrida só precisa de quadris+joelhos — jogador sem enquadramento de joelhos não calibra e não joga; falha de qualidade reinicia o ciclo silenciosamente. | Média (onboarding) | Verificado no código |
| 8 | **Cegueira operacional**: sem `inferenceMs` no protocolo novo, sem poses/s na UI, sem `presentedFrames`, `controls`/`kinematicsMs` sem consumidor — degradação de CV é indistinguível de "jogador parou" para quem depura. | Baixa–Média | Verificado |

> Nota de honestidade: **nada neste estado foi exercido com câmera real e pessoa real** — o próprio autor do PR #6 declara "Not yet verified with a real person walking or running in front of a webcam" e o limite de 15 fps na seção "Known limit" do corpo do PR. Todos os números de amplitude de sinal humano abaixo são estimativas de literatura, marcadas como tal.

---

## Gargalos

### 1. O teto de poses/s é o teto de cadência — e o pior caso nunca dispara fallback

**O que é.** A contagem de passos exige que cada subida de joelho produza amostras suficientes acima do limiar 0,1 através do filtro 1€ (`cadenceTracker.ts:32-46`, `oneEuroFilter.ts`, `schmittTrigger.ts:9-16`). O pulso de joelho-acima-do-limiar ocupa ~40–50% do período do passo (estimativa de marcha; não medida em humano). Amostras por pulso ≈ 0,45·(60 000/spm)/intervalo-de-frame:

| Poses/s efetivas | Frame | Pulso a 138 spm (~200 ms) | Pulso a 190 spm (~140 ms) | Consequência na corrida |
|---|---|---|---|---|
| 30 (saudável) | 33 ms | ~6 amostras | ~4 | teto gravável = MIN_STEP_INTERVAL 220 ms ≈ **272 spm** — folga total sobre o teto do mapa (200 spm → speed 1) |
| 15 | 66 ms | ~3 | ~2 | limite medido pelo autor: 170 subcontado, 190 perdido |
| ~10 (CPU fraca) | 100 ms | ~2 | ~1,4 | run gait (~138 spm) vira moeda — `speed01` não passa de ~0,5 de forma estável |
| ~5–7 (GPU-delegate em GL de software) | 143–200 ms | ~1–1,4 | <1 | nem andar direito: passos perdidos → `cadenceSpm` cai pela metade a cada miss (`60_000/max(período, decorrido)`, `cadenceTracker.ts:70`) |

O teto estrutural vem do um-frame-em-trânsito + `detectForVideo` síncrono (auditoria geral, item #7): `poses/s ≈ min(30, 1000/round-trip)`. O dado local medido (mesma máquina, `pesquisa-pipeline-cv.md` §7.5): **CPU ~16–21 ms → ~48–62 poses/s; "GPU" via SwiftShader ~96–243 ms → ~5–10 poses/s — e o fallback só dispara em exceção** (`pose.worker.ts:32-46,87-94`), não em lentidão. Ou seja: usuário com GPU blocklistada/VM/RDP/GL de software recebe ~7 poses/s **silenciosamente** — o pior regime possível para esta mecânica, sem aviso.

**Impacto específico da corrida.** A velocidade do corredor é derivada de cadência medida: abaixo de ~15 poses/s o jogo não distingue "jogador lento" de "pipeline lenta" — quem corre a 180 spm no lugar vê o avatar andar (~speed 0,5), obstáculos em marcha lenta e a animação dessincronizada. É o gargalo estrutural do jogo: a mecânica central (pace = velocidade) é a mais sensível à taxa de amostragem de todo o produto.

**Direção de correção:**
- Detectar GL de software (`WEBGL_debug_renderer_info` → "SwiftShader"/"llvmpipe"/"Software") e preferir CPU, ou medir o primeiro `detectForVideo` e fazer fallback **por latência** — já recomendado na pesquisa §7.5 e é a ação de maior ROI para este jogo.
- Expor poses/s efetivas (ou pelo menos `presentedFrames` discontinuidades + ms de round-trip) — hoje `inferenceMs` nem é transportado no protocolo novo e `kinematicsMs` (`actionPipeline.ts:23,76`) não tem consumidor.
- `VideoFrame` direto no rVFC corta o estágio de bitmap (pesquisa §2.2); em fallback CPU, `resizeWidth` ~320.
- Se taxa efetiva baixa for a norma-alvo, considerar limiar de subida adaptativo à taxa medida — arriscado, marcar como não testado.

### 2. Salto e corrida disputam o mesmo sinal de quadril — a combinação obrigatória do jogo é a menos testada

**O que é.** `JumpDetector` mede `rise = (hipY0 − quadril.y)/torsoHeight` em **espaço de imagem** (`jumpDetector.ts:20-21`). Máquina de estados:

- `armed` (uma vez, nunca desarma até `reset`): exige `rise ≤ 0,03` por 160 ms contínuos (`:24-31`);
- disparo: `rise ≥ 0,08` **e** velocidade ≥0,5 torso/s sustentados por 30 ms (`:5-7,37-47`), refratário 400 ms (`:41`);
- `airborne` libera só após outros 160 ms de `rise ≤ 0,03` (`:48-54`).

**O problema físico.** A oscilação vertical do centro de massa correndo é ~7–9 cm pico-a-pico (6,5–13,1 cm; MSSE abstract, doi 10.1249/01.mss.0001061236.55291.a0 — medida em esteira; o ponto sacro acompanha o CoM a ±1,5 mm, PubMed 19356933). Em unidades de torso (~0,5–0,55 m) isso é amplitude ~0,07–0,18 por ciclo, a ~2,3–3,3 Hz no ritmo de corrida — **exatamente a faixa marginal entre os limiares 0,03 e 0,08**.

> **Errata (2026-11-25):** a versão original desta nota dizia "~1,4–1,6 Hz" — erro de um fator de dois. A oscilação vertical na corrida acontece **uma vez por passo**, não por passada: na faixa jogável (140–200 spm) isso é 2,3–3,3 Hz, a própria frequência de passo. Fontes primárias em `docs/pesquisa-deteccao-pelo-torso.md` §1. A correção não muda a conclusão qualitativa — a conjunção amplitude×velocidade continua marginal — mas agrava o quadro do detector antigo: oscilando mais rápido, as janelas de sustentação de 30 ms encolhem ainda mais, e o filtro 1€ de fcmin 1 Hz do detector antigo devorava a amplitude nessa banda. O desfecho real é outro, melhor: este gargalo foi resolvido na branch `feat/torso-detection` pela direção "referência adaptativa" aqui recomendada — baseline adaptativa no canal de torso, cadência medida da própria oscilação vertical (não mais dos joelhos) e limiares de salto re-ancorados na cadeia filtrada (0,1 torso / 1,2 torso/s, valores iniciais a validar em câmera real). A conta para senoide de amplitude A e frequência f: a conjunção `rise ≥ 0,08 & velocidade ≥ 0,5` se sustenta só perto da subida rápida e perto do pico — com A≈0,1/f=1,5 Hz são ~9 ms por ciclo (< 30 ms, não dispara; o teste de bob existente usa 0,05: `kinematics.test.ts:136-145`); com A≈0,15 viram ~48 ms > 30 ms → **dispara**. Três desfechos possíveis conforme a amplitude/postura reais:

1. Bounce moderado (vale ≤0,03 por ≥160 ms no fundo do ciclo): arma e funciona — o jogo detecta o salto na subida.
2. Bounce na faixa (pico ≥0,08 com velocidade): **salto falso a cada ciclo** (até ~2,5/s pelo refratário de 400 ms) — o corredor "pula" sozinho e limpa obstáculos de graça.
3. Bounce alto no vale (nunca ≤0,03 por 160 ms): se um salto falso ou real trancar `airborne`, ele **nunca libera** enquanto correr → saltos subsequentes mortos (`!this.airborne` em `:41`).

A calibração agravada: correndo, a postura média é mais baixa (joelhos flexionados) → média de `rise` fica negativa, o que ajuda (afasta do limiar); mas `torsoHeight` encolhe na mesma proporção → o `rise` normalizado infla → empurra de volta. Efeito líquido não medido. A deriva de baseline ao mudar de distância da câmera já era problema conhecido no relatório anterior (`reports/Correções da cinemática de pose.md`: "Nenhuma variante resolve deriva da linha de base").

**Impacto.** Pular *enquanto corre* é o gesto obrigatório — não existe opção de andar pelo obstáculo. Se cair no caso 2 ou 3, o jogo quebra de forma visível (pulo fantasma) ou invisível (pulo ignorado). É a maior incógnita de gameplay deste merge.

**Direção de correção:** medir o sinal real primeiro (logar `rise` filtrado durante 10 s de marcha + saltos — não há número publicado para o modelo Lite). Caminhos prováveis: referência adaptativa (baseline = mediana móvel do quadril), subtrair a componente periódica no ritmo medido pelo `CadenceTracker`, ou exigir subida com **ambos** os joelhos baixos (salto real levanta as duas pernas). A faixa 0,05→0,15 merece varredura em teste sintético antes do hardware.

### 3. Um frame ruim zera o corredor — stop-on-degraded vira engasgo crônico

**O que é.** Qualquer estado não-`tracked` da portaria da cadência emite imediatamente `sprint {speed01: 0}` uma vez (`actionPipeline.ts:47-50`, latch `sprinting` em `:20,45,87-91`). É contrato: `ContinuousControls.sprintSpeed01` é "Always neutral when cadence tracking is degraded or lost" (`protocol.ts:89-90`) e o teste o fixa (`kinematics.test.ts:415-417`). O jogo recebe `speed01=0` e `shownSpeed` decai τ≈167 ms (`TrackGame.ts:104`) — um dip de 33 ms derruba a velocidade exibida ~45% e a recuperação leva mais ~300–500 ms (3 frames bons para rearmar o portão + nova subida do ease).

**Por que dói neste jogo.** Os landmarks exigidos são quadris+joelhos (25,26) — justamente os mais afetados por motion blur durante passada rápida (a velocidade angular do joelho é máxima exatamente quando o jogador corre mais). Cada piscada de confiança → micro-parada; em dispositivo lento o portão leva 3 frames a ~143–200 ms cada para recuperar → ciclos para-anda de ~0,4–0,9 s. Combinado com o achado #1, é o efeito "corredor engasgado" no hardware que mais precisa dele.

**Direção de correção:** o contrato pode ficar — a graça pode ir no jogo: `TrackGame` pode ignorar `sprint{0}` marcado `degraded` (evento já carrega `trackingState`, `protocol.ts:111`) ou aplicar histerese curta (ex.: só zerar após ~300 ms de neutralidade), preservando o stop garantido em `lost`. Alternativa no pipeline: emitir o stop só em `lost` (4 frames ruins seguidos ≈ ≥132 ms) e deixar `degraded` congelar a última velocidade — muda o contrato escrito, decisão de produto.

### 4. Partida e parada ~2–3× mais lentas que a meta de latência que o próprio PR cita

**O que é.** `CadenceTracker` mede frequência só **entre eventos de passo completos**: precisa de 2 cruzamentos de limiar (um intervalo) para o primeiro `speed01>0` (`cadenceTracker.ts:59-69`); e declara parada em `min(1,6·período, 1600 ms)` (`:13-14,69`).

- **Partida**: primeiro evento no meio da primeira subida de joelho + um período → ~0,6–1,0 s físico + ~0,1–0,2 s de pipeline ≈ **0,7–1,3 s até o avatar andar**.
- **Parada**: ~0,5 s (a 190 spm) a 1,6 s (≤60 spm — aí o teto `MAX_STOP_DELAY_MS` governa), mais o ease visual.

**Referência primária — GUD WIP (PMC4303911, Wendt/Whitton/Brooks, IEEE VR 2010):** o sistema que o PR #6 cita para "start and stop latency goals" (a) estima frequência **com frações de um passo** — cada estado do ciclo de marcha completado atualiza a estimativa, 3 atualizações por passo; (b) detecta parada por estado de duplo-suporte que excede a duração prevista, parando **~500 ms após o último passo** (limiar 0,8 Hz); (c) identifica Foot Off por limiar de posição **e** velocidade combinados (0,02 m + 0,5 m/s) — o que o torna tolerante a manobras. O tracker atual é só posição+Schmitt: equivalente ao LLCM-WIP que o GUD WIP veio superar, com a graça do decaimento contínuo via `elapsed` — que já implementa metade da ideia (a velocidade murcha antes do stop binário → a parada é *percebida* antes de `1,6·período`).

**Impacto:** parada ~2–3× mais lenta que o alvo citado; partida ~1 período mais lenta que o alcançável com estimativa por fração de passo. Aceitável para arcade, mas é a diferença entre "responsivo" e "molenga" na primeira impressão.

**Direção de correção:** incorporar a ideia GUD WIP sem reescrever — usar a duração da *subida* do joelho (tempo entre cruzamento on e off) para prever a frequência no primeiro passo; para parada, reduzir `STOP_AFTER_PERIODS`/`MAX_STOP_DELAY_MS` ou detectar "duplo suporte prolongado" (as duas subidas ≤0,05 por >~duração prevista do estado) — já há `needsNeutral` medindo exatamente isso para armar.

### 5. Janela de salto × latência ponta a ponta — a física do gesto precisa antecipar o pipeline

**Orçamento de latência fóton→estado-do-jogo (componentes e fontes):**

| Estágio | Estimativa | Fonte |
|---|---|---|
| fóton→apresentação (sensor/ISP/gUM) | ~30–80 ms | não medido neste projeto; instrumento correto = `metadata.captureTime` (spec WICG: SHOULD para gUM) — hoje ignorado (`poseClient.ts:71` usa só `now`) |
| apresentação→callback rVFC | 0–1 vsync (até ~17 ms) | spec: "callback can occasionally be fired one v-sync late"; sob carga pode pular frames (`presentedFrames`) |
| `createImageBitmap` | ~1–4 ms | auditoria anterior; ~0,05 ms medido a partir de canvas (pesquisa §7.5) |
| postMessage ida+volta | ~1 ms | desprezível |
| `detectForVideo` | ~16–21 ms CPU medido / ~5–25 GPU real / ~96–243 GL-software | pesquisa §7.5 (Chromium 159 headless); model card ~20–23 ms Pixel 3 |
| dispatch→estado→render | 0–17 ms | task síncrono + próximo `setAnimationLoop` tick |
| **Total** | **~60–150 ms típico; ~300–500 ms no pior caso GL-software** | |

Os timestamps internos (`snapshot.timestampMs` = `now` do rVFC, `poseClient.ts:71-74,173`) medem a **apresentação** — relógio uniforme e monotônico (o clamp `lastTimestamp+0,01` garante a exigência do modo VIDEO de timestamps crescentes — ai.google.dev, "monotonic timestamps"). Intervalos medidos nele (período de passo, velocidades) são **não enviesados** — o atraso constante cancela. O que chega atrasado é só a *aplicação* do evento: o jogo não usa `event.timestampMs` para temporizar nada — aplica na chegada (`TrackGame.ts:86-90`).

**Consequência para o salto.** O obstáculo é limpo se `jumpTime > 0,15` **ou** `y > 0,45` no cruzamento (`TrackGame.ts:128-132`). Com o arco de 0,72 s/1,35 u: `y>0,45` cobre 78–642 ms após o evento; `jumpTime>0,15` cobre <570 ms → **união = evento aplicado até ~642 ms antes do cruzamento**. Com Δ≈60–150 ms de latência, o take-off físico tem que acontecer ~490–580 ms antes do obstáculo chegar — a ~11–13 u de distância no ritmo máximo (22 u/s), ou seja, "quando o obstáculo está a meio caminho". Pular antes de ~650 ms falha (arco já desceu — o salto é fixo, saltar mais alto de verdade não estica o arco). Jogável, mas exige antecipação que o feedback na tela não ensina: o jogador lê o arco atrasado ~0,1–0,2 s do próprio corpo.

**Paridade quebrada:** teclado aplica `jumpTime=0,72` instantâneo (`TrackGame.ts:95`) — a janela física é ~640 ms mais o que quiser — vs ~500 ms úteis pela câmera. Idem raia (±1 imediato vs. cruzar limiar + cooldown 350 ms + pipeline).

**Direção de correção:** medir `captureTime` quando a telemetria voltar; se a janela ficar curta em hardware real, alargar por design (verificar cruzamento `z>0,2` contra uma janela de salto de ~0,9 s, ou antecipar o obstáculo pela velocidade atual) — não alongar o arco, que já é generoso.

### 6. Referência de vertical instável durante a marcha → ruído na inclinação de raia

**O que é.** `torsoLeanRad` mede a inclinação lateral contra a vertical **estimada pelas pernas** — `hip_mid − knee_mid` (`bodyFrame.ts:79-89`), caindo para `torsoUp0` calibrado quando joelhos fora de vista/confiança (<0,55 ou span <0,1). Limiares: dispara a ≥0,15 rad, rearma a ≤0,1, cooldown 350 ms (`postureSignals.ts:19-28`).

**O risco.** Marchando, os joelhos alternam subida: o ponto médio dos joelhos sobe e desloca lateralmente a cada passo → a "vertical" pendula aproximadamente `atan(Δx_joelho_med/span)` ~7–12° (~0,12–0,2 rad) no ritmo do passo — na borda do limiar 0,15 rad. O resultado pode ser: histerese mastigada sem disparo (ok), disparo falso limitado a ~3 trocas/s pelo cooldown, ou nada — depende de amplitudes reais não medidas. A suíte **nunca exercita isso**: a fixture mantém `world[25]/[26]` fixos (`tests/fixtures/syntheticPose.ts:44-45`) — os testes de marcha (`pace.test.ts:19`) só movem landmarks de *imagem*. Os testes de raia usam tronco estático ou giro de yaw (`kinematics.test.ts:292-372`).

**Direção de correção:** média móvel curta da referência (ou travá-la durante `cadenceSpm > 0`); teste sintético com joelhos-mundo alternando.

### 7. Portão de calibração: corpo inteiro + 4 s parado, para um jogo que só precisa de quadris e joelhos

**O que é.** `AutoCalibrator` exige `[11,12,15,16,23,24,25,26]` todos ≥0,55 (`autoCalibrator.ts:10,22`), ~1 s de assentamento + 3 s de coleta, ancora-se em ombros+quadris parados a ≤0,04 (`:8,33`). Falha de qualidade → volta a `framing` e tenta de novo sem mensagem específica (`:46-48`). A orientação na UI já pede "dos ombros aos joelhos, com as mãos visíveis" (`CameraPip.tsx:17`) — necessidade do **tênis** (punhos) imposta à **corrida**.

**Impacto:** espaço pequeno, pessoa alta ou câmera baixa sem joelhos no quadro → `framing`/`settling` eterno e o jogo da corrida — que só usa cadência (quadris+joelhos) e salto (quadris) — fica injogável por exigência alheia. Dispositivo em ~7 poses/s (achado #1) ainda consegue calibrar (12 amostras/2,8 s são folgados), mas cada reinício de âncora custa os mesmos 4 s.

**Direção de correção:** requisitos por modalidade (corrida: 23–26 apenas); mensagem de recalibração orientada quando `finish` retorna null (razão: span/amostras/qualidade).

### 8. Cegueira operacional — a degradação é invisível para quem joga e para quem depura

**O que é.** Nenhum canal sobrevive para medir saúde do CV: `inferenceMs`/`receivedAtMs`/`frameId` foram removidos do protocolo (auditoria anterior os listava como código morto — agora nem transportados); `kinematicsMs` e `controls` são computados e descartados (`actionPipeline.ts:23,76`, `App.tsx:84-95`); `metadata.presentedFrames`/`captureTime` do rVFC ignorados (`poseClient.ts:71`); HUD mostra só `RITMO %` (`GameCanvas.tsx:55`).

**Impacto:** o sintoma visível de todos os achados acima — cadência truncada, dips de portão — é indistinguível de "a pessoa parou de se mexer". Nenhuma telemetria local para o usuário ("sinal fraco") nem para o desenvolvedor (console/métricas).

**Direção de correção:** painel mínimo de debug (poses/s, delegate, ms/frame, trackingState por feature) atrás de flag; ou chip "sinal fraco" quando poses/s < ~20 ou dips de portão frequentes.

---

## Descartados ou menores

- **GameLoop/passos fixos** — correto para eventos assíncronos: eventos são escritas de estado, aplicados no próximo substep; acumulador limitado a 0,1 s e 5 substeps (`GameLoop.ts:46-56`) já auditado e mantém o veredito. A chegada de eventos a ~poses/s variável não acopla mal com o passo 1/60.
- **HUD/React** — 5 Hz com comparação de string (`TrackGame.ts:145-151`); `setTracking` por frame mas bail-out por `Object.is` — veredito da auditoria anterior mantido.
- **`stridePhase` segue a cadência medida** (`TrackGame.ts:114`) — cada perna oscila a spm/120 Hz, em fase com os passos reais — detalhe elegante do PR #6, sem custo.
- **Easing `shownSpeed` τ≈167 ms** — soma ~300 ms à percepção de mudança de velocidade; escolha de suavização, compõe (não causa) a latência do #4.
- **Obstáculo fora da raia vale +100** (`TrackGame.ts:130`) — ~2/3 dos obstáculos são pontos grátis se o jogador só correr reto; balanceamento a revisitar, não gargalo.
- **Checagem de cruzamento em `z>0,2` com corredor em `z=1,4`** (`TrackGame.ts:73,128`) — o "passe" registra ~55 ms antes do alinhamento visual a 22 u/s. Cosmético.
- **Teclado sem áudio** — `onKey` muta estado direto, sem `dispatchEvent` → salto por tecla não toca `audio.jump()` (`App.tsx:44-49`, `TrackGame.ts:92-101`). Inconsistência mínima.
- **Spawn/despawn de obstáculos** — geometrias/materiais novos por spawn, liberados por `disposeObjectTree` no despawn (`TrackGame.ts:78-84,134-138`) — correto.
- **Timestamp de apresentação vs captura** — já analisado no orçamento do achado 5: enviesa só latência absoluta, não intervalos.
- **Primeiro frame quente** — spike de primeira inferência (~142 ms CPU / ~2 s GL-software, pesquisa §7.5) cai dentro da janela de calibração de 4 s — absorvido.
- **Score por `advance`** — bug de arredondamento do relatório anterior resolvido por `trackScore.ts:6` (fracional acumulado) + `trackScore.test.ts`.

---

## Onde estamos — avaliação honesta

**Funciona (verificado em código/testes):** pipeline CV viva e quente (worker persistente, init paralelo, assets imutáveis); portões por feature com confiança por evento; inclinação de raia geométrica em espaço de mundo com testes de yaw/tilt; cadência contínua com parada proporcional ao período — a mecânica "o corredor anda no seu ritmo" está implementada e 79 testes passam sobre fixtures sintéticas.

**O gargalo nº 1 da corrida** é o achado #1: a taxa de poses é o teto físico da cadência medida, e o pior caso real medido (GPU-delegate sobre GL de software ~5–10 fps, sem fallback) deixa o jogo no regime onde nem "correr" é detectável — tudo isso sem indicador visível. A correção priorizada é barata (detectar GL de software + fallback por latência) e já estava prescrita na pesquisa §7.5.

**O gargalo nº 2 é de verificação**: salto-durante-corrida (achado #2) e raia-durante-marcha (achado #6) são as interações que definem o jogo, e nenhuma foi medida fora de sintéticos — a suíte cobre o bob de 0,05 mas não a faixa 0,1–0,15 onde mora a oscilação real de corrida. O PR #6 diz isso na lata: "Not yet verified with a real person walking or running in front of a webcam".

**Prioridade prática:** (1) fallback por latência/GL-software; (2) logar sinais (`rise`, `lift`, poses/s) numa sessão com câmera real; (3) decidir a graça de `degraded` para a cadência (#3); (4) depois ajustar limiares com dados, não com literatura.

---

## Perguntas em aberto / não verificado

- **`dominantHand` fixo vs. detecção dupla de punho** — a divergência de merge real: `feat/camera-auto-calibration` original guardava **os dois** punhos (`readyWristLocal: Record<Hand, Point3>`) e instanciava um `SwingDetector` por braço ("whichever arm swings is the racket hand", `git show eedb6c0:src/kinematics/actionPipeline.ts`); o merge adotou o formato do PR #5 (um `dominantHand` único) e o `AutoCalibrator` ficou chamando `calibrator.finish('right')` (`autoCalibrator.ts:46`) — canhotos recebem o perfil errado de swing e a capacidade de detecção automática da mão se perdeu. Decisão pendente: restaurar `Record<Hand>`+dois detectores, ou detectar mão dominante na calibração, ou manter seletor manual.
- **Amplitude real do sinal de joelho/quadril em marcha** para o modelo Lite a 640 px — decide os achados #2 e #6; nenhum número publicado; medir.
- **`rise` durante corrida real** — os três desfechos do achado #2 dependem de amplitude e postura média não medidas.
- **Sinal/limiar de raia sob marcha real** — a wobble de `legsVertical` (achado #6) e o sinal `delta<0 → 'left'` (`postureSignals.ts:23`) foram provados só em fixture de mundo; relatório anterior já flagrara inversão histórica de lado — checar na câmera: inclinar à direita move o corredor à direita da tela.
- **Poses/s em hardware representativo real** (GPU integrada, blocklists, mobile) — só o caso SwiftShader/local foi medido.
- **Latência fóton→ação real** — precisa de `captureTime`; ~60–150 ms é a faixa estimada, não medida.
- **Se a graça de `degraded` deve viver no pipeline (mudar o contrato `protocol.ts:89-90`) ou no jogo (ignorar sprint-0 `degraded`)** — decisão de produto (achado #3).
- **Cadência "no lugar" vs. esteira** — os anchors 100/130/137,5/200 vêm de marcha em esteira (CADENCE-Adults, WRT); para passada no lugar a referência primária mais próxima é "ritmo moderado ≈100–120 spm com o pé subindo 15–20 cm" (estudos de TV-commercial-stepping) — o mapa `SPEED_BY_CADENCE` provavelmente precisa de calibração própria.
- **`presentedFrames`** — drops de apresentação sob carga não são contados em lugar nenhum.

---

## Fontes

**Código (citações `path:line` nesta árvore mergeada):** `src/App.tsx`, `src/cv/{poseClient,pose.worker,protocol,calibrator,autoCalibrator,oneEuroFilter,mediapipeAssets}.ts`, `src/kinematics/{actionPipeline,cadenceTracker,jumpDetector,postureSignals,trackingGate,schmittTrigger,bodyFrame,swingDetector,math}.ts`, `src/games/{core/GameLoop,track/{TrackGame,gait,trackScore},audio}.ts`, `src/ui/{GameCanvas,CameraPip,PoseOverlay}.{tsx,ts}`, `tests/{pace,trackScore,kinematics,poseClient}.test.ts`, `tests/fixtures/syntheticPose.ts`, `vercel.json`. Histórico de merge: `git show 266e042` (PR #6), `git show eedb6c0` (auto-calibração pré-merge, formato duplo de punho), `git show 17b6fed` (resolução). Corpos dos PRs #5 e #6 no GitHub (`gh pr view`) — incluindo o "Known limit" do autor sobre 15 fps e a nota "controls sem consumidor" do PR #5.

**Documentos internos lidos:** `docs/analise-de-gargalos.md` (auditoria do pipeline; itens #1–#6 resolvidos neste merge, #7 citado como teto), `docs/pesquisa-pipeline-cv.md` (§7.5 benchmark medido: CPU ~16–21 ms ≈ 48–62 poses/s, GL-software ~96–243 ms ≈ 5–10 fps sem fallback; §2.2 VideoFrame; §6 metadata), `reports/Correções da cinemática de pose.md` (deriva de baseline do salto; inversão histórica de lado de raia), `research_notes/Modularização do Wii Web Sports Arena/{pose_pipeline,game_architecture}.md`.

**Fontes primárias externas:**
- https://ai.google.dev/mediapipe/solutions/vision/pose_landmarker — modo VIDEO síncrono, timestamps monotônicos, padrão livestream "latest frame" (o adotado aqui).
- https://huggingface.co/litert-community/MediaPipe-PoseLandmarker-Lite — model card: ~44 FPS CPU / ~49 FPS GPU num Pixel 3; SHA-256 `59929e1d…574a` bate com `public/mediapipe/models/SHA256SUMS`.
- https://wicg.github.io/video-rvfc/ — semântica do rVFC: callback nos rendering steps antes do rAF, "fired one v-sync late" possível, `captureTime` SHOULD para gUM, `presentedFrames` monotônico.
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback — metadados e taxa min(fps do vídeo, refresh).
- https://pmc.ncbi.nlm.nih.gov/articles/PMC6337834/ — CADENCE-Adults (Tudor-Locke et al. 2019): 76 adultos em **esteira**; heurística 100 spm = 3 METs, 130 spm = 6 METs.
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10526715/ — Chase et al. 2023: transição andar→correr por cadência, faixa heurística 135–140 spm, **esteira** (base dos limiares 0,55/0,5 em `gait.ts` e do anchor 137,5).
- https://pmc.ncbi.nlm.nih.gov/articles/PMC4303911/ — GUD WIP (Wendt/Whitton/Brooks, IEEE VR 2010): walking-in-place orientado a ciclo de marcha; para ~500 ms após o último passo (limiar 0,8 Hz); estima frequência a cada estado completado (3×/passo); Foot Off por posição **+** velocidade (0,02 m, 0,5 m/s).
- https://journals.lww.com/acsm-msse/Fulltext/2012/02000/Energy_Cost_of_Stepping_in_Place_while_Watching.20.aspx e https://pmc.ncbi.nlm.nih.gov/articles/PMC3487755/ — Steeves/Thompson/Bassett: passada no lugar como atividade; "ritmo moderado" definido como 100–120 spm com pé subindo ~15–20 cm — referência mais próxima do gesto real do jogo.
- https://doi.org/10.1249/01.mss.0001061236.55291.a0 — oscilação vertical do CoM correndo: 9,0–9,3 ± ~1,5 cm, faixa 6,5–13,1 cm (markerless mocap, esteira).
- https://pubmed.ncbi.nlm.nih.gov/19356933/ — ponto único no sacro estima deslocamento vertical do CoM correndo (discrepância sistemática 0–1,5 mm).
- https://hal.inria.fr/hal-00670496 — Casiez, Roussel, Vogel, "1€ Filter" (CHI 2012) — o filtro implementado em `src/cv/oneEuroFilter.ts`.
- `node_modules/@mediapipe/tasks-vision/vision.d.ts` (v1.2.3) — `detectForVideo(ImageSource, timestamp)`, `forVisionTasks(basePath, useModule)` (`:522,819,1308`).
