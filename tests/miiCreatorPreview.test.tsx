// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createMiiStage } from '../src/miis/miiStage';
import { MiiCreator } from '../src/ui/MiiCreator';
import { LangProvider } from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/miis/miiStage', () => ({ createMiiStage: vi.fn(() => undefined) }));

it('frames the editor head from its face side, not with the full-body camera', () => {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root.render(createElement(LangProvider, null, createElement(MiiCreator, { onClose: () => undefined }))));
  const { camera } = vi.mocked(createMiiStage).mock.calls[0]![1]!;
  // The head sits at the origin and faces -Z: the camera must be close, level and on that side.
  expect(camera!.position[2]).toBeLessThan(0);
  expect(camera!.lookAt).toEqual([0, 0, 0]);
  act(() => root.unmount());
});
