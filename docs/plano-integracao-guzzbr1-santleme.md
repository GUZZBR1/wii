# Plano de integração: website GUZZBR1 + Nevergear do Santleme

## Escopo confirmado

Manter o website neste repositório e usar o Nevergear atual de `santleme/wii` na área `/app`. Preservar as páginas e o conteúdo do site. A arena usa `src/App.tsx`, `src/games`, `src/cv` e `packages/core`; não haverá uma segunda engine dentro de `site/`.

## Execução

1. **Atualizar upstream — concluído.** O fetch confirmou `19c2980`, incluindo o PR #26 (fallback de CPU do MediaPipe). O `main` local e o do fork foram sincronizados por fast-forward.
2. **Incorporar corrida — concluído na branch de integração.** O trabalho do PR #24 está incluído, preservando moedas, countdown, pausa por tracking, ranking e restart, junto do tênis do PR #23. O histórico foi mantido por merge, sem reescrever os commits publicados.
3. **Ligar site ao jogo — concluído na branch de integração.** O website foi movido para o app da raiz. A rota `/app` carrega a arena original por `ArenaShell`; a saída volta ao site e desmonta o jogo. A cópia de engine/testes em `site/` foi removida. Câmera, workers e jogos continuam com seus donos originais; apenas o CSS da arena foi isolado para não afetar as outras rotas.
4. **Consolidar build e deploy — concluído na branch de integração.** Um `package.json`, lockfile, workflow e `dist` atendem website e arena. Vercel usa a raiz e reescreve acessos diretos às rotas do site, preservando os caminhos de ativos.
5. **Verificar — concluído; publicação em andamento.** Rodar `npm test`, `npm run lint`, `npm run build` e `npm run check:articles`; atualizar o PR #25 com a implementação final e a evidência.
6. **Limpar branches — após merge no destino.** Preservar branches e worktrees com alterações não incorporadas. Não excluir as branches dos PRs enquanto estiverem abertos.

## Evidência e limites

- 369 testes passaram com paralelismo limitado a dois workers, evitando timeouts por concorrência no ambiente local.
- Build e integridade dos cinco artigos PT, cinco EN e figuras passaram.
- Smoke test em Chromium: rotas diretas, site → jogo → site, corrida/tênis pelo teclado, largura de 320 px, câmera simulada encerrada na saída e stream de permissão atrasada descartado. Nenhum erro JavaScript; estilos do body iguais antes e depois da arena.
- Webcam física não foi exercitada; o teste de câmera usa stream sintético e worker simulado.
- Builds mantêm o aviso de chunks grandes; o CSS existente do website tem avisos de lint sobre especificidade e `!important`.
- Direitos de imagens mantêm as pendências registradas em `public/images/archive/SOURCES.md`.
- Publicar o PR não significa merge ou deploy em produção. A conta tem acesso somente de leitura ao upstream; a integração no `main` dele depende do mantenedor.
