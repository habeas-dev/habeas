#!/usr/bin/env python3
"""Add JSON-LD structured data: SoftwareApplication on the home page, FAQPage on the two
why-habeas pages.

The FAQ entries are extracted from each page's own <h2>/<p> content rather than written by hand,
so the markup cannot drift from what a visitor actually reads — which is what Google requires of
structured data. Idempotent: pages that already carry a ld+json block are skipped.
"""
import html as htmllib
import json
import pathlib
import re
import sys

DOCS = pathlib.Path(__file__).resolve().parent.parent

SOFTWARE = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Habeas",
    "url": "https://habeas.dev/",
    "applicationCategory": "BrowserApplication",
    "operatingSystem": "Chrome, Edge, Brave, Opera, Firefox",
    "browserRequirements": "Chromium-based browser, or Firefox 128 and newer",
    "description": ("Open-source browser extension that extracts your own receipts, invoices, statements "
                    "and transaction records from services with no usable export, entirely inside your "
                    "already-authenticated browser session — no stored credentials, no server-side scraping."),
    "isAccessibleForFree": True,
    "license": "https://www.gnu.org/licenses/agpl-3.0.html",
    "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
    "downloadUrl": [
        "https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog",
        "https://addons.mozilla.org/firefox/addon/habeas/",
    ],
    "sameAs": [
        "https://github.com/habeas-dev/habeas",
        "https://www.producthunt.com/products/habeas",
    ],
    "author": {"@type": "Organization", "name": "Habeas", "url": "https://habeas.dev/"},
    # No aggregateRating: the stores have no ratings yet, and inventing one would be a lie to Google.
}

FAQ_PAGES = [("why-habeas.html", "en"), ("es/por-que-habeas.html", "es")]


def text_of(fragment):
    """Visible text of an HTML fragment, whitespace-normalised."""
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", htmllib.unescape(fragment)).strip()


def extract_faq(page_html):
    """Each <h2> is a question; its answer is everything up to the next <h2>."""
    main = page_html[page_html.index('<main class="doc">'): page_html.index("</main>")]
    chunks = re.split(r"<h2[^>]*>", main)[1:]
    entries = []
    for chunk in chunks:
        question, _, rest = chunk.partition("</h2>")
        answer = text_of(rest)
        if not answer:
            continue
        entries.append({
            "@type": "Question",
            "name": text_of(question),
            "acceptedAnswer": {"@type": "Answer", "text": answer},
        })
    return entries


def inject(path, payload, indent_note):
    page = path.read_text(encoding="utf-8")
    if "application/ld+json" in page:
        return False
    block = (f'  <!-- {indent_note} -->\n'
             f'  <script type="application/ld+json">\n'
             f'{json.dumps(payload, ensure_ascii=False, indent=2)}\n'
             f'  </script>\n')
    page = re.sub(r"([ \t]*)</head>", block + r"\1</head>", page, count=1)
    path.write_text(page, encoding="utf-8")
    return True


done = []
if inject(DOCS / "index.html", SOFTWARE, "Structured data: the extension itself"):
    done.append("index.html (SoftwareApplication)")

for rel, lang in FAQ_PAGES:
    path = DOCS / rel
    if not path.exists():
        sys.exit(f"{rel} not found — run split-why-habeas.py first")
    entries = extract_faq(path.read_text(encoding="utf-8"))
    if not entries:
        sys.exit(f"{rel}: no questions extracted")
    payload = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "inLanguage": lang,
        "mainEntity": entries,
    }
    if inject(path, payload, f"Structured data: {len(entries)} questions, extracted from the copy below"):
        done.append(f"{rel} (FAQPage, {len(entries)} questions)")

print("added:", "; ".join(done) if done else "nothing (all pages already have JSON-LD)")
