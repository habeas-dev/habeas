// Highlight the install button for the browser you are actually using.
//
// Both buttons ship neutral, and this promotes one. That order matters: without JavaScript, or on a
// browser Habeas does not support, neither stands out — which is the honest default. Marking Chrome as
// the primary action for a Firefox reader is a small lie the page tells about a hundred times a day.
//
// Chromium covers Chrome, Edge, Brave, Opera and Vivaldi: they all install the same package from the
// Chrome Web Store. Safari matches nothing, and that is correct — there is no build for it, so the page
// should not imply there is.
(function () {
  const asides = document.querySelectorAll('.install-cta');
  if (!asides.length) return;

  const ua = navigator.userAgent;
  // Firefox first: its user agent does not contain "Chrome", but checking the other way round is the
  // classic way to mistake every Chromium fork for Chrome and Firefox for nothing.
  const here = /Firefox\//.test(ua) ? 'firefox'
    : (/Chrome\/|Chromium\//.test(ua) && !/Edg?A\//.test(ua)) ? 'chrome'
    : null;
  if (!here) return;

  for (const aside of asides) {
    const btn = aside.querySelector(`[data-browser="${here}"]`);
    if (btn) btn.classList.add('primary');
  }
})();
