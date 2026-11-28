// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { LangProvider, resolveLanguage, useLang } from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LanguageControl() {
  const { lang, setLang } = useLang();
  return <button type="button" onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}>{lang}</button>;
}

it('uses the saved language before browser preferences and falls back to a supported browser language', () => {
  expect(resolveLanguage('pt', ['en-US'])).toBe('pt');
  expect(resolveLanguage('en', ['pt-BR'])).toBe('en');
  expect(resolveLanguage(null, ['fr-FR', 'pt-BR', 'en-US'])).toBe('pt');
  expect(resolveLanguage(null, ['fr-FR', 'en-US'])).toBe('en');
  expect(resolveLanguage(null, ['fr-FR'])).toBe('en');
});

it('persists manual language changes and updates the document language', async () => {
  localStorage.setItem('nevergear-lang', 'pt');
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LangProvider><LanguageControl /></LangProvider>));
    expect(container.textContent).toBe('pt');
    expect(document.documentElement.lang).toBe('pt-BR');
    await act(async () => { container.querySelector('button')?.click(); });
    expect(container.textContent).toBe('en');
    expect(localStorage.getItem('nevergear-lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.removeItem('nevergear-lang');
  }
});
