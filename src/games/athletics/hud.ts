import { formatTime, type Split } from './race';

export interface AthleticsResult {
  title: string;
  detail: string;
  time: string;
  distance: number;
}

export function distanceLabel(distance: number, goal: number): string {
  return `${Math.min(goal, Math.floor(distance))} / ${goal} m`;
}

export function raceStatus(seconds: number, gait: string): string {
  return `${formatTime(seconds)} · ${gait}`;
}

export function finishResult(seconds: number, goal: number, splits: readonly Split[]): AthleticsResult {
  const time = formatTime(seconds);
  const splitText = splits.map((split) => `${split.meters} m ${formatTime(split.seconds)}`).join(' · ');
  return {
    title: 'Prova Concluída!',
    detail: `Tempo ${time} · percurso ${goal} m${splitText ? ` · ${splitText}` : ''}`,
    time,
    distance: goal,
  };
}
