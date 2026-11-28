// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { BoxingHudState } from '../src/games/boxing/BoxingGame';
import { DEFAULT_BOXING_SETUP } from '../src/games/boxing/boxingSetup';
import { OPPONENT_PROFILES } from '../src/games/boxing/opponentProfiles';
import { GameCanvas } from '../src/ui/GameCanvas';
import { GameLobby } from '../src/ui/GameLobby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface BoxingOptions {
  tutorial?: boolean;
  holdResult?: boolean;
  opponent?: string;
  motionRng?: () => number;
  onPunchTravel?: (travel: number) => void;
}

const boxingInstances = vi.hoisted(() => [] as { options?: BoxingOptions; updateHud: (state: BoxingHudState) => void }[]);

vi.mock('../src/games/boxing/BoxingGame', () => ({
  BoxingGame: class {
    constructor(
      _canvas: HTMLCanvasElement,
      updateHud: (state: BoxingHudState) => void,
      _audio?: unknown,
      _rng?: unknown,
      options?: BoxingOptions,
    ) {
      boxingInstances.push({ options, updateHud });
    }

    dispose(): void {}
  },
}));

it('renders Adversário options and omits removed mode buttons in GameLobby for boxing', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <GameLobby
          sport="boxing"
          goal={100}
          onGoal={() => {}}
          boxingSetup={DEFAULT_BOXING_SETUP}
          onBoxingSetup={() => {}}
          onPlay={() => {}}
          onBack={() => {}}
        />,
      );
    });

    const legends = [...container.querySelectorAll('legend')].map((el) => el.textContent);
    expect(legends).toContain('Adversário');
    expect(legends).not.toContain('Modo');

    const buttonLabels = [...container.querySelectorAll('button')].map((el) => el.textContent);
    for (const profile of OPPONENT_PROFILES) {
      expect(buttonLabels).toContain(profile.label);
    }
    expect(buttonLabels).not.toContain('Saco de Pancada');
    expect(buttonLabels).not.toContain('Esquiva');
    expect(buttonLabels).not.toContain('Tutorial');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

it('passes tutorial: true on mount and renders ADVERSÁRIO buttons when selectionOpen is true in GameCanvas', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  boxingInstances.length = 0;

  try {
    await act(async () => {
      root.render(<GameCanvas sport="boxing" onEngine={() => {}} tracking="TRACKING" />);
    });

    expect(boxingInstances).toHaveLength(1);
    expect(boxingInstances[0]!.options?.tutorial).toBe(true);

    await act(async () => {
      boxingInstances[0]!.updateHud({
        score: 100,
        label: '100',
        speed01: 0,
        status: 'Prepare-se',
        boxing: {
          playerHp: 100,
          opponentHp: 100,
          maxHp: 100,
          round: 1,
          rounds: 3,
          secondsLeft: 90,
          selectionOpen: true,
        },
      });
    });

    const setupFieldset = container.querySelector('fieldset.boxing-setup');
    expect(setupFieldset).not.toBeNull();
    expect(setupFieldset!.textContent).toContain('ADVERSÁRIO');
    expect(setupFieldset!.textContent).not.toContain('MODO');

    const setupButtons = [...setupFieldset!.querySelectorAll('button')].map((el) => el.textContent);
    for (const profile of OPPONENT_PROFILES) {
      expect(setupButtons).toContain(profile.label);
    }
    expect(setupButtons).not.toContain('Saco de Pancada');
    expect(setupButtons).not.toContain('Esquiva');
    expect(setupButtons).not.toContain('Tutorial');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
