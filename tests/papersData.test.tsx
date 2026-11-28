// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it } from 'vitest';
import { papers } from '../src/data/papers';
import { LangProvider } from '../src/i18n';
import ArticlePage from '../src/pages/ArticlePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("labels our drafts with their own names, never with another author's work", () => {
  localStorage.setItem('nevergear-lang', 'pt');
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const page = createElement(Routes, null, createElement(Route, { path: '/papers/:n', element: createElement(ArticlePage) }));
  act(() => root.render(createElement(LangProvider, null, createElement(MemoryRouter, { initialEntries: ['/papers/01'] }, page))));
  const nav = container.querySelector('.article-nav')!.textContent;
  expect(nav).toContain('02 tempo de resposta');
  expect(nav).not.toContain(papers[1]!.short);
  act(() => root.unmount());
});

it('sends every external reference to its publication', () => {
  for (const paper of papers) expect(paper.externalUrl).toMatch(/^https:\/\/(arxiv\.org|doi\.org|www\.degruyter\.com)\//);
});
