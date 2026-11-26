// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { distanceLabel, finishResult, raceStatus } from '../src/games/athletics/hud';
import { GameCanvas } from '../src/ui/GameCanvas';
import { GamesMenu } from '../src/ui/WiiMenu';

vi.mock('../src/games/athletics/AthleticsGame', () => ({
  AthleticsGame: class {
    constructor(_canvas: HTMLCanvasElement, onHud: (state: unknown) => void) {
      onHud({
        score: 400,
        label: '400 / 400 m',
        speed01: 0,
        status: '0:44.4 · Parado',
        result: {
          title: 'Prova Concluída!',
          detail: 'Tempo 0:44.4 · percurso 400 m',
          time: '0:44.4',
          distance: 400,
        },
      });
    }

    onAction(): void {}
    onKey(): void {}
    setTracking(): void {}
    dispose(): void {}
  },
}));

vi.mock('../src/games/track/TrackGame', () => ({
  TrackGame: class {
    constructor(_canvas: HTMLCanvasElement, onHud: (state: unknown) => void) {
      onHud({
        score: 300,
        label: '00300',
        speed01: 0,
        status: 'Parado',
        result: { points: 300, ranking: [500, 300, 100], position: 2 },
      });
    }

    onAction(): void {}
    onKey(): void {}
    setTracking(): void {}
    dispose(): void {}
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('athletics HUD copy', () => {
  it('formats distance, race status and completion summary', () => {
    expect(distanceLabel(99.9, 400)).toBe('99 / 400 m');
    expect(distanceLabel(401, 400)).toBe('400 / 400 m');
    expect(raceStatus(65.47, 'Correndo')).toBe('1:05.4 · Correndo');
    const result = finishResult(44.47, 400, [
      { meters: 100, seconds: 11.12 },
      { meters: 400, seconds: 44.47 },
    ]);
    expect(result).toMatchObject({ title: 'Prova Concluída!', time: '0:44.4', distance: 400 });
    expect(result.detail).toContain('Tempo 0:44.4 · percurso 400 m');
    expect(result.detail).toContain('100 m 0:11.1');
  });

  it('uses distance and rhythm labels plus athletics controls', () => {
    const html = renderToStaticMarkup(createElement(GameCanvas, {
      sport: 'athletics',
      onEngine: () => {},
      tracking: 'SEM POSE',
    }));
    expect(html).toContain('DISTÂNCIA');
    expect(html).toContain('0 / 400 m');
    expect(html).toContain('RITMO');
    expect(html).toContain('corra no lugar para manter o ritmo');
    expect(html).not.toContain('trocar raia');
  });

  it('lists the 400 m mode in the sports menu and shows its hint', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(GamesMenu, { onPick: () => {}, onBack: () => {}, onHome: () => {} }));
    });
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === 'Maratona 400m');
    expect(button).toBeDefined();
    await act(async () => {
      button!.focus();
    });
    expect(container.querySelector('figcaption')?.textContent).toBe('Circuito olímpico Wii 2.0 guiado pelo ritmo');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps the existing track and tennis labels', () => {
    const props = { onEngine: () => {}, tracking: 'SEM POSE' };
    expect(renderToStaticMarkup(createElement(GameCanvas, { ...props, sport: 'track' }))).toContain('SCORE');
    expect(renderToStaticMarkup(createElement(GameCanvas, { ...props, sport: 'tennis' }))).toContain('MIRA');
  });

  it('keeps the loss ranking dialog for the hurdle runner', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(GameCanvas, {
        sport: 'track',
        onEngine: () => {},
        tracking: 'TRACKING',
      }));
      await vi.dynamicImportSettled();
    });

    expect(container.textContent).toContain('Você perdeu!');
    expect(container.textContent).toContain('300');
    expect(container.textContent).toContain('pontos');
    expect(container.querySelectorAll('.game-over ol li')).toHaveLength(3);
    expect(container.querySelector('.game-over li.current')?.textContent).toBe('2º300');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders a completed race dialog instead of the loss ranking', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(GameCanvas, {
        sport: 'athletics',
        onEngine: () => {},
        tracking: 'TRACKING',
      }));
      await vi.dynamicImportSettled();
    });

    expect(container.textContent).toContain('Prova Concluída!');
    expect(container.textContent).toContain('Tempo 0:44.4 · percurso 400 m');
    expect(container.textContent).not.toContain('Você perdeu!');
    expect(container.textContent).not.toContain('pontos');
    expect(container.querySelector('.game-over ol')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
