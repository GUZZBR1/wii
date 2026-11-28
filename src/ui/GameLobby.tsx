import { GOALS, type Goal } from '../games/athletics/race';
import { OPPONENT_PROFILES } from '../games/boxing/opponentProfiles';
import type { BoxingSetup } from '../games/boxing/boxingSetup';
import type { Sport } from './GameCanvas';
import { HUD_TEXT } from './hudText';

const GAMES: Record<Sport, { name: string; tagline: string; howTo: string }> = {
  track: { name: 'Corrida', tagline: 'Arena de corrida', howTo: 'Corra no lugar, pule e incline o corpo para trocar de raia' },
  athletics: { name: 'Atletismo', tagline: 'Estádio Resort', howTo: 'Corra no lugar: quanto mais intensa a corrida, mais rápido o seu Mii' },
  tennis: { name: 'Tênis', tagline: 'Quadra central', howTo: 'Balance o braço como uma raquete para rebater' },
  boxing: { name: 'Boxe', tagline: 'Noite de luta', howTo: 'Soque para a frente, levante a guarda e incline o corpo para esquivar' },
};

interface Props {
  sport: Sport;
  goal: Goal;
  onGoal: (goal: Goal) => void;
  boxingSetup: BoxingSetup;
  onBoxingSetup: (setup: BoxingSetup) => void;
  onPlay: () => void;
  onBack: () => void;
}

/** Tela de entrada de cada jogo: a partida (e a câmera de pose) só começa no botão Jogar. */
export function GameLobby({ sport, goal, onGoal, boxingSetup, onBoxingSetup, onPlay, onBack }: Props) {
  const { name, tagline, howTo } = GAMES[sport];
  const controls = HUD_TEXT[sport].controls;

  const option = <T,>(label: string, choices: { value: T; text: string }[], selected: T, pick: (value: T) => void) =>
    <fieldset className="lobby-options">
      <legend>{label}</legend>
      {choices.map((c) => <button key={c.text} type="button" className="dock-btn" aria-pressed={c.value === selected} onClick={() => pick(c.value)}>{c.text}</button>)}
    </fieldset>;

  return <section className={`menu game-lobby ${sport}`} aria-label={name}>
    <img className="lobby-backdrop" src={`/images/games/${sport}.jpg`} alt="" />
    <div className="lobby-stage">
      <header className="lobby-title">
        <span>{tagline}</span>
        <h1>{name}</h1>
      </header>
      <div className="lobby-card">
        <div className="lobby-info">
          <h2>Como jogar</h2>
          <p>{howTo}.</p>
          <p className="lobby-keys">Controles: {controls}</p>
          {sport === 'athletics' && option('Distância', GOALS.map((m) => ({ value: m, text: `${m} m` })), goal, onGoal)}
          {sport === 'boxing' && option('Adversário', OPPONENT_PROFILES.map((p) => ({ value: p.id, text: p.label })), boxingSetup.opponent, (opponent) => onBoxingSetup({ ...boxingSetup, opponent }))}
        </div>
      </div>
      <LobbyActions onPlay={onPlay} onBack={onBack} />
    </div>
  </section>;
}

const IRON_STAGES = ['Atletismo · 100 m', 'Tênis', 'Boxe'];

/** Entrada do desafio Iron Man: as três modalidades em sequência. */
export function IronManLobby({ onPlay, onBack }: { onPlay: () => void; onBack: () => void }) {
  return <section className="menu game-lobby ironman" aria-label="Iron Man">
    <div className="lobby-backdrop lobby-trio">
      {['athletics', 'tennis', 'boxing'].map((sport) => <img key={sport} src={`/images/games/${sport}.jpg`} alt="" />)}
    </div>
    <div className="lobby-stage">
      <header className="lobby-title">
        <span>NeverGear Sports</span>
        <h1>Iron Man</h1>
      </header>
      <div className="lobby-card">
        <div className="lobby-info">
          <h2>O desafio</h2>
          <p>Três modalidades em sequência, sem voltar ao menu. No fim, você vê o resumo de cada etapa.</p>
          <ol>{IRON_STAGES.map((stage) => <li key={stage}>{stage}</li>)}</ol>
        </div>
      </div>
      <LobbyActions onPlay={onPlay} onBack={onBack} />
    </div>
  </section>;
}

function LobbyActions({ onPlay, onBack }: { onPlay: () => void; onBack: () => void }) {
  return <div className="lobby-actions">
    <button type="button" className="nevergear-btn pill lobby-back" onClick={onBack}>Voltar</button>
    <button type="button" className="nevergear-btn pill lobby-play" onClick={onPlay}>Jogar</button>
  </div>;
}
