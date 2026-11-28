import type { Bilingual } from '../i18n';

/**
 * Artigos científicos de referência para o pipeline de visão computacional e os jogos pelo corpo.
 * short/title/blurb são o texto em português; en traz a tradução para inglês (mesma estrutura).
 */
export interface Paper {
  n: string;
  short: string;
  title: string;
  blurb: string;
  externalUrl?: string;
  en: { short: string; title: string; blurb: string };
}

export const papers: Paper[] = [
  {
    n: '01',
    short: 'golpes no tênis',
    title: 'Multi-Task Tennis Stroke Biomechanics Analysis Using MediaPipe Pose',
    blurb: 'Hazarika et al. (2026) · Detector cinético de golpes por velocidade ponderada de punho, cotovelo e ombro e generalização entre jogadores.',
    externalUrl: 'https://arxiv.org/abs/2606.15992',
    en: {
      short: 'tennis strokes',
      title: 'Multi-Task Tennis Stroke Biomechanics Analysis Using MediaPipe Pose',
      blurb: 'Hazarika et al. (2026) · Kinetic stroke event detector from weighted wrist, elbow, and shoulder velocities with cross-player generalization.',
    },
  },
  {
    n: '02',
    short: 'precisão 3D',
    title: 'Accuracy Evaluation of 3D Pose Estimation with MediaPipe Pose for Physical Exercises',
    blurb: 'Dill et al. (BMT 2023) · Avaliação do MediaPipe Pose contra MoCap óptico sob múltiplos ângulos, mostrando queda com oclusão e ângulos desfavoráveis.',
    externalUrl: 'https://www.degruyter.com/document/doi/10.1515/cdbme-2023-1141/html',
    en: {
      short: '3D accuracy',
      title: 'Accuracy Evaluation of 3D Pose Estimation with MediaPipe Pose for Physical Exercises',
      blurb: 'Dill et al. (BMT 2023) · Evaluation of MediaPipe Pose against optical MoCap across viewing angles, showing accuracy drops with occlusion.',
    },
  },
  {
    n: '03',
    short: 'exergames por câmera',
    title: 'Smartphone Exergames with Real-Time Markerless Motion Capture: Challenges and Trade-offs',
    blurb: 'Phosanarack et al. (CHI Workshop / arXiv 2025) · Trade-offs de latência, precisão, enquadramento e robustez em exergames sem marcadores em hardware comum.',
    externalUrl: 'https://arxiv.org/abs/2507.06669',
    en: {
      short: 'camera exergames',
      title: 'Smartphone Exergames with Real-Time Markerless Motion Capture: Challenges and Trade-offs',
      blurb: 'Phosanarack et al. (CHI Workshop / arXiv 2025) · Latency, accuracy, framing, and robustness trade-offs in markerless exergames on commodity cameras.',
    },
  },
  {
    n: '04',
    short: 'avaliação por DTW',
    title: 'Webcam-Based Exergame for Motor Recovery with Physical Assessment via DTW',
    blurb: 'Labchurat et al. (Sensors 2026) · Uso de webcam comum + MediaPipe para ombro e cotovelo com Dynamic Time Warping e Z-score entre usuários.',
    externalUrl: 'https://doi.org/10.3390/s26041219',
    en: {
      short: 'DTW assessment',
      title: 'Webcam-Based Exergame for Motor Recovery with Physical Assessment via DTW',
      blurb: 'Labchurat et al. (Sensors 2026) · Commodity webcam + MediaPipe for shoulder and elbow tracking with DTW and Z-score normalization across users.',
    },
  },
  {
    n: '05',
    short: 'pose no dispositivo',
    title: 'BlazePose: On-device Real-time Body Pose tracking',
    blurb: 'Bazarevsky et al. (Google Research, 2020) · Arquitetura leve de 33 pontos corporais que roda em tempo real na CPU do navegador via MediaPipe.',
    externalUrl: 'https://arxiv.org/abs/2006.10204',
    en: {
      short: 'on-device pose',
      title: 'BlazePose: On-device Real-time Body Pose tracking',
      blurb: 'Bazarevsky et al. (Google Research, 2020) · Lightweight 33-keypoint body pose architecture running in real time on browser CPU via MediaPipe.',
    },
  },
  {
    n: '06',
    short: 'filtro 1€',
    title: '1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems',
    blurb: 'Casiez, Roussel & Vogel (ACM CHI 2012) · Filtro passa-baixa adaptativo pela velocidade que reduz tremulação parado sem atrasar movimentos rápidos.',
    externalUrl: 'https://doi.org/10.1145/2207676.2208639',
    en: {
      short: '1€ filter',
      title: '1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems',
      blurb: 'Casiez, Roussel & Vogel (ACM CHI 2012) · Speed-adaptive low-pass filter that suppresses stationary jitter without lagging behind fast motion.',
    },
  },
];

/** Frases do palco sobre as referências científicas que sustentam o projeto. */
export const paperLines: Bilingual[] = [
  { pt: 'Seis artigos que sustentam a visão computacional e os jogos pelo corpo.', en: 'Six papers behind our computer vision pipeline and body-controlled games.' },
  { pt: 'Do BlazePose e Filtro 1€ à detecção de golpes e precisão 3D.', en: 'From BlazePose and the 1€ Filter to stroke detection and 3D accuracy.' },
  { pt: 'Literatura revisada para webcam comum, sem sensores externos.', en: 'Peer-reviewed and preprint literature for ordinary webcams, with no external sensors.' },
  { pt: 'Clique em qualquer cartão para abrir o resumo e ir direto ao artigo.', en: 'Click any card to open its summary and jump straight to the paper.' },
];
