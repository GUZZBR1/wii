import { GOALS, type Goal } from '../games/athletics/race';
import { BOXING_MODES } from '../games/boxing/boxingModes';
import { OPPONENT_PROFILES } from '../games/boxing/opponentProfiles';
import type { BoxingSetup } from '../games/boxing/boxingSetup';
import type { Sport } from './GameCanvas';
import { BOXING_TRAINING_CONTROLS, HUD_TEXT } from './hudText';
import { useLang, type Bilingual } from '../i18n';

const GAMES: Record<Sport, { name: Bilingual; tagline: Bilingual; howTo: Bilingual }> = {
  track: { name: { pt: 'Corrida', en: 'Track' }, tagline: { pt: 'Arena de corrida', en: 'Track arena' }, howTo: { pt: 'Corra no lugar, pule e incline o corpo para trocar de raia', en: 'Run in place, jump, and lean to change lanes' } },
  athletics: { name: { pt: 'Atletismo', en: 'Athletics' }, tagline: { pt: 'Estádio Resort', en: 'Resort Stadium' }, howTo: { pt: 'Corra no lugar: quanto mais intensa a corrida, mais rápido o seu Mii', en: 'Run in place. The faster you run, the faster your Mii moves' } },
  tennis: { name: { pt: 'Tênis', en: 'Tennis' }, tagline: { pt: 'Quadra central', en: 'Center court' }, howTo: { pt: 'Balance o braço como uma raquete para rebater', en: 'Swing your arm like a racket to hit the ball' } },
  boxing: { name: { pt: 'Boxe', en: 'Boxing' }, tagline: { pt: 'Noite de luta', en: 'Fight night' }, howTo: { pt: 'Soque para a frente, levante a guarda e incline o corpo para esquivar', en: 'Punch forward, raise your guard, and lean to dodge' } },
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

/** Game entry screen: the match and pose camera start only when Play is selected. */
export function GameLobby({ sport, goal, onGoal, boxingSetup, onBoxingSetup, onPlay, onBack }: Props) {
  const { lang, tr } = useLang();
  const game = GAMES[sport];
  const controls = sport === 'boxing' && (boxingSetup.mode === 'bag' || boxingSetup.mode === 'dodge')
    ? BOXING_TRAINING_CONTROLS[boxingSetup.mode][lang]
    : HUD_TEXT[sport].controls[lang];

  const option = <T,>(label: string, choices: { value: T; text: string }[], selected: T, pick: (value: T) => void) =>
    <fieldset className="lobby-options">
      <legend>{label}</legend>
      {choices.map((choice) => <button key={choice.text} type="button" className="dock-btn" aria-pressed={choice.value === selected} onClick={() => pick(choice.value)}>{choice.text}</button>)}
    </fieldset>;

  return <section className={`menu game-lobby ${sport}`} aria-label={game.name[lang]}>
    <img className="lobby-backdrop" src={`/images/games/${sport}.jpg`} alt="" />
    <div className="lobby-stage">
      <header className="lobby-title">
        <span>{game.tagline[lang]}</span>
        <h1>{game.name[lang]}</h1>
      </header>
      <div className="lobby-card">
        <div className="lobby-info">
          <h2>{tr('Como jogar', 'How to play')}</h2>
          <p>{game.howTo[lang]}.</p>
          <p className="lobby-keys">{tr('Controles', 'Controls')}: {controls}</p>
          {sport === 'athletics' && option(tr('Distância', 'Distance'), GOALS.map((metres) => ({ value: metres, text: `${metres} m` })), goal, onGoal)}
          {sport === 'boxing' && option(tr('Modo', 'Mode'), BOXING_MODES.map((mode) => ({ value: mode.id, text: lang === 'pt' ? mode.label : mode.labelEn })), boxingSetup.mode, (mode) => onBoxingSetup({ ...boxingSetup, mode }))}
          {sport === 'boxing' && boxingSetup.mode === 'fight' && option(tr('Adversário', 'Opponent'), OPPONENT_PROFILES.map((profile) => ({ value: profile.id, text: lang === 'pt' ? profile.label : profile.labelEn })), boxingSetup.opponent, (opponent) => onBoxingSetup({ ...boxingSetup, opponent }))}
        </div>
      </div>
      <LobbyActions onPlay={onPlay} onBack={onBack} />
    </div>
  </section>;
}

const IRON_STAGES: Bilingual[] = [
  { pt: 'Atletismo · 100 m', en: 'Athletics · 100 m' },
  { pt: 'Tênis', en: 'Tennis' },
  { pt: 'Boxe', en: 'Boxing' },
];

/** Entry screen for the three-event Iron Man challenge. */
export function IronManLobby({ onPlay, onBack }: { onPlay: () => void; onBack: () => void }) {
  const { lang, tr } = useLang();
  return <section className="menu game-lobby ironman" aria-label="Iron Man">
    <div className="lobby-backdrop lobby-trio">
      {['athletics', 'tennis', 'boxing'].map((sport) => <img key={sport} src={`/images/games/${sport}.jpg`} alt="" />)}
    </div>
    <div className="lobby-stage">
      <header className="lobby-title">
        <span>Nevergear Sports</span>
        <h1>Iron Man</h1>
      </header>
      <div className="lobby-card">
        <div className="lobby-info">
          <h2>{tr('O desafio', 'The challenge')}</h2>
          <p>{tr('Três modalidades em sequência, sem voltar ao menu. No fim, você vê o resumo de cada etapa.', 'Play three sports in a row without returning to the menu. See a summary of each stage at the end.')}</p>
          <ol>{IRON_STAGES.map((stage) => <li key={stage.en}>{stage[lang]}</li>)}</ol>
        </div>
      </div>
      <LobbyActions onPlay={onPlay} onBack={onBack} />
    </div>
  </section>;
}

function LobbyActions({ onPlay, onBack }: { onPlay: () => void; onBack: () => void }) {
  const { tr } = useLang();
  return <div className="lobby-actions">
    <button type="button" className="nevergear-btn pill lobby-back" onClick={onBack}>{tr('Voltar', 'Back')}</button>
    <button type="button" className="nevergear-btn pill lobby-play" onClick={onPlay}>{tr('Jogar', 'Play')}</button>
  </div>;
}
