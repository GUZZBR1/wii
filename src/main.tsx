// First, so saved data is renamed before anything reads it.
import './lib/migrateStorage';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App';
import { LangProvider } from './i18n';
import './site.css';

// The drawing studio was removed from the site; clear the data it left in this browser.
try {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('draw-studio-')) localStorage.removeItem(key);
  }
} catch { /* Without storage, there is nothing to clear. */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Navigation must not be a transition: the hand pointer updates state every camera frame and starves it. */}
    <BrowserRouter useTransitions={false}>
      <LangProvider>
        <App />
      </LangProvider>
    </BrowserRouter>
  </StrictMode>,
);
