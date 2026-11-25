import type { Sport } from './GameCanvas';

export function ArenaHub({ sport, onSport }: { sport: Sport; onSport: (sport: Sport) => void }) {
  return <div className="sport-switch" role="tablist" aria-label="Modalidades">
    <button type="button" role="tab" aria-selected={sport === 'track'} className={sport === 'track' ? 'active' : ''} onClick={() => onSport('track')}>
      <span className="sport-number">01</span><span><strong>Hurdle Rush</strong><small>Corrida com obstáculos · esporte herói</small></span><span className="sport-arrow">↗</span>
    </button>
    <button type="button" role="tab" aria-selected={sport === 'tennis'} className={sport === 'tennis' ? 'active' : ''} onClick={() => onSport('tennis')}>
      <span className="sport-number">02</span><span><strong>Baseline Rally</strong><small>Tênis arcade · vertical slice</small></span><span className="sport-arrow">↗</span>
    </button>
  </div>;
}
