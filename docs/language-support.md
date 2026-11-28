# Language support

The site and game interface support Portuguese and English. On first launch, the app checks the browser's `navigator.languages` list and selects the first supported language it finds. Browsers commonly populate this list from the user's language preferences, which may follow operating-system settings; the app does not read the operating system directly. It uses `navigator.language` if the list is empty and falls back to English when neither preference is Portuguese or English.

The language switcher is available on the website and remains visible in the arena. Choosing a language saves it in `localStorage` under `nevergear-lang`, so that explicit choice takes precedence over browser preferences on later visits. If browser storage is unavailable, the selection lasts only until the page is closed.

The active language is provided through `LangProvider` in `src/i18n.tsx`. It also sets the document's `lang` attribute and exposes the corresponding locale for dates and formatting. Game engines receive the selected language when created and expose `setLanguage` so an in-progress game can update its text without restarting.

The English and Portuguese article sources are kept separately under `src/data/articles-en/` and `src/data/articles-pt/`. The research documents under `docs/research/` remain English documentation; the site does not use those documentation files as its Portuguese article source.
