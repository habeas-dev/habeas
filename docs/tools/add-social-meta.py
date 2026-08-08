#!/usr/bin/env python3
"""One-shot helper: add the Open Graph / Twitter card block to every indexable page in docs/.

Each page's og:url, og:title and og:description are derived from its own <link rel=canonical>,
<title> and <meta name=description>, so nothing has to be kept in sync by hand. Idempotent:
re-running leaves already-tagged pages untouched.
"""
import re
import pathlib
import sys

DOCS = pathlib.Path(__file__).resolve().parent.parent
IMAGE = "https://habeas.dev/og-image.png"
PAGES = ["index.html", "why-habeas.html", "sources.html", "architecture.html", "privacy.html", "terms.html"]


def grab(pattern, html, label, page):
    m = re.search(pattern, html, re.S)
    if not m:
        sys.exit(f"{page}: no {label} found")
    return m.group(1).strip()


def build_block(title, desc, url):
    return "\n".join([
        f'  <meta property="og:type" content="website" />',
        f'  <meta property="og:url" content="{url}" />',
        f'  <meta property="og:title" content="{title}" />',
        f'  <meta property="og:description" content="{desc}" />',
        f'  <meta property="og:image" content="{IMAGE}" />',
        f'  <meta property="og:image:width" content="1200" />',
        f'  <meta property="og:image:height" content="630" />',
        f'  <meta property="og:image:alt" content="Habeas — export your own data. Receipts, invoices and statements, from your own browser session." />',
        f'  <meta property="og:site_name" content="Habeas" />',
        f'  <meta name="twitter:card" content="summary_large_image" />',
    ])


changed = []
for page in PAGES:
    path = DOCS / page
    html = path.read_text(encoding="utf-8")
    if 'property="og:image"' in html:
        continue
    title = grab(r"<title>(.*?)</title>", html, "<title>", page)
    desc = grab(r'<meta name="description" content="(.*?)"\s*/?>', html, "description", page)
    url = grab(r'<link rel="canonical" href="(.*?)"', html, "canonical", page)

    # Drop any partial og:* tags already present; the new block supersedes them.
    html = re.sub(r'[ \t]*<meta property="og:(?:type|url|title|description|site_name)"[^>]*>\n', "", html)
    block = build_block(title, desc, url)
    # Insert right before </head> so it sits after the page's own <style>/<link> tags.
    html = re.sub(r"([ \t]*)</head>", block + r"\n\1</head>", html, count=1)
    path.write_text(html, encoding="utf-8")
    changed.append(page)

print("tagged:", ", ".join(changed) if changed else "nothing (all pages already have og:image)")
