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
    en: { edge: 'Install on Edge', others: 'Install on other browsers' },
    es: { edge: 'Instalar en Edge', others: 'Instalar en otros navegadores' },
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

    // Build the Edge anchor from the Chrome one so it inherits the page's own classes and, crucially,
    // its data-umami-event-source — the per-page attribution the funnel report is keyed on.
    if (chrome && !aside.querySelector('[data-browser="edge"]')) {
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

    const buttons = [...aside.querySelectorAll('[data-browser]')];
    const mine = buttons.find((b) => b.getAttribute('data-browser') === here);
    if (!mine) continue;

    mine.classList.add('primary');

    const others = buttons.filter((b) => b !== mine);
    if (!others.length) continue;

    const details = document.createElement('details');
    details.className = 'install-others';
    const summary = document.createElement('summary');
    summary.textContent = t.others;
    details.append(summary, ...others);
    mine.insertAdjacentElement('afterend', details);
  }
})();
