(() => {
  const LABELS = {
    en: {
      '/': 'Home',
      '/why-habeas.html': 'Why Habeas?',
      '/sources.html': 'Sources',
      '/architecture.html': 'Architecture',
      '/privacy.html': 'Privacy',
      '/terms.html': 'Terms',
      'https://github.com/habeas-dev/habeas': 'GitHub',
      langswitch: 'Language',
    },
    es: {
      '/': 'Inicio',
      '/why-habeas.html': 'Por qué Habeas',
      '/sources.html': 'Fuentes',
      '/architecture.html': 'Arquitectura',
      '/privacy.html': 'Privacidad',
      '/terms.html': 'Términos',
      'https://github.com/habeas-dev/habeas': 'GitHub',
      langswitch: 'Idioma',
    },
  };

  // Pages that exist as a real URL per language (rather than a client-side toggle): the nav has to
  // point at the right one, not just relabel the link. Keyed by the English (canonical) path.
  const LOCALIZED = {
    '/why-habeas.html': { en: '/why-habeas.html', es: '/es/por-que-habeas.html' },
  };
  const CANONICAL = {};
  for (const [key, urls] of Object.entries(LOCALIZED)) {
    for (const url of Object.values(urls)) CANONICAL[url] = key;
  }

  // Point every nav link at the current language's URL. Split out from the labelling below because
  // the home page localises its own nav labels via [data-i18n] but still needs the hrefs fixed.
  function localizeNavHrefs(lang) {
    document.querySelectorAll('header nav a[href]').forEach((link) => {
      const href = link.getAttribute('href');
      // Resolve whichever language variant this link currently points at back to its canonical
      // key, so switching language repeatedly stays correct.
      const key = CANONICAL[href] || href;
      const target = LOCALIZED[key]?.[lang] || LOCALIZED[key]?.en;
      if (target && target !== href) link.setAttribute('href', target);
    });
  }

  function applyTopNavLanguage(lang) {
    const dict = LABELS[lang] || LABELS.en;
    localizeNavHrefs(lang);
    document.querySelectorAll('header nav a[href]').forEach((link) => {
      const key = CANONICAL[link.getAttribute('href')] || link.getAttribute('href');
      if (dict[key]) link.textContent = dict[key];
    });
    const switcher = document.querySelector('header nav .langswitch');
    if (switcher) switcher.setAttribute('aria-label', dict.langswitch);
  }

  globalThis.habeasLocalizeNavHrefs = localizeNavHrefs;
  globalThis.habeasApplyTopNavLanguage = applyTopNavLanguage;
})();
