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
  tennis?: {
    points: Readonly<Record<"player" | "opponent", string>>;
    games: Readonly<Record<"player" | "opponent", number>>;
    server: "player" | "opponent";
    winner: "player" | "opponent" | null;
    secondServe: boolean;
  };
}
