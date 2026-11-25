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

1. **O design atual já está perto do piso de tempo.** O requisito real não são "3 segundos
   de relógio" — são **~2 segundos de sinal válido** com folga para blecautes (cobertura
   65% × janela 3s = 1,95s válidos no mínimo). Coincidência exata: o piso estatístico
   calculado abaixo é ~2s de sinal válido. A janela de 3s é a versão tolerante-a-falhas
   desse piso.
2. **Abaixo de ~1,5-2s o erro para de ser ruído e vira época de sway**: a oscilação
   postural dominante tem período de 2-5s; uma janela menor que meio-período amostra a
   postura num extremo do balanço em vez do centro — erro sistemático que nenhuma mediana
   remove.
3. **O tempo pode baixar de forma adaptativa**: se a cobertura está alta e o drift baixo,
   2s bastam; o ganho real não é encolher a janela fixa, é **sair cedo quando convergiu**
   (potencial de 4s → ~2,5-3s totais no caso típico) e alongar quando degradado.
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
- Espectro: 90-95% da energia posicional **abaixo de 2Hz**; componente corporal dominante
  **abaixo de 0.5Hz**; deriva significativa abaixo de 0.1Hz (Soames & Atha 1982; Błaszczyk)
- Pés juntos **dobram** o sway lateral; olhos fechados aumentam tudo

Consequência para janela de calibração [Inf]:

- Período dominante 2-5s ⇒ janela de 2-4s captura **~1 ciclo ou menos**.
- A média/mediana da janela tem erro de época de alguns mm dependendo de onde cai no ciclo.
- Envelope realista de variação em 2-4s: **5-15mm típico**, ocasionalmente 15-30mm em
  transferências de peso. Um gate de imobilidade que exija "parado de verdade" em escala
  de pixel é fisicamente irrealista — o `STILL_TOLERANCE = 0.04` atual (≈4% da imagem,
  ~3-8cm em escala corporal típica) é grosseiro mas do lado certo da realidade.
- **Janela < 1,5s arrisca amostrar a postura num extremo do sway** — erro sistemático de
  cm que contamina exatamente os parâmetros mais sensíveis (hipY0, ver §4).

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
| Envelope validado Google | pessoa a **2-4m**; >4m fora de escopo | [G] model card |
| Tamanho mínimo do sujeito | **256×256px** "para melhores resultados" (heurístico, ambíguo) | [G] ML Kit |
| Altura do sujeito | idealmente **≥1/3 da altura do frame** | [P] Apple Vision |
| Entrada mínima | 480×360px | [G] ML Kit |
| Detector interno | crop da pessoa reescalado para 256² — resolução extra no frame não cria detalhe que o sensor não resolveu | [G] paper |

Geometria para nossa câmera típica (78° diag, HFOV ~70°, VFOV ~43°, classe C920) **[Calc]**:
a 2m, pessoa de 1,7m ≈ **771px em 720p** — não cabe na vertical (107% do frame);
a 2,5m ≈ 617px (86%, cabe com margem); a 1,5m **não cabe** em nenhuma hipótese.
Em 640×480 o corpo inteiro exige ~2,3-3m dependendo da altura da pessoa — consistente
com o envelope 2-4m do model card e com a prática da indústria (Kinect 1,8-2,5m,
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

## 5. Piso de tempo: a conta final

Derivação do mínimo de **sinal válido**:

1. **Independência de ruído**: ~10 realizações independentes para mediana comprimir ruído
   branco residual. Com ruído correlacionado em τ~0,3-1s (pós-dupla-filtragem, ordem de
   grandeza [Inf]), isso pede 1-3s de janela. Não é o constraint dominante.
2. **Época de sway**: cobrir ≥~meio-período da oscilação dominante (período 2-5s) para a
   mediana cair perto do centro de massa da postura → **≥1,5-2s**. Constraint dominante.
3. **Robustez a outliers**: mediana tolera até <50% contaminados; com cobertura 65% e
   frames ruins concentrados, margem real exige a janela ser ~1,5× o sinal necessário.
4. **Verificação de postura** (pernas estendidas, imobilidade): instantânea por frame,
   mas precisa coexistir com os frames válidos — na prática já coberta pelos itens acima.

Resultado [Inf]: **piso ≈ 2s de sinal válido**, que com tolerância a blecaute (65%)
vira **janela de relógio ≈ 3s** — exatamente o design atual. O piso absoluto com
condições perfeitas (sem blecaute, drift baixo verificado) seria ~2s de relógio.

### 5.1 Onde dá para ganhar tempo sem perder qualidade

1. **Saída adaptativa antecipada**: terminar aos ~2-2,2s se cobertura ≥90% E drift de
   centroides baixo E confiança mediana alta. Caso típico economiza ~1s; caso ruim
   continua 3s+. É a otimização real — não encolher a janela fixa.
2. **Fundir settle com coleta**: o settle de 1s hoje é pré-condição pura; os frames do
   settle que já estão bons poderiam entrar na janela (a verificação de imobilidade é
   contínua de qualquer forma). Potencial: 4s → ~2,5-3s totais no caso bom.
3. **Calibração por esporte com escopo mínimo**: tênis só precisa de ombros+pulsos
   (parâmetros folgados — convergem em ~1-1,5s); corrida é quem puxa o piso de 2s
   (hipY0/joelhos). Split já existe no rastreamento de cobertura; daria para ter
   duração mínima distinta por trilha.
4. **Não ganha nada**: subir fps (ruído correlacionado), subir resolução (crop interno
   256²), aumentar contagem mínima de amostras além do span temporal.

### 5.2 O que não se deve fazer

- **Janela < 1,5s fixa**: amostra sway em extremo; contamina hipY0/joelhos com cm de
  erro sistemático — invisível nos testes porque fixtures sintéticas não têm sway.
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

| Dimensão | Piso | Alvo | Evidência |
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
| Sinal válido acumulado | **~2s** | ≥1,95s (65% de 3s) | — já no piso |
| Janela de relógio | ~2s (condições perfeitas) | 3s | saída adaptativa antecipada |
| Settle | 0 (fundível na coleta) | 1s | fusão com coleta + verificação contínua |
| Total por tentativa (caso bom) | **~2-2,5s** | ~4s | ~2,5-3s com as duas melhorias |
| Tênis apenas (trilha de pulsos) | ~1-1,5s | idem | duração distinta por trilha |

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
4. **Distribuição populacional de excursão de quadril/ombros em janelas de 2-4s** —
   posturografia mede 20-120s; os números de §2.3 são interpolação fundamentada [Inf].
5. **Validação com pessoa e câmera reais** — zero no projeto até aqui (issue #20);
   todas as amplitudes de sinal humano são estimativas de literatura.

## 8. Resposta em uma frase

> **Mínimo real: ~2 segundos de sinal de pose válido, com corpo enquadrado (≥1/3 do
> frame, cabeça visível, 2-3m), luz frontal de escritório (~300+ lux) e câmera imóvel —
> ou seja, a janela de 3s com cobertura 65% já é esse piso com a tolerância a falhas
> embutida; o ganho disponível não é encolher a exigência, é convergir adaptativamente
> (~2,5s no caso bom em vez de 4s fixos) e cobrar menos do tênis, que não precisa da
> trilha de pernas.**

---

### Fontes principais

- Physio2.2M — acurácia BlazePose vs. mocap em C920 [I]: nature.com/articles/s41598-025-22626-7
- BlazePose paper/model card [G]: arxiv.org/abs/2006.10204 · developers.google.com/static/ml-kit/images/vision/pose-detection/pose_model_card.pdf
- ML Kit Pose guidance [G]: developers.google.com/ml-kit/vision/pose-detection/android
- Posturografia: Kenny 2019 (PMC6449971), Wiesmeier 2015 (PMC4477145), Gatev (PMC2269093), Doyle 2008 SDA, Soames & Atha 1982
- Multi-view webcam/Vicon [I]: PMC13766164 · stereo vs. monocular: PMC11644880
- Degradação controlada Pose Landmarker [I]: PMC13747219 · PoseBench: arxiv.org/abs/2505.23760
- Logitech C922 lux [P]: support.logi.com/hc/en-us/articles/360023345533
- Theia camera setup [P]: docs.theiamarkerless.com · OpenCap [A]: journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462
- ExerCam [A]: mdpi.com/2076-3417/11/19/9132 · Apple Vision [P]: WWDC2020/10653
- Kinect zero-calibration [P]: Zhang, Microsoft Research IEEE MM 2012
- Interno: `docs/auditoria-mediapipe.md`, `docs/pesquisa-inclinacao-tronco.md`,
  `docs/pesquisa-robustez-gestos.md`, `docs/autocalibracao-tolerancia-perda.md`,
  `docs/analise-gargalos-corrida.md`, `src/cv/calibrator.ts`, `src/cv/autoCalibrator.ts`
