# Progresso da refatoração arquitetural

Este é o registro vivo das rodadas de melhoria arquitetural solicitadas para o produto. O trabalho preserva o comportamento e os contratos existentes, migra os chamadores no mesmo lote e remove a implementação substituída quando a compatibilidade permite.

## Estado da iniciativa

- **Base de implementação desta rodada:** `origin/main` em `799abca` (`refactor/canonical-frame-capture`, worktree isolada).
- **Levantamento do estado ativo:** PR42 em `98ea424`; usado para localizar mudanças recentes e worktrees em andamento, sem copiar arquivos locais não revisados.
- **Estado do checkout compartilhado:** alterações locais fora desta worktree são preservadas e não fazem parte desta rodada.
- **Skills aplicadas:** `codebase-design` e `domain-modeling`.
- **Glossário/ADRs anteriores:** não existem nesta base. Criar o glossário quando um termo de domínio precisar ser resolvido; registrar decisões arquiteturais com trade-offs duradouros em `docs/adr/`.

## Mapa de arquitetura — base `origin/main`

### Fluxo principal

```mermaid
flowchart LR
  Browser[Browser: webcam, storage, DOM] --> Site[src/main.tsx + src/app/App.tsx]
  Site --> ArenaShell[src/components/ArenaShell.tsx]
  ArenaShell --> Arena[src/App.tsx: camera and game orchestration]
  Arena --> AppAdapters[src/cv: local assets and browser adapters]
  AppAdapters --> Core[@wii/spatial-core]
  Core --> Workers[Pose and hand module Workers]
  Workers --> MediaPipe[Local MediaPipe WASM and task models]
  Core --> Snapshots[PoseSnapshot / HandSnapshot]
  Arena --> Calibration[src/cv/adaptiveCalibrator.ts]
  Snapshots --> Kinematics[src/kinematics: pure detectors]
  Kinematics --> Events[SportActionEvent / ContinuousControls]
  Events --> GameCanvas[src/ui/GameCanvas.tsx]
  GameCanvas --> Games[src/games: Track and Tennis]
  Games --> Loop[src/games/core/GameLoop.ts]
```

`src/app/App.tsx` is the website router and page shell; `src/App.tsx` is the camera and arena coordinator. The similar names describe separate modules and are an ongoing source of navigation cost.

### Modules and ownership

| State or rule | Current owner | Readers and important constraints |
| --- | --- | --- |
| Camera stream, UI mode, camera attempt | `src/App.tsx` | Starts/stops the browser stream and chooses hand or pose capture. Attempt and mode refs invalidate late async work. |
| Pose worker, request IDs, capture epoch | `packages/core/src/providers/poseClient.ts` | Owns the pose Worker, frame correlation, capture callbacks and pose protocol. `VideoFramePump` owns scheduling and single-flight; the pose bitmap is transferred to the worker. |
| Hand worker, capture and in-flight frame | `packages/core/src/providers/handClient.ts` | Owns the hand Worker, worker request correlation, resizing and live capture. `processFrame` closes rejected bitmaps and transfers accepted ones; the shared pump owns scheduling and single-flight. |
| App hand adapter | `src/cv/handClient.ts` | Supplies versioned local asset URLs and asset warming. It no longer implements a second capture scheduler. |
| Alternate provider switching | `packages/core/src/runtime/spatialRuntime.ts` | Owns a provider generation. It delegates live capture to providers that support it; processFrame-only adapters use the shared pump. It is exported and tested, but no production caller was found. |
| Calibration and action history | `src/App.tsx`, `src/cv/adaptiveCalibrator.ts`, `src/kinematics/*` | The coordinator owns long-lived instances; pure detectors own their local filters and timing windows. `adaptiveCalibrator.ts` consumes kinematics helpers; the reverse type dependency was removed in round 2 by importing contracts from `@wii/spatial-core`. |
| Three.js renderer and fixed-step clock | `src/games/core/GameLoop.ts` | Game instances own their scene objects and dispose them through shared helpers. |
| Rules and match state | `src/games/track/*`, `src/games/tennis/*` | Pure rules have direct deterministic tests; rendering is owned by each game class. |
| Website and menu state | React modules under `src/app`, `src/components`, `src/pages`, `src/ui` | Local UI state stays in React. The language provider owns selected language. |
| Browser persistence | `src/lib/quality.ts`, `src/App.tsx`, `src/i18n.tsx`, `src/components/SiteHeader.tsx`, legacy `TrackGame.ts` | Local storage holds quality preference, mute, language, theme and obstacle-course records. There is no server-side user store. |

### Contracts, infrastructure, and production constraints

- There is no backend API, authentication service, or remote application data store. The product deploys as static Vite assets; browser permission controls camera access.
- Worker messages and `PoseSnapshot`/`HandSnapshot` types live in `packages/core/src/providers/` and `packages/core/src/types.ts`. `src/cv/protocol.ts` is a one-line re-export used by many app modules; it does not define a competing protocol.
- `src/cv/mediapipeAssets.ts` pins local model hashes and the WASM version. App adapters construct versioned local URLs and warm assets. The workers fetch the local model files; video frames stay on-device.
- `vite.config.ts` maps `@wii/spatial-core` to source in app/dev mode. Tests resolve the built workspace package; `pretest` builds it first. This is intentional and verified by the workspace/package setup.
- The browser-facing errors include camera acquisition, worker initialization (30-second timeout), worker errors and GPU-to-CPU fallback. Site article failures are logged at the app error boundary. Developer CV recordings/replays live under `src/cv/diagnostics` and `scripts/`.
- CI (`.github/workflows/ci.yml`) runs `npm ci`, tests, Biome lint, production build and article validation. A scoped Biome override now enforces the purity/import direction of `src/kinematics`; other ownership and dependency rules remain in the backlog.
- There is no shared theme package: site and arena styling have separate CSS entry points. The design system and accessibility contracts remain to be audited before any visual consolidation.

## Rodada 1 — captura de quadros

### Checklist de estado e concorrência

| Item | Decisão/estado observado para a migração |
| --- | --- |
| Donos | `App` continua dono do `MediaStream` e da modalidade. Cada provider continua dono do Worker, dos IDs de requisição e do protocolo. O novo pump é dono apenas do agendamento e do backpressure de captura. `SpatialRuntime` continua dono da geração de provider. |
| Leitores/escritores | `PoseClient`, o adaptador de `HandClient` e `SpatialRuntime` iniciam/param captura. Apenas o pump registra/cancela rVFC/rAF e mantém o slot de processamento agendado. |
| Vida útil | Um pump vive com seu cliente ou runtime. `pauseCapture` cancela callbacks agendados; `dispose` também encerra o cliente/worker. Pausar e retomar no mesmo worker não zera a sequência temporal. |
| Buffers | O pump não cria nem retém `ImageBitmap`. O provider/adaptador cria a cópia, fecha-a se a sessão ficar obsoleta e transfere a propriedade ao Worker no `postMessage`; após transferência, o buffer não é mutável nem fechável pelo chamador. |
| Invalidação | O pump usa uma geração privada para callbacks de scheduler. `cameraAttemptRef`, `PoseClient.captureEpoch`, o contador de sessão da mão e `SpatialRuntime.generation` mantêm seus significados atuais; nenhum substitui os demais. |
| Ponto de commit | O frame é aceito pelo Worker quando `postMessage(FRAME, [bitmap])` retorna. O slot do pump só fica livre quando o resultado/erro desse frame foi resolvido ou quando o cliente é descartado. |
| Ordenação/progresso | Um frame em processamento por pump; não há fila. O próximo frame de vídeo é agendado, mas descartado enquanto o slot estiver ocupado. Erro de cópia/processamento reporta erro e libera o slot para quadros futuros. |
| Exceções | Falhas de `createImageBitmap` e de processamento chegam ao callback de erro. Erros fatais do Worker continuam sendo tratados pelo cliente. O pump não converte erro fatal em retry silencioso. |

### Trabalho e evidência

- [x] Linha de base determinística antes da migração: `npm test -- tests/poseClient.test.ts tests/handClient.test.ts tests/handCapture.test.ts tests/spatialRuntime.test.ts` — 4 arquivos, 17 testes passaram; os 5 testes de qualidade também passaram.
- [x] Revisão independente de três interfaces: captura pelo callback mínimo, pump genérico configurável e interface otimizada para o chamador comum.
- [x] Implementar o pump único e migrar os três caminhos de agendamento.
- [x] Preservar o método público `HandClient.processFrame` e o contrato de adaptadores de `SpatialRuntime` que só implementam `processFrame`.
- [x] Acrescentar testes determinísticos de backpressure, troca de sessão, fallback rAF, erros, pausa reentrante e lançamento síncrono.
- [x] Remover os loops duplicados já substituídos e revisar os chamadores pelo teste de exclusão; a busca confirmou que rVFC/rAF dos três caminhos agora aparece apenas no pump.
- [x] Executar suíte completa, lint e build; a revisão independente dos dois riscos encontrados foi concluída após as correções.

### Verificação e resultado

- Suíte completa com gravações locais existentes ligadas temporariamente à worktree (sem copiá-las): `npm test` — 54 arquivos, 440 testes aprovados; link removido depois da execução.
- Build de produção: `npm run build` — aprovado. Vite ainda informa o aviso preexistente de chunks acima de 500 kB.
- Lint: `npm run lint` — exit 0, com 28 avisos de CSS existentes. Os oito arquivos alterados passaram sem avisos em execução isolada do Biome.
- Artigos: `npm run check:articles` — aprovado (5 artigos PT, 5 EN e figuras no bundle).
- `git diff --check` — aprovado.
- Revisão independente encontrou e levou à correção de duas regressões: reentrância em `PoseClient.beginCapture` e fechamento de bitmap se um adaptador do runtime lança sincronamente. A segunda revisão não encontrou outros problemas concretos.

## Rodada 2 — limite de dependências da cinemática

### Mudança

- Os módulos de `src/kinematics` importam contratos de pose/calibração diretamente de `@wii/spatial-core`, removendo a dependência de tipos no re-export da camada `src/cv/protocol.ts` e, com ela, o ciclo de fonte com `src/cv/adaptiveCalibrator.ts`.
- Um override Biome aplicado somente a `src/kinematics/**` rejeita imports de CV/adapters, UI, jogos, páginas, React, Three.js e MediaPipe. Ele também bloqueia globais de DOM, vídeo, canvas, worker e animação.
- Imports do core são limitados a contratos de dados, `OneEuroFilter` e detectores puros já canônicos no pacote (como `RotationalFlickDetector`); o barrel misto não fica aberto para providers e runtime de browser.
- Imports internos proibidos usam padrões que cobrem profundidades diferentes. A regra também bloqueia leitura do relógio global: `kinematicsMs` não tinha consumidores e foi removido; `ActionPipeline.reset(timestampMs)` agora recebe o instante do coordenador.
- A regra usa os parsers AST do Biome já instalado e o lint que o CI executa; não foi adicionada dependência ou uma segunda ferramenta de verificação.

### Verificação

- [x] `npx biome lint src/kinematics` passou sem avisos.
- [x] Fixtures temporárias confirmaram que Three.js, imports relativos da CV em diretórios atuais e aninhados, jogos, globais DOM e o export `PoseClient` do core são rejeitados; as fixtures foram removidas.
- [x] Suíte completa com gravações locais existentes: `npm test` — 54 arquivos, 440 testes aprovados; links temporários removidos após os testes.
- [x] `npm run build` e `npm run check:articles` passaram; Biome passou com 28 avisos CSS existentes e nenhum aviso na pasta de cinemática; `git diff --check` passou.
- [x] Revisão independente confirmou os padrões aninhados, o relógio explícito e ausência de novos achados ou falsos positivos.

## Rodada 3 — erro fatal tardio dos Workers

### Invariantes de estado e ordenação

| Item | Decisão/estado observado |
| --- | --- |
| Donos | Cada `PoseClient`/`HandClient` possui seu Worker e estado `inFlight`; o Worker possui o Landmarker e decide quando a inferência/fallback deixou o Worker inutilizável. |
| Leitores/escritores | Os Workers enviam resposta de quadro e podem, depois, enviar o resultado da tentativa de fallback. Os clientes leem ambos na mesma fila de mensagens; uma resposta de quadro não encerra o ciclo de vida do Worker. |
| Vida útil | O Worker só é considerado atual quando ainda coincide com `this.worker`; `dispose()` invalida o cliente, fecha o worker e libera qualquer pedido ainda pendente. |
| Buffers | O bitmap é transferido no `postMessage(FRAME)` e fechado pelo Worker. Um erro posterior de fallback não devolve nem altera a posse do bitmap. |
| Invalidação | Erros recuperáveis continuam exigindo o pedido atual (`requestId` e `captureEpoch` para pose, `requestId` para mão). Erro fatal do Worker não é rejeitado por correlação de quadro, pois descreve a saúde global do Worker. |
| Ponto de commit | Receber erro fatal do Worker ainda ativo encerra o provider e reporta erro, mesmo se `POSE`/`HAND` já tiver liberado o quadro ou um quadro posterior estiver em voo. |
| Progresso | Ao encerrar, o cliente resolve o pedido pendente e interrompe captura; erros recuperáveis liberam somente o pedido correlacionado e deixam quadros futuros prosseguirem. |
| Exceções | A mensagem fatal preserva o status para a UI; o callback é capturado antes do `dispose()`, que limpa os callbacks internos. |

### Mudança e verificação

- O fallback por latência posta o resultado (`POSE`/`HAND`) e pode falhar depois ao inicializar CPU. A auditoria confirmou que os dois clientes descartavam o erro fatal atrasado por exigir que seu pedido ainda estivesse `inFlight`. Ao rebasear sobre a main atual, `PoseClient` já continha a invalidação do Worker ativo; essa semântica foi preservada e ganhou regressão explícita. `HandClient` ainda descartava o erro fatal atrasado.
- Foram adicionados testes determinísticos que primeiro reproduzem o resultado, iniciam outro quadro em voo e então entregam o erro fatal antigo. Ambos falhavam no pai original do lote; na main atual, o caso de pose já passa e o de mão exige a correção.
- `PoseClient` preserva o tratamento existente na main e sua nova regressão; `HandClient` agora trata erro fatal como condição do Worker ativo, liberando qualquer pedido restante. Erros não fatais mantêm a validação por ID/epoch.
- Os workers continuam com protocolos e configuração específicos. A auditoria não recomenda uma abstração genérica de Worker; a decisão de extrair somente a máquina de fallback fica pendente até comparar custos e transições.
- Suíte completa: 54 arquivos e 442 testes Vitest passaram; os cinco testes Node de qualidade também passaram. Os replays usaram somente os JSON locais existentes, ligados temporariamente e removidos do worktree após a execução.
- `npm run build`, `npm run check:articles`, `npx biome lint src/kinematics` e `git diff --check` passaram. `npm run lint` passou com 28 avisos CSS já existentes; nenhum aviso novo apareceu em kinematics.
- Revisão independente do caso com frame mais novo pendente não encontrou achados concretos.

## Ciclo de melhoria

Cada lote termina com código migrado, teste na interface apropriada, exclusão segura da implementação substituída, restrição contra regressão quando aplicável e commit próprio. A lista ordenada e as decisões pendentes ficam em [architecture-backlog.md](architecture-backlog.md); decisões que passem o critério ADR ficam em `docs/adr/`.
