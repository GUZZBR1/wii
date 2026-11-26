# Centro neutro sob histerese e sensibilidade projetiva — calibração online e normalização lateral

Data da pesquisa: novembro de 2026.
Escopo: controle de raia por deslocamento lateral do centro dos ombros em coordenadas de imagem, com centro neutro adaptativo. Complementa `docs/pesquisa-inclinacao-tronco.md` e `docs/auditoria-mediapipe.md`; não repete a auditoria do pipeline nem a análise completa de inclinação do tronco.

**Perguntas.**

- **A.** Quando o jogador está fora do centro, mas dentro da banda de histerese (`0.05 ≤ |u| < 0.12`), esse deslocamento é postura de repouso ou entrada de controle? É seguro usar o estado da zona de raia para admitir evidência de calibração?
- **B.** Qual denominador de normalização é mais robusto: largura projetada dos ombros em x, comprimento euclidiano da linha dos ombros, altura/comprimento do tronco, ou um híbrido? O limiar de entrada na raia deveria depender da orientação corporal projetada?

## 0. Relação com as notas existentes e correções de precisão

As notas anteriores já estabelecem o essencial sobre `worldLandmarks`: eles têm origem no ponto médio dos quadris, são estimados em metros a partir de ajustes GHUM, não formam um referencial fixo do mundo nem um referencial alinhado à gravidade, e sua profundidade é a componente mais fraca. Esta pesquisa confirma essas conclusões nas fontes primárias citadas abaixo.

Três precisões importantes:

1. **O sinal de z dos `worldLandmarks` não é documentado de forma consistente entre as superfícies oficiais.** A documentação do Pose Landmarker diz apenas que os world landmarks estão em metros com origem no quadril; para os landmarks normalizados, z menor significa mais próximo da câmera. Um mantenedor do MediaPipe afirmou na issue #4205 que a relação de z também valeria para world coordinates, com valores negativos entre quadril e câmera. Já o blog oficial do TensorFlow sobre BlazePose GHUM descreve `keypoints3D` com z positivo ao se aproximar da câmera. Pode haver diferença de wrapper/legado ou simplesmente inconsistência de documentação. **Não se deve depender do sinal de z sem verificação em runtime na API exata usada pelo app.** Fontes: [Pose Landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker), [issue #4205](https://github.com/google/mediapipe/issues/4205), [TensorFlow Blog — BlazePose GHUM](https://blog.tensorflow.org/2021/08/3d-pose-detection-with-mediapipe-blazepose-ghum-tfjs.html).

2. **Uma rotação puramente planar da linha dos ombros não "infla" o comprimento euclidiano real da linha.** Se uma linha rígida horizontal de comprimento `sW` gira por φ dentro do plano da imagem, suas componentes passam a ser `sW cos φ` em x e `sW sin φ` em y; o comprimento euclidiano permanece `sW`. O problema prático do `Math.hypot(dx, dy)` no código atual é outro: `x` e `y` dos landmarks foram normalizados separadamente por largura e altura da imagem, portanto `hypot` em coordenadas normalizadas mistura unidades diferentes e superpondera a componente vertical em frames de vídeo em paisagem. A documentação oficial diz explicitamente que x é normalizado pela largura e y pela altura. Fonte: [Pose Landmarker guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js). A matemática acima é derivação própria, não uma afirmação da literatura.

3. **`worldLandmarks` não medem deslocamento lateral do corpo no ambiente.** Como a origem é o centro do quadril a cada frame, um passo inteiro para o lado desloca quadril e origem juntos; a translação desaparece. O issue #5444 confirma que a origem muda frame a frame com o quadril. Portanto world landmarks não são substituto direto da coordenada de imagem para controle de raia por posição corporal. Fonte: [issue #5444](https://github.com/google-ai-edge/mediapipe/issues/5444).

---

# Parte A — postura de repouso versus entrada intencional durante calibração online

## A1. O que os sistemas de controle fazem em problemas análogos

### A1.1 IMUs: só estimar bias quando há evidência independente de repouso

A analogia mais forte é a estimativa de bias de giroscópio/acelerômetro em navegação inercial. Nesses sistemas, uma medida artificial de velocidade zero ou taxa angular zero só é aplicada quando um detector independente decide que o sensor está parado.

- O artigo **"Inertial Navigation Aiding by Stationary Updates"** resume o princípio: quando o veículo é conhecido como estacionário, medidas artificiais de velocidade zero e/ou taxa angular zero corrigem velocidade, atitude e biases da IMU; a implementação exige testes automáticos confiáveis para detectar os períodos estacionários. Fonte: [IEEE T-ITS, DOI 10.1109/TITS.2011.2168818](https://doi.org/10.1109/tits.2011.2168818).

- O filtro **VQF** implementa exatamente essa separação. Durante repouso, o bias do giroscópio é estimado diretamente das leituras filtradas; durante movimento, a atualização é menos confiável. O artigo descreve um único filtro de Kalman que executa atualizações diferentes conforme o estado repouso/movimento e atribui "much larger trust" às atualizações em repouso. Fonte: [Laidig & Seel, VQF, arXiv:2203.17024](https://arxiv.org/pdf/2203.17024), publicado como [Information Fusion 91, 187–204, DOI 10.1016/j.inffus.2022.10.014](https://doi.org/10.1016/j.inffus.2022.10.014).

- O detalhe mais relevante para o nosso feedback é que a detecção de repouso do VQF **não usa o sinal já corrigido pelo bias estimado**. O algoritmo filtra as medidas brutas de giroscópio e acelerômetro, calcula o desvio entre a medida instantânea e a referência passa-baixas e só declara repouso se esse desvio permanecer abaixo dos limiares por cerca de 1,5 s; a implementação também rejeita repouso quando a própria referência filtrada excede o maior bias plausível (`biasClip`). Fonte: [apêndice C do paper VQF](https://arxiv.org/pdf/2203.17024) e [implementação Python de referência](https://vqf.readthedocs.io/en/stable/_modules/vqf/pyvqf.html).

- A revisão **"Fifteen Years of Progress at Zero Velocity"** adverte que aplicar ZUPT quando a hipótese de velocidade zero é falsa introduz erros sistemáticos: os erros deixam de ser brancos/de média zero, e passos podem ser encurtados ou verticalmente distorcidos. O limiar de detecção representa um compromisso entre erro do sensor e erro de modelo. Fonte: [Nilsson et al., arXiv:2008.09208](https://arxiv.org/html/2008.09208v1), publicado como [IEEE Sensors Journal, DOI 10.1109/JSEN.2020.3018880](https://doi.org/10.1109/jsen.2020.3018880).

**Lição para o jogo.** "Zona central" não deve ser tratada como prova suficiente de repouso/neutralidade, da mesma forma que "valor pequeno de giroscópio" não basta para provar IMU parada. É preciso um detector de repouso que use grandezas independentes do centro calibrado — por exemplo velocidade/variância do centro dos ombros, que não depende de `x0` — e é preciso aceitar que falsos positivos de repouso introduzem viés sistemático no neutro.

### A1.2 Joysticks: centros adaptativos usam pontos de repouso qualificados, não todas as amostras próximas do centro

A patente da Microsoft **US10463954B2 — "Mechanical center calibration of control sticks in user input devices"** descreve calibração do centro mecânico a partir de uma sequência de "qualified resting points". Os pontos só se qualificam quando o controle:

- retorna para uma zona de qualificação central depois de ter saído dela;
- para de mudar dentro de certo tempo após entrar na zona;
- permanece com variação abaixo de um limiar por um tempo mínimo;
- e, em uma das formas descritas, produz no máximo um ponto de repouso por entrada na zona, sendo necessário sair e reentrar para qualificar outro.

A estimativa usa uma média móvel ponderada desses pontos. Fonte primária: [US10463954B2](https://patents.google.com/patent/US10463954B2/en).

**Lição para o jogo.** A unidade natural de evidência não é "cada frame dentro da banda", mas um **episódio de repouso qualificado**: o corpo entra na zona neutra, estabiliza, permanece tempo suficiente, e só então contribui — idealmente com uma mediana do episódio, não com centenas de frames correlacionados. A exigência de sair e reentrar evita que uma única retenção longa domine a referência.

### A1.3 Calibração implícita em HCI: atualizar só com amostras validadas por evidência comportamental

A literatura de eye tracking é útil porque também lida com drift de calibração durante uso.

- **PACE — Personalized, Auto-Calibrating Eye Tracking** coleta dados de interação sem calibração explícita, mas não aceita tudo: usa validação informada por comportamento e validação orientada por dados para identificar boas amostras de treinamento; amostras rejeitadas são retidas e reavaliadas após atualizações do modelo. Fonte: [Huang et al., CHI 2016, DOI 10.1145/2858036.2858404](https://dl.acm.org/doi/pdf/10.1145/2858036.2858404).

**Lição para o jogo.** A pergunta não é apenas "a amostra está perto do centro atual?", mas "existe uma razão comportamental independente para acreditar que este é um estado neutro?". No nosso caso, os melhores substitutos disponíveis são repouso/dwell, recorrência de episódios e ausência de transição recente de raia — não o valor de `u` sozinho.

### A1.4 Controle adaptativo robusto: dead zone, adaptação lenta e limites são proteções clássicas contra drift

Em controle adaptativo, atualizar parâmetros continuamente a partir de erro pequeno ou contaminado por perturbação produz "parameter drift". Ioannou e Sun dedicam o capítulo 8 de *Robust Adaptive Control* a instabilidades de adaptação e às modificações robustas: leakage, projeção de parâmetros, normalização dinâmica e dead zone. O princípio do dead zone é adaptar somente quando o erro é grande em relação ao erro de modelo/perturbação; caso contrário, a adaptação é desligada ou atenuada. Fonte primária: [Ioannou & Sun, *Robust Adaptive Control*, capítulo 8](https://flyingv.ucsd.edu/krstic/teaching/282/ioannousun.pdf).

**Lição para o jogo.** O centro neutro é um parâmetro adaptativo. O design correto não é um integrador que sempre corrige o erro observado; é um estimador com admissão condicionada, atualização lenta, agregação robusta, limites de taxa, congelamento quando o canal de controle está saturado/em uma raia, e mecanismo de recuperação quando a hipótese de observabilidade deixa de valer.

## A2. O que jogos/exergames controlados por pose fazem

### A2.1 Documentação oficial de pose: histerese, EMA e normalização por torso

O guia oficial de classificação de poses do Google/ML Kit recomenda EMA para ruído frame a frame e histerese de limiar duplo: o limiar de saída é mais baixo que o de entrada, criando um intervalo em que o estado não muda. O mesmo guia diz que, antes de converter poses em vetores de características, as poses foram normalizadas para ter **o mesmo tamanho de torso e orientação vertical do torso**. Fonte: [Pose classification options — ML Kit](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses).

### A2.2 Projetos MediaPipe de controle corporal em browser: prática convergente, validação fraca

Estes artefatos são fontes primárias de engenharia, não evidência científica controlada:

- **Expressway** usa MediaPipe Face/Pose no browser, calibra neutro e extremos, define limiares como fração da amplitude com piso de ruído, aplica One Euro, deadzone e Schmitt trigger, e informa que o baseline neutro "keeps drifting slowly while you play". Fonte: [Expressway — how it works](https://automationoptimization.github.io/expressway/).
- **ROY SPEED — Body-Tracking AR Running Game** usa calibração inicial adaptada à altura/distância, suavização exponencial, histerese e cooldowns; o README também menciona adaptação lenta de baseline enquanto o jogador está parado. Fonte: [GitHub — anupomroy111/Body-Tracking-AR-Running-Game](https://github.com/anupomroy111/Body-Tracking-AR-Running-Game).
- **SurfCam** divide medidas verticais pelo comprimento do torso para independência da distância e usa três faixas de posição lateral com histerese. Fonte: [GitHub — Blueturboguy07/surfcam](https://github.com/Blueturboguy07/surfcam).

A convergência prática é: calibração explícita ou lenta, histerese, normalização corporal e proteção contra drift. Nenhum desses projetos oferece análise formal de estabilidade do loop zona→calibração→zona.

## A3. Análise do feedback loop — derivação própria

Seja `p` a posição postural real do centro dos ombros, `x0` o centro neutro estimado e `e = x0 - p` o erro de calibração. Ignorando ruído e escala, uma atualização admitida do tipo

```
x0 ← x0 + α(x - x0),   0 < α < 1
```

produz `e ← (1 - α)e`. Ou seja, **enquanto evidência correta continua sendo admitida, o loop é contrativo, não explosivo**. O problema não é instabilidade exponencial clássica; é perda de observabilidade por gating.

A zona depende do mesmo `e`: se o erro for grande o bastante para fazer a postura verdadeiramente central parecer uma raia (`|u| ≥ 0.12`), a zona sai do centro, amostras deixam de ser admitidas, `x0` não corrige, a zona continua lateral — deadlock de calibração mesmo com o jogador parado no centro físico. A defesa prática é que erros menores que o limiar de entrada são autocorrigíveis (a evidência centrada continua admitida), e erros grandes dependem do escape hatch temporal.

## A4. Recomendação de design para o Problema A

**A zona é veto/contexto, não prova.** Quando a zona é centro, um deslocamento dentro da banda não está comandando raia e pode ser postura; idealmente entraria na calibração depois de passar por um detector independente de repouso, agregação episódica e adaptação lenta. Em zona lateral, nenhuma amostra da banda é evidência de neutro. O risco principal não é oscilação exponencial, mas deadlock por perda de observabilidade.

> **Status (implementado neste PR):** o veto por zona está aplicado com a zona gravada por amostra no momento da coleta — admitir com a zona atual reabriria retroativamente as amostras de lane segurada ainda na janela. A qualificação independente de repouso e a agregação episódica abaixo continuam como trabalho futuro.

Refinamento documentado para trabalho futuro (não implementado no PR do controle por posição): episódios de repouso qualificados — zona central contínua, velocidade do centro dos ombros (independente de `x0`, pois derivada temporal cancela o offset) abaixo de limiar por 0,7–1,5 s, uma mediana por episódio, recorrência antes de mover o centro, reentrada obrigatória como na patente de joystick US10463954B2. Os valores são hipóteses de engenharia a medir com sessões reais, não constantes validadas.

**Testes mínimos recomendados pela pesquisa** — parcialmente já cobertos no PR: postura deslocada estável a ±0,07 converge sem entrar em raia ✔; retenções longas a ±0,13/±0,20 não são perseguidas ✔; sway periódico dentro da banda não adapta (simétrico — a moda é consenso); erro artificial de `x0` autocorrige abaixo do limiar de entrada.

---

# Parte B — semântica do MediaPipe e geometria projetiva da normalização

## B1. O que `landmarks` e `worldLandmarks` realmente significam

A documentação oficial do Pose Landmarker define `landmarks.x/y` normalizados pela largura e altura da imagem **respectivamente** — denominadores diferentes. `worldLandmarks` são coordenadas 3D em metros com origem no ponto médio dos quadris, estimados por fitting do modelo estatístico GHUM a evidência 2D. Fontes: [Pose Landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker), [model card BlazePose GHUM 3D](https://developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf), [BlazePose GHUM Holistic, arXiv:2206.11678](https://arxiv.org/abs/2206.11678).

Consequência imediata: qualquer comprimento euclidiano calculado diretamente como `hypot(dx_norm, dy_norm)` **não é um comprimento consistente no plano da imagem**, porque x e y foram escalados por denominadores diferentes. Em frame 16:9, a componente vertical é superponderada por (W/H)² ≈ 3,16 no quadrado — uma linha de ombros inclinada mede mais largura que a mesma linha horizontal, e a medida varia com a inclinação exatamente durante o desvio.

**Consequência para raia.** Não usar `worldLandmarks.x` do centro dos ombros como sinal de posição lateral do jogador: a origem no quadril apaga a translação do corpo inteiro — exatamente o que o controle precisa medir.

## B2. Geometria projetiva — derivação própria sob weak perspective

Seja `s = f/Z` a escala imagem/mundo, `W` a largura física dos ombros, `θ` o yaw em torno do eixo vertical. Para yaw puro e ombros horizontais: largura projetada `w ≈ sW cos θ`; altura vertical do tronco não muda.

**Passo paralelo à câmera** por distância física `D`: `Δx ≈ sD`, razão normalizada `u ≈ (D/W) sec θ` — a sensibilidade infla por `1/cos θ` (×1,15 a 30°, ×1,41 a 45°). **Passo lateral ao próprio corpo**: numerador e denominador contraem juntos — razão invariante. Jogadores reais assistindo à tela desviam majoritariamente ao longo do eixo-x da câmera, então a inflação é o caso relevante — mas só se torna grande em yaw degenerado (>30°), onde a qualidade da pose já cai por outras razões.

**Rotação planar (tilt de ombros em lean):** em pixels, `hypot` é invariante à rotação; x-only encolhe com `cos φ` e criaria reforço positivo — denominador caindo enquanto o numerador do desvio sobe. Em coordenadas normalizadas, porém, o `hypot` ingênuo mistura unidades e deixa de ser invariante. A forma correta em unidades de fração da largura:

```
w = hypot(x11 - x12, (y11 - y12) * imageHeight / imageWidth)
```

## B3. Veredicto do Problema B

> **Status (implementado neste PR):** a correção de aspect ratio recomendada abaixo já está aplicada — `LanePositionTracker` e `AdaptiveCalibrator` medem a largura dos ombros com `dy × frameHeight/frameWidth`, e as dimensões do frame viajam no `PoseSnapshot` desde o bitmap do worker. Gravações de pose ganharam schema v2 com as dimensões por frame; arquivos v1 migram pela geometria de input gravada no source. O que permanece como trabalho futuro é a escala frontal equivalente híbrida para yaw extremo, condicionada ao benchmark descrito.

Nenhum denominador único é robusto em todas as condições. O `hypot` atual precisa primeiro ser corrigido para aspect ratio — correção geométrica direta, sem tuning. Entre as opções simples, largura euclidiana aspect-corrected dos ombros é melhor que x-only para jogadores frontais. Para yaw extremo, torso é geometricamente mais invariante, mas a literatura favorece comprimento euclidiano/transformação de torso, não altura vertical simples — uma **escala frontal equivalente híbrida e lentamente filtrada** é o caminho documentado para trabalho futuro, com benchmark dedicado (yaw 0/15/30/45°, passos nos dois eixos, lean, corrida com sway, câmeras 4:3 e 16:9) antes de qualquer troca de denominador. O limiar de raia permanece fixo se a escala estiver corrigida; adaptar limiar por yaw sem decompor passo/lean mistura duas semânticas de controle incompatíveis.

**Referências de normalização em literatura de pose:** ML Kit normaliza poses para o mesmo tamanho de torso e orientação vertical antes de extrair features — [Pose classification options](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses). Pose Trainer normaliza pelo comprimento do torso — [arXiv:2006.11718](https://arxiv.org/html/2006.11718v1). Gesture recognition com OpenPose adverte que normalizar pela distância ombro–ombro falha fora da frontalidade — [link](https://link.springer.com/chapter/10.1007/978-3-030-35699-6_22). Uso de world landmarks para estimar yaw/frontalidade é recomendado com cautela (componente z fraca); mantenedores relatam que world landmarks não são garantidamente reprojetáveis — [issue #1895](https://github.com/google-ai-edge/mediapipe/issues/1895).
