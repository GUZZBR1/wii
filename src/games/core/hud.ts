export interface HudFeedback {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface GameHudState {
  score: number;
  label: string;
  speed01: number;
  status: string;
  feedback?: HudFeedback;
}
