// Mark which section of a long page you are currently reading, in its table of contents.
//
// Progressive enhancement only: without this file the contents list is still a working set of anchors,
// which is the part that matters for people and for search engines. This adds the highlight.
//
// It tracks the LAST heading to have crossed the top of the viewport rather than whichever is currently
// intersecting. Scrolling through a short section otherwise leaves nothing marked — several headings pass
// the fold at once and the "visible" one is ambiguous — and a contents list that clears itself as you read
// is worse than one that never lit up at all.
(function () {
  const toc = document.querySelector('.toc');
  if (!toc) return;

  const links = new Map();
  for (const a of toc.querySelectorAll('a[href^="#"]')) {
    const el = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
    if (el) links.set(el, a);
  }
  if (!links.size) return;

  const headings = [...links.keys()];
  let current = null;

  function mark(el) {
    if (el === current) return;
    if (current) links.get(current).removeAttribute('aria-current');
    current = el;
    if (current) links.get(current).setAttribute('aria-current', 'true');
  }

  // The sticky site header covers the top of the viewport, so "crossed the top" means crossed below it.
  const offset = () => (document.querySelector('header')?.getBoundingClientRect().height || 0) + 12;

  function update() {
    const limit = offset();
    let found = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= limit) found = h; else break;
    }
    // Before the first heading, keep the first entry marked rather than nothing: the reader is in the
    // page's opening section, which is what that entry stands for.
    mark(found || headings[0]);
  }

  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  addEventListener('resize', update, { passive: true });
  update();
})();
