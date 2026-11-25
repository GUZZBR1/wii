# Pesquisa: exposição mínima de webcam para calibração por pessoa

Pergunta: qual o **mínimo** de exposição de câmera — tempo, enquadramento, luz — para calibrar
de verdade o sistema para cada pessoa, hoje (corrida/tênis) e para o que o motor vier a
suportar. Síntese de quatro frentes: literatura de acurácia do BlazePose, biomecânica de
postura parada, técnicas de webcam/imagem, prática de produtos comerciais — mais análise
estatística própria de convergência sobre o `Calibrator` atual.

Rótulos: **[G]** documento/fonte Google · **[I]** estudo independente revisado · **[P]**
documentação primária de fabricante · **[A]** acadêmico · **[C]** comunidade/blog ·
**[Calc]** aritmética derivada aqui · **[Inf]** inferência/síntese, não resultado direto.

---

## 1. Resposta executiva

O projeto atual pede **1s de settle + 3s de coleta ≈ 4s parado**. A análise mostra:

1. **O código usa 1,8 segundos de sinal válido como hipótese de engenharia.** Esse valor
   arredonda para baixo o pior caso anteriormente aceito (65% × 2800 ms = 1,82 s); não é
   um mínimo estatístico demonstrado para este app. A janela anterior de 3 s era uma
   política tolerante a falhas, não evidência de que 1,8 s baste.
2. **O sway justifica medir janelas de vários segundos, mas não determina sozinho o piso.**
   Soames & Atha encontraram uma frequência modal primária de 0,30–0,45 Hz em posturografia
   de adultos jovens (períodos equivalentes de ~2,2–3,3 s), além de picos secundários e
   terciários. Isso não prova o erro de uma mediana de landmarks do BlazePose Lite nem que
   uma janela menor que meio-período cause erro sistemático no nosso produto.
3. **O código pode baixar o tempo de forma adaptativa** quando os gates implementados
   fecham. O benefício observado nos testes é de fixtures sintéticas estáticas; a economia
   e a qualidade em webcam real ainda precisam de validação.
4. **O que não é redutível**: calibração por sessão não pode ser eliminada para detectores
   de referência neutra (baseline de salto, referência de raia, posição de prontidão),
   porque esses parâmetros dependem de **postura habitual da pessoa naquele dia, naquela
   câmera** — não de antropometria fixa. Kinect zerou calibração porque (a) tinha sensor
   de profundidade com escala métrica real e (b) detecção absoluta, não referência-relativa.
   Nosso motor é referência-relativa por design — e a pesquisa de inclinação já documentou
   que "a referência calibrada trata a postura habitual da pessoa como vertical"
   (`pesquisa-inclinacao-tronco.md`). Isso é feature, não bug: é o que torna o detector
   robusto; mas amarra a calibração à sessão.
5. **O gargalo de qualidade não é resolução nem fps — é luz estável e enquadramento.**
   Não existe lux mínimo publicado pelo Google para BlazePose; a convergência de prática
   industrial aponta ≥300 lux no sujeito como alvo prudente, luz frontal difusa, e exposição
   estável (sem hunting) como mais importantes que qualquer número de megapixels.

---

## 2. Por que a mediana converge rápido — e onde ela não converge

### 2.1 Estatística da mediana

Para ruído iid gaussiano σ por amostra, o erro da mediana de N amostras é
≈ **1,253·σ/√N**. Com σ=5mm (ordem do jitter pós-filtragem + sway), bastam ~10 amostras
**independentes** para erro de mediana ~1,6mm — desprezível frente aos orçamentos de erro
dos detectores (§4). O gargalo não é contagem de frames: é **independência** entre eles.

### 2.2 Dupla filtragem destrói independência temporal

MediaPipe aplica OneEuro internamente (`auditoria-mediapipe.md` achado #1):
`min_cutoff 0.05/beta 80` em landmarks de imagem → α≈0.01 parado. Constante de tempo
≈ 1/α frames ≈ 100 frames ≈ **3,3s a 30fps** [Calc]. Consequência documentada em
`pesquisa-robustez-gestos.md`: o ruído residual é **deriva lenta**, não ruído branco —
"defeats N-consecutive-frame logic". Numa janela de 3s, o componente de ruído suavizado
tem apenas **~1-3 amostras efetivamente independentes**. A mediana continua útil contra
outliers transientes (frames ruins, oclusão), mas não comprime a deriva lenta — ela passa.

Implicação central: **aumentar fps ou densidade de amostras não melhora a calibração**.
O que melhora é (a) tempo de janela cobrindo mais ciclos de sway e (b) rejeitar frames ruins.

### 2.3 Sway postural: o chão físico da "pessoa parada"

Literature de posturografia **[I]**:

- Quadril parado: RMS **~4-5mm**; ombros **~5-6mm** (Wiesmeier 2015, PMC4477145)
- CoP olhos abertos, 30s: excursão max-min **22mm AP / 12mm ML** (Kenny 2019, PMC6449971)
- Movimento ponto-a-ponto em ~1s: **~4mm RMS** olhos abertos (Doyle 2008, análise de difusão)
- Espectro do centro de pressão: Soames & Atha observaram 90–95% da energia abaixo de 2 Hz,
  com moda primária em 0,30–0,45 Hz e picos secundários/terciários mais altos. Centro de
  pressão em plataforma não é o mesmo sinal que landmarks estimados por webcam.
- Pés juntos **dobram** o sway lateral; olhos fechados aumentam tudo

Consequência para janela de calibração [Inf]:

- A moda primária medida corresponde a períodos de ~2,2–3,3 s; uma captura de 2–4 s pode
  conter aproximadamente um ciclo, dependendo do sujeito e da condição.
- As fontes consultadas não medem o erro de uma mediana de landmarks nessa janela. Os
  envelopes em milímetros acima descrevem CoP e não são limites de erro deste app.
- Portanto, o limiar de 1,8 s é uma hipótese a validar com sinais reais antes de tratá-lo
  como piso de qualidade do produto. O teste sintético verifica contagem temporal, não
  precisão da postura estimada.

### 2.4 Erro sistemático não averageia — mas cancela por consistência

Medições independentes de acurácia absoluta do BlazePose em webcam comum **[I]**:
Physio2.2M (C920, 30Hz, 3/3,5m, contra mocap de marcadores): MPJPE 2D **83-97mm**,
3D **146-162mm**, eixo z ~2× pior que x/y (Lite pior que Full/Heavy por ~15mm).

Esses números pareceriam fatais — mas **calibração não precisa de acurácia absoluta,
precisa de consistência**. O detector usa o mesmo sistema de medida enviesado na
calibração e no jogo; o viés fixo cancela. O que não cancela:

1. **Viés dependente de pose/posição** — a pessoa calibra em pé neutra mas joga inclinada,
   agachada, com braço estendido; erros dependentes de configuração não cancelam.
2. **Mudança de condição entre calibração e jogo** — câmera moveu, pessoa trocou de
   distância, luz mudou. `pesquisa-inclinacao-tronco.md` já documenta: "Recompute or
   invalidate calibration if the camera moves. Camera-aligned coordinates have no way
   to detect this."
3. **Eixo de profundidade** — z é o mais fraco (2× erro); qualquer detector futuro que
   dependa de profundidade herda o pior eixo (issue #19 do striking).

---

## 3. Os pisos físicos de exposição (condições, não tempo)

### 3.1 Enquadramento e pixels no corpo

Consenso multi-fonte:

| Âncora | Valor | Fonte |
|---|---|---|
| Envelope da avaliação legada MediaPipe | imagens avaliadas com pessoa a **2-4m**; não é garantia para este app | [G] avaliação Pose |
| Limite de escopo do model card BlazePose GHUM | pessoas a mais de **4m** fora de escopo; sem distância mínima validada | [G] model card |
| Tamanho mínimo do sujeito | **256×256px** "para melhores resultados" (heurístico, ambíguo) | [G] ML Kit |
| Altura do sujeito | idealmente **≥1/3 da altura do frame** | [P] Apple Vision |
| Entrada mínima | 480×360px | [G] ML Kit |
| Detector interno | crop da pessoa reescalado para 256² — resolução extra no frame não cria detalhe que o sensor não resolveu | [G] paper |

Geometria para nossa câmera típica (78° diag, HFOV ~70°, VFOV ~43°, classe C920) **[Calc]**:
a 2m, pessoa de 1,7m ≈ **771px em 720p** — não cabe na vertical (107% do frame);
a 2,5m ≈ 617px (86%, cabe com margem); a 1,5m **não cabe** em nenhuma hipótese.
Em 640×480 o corpo inteiro exige ~2,3-3m dependendo da altura da pessoa — consistente
com a faixa usada na avaliação legada do MediaPipe e com a prática da indústria (Kinect 1,8-2,5m,
PS Eye/PSVR 1,5-2m, Peloton/Tempo ~1,8-2,4m, OpenCap 2-3m) **[P/A]**.

Largura de ombro de 40cm a 2-2,5m ≈ **145-181px em 720p** (~90-113px em 480p escalado)
[Calc] — muito acima do piso de geometria degenerada do `Calibrator` (0.03), ou seja,
o gate existe para cropping extremo, não para distância normal.

Modo de falha documentado: pessoa de 240px num frame 1080p **não é detectada** no frame
inteiro, mas é detectada após crop [C/G, issue mediapipe#5157] — o detector de corpo
inteiro opera a 224² e perde pessoas pequenas antes do landmarker ter chance.

**Piso de enquadramento**: cabeça visível (requisito do detector, que usa face como
proxy de presença), corpo ocupando ≥1/3 do frame, joints relevantes longe das bordas,
margem para movimento. Corrida precisa de corpo inteiro (tornozelos); tênis de
ombros-a-joelhos + mãos — split já implementado.

### 3.2 Luz e exposição — o verdadeiro multiplicador

**Não existe lux mínimo publicado para BlazePose** — Google respondeu explicitamente não
ter calibração disso [G, issue #3453]. O que existe:

- Logitech recomenda **>300 lux** para manter 720p/60 constante na C922 [P]
- Theia (mocap profissional multicâmera) recomenda **≥500 lux, ideal 1000** [P]
- Iluminação típica: escritório 300-500 lux, **sala de estar 50-200 lux** — ou seja,
  o caso doméstico típico está abaixo do regime bom [I]
- Em baixa luz a webcam: estende exposição (máx 33ms a 30fps), sobe ganho (ruído),
  e/ou **derruba fps** — comportamento documentado em laptops (15fps a 20 lux) e
  controlado por `EXPOSURE_AUTO_PRIORITY` no V4L2 [P]

**Para a calibração especificamente, motion blur não é o constraint**: sway é mm/s —
1/30s de exposição borra 0,33mm [Calc]. Os problemas reais em baixa luz são:
ruído de ganho, **hunting de auto-exposição** (variação brilho frame-a-frame — documentado
como falha de webcams pelo DXOMARK/VCX), queda de fps, e flicker de luz artificial
(banding em rolling shutter se anti-flicker 50/60Hz errado) [P/I].

**Para o jogo depois da calibração, o constraint inverte**: mão a 1-3m/s borra
17-50mm em 1/60s, 33-100mm em 1/30s [Calc] — ~25-70px em escala de corpo inteiro,
comparável a segmentos inteiros. Exposição alvo para gameplay: **≤1/60s, ideal ≤1/120s** —
o que exige ainda mais luz. Mesma sala que "calibra" pode não "jogar".

Estudo único de degradação controlada com Pose Landmarker Full [I, JMIR 2026]:
subexposição sintética moderada e desfoque tiveram efeito **negligenciável** no erro
angular médio — mas era simulação digital sobre vídeo de laboratório, não ruído real
de sensor barato. Evidência fraca; não generalizar.

### 3.3 Confiança de landmarks

Estudo multi-câmera contra Vicon **[I]**: erro sobe marcadamente abaixo de visibility
**0.5**; variância sobe abaixo de **0.8**. Prática derivada: 0.5 piso de usabilidade,
**0.7-0.8 para frames de calibração** seria o conservador. O threshold atual 0.55 fica
no meio — razoável dado que a mediana já rejeita outliers, mas os piores frames que
passam em 0.55-0.7 são os que a mediana precisa absorver.

### 3.4 fps e rolling shutter

- Nenhum estudo controlado de fps vs acurácia espacial. 30fps é o denominador de todas
  as validações [I]. fps menor não piora o frame individual; piora cobertura temporal.
- Rolling shutter (readout típico 16-40ms em consumer) [P]: irrelevante para calibração
  parada (shear de ~0.1mm); relevante para membros rápidos no jogo (25-75mm de shear
  topo-embaixo a 1-3m/s) [Calc].
- A 7fps (dispositivo degradado) os requisitos 12 amostras/2,8s ainda passam —
  `analise-gargalos-corrida.md` já notou que o gate é folgado; o custo é que cada
  blecaute consome fatia maior da cobertura.

---

## 4. Orçamento de erro por parâmetro — o que amarra o piso de tempo

Precisão necessária vs. o que cada parâmetro calibrado alimenta:

| Parâmetro | Consumidor | Orçamento de erro | Dificuldade |
|---|---|---|---|
| `world.shoulderWidth` | escala de velocidades de swing | ~10% (4cm) — folgado | trivial: converge em <1s |
| `readyWristLocal` | re-arm de swing (raio 0.35 larguras ~14cm) | ~5cm — muito folgado | trivial |
| `image.torsoHeight` | escala de joelho/salto | ~5-10% | fácil |
| `world.leanUp0` | referência de raia; fire 0.15rad (8,6°) | ~2-3° (~2-3cm de geometria de perna) | moderado: exige pernas estendidas verificadas — já implementado |
| `image.kneeToHipY0` | offset neutro de joelho; bandas on/off 0.1/0.05 | ~0.02-0.03 unidades (~1-2cm) | apertado |
| `image.hipY0` | baseline de salto; arming ≤0.03, takeoff 0.08 torso | **~0.02 torso (~1-1,5cm) — o mais apertado** | difícil: bias de 0.03 come a banda de arming inteira |

Os dois parâmetros apertados são **verticais e dependem de postura neutra real** — é onde
o erro de época do sway morde. Com sway vertical/ML de ~4-6mm RMS e mediana sobre uma
janela que cobre ~1 ciclo (2-3s), erro residual esperado ~2-4mm [Inf] — dentro do
orçamento, com margem pequena. Uma janela de 1s que por acaso captura um extremo de
transferência de peso (15-30mm) estoura o orçamento 2-10×. **É por isso que ~2s de
sinal válido é o piso, não ~0,5s** — e por isso o gate de imobilidade e a verificação
de pernas estendidas importam mais que a contagem de amostras.

---

## 5. Hipótese de implementação para o piso de tempo

As fontes não permitem derivar um mínimo de **sinal válido** para esta aplicação:

1. **Independência de ruído**: ~10 realizações independentes para mediana comprimir ruído
   branco residual. Com ruído correlacionado em τ~0,3-1s (pós-dupla-filtragem, ordem de
   grandeza [Inf]), isso pede 1-3s de janela. Não é o constraint dominante.
2. **Exposição a sway**: a literatura sugere componentes de baixa frequência em CoP, mas não
   converte isso em duração mínima para landmarks de pose. O limite de **1,8 s** é uma
   hipótese de implementação pendente de medir duração e erro com webcam real.
3. **Robustez a outliers**: a mediana tolera até <50% de amostras contaminadas; o antigo
   gate de 65% permitia até 35% de quadros inválidos, mas isso não mede erro residual nem
   garante qualidade em uma janela mais curta.
4. **Verificação de postura** (pernas estendidas, imobilidade): instantânea por frame,
   mas precisa coexistir com os frames válidos — na prática já coberta pelos itens acima.

Política do código: **1,8 s de sinal válido e pelo menos 2 s de span**, com cobertura de
65% na coleta após o assentamento. Em fixtures estáticas, a tentativa completa em 2 s;
nenhum desses números foi validado como limite de precisão com uma pessoa e webcam reais.

### 5.1 Onde dá para ganhar tempo sem perder qualidade

1. **Saída adaptativa antecipada**: o código atual sonda os gates de cobertura por frame e
   termina após ≥1,8 s de sinal válido (2 s no fixture perfeito). Ele não mede drift
   independente nem exige 90% de cobertura; esses critérios só devem ser adicionados após
   definir uma medida e validar com webcam real.
2. **Fundir settle com coleta**: a implementação atual inclui os frames desde a âncora no
   piso de sinal válido, mas avalia cobertura de falhas só depois do assentamento. O teste
   sintético converge em 2 s; o ganho e a estabilidade da âncora precisam de avaliação real.
3. **Calibração por esporte com escopo mínimo**: ainda é uma possibilidade de desenho.
   Hoje ambos os esportes pedem ombros, punhos, quadris e joelhos; a trilha de tênis ainda
   não tem um perfil reduzido nem um piso próprio validado.
4. **Não ganha nada**: subir fps (ruído correlacionado), subir resolução (crop interno
   256²), aumentar contagem mínima de amostras além do span temporal.

### 5.2 O que não se deve fazer

- **Reduzir o piso sem medir erro com webcam real**: os fixtures sintéticos não têm sway e
  não mostram se uma calibração mais curta contamina hipY0, joelhos ou a posição de prontidão.
- **Eliminar calibração por sessão**: os parâmetros apertados são posturais e de sessão.
  O que dá para eliminar é *re-calibração desnecessária* (cache de perfil por pessoa?
  — mas câmera/cômodo mudam; e coordenadas câmera-alinhadas não detectam mudança de
  câmera, ver §2.4).
- **Baixar confiança de calibração abaixo de 0.5**: evidência independente mostra erro
  crescendo marcado ali.
- **Copiar Theia (500px de altura de pessoa, 1000 lux)**: é mocap profissional
  multicâmera; impossível e desnecessário em webcam 480p.

---

## 6. Spec mínima consolidada — "exposição mínima para calibrar de verdade"

### Condições (pré-requisitos de qualidade)

| Dimensão | Referência de engenharia | Alvo exploratório | Evidência |
|---|---|---|---|
| Distância (corpo inteiro) | ~2m (e cabeça visível) | 2-2,5m | [G][P][Calc] |
| Altura do sujeito no frame | ≥1/3 | ≥1/2 com margem de movimento | [P Apple][Inf] |
| Distância máxima | 4m (fora de escopo além) | ≤3m | [G] |
| Luz no sujeito | ~300 lux, frontal difusa, sem contra-luz | 500+ lux | [P Logitech/Theia][Inf] |
| Exposição durante calibração | qualquer até 1/30s (sway não borra) | estável, sem hunting | [Calc][P] |
| Exposição para gameplay | ≤1/60s | ≤1/120s | [Calc][Inf] |
| fps | ~15 (cobertura ainda fecha) | 30 estável | [Inf] |
| Confiança de landmark em frame de calibração | ≥0.5-0.55 | ≥0.7 | [I] |
| Câmera | fixa, imóvel durante e após calibração | — | [G/Inf] |
| Postura | pés em largura natural, olhos abertos, braços relaxados consistentes | alvo visual fixo | [I posturografia] |

### Tempo

| Componente | Mínimo teórico | Design atual | Caminho de melhoria |
|---|---|---|---|
| Sinal válido acumulado | **1,8s no código** | Não medido em webcam real | Hipótese derivada do gate anterior (65% × 2800 ms) |
| Janela de relógio | ≥2s de span no código | Não medida em webcam real | Teste sintético estático |
| Settle | Fundido à exposição desde a âncora | Verificar estabilidade de cada referência | Regra atual + teste sintético |
| Total por tentativa (caso bom) | 2s nos fixtures | Não medido em webcam real | Testes não medem sway nem erro do perfil |
| Tênis apenas (escopo reduzido) | Ainda não implementado | Medir antes de definir piso | Proposta exploratória |

### Falhas de ambiente a instruir (consenso de indústria, [P]×7 fabricantes)

Luz frontal difusa; nunca janela/lâmpada atrás da pessoa; sem sol direto; fundo estático
e sem espelhos/TVs; roupa ajustada contrastando com o fundo; sem outras pessoas/pets em
cena; sem padrões fortes na parede. Não mostrar checklist permanente — surfacing por
falha repetida (padrão dos produtos comerciais).

---

## 7. Lacunas que nenhuma fonte fecha (e o repo já sabia)

1. **Jitter de repouso do BlazePose Lite em webcam comum, em mm** — não existe número
   publicado; o repo já prescreveu o experimento (`pesquisa-robustez-gestos.md`: 10s
   parado, medir SD/p95). É a medição que faltaria para transformar §2.2 de ordem-de-
   grandeza em número. Coberto pela issue #20.
2. **Acurácia vs. iluminação real de webcam** (não simulação digital) — não existe.
3. **Compressão MJPEG de USB vs. acurácia de pose** — não medido; 720p/1080p em USB2
   implicam MJPEG (442-995 Mbit/s não comprimidos vs. 480 teóricos) [Calc][P].
4. **Distribuição populacional do erro de landmarks em janelas de 2-4s** — posturografia
   mede CoP por outras durações; não fornece erro de BlazePose Lite para este uso.
5. **Validação com pessoa e câmera reais** — zero no projeto até aqui (issue #20);
   todas as amplitudes de sinal humano são estimativas de literatura.

## 8. Resposta em uma frase

> **Hipótese atual do código: 1,8 segundos de sinal válido**, com corpo enquadrado e câmera
> imóvel. A literatura de sway motiva medir exposições de vários segundos, mas não valida
> esse limiar para landmarks do BlazePose Lite; a validação com webcam real ainda falta. A
> implementação mantém tolerância a falhas via cobertura temporal e deve ser ajustada com
> medições reais de erro e duração.

---

### Fontes principais

- Physio2.2M — acurácia BlazePose vs. mocap em C920 [I]: https://www.nature.com/articles/s41598-025-22626-7
- BlazePose paper/model card [G]: https://arxiv.org/abs/2006.10204 · https://developers.google.com/ml-kit/images/vision/pose-detection/pose_model_card.pdf
- Avaliação legada MediaPipe Pose [G]: https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md (datasets com pessoas a 2–4 m; não valida este app)
- ML Kit Pose guidance [G]: developers.google.com/ml-kit/vision/pose-detection/android
- Posturografia: Kenny 2019 (PMC6449971), Wiesmeier 2015 (PMC4477145), Gatev (PMC2269093), Doyle 2008 SDA, [Soames & Atha 1982](https://pubmed.ncbi.nlm.nih.gov/6981506/) (frequência espectral de CoP, não janela de precisão de landmarks)
- Multi-view webcam/Vicon [I]: PMC13766164 · stereo vs. monocular: PMC11644880
- Degradação controlada Pose Landmarker [I]: PMC13747219 · PoseBench: arxiv.org/abs/2505.23760
- Logitech C922 lux [P]: support.logi.com/hc/en-us/articles/360023345533
- Theia camera setup [P]: docs.theiamarkerless.com · OpenCap [A]: journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462
- ExerCam [A]: mdpi.com/2076-3417/11/19/9132 · Apple Vision [P]: WWDC2020/10653
- Kinect zero-calibration [P]: Zhang, Microsoft Research IEEE MM 2012
- Interno: `docs/auditoria-mediapipe.md`, `docs/pesquisa-inclinacao-tronco.md`,
  `docs/pesquisa-robustez-gestos.md`, `docs/autocalibracao-tolerancia-perda.md`,
  `docs/analise-gargalos-corrida.md`, `src/cv/calibrator.ts`, `src/cv/autoCalibrator.ts`
