<div align="center">

<img src="assets/caution-tape.svg" alt="Wii Web Sports" width="720" />

# Wii Web Sports Arena

**Seu corpo é o controle.** Uma arena arcade no navegador com corrida de obstáculos e tênis, controlada por pose via webcam.

</div>

## Requisitos

- Node.js 24 LTS e npm 11 ou compatível.
- Navegador desktop moderno (Chrome, Edge ou Firefox) com câmera e WebGL 2; publicação e uso da câmera exigem HTTPS (localhost funciona em desenvolvimento).
- Câmera enquadrando cabeça e torso até o quadril. Pernas e pés são opcionais; para tênis, pelo menos uma mão visível melhora a referência da raquetada.

## Desenvolvimento

```bash
npm ci
npm run dev
```

O servidor local imprime a URL de desenvolvimento. A primeira ação **Ativar câmera** solicita permissão. Não há etapa manual de calibração: corrida e salto entram assim que o torso é rastreado, enquanto escala corporal, postura neutra e referências das mãos convergem continuamente em segundo plano conforme você joga. A mão da raquete é detectada pelo movimento. Se a câmera não estiver disponível, setas e espaço continuam funcionando.

```bash
npm test
npm run build
npm run preview
npm run lint
```

### Site e jogo

O website abre em `/`, com páginas em `/vision`, `/papers` e `/product`. A área `/app` usa o Wii de `santleme/wii`: a mesma implementação de câmera, calibração, corrida e tênis em `src/App.tsx`, `src/games` e `packages/core`. O link **sair** volta para o site e desmonta a arena.

Tudo usa o `package.json` e o lockfile da raiz. `npm run dev` e `npm run build` servem o site e o jogo juntos; depois do build, execute `npm run check:articles` para conferir os artigos e figuras. O workflow `.github/workflows/ci.yml` verifica essa integração.

O build copia a variante module do WASM do MediaPipe fixado no lockfile para `public/mediapipe/wasm-<versão>/` e verifica o SHA-256 dos modelos locais — servido com o hash no nome — antes de compilar. Os ativos de `mediapipe/` e `assets/` são servidos com `Cache-Control: immutable` (ver `vercel.json`).

## Arquitetura

- `src/app/`, `src/pages/`, `src/components/`: rotas e interface do website; `ArenaShell` monta o jogo em `/app`.
- `docs/research/`: artigos e figuras PT/EN; regras visuais em `docs/website-design.md`.
- `packages/core/` (`@wii/spatial-core`): pacote headless de percepção — Worker do Pose Landmarker (variante WASM module, `useModule`), cliente de captura com um frame em trânsito que mantém o worker quente entre liga/desliga, protocolos, filtro 1-Euro e replay de pose.
- `src/cv/`: fiação fina sobre o core (URLs padrão dos ativos locais, aquecimento) e a auto-calibração online contínua.
- `src/kinematics/`: histerese, gating de confiança e detectores puros sobre o filtro 1-Euro do core.
- `src/games/`: loop fixo Three.js e cenas arcade desacopladas da câmera.
- `src/ui/`: canvas do jogo em tela cheia, seletor de modalidade e PiP da câmera.
- `tests/`: fixtures sintéticas e testes determinísticos dos detectores.

O vídeo é processado no dispositivo e não é enviado ao servidor do jogo. O MediaPipe informa que pode enviar métricas de desempenho e utilização da API ao Google; o aviso aparece no PiP da câmera. O app usa a variante Lite do Pose Landmarker, hospedada localmente com o app; os modelos Full de pose e de mão também são versionados e verificados, para o pacote `@wii/spatial-core`. Consulte [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Deploy

No Vercel, use a raiz do repositório como Root Directory, `npm run build` como build e `dist` como saída. O `vercel.json` mantém as rotas do site funcionando em acessos diretos. Com o Vercel CLI autenticado, execute `npx vercel --prod`. O projeto usa `dist/` como saída estática; a URL HTTPS resultante permite o acesso à webcam sem instalação. O comando de build verifica a versão e o SHA-256 do modelo e publica também os arquivos WASM locais.

## Controles

| Ação | Webcam | Teclado |
| --- | --- | --- |
| Correr | Ande ou corra no lugar | Seta para baixo alterna andar / correr / parar |
| Pular | Salto vertical | Espaço ou seta para cima |
| Trocar de raia | Incline o tronco | Setas esquerda/direita |
| Bater no tênis | Raquetada dominante | Espaço |

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/credits-dark.png?v=2" />
  <img src="assets/credits-light.png?v=2" alt="Design: Gustavo Moreira e Lucas Coimbra" width="640" />
</picture>
</div>
