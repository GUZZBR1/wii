import type { Bilingual } from '../i18n';

/** Short metadata in both languages: short/title/blurb contain Portuguese with an English translation in `en`. */
export interface Draft {
  n: string;
  short: string;
  title: string;
  blurb: string;
  en: { short: string; title: string; blurb: string };
}

/**
 * Papers by other authors that inform the project and appear on /papers. Titles and summaries only
 * describe what each publication itself reports.
 */
export interface Paper extends Draft {
  externalUrl: string;
}

export const papers: Paper[] = [
  {
    n: '01',
    short: 'golpes no tênis',
    title: 'Player Disjoint Multi-Task Tennis Stroke Analysis from Monocular Pose Sequences',
    blurb: 'Hazarika et al. (arXiv, 2026) · Detecta e analisa golpes de tênis pela pose em vídeo de uma única câmera, avaliando em jogadores fora do treino.',
    externalUrl: 'https://arxiv.org/abs/2606.15992',
    en: {
      short: 'tennis strokes',
      title: 'Player Disjoint Multi-Task Tennis Stroke Analysis from Monocular Pose Sequences',
      blurb: 'Hazarika et al. (arXiv, 2026) · Detects and analyses tennis strokes from single-camera pose sequences, evaluated on players held out of training.',
    },
  },
  {
    n: '02',
    short: 'precisão 3D',
    title: 'Accuracy Evaluation of 3D Pose Estimation with MediaPipe Pose for Physical Exercises',
    blurb: 'Dill et al. (Current Directions in Biomedical Engineering, 2023) · A precisão da pose 3D do MediaPipe depende muito do ângulo da câmera e do exercício.',
    externalUrl: 'https://www.degruyter.com/document/doi/10.1515/cdbme-2023-1141/html',
    en: {
      short: '3D accuracy',
      title: 'Accuracy Evaluation of 3D Pose Estimation with MediaPipe Pose for Physical Exercises',
      blurb: 'Dill et al. (Current Directions in Biomedical Engineering, 2023) · The accuracy of MediaPipe 3D pose depends heavily on the camera angle and the exercise.',
    },
  },
  {
    n: '03',
    short: 'exergames por câmera',
    title: 'Smartphone Exergames with Real-Time Markerless Motion Capture: Challenges and Trade-offs',
    blurb: 'Phosanarack et al. (workshop da CHI, 2025) · O equilíbrio entre precisão e resposta em tempo real em exergames sem marcadores no celular.',
    externalUrl: 'https://arxiv.org/abs/2507.06669',
    en: {
      short: 'camera exergames',
      title: 'Smartphone Exergames with Real-Time Markerless Motion Capture: Challenges and Trade-offs',
      blurb: 'Phosanarack et al. (CHI workshop, 2025) · Balancing accuracy and real-time responsiveness in markerless smartphone exergames.',
    },
  },
  {
    n: '04',
    short: 'avaliação por DTW',
    title: 'Webcam-Based Exergame for Motor Recovery with Physical Assessment via DTW',
    blurb: 'Labchurat et al. (Sensors, 2026) · Exergame em casa com webcam comum e MediaPipe, que avalia o movimento com Dynamic Time Warping.',
    externalUrl: 'https://doi.org/10.3390/s26041219',
    en: {
      short: 'DTW assessment',
      title: 'Webcam-Based Exergame for Motor Recovery with Physical Assessment via DTW',
      blurb: 'Labchurat et al. (Sensors, 2026) · A home exergame with an ordinary webcam and MediaPipe that assesses movement with Dynamic Time Warping.',
    },
  },
  {
    n: '05',
    short: 'pose no dispositivo',
    title: 'BlazePose: On-device Real-time Body Pose tracking',
    blurb: 'Bazarevsky et al. (workshop da CVPR, 2020) · Rede leve que estima 33 pontos do corpo a mais de 30 quadros por segundo em um celular Pixel 2.',
    externalUrl: 'https://arxiv.org/abs/2006.10204',
    en: {
      short: 'on-device pose',
      title: 'BlazePose: On-device Real-time Body Pose tracking',
      blurb: 'Bazarevsky et al. (CVPR workshop, 2020) · A lightweight network estimating 33 body keypoints at over 30 frames per second on a Pixel 2 phone.',
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

/** Stage lines about the scientific references that inform the project. */
export const paperLines: Bilingual[] = [
  { pt: 'Seis leituras sobre visão computacional e jogos pelo corpo.', en: 'Six readings on computer vision and body-controlled games.' },
  { pt: 'Do BlazePose e Filtro 1€ à detecção de golpes e precisão 3D.', en: 'From BlazePose and the 1€ Filter to stroke detection and 3D accuracy.' },
  { pt: 'Artigos e preprints de outros autores, não resultados deste projeto.', en: 'Papers and preprints by other authors, not results of this project.' },
  { pt: 'Clique em qualquer cartão para abrir o resumo e ir direto ao artigo.', en: 'Click any card to open its summary and jump straight to the paper.' },
];

/** Project research drafts in docs/research, shown on /papers/:n. These are proposals, not validated results. */
export const drafts: Draft[] = [
  { n: '01', short: 'dados sintéticos', title: 'Simulação e dados sintéticos para avaliar sistemas de desenho por câmera', blurb: 'Cenários simulados como complemento às gravações reais, e até onde eles servem.', en: { short: 'synthetic data', title: 'Simulation and synthetic data for evaluating camera drawing systems', blurb: 'Simulated scenarios as a complement to real recordings, and how far they are useful.' } },
  { n: '02', short: 'tempo de resposta', title: 'Desempenho temporal em sistemas de desenho assistidos por visão computacional', blurb: 'A rapidez da resposta e a continuidade que a pessoa percebe enquanto desenha.', en: { short: 'response time', title: 'Temporal performance in computer-vision-assisted drawing systems', blurb: 'The speed of the response and the continuity the person perceives while drawing.' } },
  { n: '03', short: 'reprodutibilidade', title: 'Reprodutibilidade experimental em sistemas de visão computacional com modelos externos', blurb: 'Rastrear modelos, dados e configurações para que um resultado possa ser repetido.', en: { short: 'reproducibility', title: 'Experimental reproducibility in computer vision systems with external models', blurb: 'Tracking models, data and configurations so that a result can be repeated.' } },
  { n: '04', short: 'acessibilidade', title: 'Acessibilidade e diversidade de uso em sistemas de desenho assistidos por câmera', blurb: 'Quem consegue usar, em que contextos, e onde estão as barreiras.', en: { short: 'accessibility', title: 'Accessibility and diversity of use in camera-assisted drawing systems', blurb: 'Who can use them, in which contexts, and where the barriers are.' } },
  { n: '05', short: 'experiência', title: 'Qualidade e continuidade da experiência em sistemas de desenho assistidos por câmera', blurb: 'Ligar as medidas técnicas ao que as pessoas realmente percebem ao desenhar.', en: { short: 'experience', title: 'Quality and continuity of the experience in camera-assisted drawing systems', blurb: 'Connecting technical measures to what people actually perceive when drawing.' } },
];
