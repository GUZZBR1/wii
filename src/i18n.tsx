import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readStored, writeStored } from './lib/storage';

export type Lang = 'pt' | 'en';

const STORAGE_KEY = 'nevergear-lang';

/** Prefer a saved choice, then the first supported browser language, and default to English. */
export function resolveLanguage(saved: string | null, preferred: readonly string[]): Lang {
  if (saved === 'pt' || saved === 'en') return saved;
  const firstSupported = preferred.find((code) => /^(pt|en)(?:-|$)/i.test(code));
  return firstSupported && /^pt(?:-|$)/i.test(firstSupported) ? 'pt' : 'en';
}

function initialLang(): Lang {
  if (typeof navigator === 'undefined') return resolveLanguage(readStored(STORAGE_KEY), []);
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  return resolveLanguage(readStored(STORAGE_KEY), preferred);
}

interface LangValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Select text for the active language: tr('Portuguese', 'English'). */
  tr: <T = string>(pt: T, en: T) => T;
  /** BCP 47 locale for dates and sorting. */
  locale: string;
}

const LangContext = createContext<LangValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writeStored(STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  }, [lang]);

  const value = useMemo<LangValue>(
    () => ({
      lang,
      setLang,
      tr: (pt, en) => (lang === 'pt' ? pt : en),
      locale: lang === 'pt' ? 'pt-BR' : 'en-US',
    }),
    [lang, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangValue {
  const value = useContext(LangContext);
  if (!value) throw new Error('useLang must be used inside <LangProvider>');
  return value;
}

/** Static bilingual text stored as a { pt, en } object. */
export type Bilingual = { pt: string; en: string };
