#!/usr/bin/env node
// Generate one Spanish landing page per source under docs/es/descargar/, merging the live registry
// (streams, formats, gaps, trust) with the curated copy in docs/source-pages.es.json.
//
//     node docs/tools/build-source-pages.mjs              # fetch the live index
//     node docs/tools/build-source-pages.mjs <index.json> # or read a local index
//
// A source with no entry in source-pages.es.json gets NO page. That is deliberate: pages spun from
// a template with nothing source-specific in them are doorway content, which Google's spam policies
// name explicitly and which would put the whole domain at risk. Every generated page states what
// that source actually produces, in what formats, and what it does not cover.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, '..');
const OUT_DIR = join(DOCS, 'es', 'descargar');
const INDEX_URL = 'https://habeas-dev.github.io/sources/index.json';
const CWS = 'https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog';
const AMO = 'https://addons.mozilla.org/firefox/addon/habeas/';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// What each schema actually yields, so "what you get" is accurate rather than generic.
const SCHEMA_ES = {
  'receipt@1': 'cada compra con su fecha, importe, moneda, tienda y categoría',
  'transaction@1': 'cada movimiento con su fecha, importe, moneda, concepto y contraparte',
  'invoice@1': 'cada documento con su fecha, importe, moneda y numeración',
  'investment@1': 'cada posición con su fecha, importe, moneda e instrumento',
};
const FORMAT_ES = { pdf: 'PDF', excel: 'Excel', json: 'JSON', html: 'HTML', xls: 'Excel', csv: 'CSV' };

async function loadIndex() {
  const arg = process.argv[2];
  const raw = arg ? JSON.parse(readFileSync(arg, 'utf8')) : await fetch(INDEX_URL).then((r) => r.json());
  return raw.sources || raw;
}

function outputsOf(full) {
  // A source either declares streams (each its own data set) or is one implicit output.
  if (full.streams?.length) {
    return full.streams.map((s) => ({
      id: s.id,
      schema: s.schema || full.schema,
      formats: (s.formats || []).map((f) => f.id).filter(Boolean),
    }));
  }
  return [{ id: null, schema: full.schema, formats: [] }];
}

function page({ meta, full, copy }) {
  // The registry name is an id-ish label ("Carrefour España — tickets"); prose wants the brand.
  const brand = copy.brand || meta.name;
  const url = `https://habeas.dev/es/descargar/${copy.slug}`;
  const outputs = outputsOf(full);
  const formats = [...new Set([...(meta.formats || []), ...outputs.flatMap((o) => o.formats)])];
  const fmtLabel = formats.map((f) => FORMAT_ES[f] || f.toUpperCase());
  const title = `${copy.h1} — Habeas`;
  const desc = `${copy.intro.split('.')[0]}. Habeas los descarga desde tu propia sesión del navegador, sin guardar tu contraseña.`;

  const outputRows = outputs.map((o) => {
    const what = SCHEMA_ES[o.schema] || 'los datos que el servicio expone';
    const fmts = o.formats.length ? ` · ${o.formats.map((f) => FORMAT_ES[f] || f).join(' o ')}` : '';
    return `        <li><strong>${esc(o.id || copy.docs)}</strong>${esc(fmts)} — ${esc(what)}.</li>`;
  }).join('\n');

  const gaps = (full.gaps || []).length
    ? `      <div class="box"><strong>Qué no cubre:</strong> esta fuente no extrae ${full.gaps.map(esc).join(' ni ')}. Se dice aquí para que sepas qué esperar antes de instalar nada.</div>\n`
    : '';

  const note = copy.note ? `      <div class="box"><strong>A tener en cuenta:</strong> ${esc(copy.note)}</div>\n` : '';

  const trust = meta.trust === 'first-party'
    ? 'Es una fuente <strong>auditada</strong> por el proyecto y verificada contra el servicio real.'
    : 'Es una fuente <strong>de la comunidad</strong>: su definición es pública y revisable, y funciona bajo las mismas reglas de seguridad que el resto.';

  const faq = [
    [`¿Habeas guarda mi contraseña de ${brand}?`,
     'No. Inicias sesión tú, en la web de siempre, incluido cualquier código de verificación. Habeas reutiliza la sesión que tu navegador ya tiene abierta y nunca lee ni almacena tus credenciales.'],
    ['¿Se envían mis datos a algún servidor?',
     'No. Todo ocurre dentro de tu navegador. Los documentos van solo al destino que tú elijas: una descarga, una carpeta de tu equipo, tu propio Google Drive o Dropbox, o un endpoint que configures.'],
    ['¿En qué formato obtengo los documentos?',
     fmtLabel.length
       ? `Los documentos originales tal cual los emite el servicio (${fmtLabel.join(', ')}), acompañados de un manifiesto con los datos ya normalizados.`
       : 'Los datos normalizados en un manifiesto, junto con los documentos originales que el servicio ofrezca.'],
    ['¿Es gratis?', 'Sí. Habeas es software libre con licencia AGPL-3.0 y su código es público en GitHub.'],
  ];

  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: 'es',
    mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${url}" />
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="stylesheet" href="/style.css" />
  <style>
    .doc { max-width: 780px; margin: 0 auto; padding: 8px 20px 64px; }
    .doc h1 { font-size: 2rem; margin: 24px 0 10px; }
    .doc h2 { font-size: 1.25rem; margin: 32px 0 8px; }
    .doc p, .doc li { line-height: 1.65; }
    .doc ul { padding-left: 1.2em; }
    .doc .lead { color: var(--muted, #888); margin: 0 0 24px; }
    .doc .box { border: 1px solid var(--line, #3333); border-radius: 10px; padding: 14px 16px; margin: 18px 0; }
    .doc .cta { display: flex; gap: 10px; flex-wrap: wrap; margin: 24px 0 8px; }
    .doc a { color: inherit; }
  </style>
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${url}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:image" content="https://habeas.dev/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="Habeas" />
  <meta name="twitter:card" content="summary_large_image" />
  <script type="application/ld+json">
${JSON.stringify(faqLd, null, 2)}
  </script>
  <!-- Analytics: self-hosted Umami (cookieless, no PII) — first-party under habeas.dev -->
  <script defer src="https://analytics.habeas.dev/script.js" data-website-id="84a75f7a-c014-4ce8-a3be-1f8dd1899a28" data-domains="habeas.dev"></script>
</head>
<body>
  <header>
    <div class="wrap">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="/logo-light.svg" />
        <img class="logo" src="/logo.svg" alt="Habeas" />
      </picture>
      <span class="name">Habeas</span>
      <nav>
        <a href="/">Inicio</a>
        <a href="/es/por-que-habeas.html">Por qué Habeas</a>
        <a href="/sources.html">Fuentes</a>
        <a href="/privacy.html">Privacidad</a>
        <a href="https://github.com/habeas-dev/habeas">GitHub</a>
      </nav>
    </div>
  </header>

  <main class="doc">
    <h1>${esc(copy.h1)}</h1>
    <p class="lead">${esc(copy.intro)}</p>

    <h2>Qué obtienes</h2>
    <p>Habeas es una extensión de navegador de código abierto que recoge tus documentos de ${esc(brand)} y los guarda donde tú digas. De esta fuente extrae:</p>
    <ul>
${outputRows}
    </ul>
${note}${gaps}
    <h2>Cómo funciona</h2>
    <p>No es un servicio que se conecte a ${esc(meta.domain)} por su cuenta. Funciona <strong>dentro de tu propio navegador</strong>, aprovechando la sesión que ya tienes abierta:</p>
    <ul>
      <li>Entras en ${esc(meta.domain)} y te identificas tú, como siempre, con tu MFA o el código que uses.</li>
      <li>Habeas reutiliza esa sesión ya autenticada para pedir tus documentos igual que lo hace la propia web.</li>
      <li>Eliges el destino: descarga, carpeta local, tu Google Drive, Dropbox, WebDAV, S3 o un endpoint propio.</li>
    </ul>
    <p><strong>Tu contraseña nunca se lee, ni se guarda, ni se envía a ningún sitio</strong>, y no hay ningún proceso trabajando en segundo plano mientras no estás. ${trust}</p>

    <div class="cta">
      <a class="btn primary" href="${CWS}" data-umami-event="install" data-umami-event-store="chrome" data-umami-event-source="${esc(meta.id)}">Instalar en Chrome</a>
      <a class="btn primary" href="${AMO}" data-umami-event="install" data-umami-event-store="firefox" data-umami-event-source="${esc(meta.id)}">Instalar en Firefox</a>
    </div>
    <p class="lead">Gratis y de código abierto (AGPL-3.0). Instala la extensión y activa la fuente «${esc(meta.name)}» desde Ajustes → Explorar fuentes.</p>

    <h2>Preguntas frecuentes</h2>
${faq.map(([q, a]) => `    <h3>${esc(q)}</h3>\n    <p>${esc(a)}</p>`).join('\n')}

    <h2>Otras fuentes</h2>
    <p>Habeas funciona con más servicios españoles e internacionales. <a href="/sources.html">Mira el catálogo completo</a> o lee <a href="/es/por-que-habeas.html">por qué existe Habeas</a>.</p>
  </main>
</body>
</html>
`;
}

const index = await loadIndex();
const copies = JSON.parse(readFileSync(join(DOCS, 'source-pages.es.json'), 'utf8'));
const byId = new Map(index.map((s) => [s.id, s]));

mkdirSync(OUT_DIR, { recursive: true });
// Drop pages whose source lost its curated copy, so a removed entry does not leave an orphan live.
for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.html')) rmSync(join(OUT_DIR, f));

const written = [];
for (const [id, copy] of Object.entries(copies)) {
  if (id.startsWith('_')) continue;
  const meta = byId.get(id);
  if (!meta) { console.error(`  ! ${id}: not in the registry — skipped`); continue; }
  const full = await (process.argv[2] ? Promise.resolve({}) : fetch(meta.url).then((r) => r.json()));
  writeFileSync(join(OUT_DIR, `${copy.slug}.html`), page({ meta, full, copy }));
  written.push(`${copy.slug}.html  (${id})`);
}

const missing = index.filter((s) => s.country === 'ES' && !copies[s.id]).map((s) => s.id);
console.log(`${written.length} pages written to es/descargar/`);
for (const w of written) console.log(`  ${w}`);
if (missing.length) console.log(`\nES sources with no curated copy (no page generated): ${missing.join(', ')}`);
