# Corrida de 100 m e revisão do tracking

Data: 26 de novembro de 2026. **Estado: em andamento, não pronto para produção.**

## Problema

Na corrida com obstáculos o boneco andava, corria e pulava sozinho, não ia para o lado e não
reconhecia andar. Distinguir parado, andando, correndo, pulando, trocando de raia e só mexendo os
braços com uma webcam falhava de várias formas. A decisão foi manter esse modo e criar uma prova de
100 m que só precisa de uma pergunta: **com quanta intensidade a pessoa está correndo?** Um erro ali
vira "um pouco mais devagar", não uma ação que não aconteceu.

## Ressalva principal

**Todos os limites foram escolhidos em gravações de uma única pessoa**, na mesma sala e webcam. Não
há evidência de que funcionem para outras pessoas. Quando uma gravação não usada em nenhum ajuste foi
testada pela primeira vez, a corrida caiu para 42% de detecção.

## Prova de 100 m

Código: `src/games/sprint/race.ts` (regras puras), `src/games/sprint/SprintGame.ts` (cena),
`src/kinematics/intensity.ts` (medidor).

Fases:

1. **Enquadramento** (`framingAdvice`, em `src/kinematics/framing.ts`): pede para inclinar, afastar ou
   centralizar. Segue com 1 s de imagem boa, ou após 15 s com o corpo visível, para ninguém ficar preso.
2. **Aquecimento** (5 s, "corra com tudo"): a leitura alta vira o 100% daquela pessoa e câmera. Se o
   jogo quase não ler movimento, o aquecimento se repete até duas vezes dizendo o que fazer ("mostre as
   mãos" ou "mexa mais os braços") e só então usa uma referência padrão. Uma barra de energia mostra ao
   vivo o que está sendo lido, no aquecimento e na prova.
3. **Contagem** de 3 s.
4. **Prova** contra três adversários de ritmo fixo. A velocidade segue a intensidade com embalo
   (ganha em 0,5 s, perde em 1,4 s). **Só se joga com o corpo**: a prova não tem teclado, então o tracking
   precisa funcionar para quem chega; não há saída alternativa.

### Medidor de intensidade

Vale o maior entre dois sinais, de 0 a 1:

- **Bombeio dos braços:** quantas vezes por segundo os pulsos trocam qual está mais alto. É uma
  frequência, então ângulo e distância da câmera pesam pouco. É o sinal principal: a pessoa gravada
  trota "deslizando", com braços fortes e quase sem sobe e desce.
- **Balanço da cabeça**, em larguras de ombro, para quem corre sem usar os braços.

Nas gravações bem enquadradas: parado 0–0,04; só braços devagar 0,10–0,29; andando 0,05–0,11;
correndo 0,62–0,78. Com a cabeça fora do quadro os valores pioram.

Limitações conhecidas: mexer só os braços rende velocidade (aceito nesta prova); mãos fora da imagem
ou movimento de braço pequeno e junto ao corpo não contam; andar quase não gera velocidade.

## Corrida com obstáculos

| Ação | Técnica | Arquivo |
| --- | --- | --- |
| Correr | dispersão da altura dos ombros em 1 s (em larguras de ombro), com os dois ombros e a cabeça juntos | `bounce.ts` |
| Andar | vai e vem lateral dos ombros, um retorno por passo, com a cabeça quase parada na vertical | `walk.ts` |
| Pular | os dois ombros sobem ≥ 0,45 largura acima de onde estavam; em pulos seguidos, mede a partir do chão | `jumpDetector.ts` |
| Raia | centro medido quando a pessoa fica 1 s parada; limites de entrada e saída em larguras de ombro | `postureSignals.ts` |

Quadros em que o esqueleto "quebra" (um ombro salta sobre o outro) ou fica de cabeça para baixo são
descartados. O padrão de inferência passou a ser **CPU** (modelo Lite): numa GPU integrada o modelo
Full disputava com o jogo 3D e a câmera travava. `?delegate=gpu` volta à GPU.

Ainda ruim: andar é reconhecido só em parte e a margem é estreita; pulo baixo durante a corrida não é
contado; passos lentos ou suaves podem ser ignorados.

## O que o BlazePose exige

O detector usa o rosto para achar a pessoa e assume que a cabeça está visível
([artigo](https://arxiv.org/abs/2006.10204)). Nas primeiras gravações a cabeça estava fora do quadro
na maior parte do tempo, e o rastreamento se perdia durante a corrida. Daí o aviso na tela.

## Como medir

Tudo é local; nada é enviado a um servidor do jogo.

- **G** (nas corridas, com câmera): grava um roteiro guiado de pontos do corpo (`recordingScript.ts`).
- **E**: salva os últimos 20 s depois de um erro.
- `/app?fotos`: junto do **E**, salva pequenas imagens da câmera. Desligado por padrão. São imagens da
  pessoa: não commitar, e só abrir ou compartilhar com o consentimento dela.
- `/app?fps`: taxa de tela, câmera e pose, e qual chip desenha o WebGL.
- Gravações vão em `tests/recordings/` (ignorado pelo git). `tests/recordedTrack.test.ts` repete cada uma
  no detector e falha se um piso regredir. **Sem as gravações locais, esses pisos não rodam**, inclusive
  no CI.
- `scripts/pose-replay.html` gera os mesmos JSONs a partir de um vídeo, a 30 quadros por segundo. Ainda
  não foi usado num navegador depois dessa mudança.

## Falta fazer

1. Testar a prova de 100 m ao vivo, incluindo enquadramento e aquecimento.
2. Conferir ao vivo se a instrução do aquecimento aparece na hora certa para quem o jogo não entende.
3. Testar com pelo menos três outras pessoas, com critério definido antes: a barra enche correndo, fica
   vazia parado, e correr forte é claramente mais rápido que correr leve.
4. Opcional: avaliar em [UTD-MHAD](https://personal.utdallas.edu/~kehtar/UTD-MHAD.html) (8 pessoas,
   corrida no lugar; câmera e distância diferentes; a página não declara licença).
5. Diagnosticar travamentos de câmera com `/app?fps`.
6. Ajustar ritmos dos adversários e a escala de velocidade, hoje um primeiro chute.
7. A calibração contínua ainda calcula um centro de raia que o jogo não usa mais: remover.
