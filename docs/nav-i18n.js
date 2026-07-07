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

  function applyTopNavLanguage(lang) {
    const dict = LABELS[lang] || LABELS.en;
    document.querySelectorAll('header nav a[href]').forEach((link) => {
      const key = link.getAttribute('href');
      if (dict[key]) link.textContent = dict[key];
    });
    const switcher = document.querySelector('header nav .langswitch');
    if (switcher) switcher.setAttribute('aria-label', dict.langswitch);
  }

  globalThis.habeasApplyTopNavLanguage = applyTopNavLanguage;
})();
