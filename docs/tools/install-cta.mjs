// The install call to action, in one place.
//
// It appeared verbatim in three templates, and keeping three copies in step failed the first time it was
// touched: moving the buttons into the guide index's header left the old pair sitting in the body, so the
// page offered "Install on Chrome" twice, one set under the other. One function, three callers.
//
// It renders as an aside — a column beside the text, not a block interrupting it. A reader who has already
// decided should not have to scroll back to a button, and a reader who has not should not be stopped
// mid-sentence by one.
export const CWS = 'https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog';
export const AMO = 'https://addons.mozilla.org/firefox/addon/habeas/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param t     the page's string table (installChrome, installFirefox, installLead, chromeNote)
 * @param where value for data-umami-event-source, so each placement is measurable on its own
 */
export function installAside(t, where) {
  return `<aside class="install-cta" aria-label="${esc(t.installChrome)}">
      <a class="btn" data-browser="chrome" href="${CWS}" data-umami-event="install" data-umami-event-store="chrome" data-umami-event-source="${esc(where)}">${esc(t.installChrome)}</a>
      <a class="btn" data-browser="firefox" href="${AMO}" data-umami-event="install" data-umami-event-store="firefox" data-umami-event-source="${esc(where)}">${esc(t.installFirefox)}</a>
      <p class="note">${esc(t.installLead)}</p>
      <p class="note">${esc(t.chromeNote)}</p>
    </aside>
    <script defer src="/install-cta.js"></script>`;
}
