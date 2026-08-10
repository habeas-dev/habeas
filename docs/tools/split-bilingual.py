#!/usr/bin/env python3
"""Split a page that carries both languages in one document into one indexable URL per language.

    python3 docs/tools/split-bilingual.py <page.html> <es/target.html> --es-title "…" --es-desc "…"

Pages built with `data-lang-content` blocks show one language and `hidden` the other. Google sees two
languages under a single URL, reads it as duplicate content, and has no way to serve the Spanish one to
Spanish searchers — while the Spanish nav links to a page that opens in English.

After: the English page keeps its URL with only English, the Spanish copy gets its own URL under /es/,
and the two are linked by hreflang. The language switch navigates between them instead of toggling a
hidden div.

Idempotent per page: refuses to run if the target already exists.
"""
import argparse
import pathlib
import re
import sys

DOCS = pathlib.Path(__file__).resolve().parent.parent
ORIGIN = "https://habeas.dev"


def block(html, lang):
    """(whole element, inner HTML) for a data-lang-content block. The blocks nest <div>s, so walk the
    tag stream to find the matching close rather than regex-matching the first one."""
    m = re.search(rf'<div data-lang-content="{lang}"[^>]*>', html)
    if not m:
        sys.exit(f"could not find the {lang} content block")
    start, inner = m.start(), m.end()
    depth = 1
    for tag in re.finditer(r"<(/?)div\b[^>]*>", html[inner:]):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            return html[start: inner + tag.end()], html[inner: inner + tag.start()].strip("\n")
    sys.exit(f"unbalanced <div> inside the {lang} block")


def dedent(body):
    """The blocks sit one level deeper than <main>; pull them back out."""
    return "\n".join(l[2:] if l.startswith("      ") else l for l in body.split("\n"))


SWITCH = """  <script src="{nav}"></script>
  <script>
    (function () {{
      const KEY = 'habeas-lang', HERE = '{here}', ALT = {{ en: '{en_path}', es: '{es_path}' }};
      document.querySelectorAll('.langswitch button[data-lang]').forEach((b) => {{
        const l = b.getAttribute('data-lang');
        b.setAttribute('aria-pressed', String(l === HERE));
        b.addEventListener('click', () => {{
          try {{ localStorage.setItem(KEY, l); }} catch (e) {{}}
          if (l !== HERE) location.href = ALT[l];
        }});
      }});
      globalThis.habeasApplyTopNavLanguage?.(HERE);
    }})();
  </script>
</body>
</html>
"""

ap = argparse.ArgumentParser()
ap.add_argument("page")
ap.add_argument("target")
ap.add_argument("--es-title", required=True)
ap.add_argument("--es-desc", required=True)
a = ap.parse_args()

en_path_file = DOCS / a.page
es_path_file = DOCS / a.target
if es_path_file.exists():
    sys.exit(f"{a.target} already exists — nothing to do")

html = en_path_file.read_text(encoding="utf-8")
en_url = f"{ORIGIN}/{a.page}"
es_url = f"{ORIGIN}/{a.target}"
en_path, es_path = f"/{a.page}", f"/{a.target}"

en_div, en_body = block(html, "en")
es_div, es_body = block(html, "es")
head = html[: html.index("</head>")]

hreflang = (
    f'  <link rel="alternate" hreflang="en" href="{en_url}" />\n'
    f'  <link rel="alternate" hreflang="es" href="{es_url}" />\n'
    f'  <link rel="alternate" hreflang="x-default" href="{en_url}" />\n'
)

# --- English page: drop the Spanish block, add hreflang, navigate on switch ---------------------
script_at = html.index('  <script src="nav-i18n.js">')
en_html = html.replace(es_div + "\n", "").replace(en_div, dedent(en_body))
en_html = en_html.replace("</head>", hreflang + "</head>", 1)
en_html = en_html[: en_html.index('  <script src="nav-i18n.js">')] + SWITCH.format(
    nav="nav-i18n.js", here="en", en_path=en_path, es_path=es_path)
en_path_file.write_text(en_html, encoding="utf-8")

# --- Spanish page: same shell, Spanish head, root-absolute assets -------------------------------
es_head = head.replace('<html lang="en">', '<html lang="es">')
es_head = re.sub(r"<title>.*?</title>", f"<title>{a.es_title}</title>", es_head, flags=re.S)
es_head = re.sub(r'(<meta name="description" content=")(.*?)(")', rf"\g<1>{a.es_desc}\g<3>", es_head, flags=re.S)
es_head = es_head.replace(f'href="{en_url}"', f'href="{es_url}"')          # canonical
es_head = es_head.replace(f'content="{en_url}"', f'content="{es_url}"')     # og:url
es_head = re.sub(r'(<meta property="og:title" content=")(.*?)(")', rf"\g<1>{a.es_title}\g<3>", es_head, flags=re.S)
es_head = re.sub(r'(<meta property="og:description" content=")(.*?)(")', rf"\g<1>{a.es_desc}\g<3>", es_head, flags=re.S)
for asset in ("logo.svg", "logo-light.svg", "style.css"):
    es_head = es_head.replace(f'"{asset}"', f'"/{asset}"')
es_head += hreflang + "</head>\n"

shell = html[html.index("<body>"): html.index('  <main class="doc">')]
for asset in ("logo.svg", "logo-light.svg"):
    shell = shell.replace(f'"{asset}"', f'"/{asset}"')
# Static Spanish nav labels — a Spanish page should read as Spanish without waiting for JS.
for en_label, es_label in [
    ('<a href="/">Home</a>', '<a href="/">Inicio</a>'),
    ('<a href="/why-habeas.html">Why Habeas?</a>', '<a href="/es/por-que-habeas.html">Por qué Habeas</a>'),
    ('<a href="/sources.html">Sources</a>', '<a href="/sources.html">Fuentes</a>'),
    ('<a href="/developers.html">Developers</a>', '<a href="/es/desarrolladores.html">Desarrolladores</a>'),
    ('<a href="/architecture.html">Architecture</a>', '<a href="/architecture.html">Arquitectura</a>'),
    ('<a href="/privacy.html">Privacy</a>', '<a href="/privacy.html">Privacidad</a>'),
    ('<a href="/terms.html">Terms</a>', '<a href="/terms.html">Términos</a>'),
]:
    shell = shell.replace(en_label, es_label)
shell = shell.replace('aria-label="Language"', 'aria-label="Idioma"')
shell = shell.replace('<button data-lang="en" aria-pressed="true">EN</button>', '<button data-lang="en" aria-pressed="false">EN</button>')
shell = shell.replace('<button data-lang="es" aria-pressed="false">ES</button>', '<button data-lang="es" aria-pressed="true">ES</button>')

es_html = es_head + shell + '  <main class="doc">\n' + dedent(es_body) + "\n  </main>\n\n" + SWITCH.format(
    nav="/nav-i18n.js", here="es", en_path=en_path, es_path=es_path)
es_path_file.parent.mkdir(parents=True, exist_ok=True)
es_path_file.write_text(es_html, encoding="utf-8")

print(f"wrote {a.target} ({len(es_html)} bytes)")
print(f"rewrote {a.page} (English only, {len(en_html)} bytes)")
