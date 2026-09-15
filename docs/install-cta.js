// Show the install button for the browser you are actually using, and fold the rest away.
//
// Progressive enhancement, in this order:
//
//   1. Without JavaScript the page ships every button, visible and neutral. That is the honest default:
//      nothing is hidden behind a script, and a reader on an unsupported browser is not told a build
//      exists for them. It is also what search engines and link previews see.
//   2. With JavaScript, the button for the detected browser is promoted and the others move into a
//      disclosure. Marking Chrome as the primary action for a Firefox reader is a small lie the page
//      tells about a hundred times a day; showing three buttons when two are wrong is only a quieter
//      version of the same lie.
//   3. On a browser we do not recognise (Safari, and anything new), nothing is promoted and nothing is
//      folded. Neutral is the correct answer when we do not know.
//
// Edge earns its own entry rather than riding the Chromium button: it installs the same package from a
// DIFFERENT store, and sending an Edge user to the Chrome Web Store makes the browser interrupt the
// install with a "this extension comes from another store" warning — the worst possible first contact
// for a tool that asks to sit inside your banking session. The Edge anchor is built here rather than
// written into all 51 guide pages, so the markup stays two buttons and every page inherits the third.
(function () {
  const asides = document.querySelectorAll('.install-cta');
  if (!asides.length) return;

  const EDGE_URL = 'https://microsoftedge.microsoft.com/addons/detail/habeas-%E2%80%94-descarga-tickets/clcjdklighbiegkncdicfbgkeahjmaoa';

  const STRINGS = {
    en: { edge: 'Install on Edge', others: 'Install on other browsers',
      othersMethods: 'Other browsers and ways to install' },
    es: { edge: 'Instalar en Edge', others: 'Instalar en otros navegadores',
      othersMethods: 'Otros navegadores y formas de instalar' },
  };
  const t = STRINGS[(document.documentElement.lang || 'en').slice(0, 2)] || STRINGS.en;

  const ua = navigator.userAgent;
  // Order matters. Firefox first: its user agent carries no "Chrome", and testing the other way round is
  // the classic way to mistake every Chromium fork for Chrome and Firefox for nothing. Edge before
  // Chrome for the same reason — desktop Edge is "Edg/" and DOES carry "Chrome/", so a plain Chrome test
  // swallows it. ("EdgA/" and "EdgiOS/" are Edge on Android and iOS, where no extension store applies.)
  const here = /Firefox\//.test(ua) ? 'firefox'
    : /EdgA\/|EdgiOS\//.test(ua) ? null
      : /Edg\//.test(ua) ? 'edge'
        : /Chrome\/|Chromium\//.test(ua) ? 'chrome'
          : null;
  if (!here) return;

  for (const aside of asides) {
    const chrome = aside.querySelector('[data-browser="chrome"]');

    // Two shapes share this logic. The guide aside is a bare list of buttons, so the unit that gets
    // promoted or folded IS the button. The home panel wraps each button in an `.opt` that also carries
    // its icon, heading, description and caveats — there the unit is the whole block, so an option never
    // gets separated from the copy that explains it, and the Chrome trust notes fold away with Chrome.
    const opts = [...aside.querySelectorAll('.opt')];

    // Build the Edge anchor from the Chrome one so it inherits the page's own classes and, crucially,
    // its data-umami-event-source — the per-page attribution the funnel report is keyed on. Skipped
    // wherever an Edge option is already written into the markup, copy and all.
    if (chrome && !opts.length && !aside.querySelector('[data-browser="edge"]')) {
      const edge = chrome.cloneNode(true);
      edge.setAttribute('data-browser', 'edge');
      edge.href = EDGE_URL;
      edge.setAttribute('data-umami-event-store', 'edge');
      // sources.html re-translates on language switch through its own data-t dictionary; point the clone
      // at its own key so a later pass does not relabel this button "Install on Chrome".
      if (edge.hasAttribute('data-t')) edge.setAttribute('data-t', 'installEdge');
      if (edge.hasAttribute('data-i18n')) edge.setAttribute('data-i18n', 'install_edge_cta');
      edge.textContent = t.edge;
      edge.classList.remove('primary');
      chrome.insertAdjacentElement('afterend', edge);
    }

    // `units` are what moves; `mine` is the one to promote. An option with no [data-browser] — the
    // unpacked build — matches no browser and so is always an alternative, which is correct: it is a
    // method, not a store.
    const units = opts.length ? opts : [...aside.querySelectorAll('[data-browser]')];
    const mine = units.find((u) => (u.matches('[data-browser]') ? u : u.querySelector('[data-browser]'))
      ?.getAttribute('data-browser') === here);
    if (!mine) continue;

    (mine.matches('[data-browser]') ? mine : mine.querySelector('[data-browser]')).classList.add('primary');

    const others = units.filter((u) => u !== mine);
    if (!others.length) continue;

    const details = document.createElement('details');
    details.className = 'install-others';
    const summary = document.createElement('summary');
    const methods = aside.dataset.othersLabel === 'methods';
    summary.textContent = methods ? t.othersMethods : t.others;
    // Guides are static per language and carry no i18n runtime, so the text above is final there. The
    // home does translate at DOMContentLoaded — after this deferred script — so it needs the key too, or
    // a Spanish reader gets an English summary over Spanish buttons.
    summary.setAttribute('data-i18n', methods ? 'install_others_methods_h' : 'install_others_h');
    details.append(summary, ...others);
    mine.insertAdjacentElement('afterend', details);

    // A caveat belongs to the option it is about. In the home panel that is structural — the note lives
    // inside its `.opt` and folds with it. The guide aside is flat, so the note says which button it
    // belongs to and follows it in: a Firefox reader should not be warned about a Chrome Web Store
    // notice they will never see. A note whose browser IS the promoted one simply stays put.
    for (const note of aside.querySelectorAll('[data-browser-note]')) {
      const owner = note.getAttribute('data-browser-note');
      if (owner === here) continue;
      details.querySelector(`[data-browser="${owner}"]`)?.insertAdjacentElement('afterend', note);
    }
  }
})();
