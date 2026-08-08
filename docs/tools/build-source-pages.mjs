#!/usr/bin/env node
// Generate the per-source landing pages, one per source per language, merging the live registry
// (streams, formats, gaps, trust) with the curated copy in docs/source-pages.json.
//
//     node docs/tools/build-source-pages.mjs
//
// English lives at /download/<slug>.html and Spanish at /es/descargar/<slug>.html, mirroring how the
// rest of the site is laid out (English at the root, Spanish under /es/). The two are cross-linked
// by hreflang, so neither language ever dead-ends into the other.
//
// The copy lives in each source's own definition in the registry (`content`, one entry per language),
// so publishing a source ships its guide with it. docs/source-pages.json stays as a LOCAL OVERRIDE for
// tweaking wording without republishing the catalog.
//
// A source with no `content` gets NO page, and neither does one flagged `beta: true` — those are drafts
// not yet verified against a real capture, and a page that ranks for "how to download your X" when the
// extraction may not work is worse than no page. Pages spun from a template with nothing
// source-specific in them would be doorway content, which Google's spam policies name explicitly.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, '..');
const INDEX_URL = 'https://habeas-dev.github.io/sources/index.json';
const ORIGIN = 'https://habeas.dev';
const CWS = 'https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog';
const AMO = 'https://addons.mozilla.org/firefox/addon/habeas/';

// Everything language-specific lives here, so adding a third language is a matter of one more entry
// plus its copy in source-pages.json.
const LANGS = {
  en: {
    dir: 'download',
    path: (slug) => `/download/${slug}.html`,
    schema: {
      'receipt@1': 'each purchase with its date, amount, currency, store and category',
      'transaction@1': 'each movement with its date, amount, currency, description and counterparty',
      'invoice@1': 'each document with its date, amount, currency and numbering',
      'investment@1': 'each position with its date, amount, currency and instrument',
    },
    t: {
      whatYouGet: 'What you get',
      whatItIs: (brand) => `Habeas is an open-source browser extension that collects your documents from ${brand} and saves them wherever you choose. From this source it extracts:`,
      note: 'Worth knowing:',
      gaps: 'What it does not cover:',
      gapsBody: (list) => `this source does not extract ${list}. It is stated here so you know what to expect before installing anything.`,
      how: 'How it works',
      howIntro: (domain) => `It is not a service that connects to ${domain} on its own. It runs <strong>inside your own browser</strong>, reusing the session you already have open:`,
      step1: (domain) => `You go to ${domain} and sign in yourself, as always, with your MFA or whatever code you use.`,
      step2: 'Habeas reuses that already-authenticated session to request your documents, exactly as the site itself does.',
      step3: 'You choose the destination: a download, a local folder, your Google Drive, Dropbox, WebDAV, S3 or an endpoint of your own.',
      never: '<strong>Your password is never read, never stored and never sent anywhere</strong>, and nothing runs in the background while you are away.',
      trustFp: 'This is an <strong>audited</strong> source, verified by the project against the real service.',
      trustCommunity: 'This is a <strong>community</strong> source: its definition is public and reviewable, and it runs under the same security rules as every other.',
      installChrome: 'Install on Chrome',
      installFirefox: 'Install on Firefox',
      free: (name) => `Free and open source (AGPL-3.0). Install the extension and enable the “${name}” source from Settings → Browse sources.`,
      faqH: 'Frequently asked questions',
      siblings: (group) => `More ${group.toLowerCase()} guides`,
      teachH: 'Your service is not on the list?',
      teachBody: 'Habeas can learn a new one <strong>without any code</strong>. Record mode watches the site’s own API while you browse it normally and drafts the source for you; you test it against your own account, and then keep it to yourself or share it so everyone gets it. That is where most of the catalog came from.',
      indexTitle: 'How to download your documents, service by service',
      indexIntro: 'A guide per service: what Habeas extracts from it, in what formats, and what it does not cover.',
      indexAll: 'See the full source catalog',
      other: 'Other sources',
      otherBody: 'Habeas works with more Spanish and international services. <a href="/sources.html">See the full catalog</a> or read <a href="/why-habeas.html">why Habeas exists</a>.',
      nav: [['/', 'Home'], ['/why-habeas.html', 'Why Habeas'], ['/sources.html', 'Sources'], ['/privacy.html', 'Privacy']],
      descTail: 'Habeas downloads them from inside your own browser session, without ever storing your password.',
      faq: (brand, fmts) => [
        [`Does Habeas store my ${brand} password?`,
         'No. You sign in yourself, on the usual website, including any verification code. Habeas reuses the session your browser already has open and never reads or stores your credentials.'],
        ['Is my data sent to a server?',
         'No. Everything happens inside your browser. Documents only go to the destination you pick: a download, a folder on your machine, your own Google Drive or Dropbox, or an endpoint you configure.'],
        ['What format do I get the documents in?',
         fmts.length
           ? `The original documents exactly as the service issues them (${fmts.join(', ')}), together with a manifest holding the normalised data.`
           : 'The normalised data in a manifest, along with whatever original documents the service offers.'],
        ['Is it free?', 'Yes. Habeas is free software under the AGPL-3.0 licence and its code is public on GitHub.'],
      ],
    },
  },
  es: {
    dir: 'es/descargar',
    path: (slug) => `/es/descargar/${slug}.html`,
    schema: {
      'receipt@1': 'cada compra con su fecha, importe, moneda, tienda y categoría',
      'transaction@1': 'cada movimiento con su fecha, importe, moneda, concepto y contraparte',
      'invoice@1': 'cada documento con su fecha, importe, moneda y numeración',
      'investment@1': 'cada posición con su fecha, importe, moneda e instrumento',
    },
    t: {
      whatYouGet: 'Qué obtienes',
      whatItIs: (brand) => `Habeas es una extensión de navegador de código abierto que recoge tus documentos de ${brand} y los guarda donde tú digas. De esta fuente extrae:`,
      note: 'A tener en cuenta:',
      gaps: 'Qué no cubre:',
      gapsBody: (list) => `esta fuente no extrae ${list}. Se dice aquí para que sepas qué esperar antes de instalar nada.`,
      how: 'Cómo funciona',
      howIntro: (domain) => `No es un servicio que se conecte a ${domain} por su cuenta. Funciona <strong>dentro de tu propio navegador</strong>, aprovechando la sesión que ya tienes abierta:`,
      step1: (domain) => `Entras en ${domain} y te identificas tú, como siempre, con tu MFA o el código que uses.`,
      step2: 'Habeas reutiliza esa sesión ya autenticada para pedir tus documentos igual que lo hace la propia web.',
      step3: 'Eliges el destino: descarga, carpeta local, tu Google Drive, Dropbox, WebDAV, S3 o un endpoint propio.',
      never: '<strong>Tu contraseña nunca se lee, ni se guarda, ni se envía a ningún sitio</strong>, y no hay ningún proceso trabajando en segundo plano mientras no estás.',
      trustFp: 'Es una fuente <strong>auditada</strong> por el proyecto y verificada contra el servicio real.',
      trustCommunity: 'Es una fuente <strong>de la comunidad</strong>: su definición es pública y revisable, y funciona bajo las mismas reglas de seguridad que el resto.',
      installChrome: 'Instalar en Chrome',
      installFirefox: 'Instalar en Firefox',
      free: (name) => `Gratis y de código abierto (AGPL-3.0). Instala la extensión y activa la fuente «${name}» desde Ajustes → Explorar fuentes.`,
      faqH: 'Preguntas frecuentes',
      siblings: (group) => `Más guías de ${group.toLowerCase()}`,
      teachH: '¿Tu servicio no está en la lista?',
      teachBody: 'Habeas puede aprender uno nuevo <strong>sin programar nada</strong>. El modo grabación observa la propia API del sitio mientras navegas con normalidad y te redacta la fuente; la pruebas contra tu propia cuenta y luego te la quedas o la compartes para que la tenga todo el mundo. De ahí sale la mayor parte del catálogo.',
      indexTitle: 'Cómo descargar tus documentos, servicio a servicio',
      indexIntro: 'Una guía por servicio: qué extrae Habeas de él, en qué formatos y qué no cubre.',
      indexAll: 'Ver el catálogo completo de fuentes',
      other: 'Otras fuentes',
      otherBody: 'Habeas funciona con más servicios españoles e internacionales. <a href="/sources.html">Mira el catálogo completo</a> o lee <a href="/es/por-que-habeas.html">por qué existe Habeas</a>.',
      nav: [['/', 'Inicio'], ['/es/por-que-habeas.html', 'Por qué Habeas'], ['/sources.html', 'Fuentes'], ['/privacy.html', 'Privacidad']],
      descTail: 'Habeas los descarga desde tu propia sesión del navegador, sin guardar tu contraseña.',
      faq: (brand, fmts) => [
        [`¿Habeas guarda mi contraseña de ${brand}?`,
         'No. Inicias sesión tú, en la web de siempre, incluido cualquier código de verificación. Habeas reutiliza la sesión que tu navegador ya tiene abierta y nunca lee ni almacena tus credenciales.'],
        ['¿Se envían mis datos a algún servidor?',
         'No. Todo ocurre dentro de tu navegador. Los documentos van solo al destino que tú elijas: una descarga, una carpeta de tu equipo, tu propio Google Drive o Dropbox, o un endpoint que configures.'],
        ['¿En qué formato obtengo los documentos?',
         fmts.length
           ? `Los documentos originales tal cual los emite el servicio (${fmts.join(', ')}), acompañados de un manifiesto con los datos ya normalizados.`
           : 'Los datos normalizados en un manifiesto, junto con los documentos originales que el servicio ofrezca.'],
        ['¿Es gratis?', 'Sí. Habeas es software libre con licencia AGPL-3.0 y su código es público en GitHub.'],
      ],
    },
  },
};


// Registry categories bucketed into groups a reader recognises. Drives both the index page and the
// sibling links at the foot of each guide — pages in the same bucket are the ones worth cross-linking.
const GROUPS = [
  { id: 'grocery',  cats: ['grocery'],                          en: 'Supermarkets',      es: 'Supermercados' },
  { id: 'retail',   cats: ['retail', 'home', 'diy', 'sports', 'marketplace'], en: 'Shops', es: 'Tiendas' },
  { id: 'banking',  cats: ['banking', 'card', 'loan', 'investment'], en: 'Banks, cards & investments', es: 'Bancos, tarjetas e inversión' },
  { id: 'tolls',    cats: ['tolls'],                            en: 'Tolls & parking',   es: 'Peajes y parking' },
  { id: 'utility',  cats: ['energy', 'telecom', 'domains'],     en: 'Services & subscriptions', es: 'Servicios y suscripciones' },
];
const UNGROUPED = new Set();
const groupOf = (meta) => {
  const hit = GROUPS.find((g) => (meta.categories || []).some((c) => g.cats.includes(c)));
  if (!hit) UNGROUPED.add(`${meta.id} (${(meta.categories || []).join(', ') || 'no categories'})`);
  return hit || GROUPS[1];
};

const FORMAT = { pdf: 'PDF', excel: 'Excel', json: 'JSON', html: 'HTML', xls: 'Excel', csv: 'CSV' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function outputsOf(full) {
  if (full.streams?.length) {
    return full.streams.map((s) => ({ id: s.id, schema: s.schema || full.schema, formats: (s.formats || []).map((f) => f.id).filter(Boolean) }));
  }
  return [{ id: null, schema: full.schema, formats: [] }];
}

function page({ lang, meta, full, entry, siblings }) {
  const L = LANGS[lang], t = L.t, copy = entry[lang];
  const brand = entry.brand || meta.name;
  const url = ORIGIN + L.path(copy.slug);
  const outputs = outputsOf(full);
  const formats = [...new Set([...(meta.formats || []), ...outputs.flatMap((o) => o.formats)])].map((f) => FORMAT[f] || f.toUpperCase());
  const title = `${copy.h1} — Habeas`;
  const desc = `${copy.intro.split('.')[0]}. ${t.descTail}`;

  const rows = outputs.map((o) => {
    const what = L.schema[o.schema] || (lang === 'es' ? 'los datos que el servicio expone' : 'the data the service exposes');
    const f = o.formats.length ? ` · ${o.formats.map((x) => FORMAT[x] || x).join(lang === 'es' ? ' o ' : ' or ')}` : '';
    return `        <li><strong>${esc(o.id || copy.docs)}</strong>${esc(f)} — ${esc(what)}.</li>`;
  }).join('\n');

  const gaps = (full.gaps || []).length
    ? `      <div class="box"><strong>${t.gaps}</strong> ${esc(t.gapsBody(full.gaps.map(esc).join(lang === 'es' ? ' ni ' : ' or ')))}</div>\n` : '';
  const note = copy.note ? `      <div class="box"><strong>${t.note}</strong> ${esc(copy.note)}</div>\n` : '';
  const trust = meta.trust === 'first-party' ? t.trustFp : t.trustCommunity;
  const faq = t.faq(brand, formats);

  // hreflang across every language that has copy for this source, so neither side dead-ends.
  const alts = Object.keys(LANGS).filter((l) => entry[l]);
  const hreflang = alts.map((l) => `  <link rel="alternate" hreflang="${l}" href="${ORIGIN}${LANGS[l].path(entry[l].slug)}" />`).join('\n')
    + `\n  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${LANGS.en.path(entry.en.slug)}" />`;

  const faqLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang,
    mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${url}" />
${hreflang}
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="stylesheet" href="/style.css" />
  <style>
    .doc { max-width: 780px; margin: 0 auto; padding: 8px 20px 64px; }
    .doc h1 { font-size: 2rem; margin: 24px 0 10px; }
    .doc h2 { font-size: 1.25rem; margin: 32px 0 8px; }
    .doc h3 { font-size: 1.02rem; margin: 20px 0 6px; }
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
  <meta property="og:image" content="${ORIGIN}/og-image.png" />
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
${t.nav.map(([href, label]) => `        <a href="${href}">${esc(label)}</a>`).join('\n')}
        <a href="https://github.com/habeas-dev/habeas">GitHub</a>
      </nav>
    </div>
  </header>

  <main class="doc">
    <h1>${esc(copy.h1)}</h1>
    <p class="lead">${esc(copy.intro)}</p>

    <h2>${esc(t.whatYouGet)}</h2>
    <p>${esc(t.whatItIs(brand))}</p>
    <ul>
${rows}
    </ul>
${note}${gaps}
    <h2>${esc(t.how)}</h2>
    <p>${t.howIntro(esc(meta.domain))}</p>
    <ul>
      <li>${esc(t.step1(meta.domain))}</li>
      <li>${esc(t.step2)}</li>
      <li>${esc(t.step3)}</li>
    </ul>
    <p>${t.never} ${trust}</p>

    <div class="cta">
      <a class="btn primary" href="${CWS}" data-umami-event="install" data-umami-event-store="chrome" data-umami-event-source="${esc(meta.id)}">${esc(t.installChrome)}</a>
      <a class="btn primary" href="${AMO}" data-umami-event="install" data-umami-event-store="firefox" data-umami-event-source="${esc(meta.id)}">${esc(t.installFirefox)}</a>
    </div>
    <p class="lead">${esc(t.free(meta.name))}</p>

    <h2>${esc(t.faqH)}</h2>
${faq.map(([q, a]) => `    <h3>${esc(q)}</h3>\n    <p>${esc(a)}</p>`).join('\n')}

${siblings.length ? `    <h2>${esc(t.siblings(groupOf(meta)[lang]))}</h2>
    <ul>
${siblings.map((sb) => `      <li><a href="${LANGS[lang].path(sb.slug)}">${esc(sb.h1)}</a></li>`).join('\n')}
    </ul>

` : ''}    <h2>${esc(t.teachH)}</h2>
    <p>${t.teachBody}</p>

    <h2>${esc(t.other)}</h2>
    <p>${t.otherBody}</p>
  </main>
</body>
</html>
`;
}


function indexPage({ lang, groups }) {
  const L = LANGS[lang], t = L.t;
  const url = `${ORIGIN}/${L.dir}/`;
  const alts = Object.keys(LANGS)
    .map((l) => `  <link rel="alternate" hreflang="${l}" href="${ORIGIN}/${LANGS[l].dir}/" />`).join('\n')
    + `\n  <link rel="alternate" hreflang="x-default" href="${ORIGIN}/${LANGS.en.dir}/" />`;
  const sections = groups.filter((g) => g.items.length).map((g) => `    <h2>${esc(g[lang])}</h2>
    <ul>
${g.items.map((i) => `      <li><a href="${L.path(i.slug)}">${esc(i.h1)}</a></li>`).join('\n')}
    </ul>`).join('\n\n');

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(t.indexTitle)} — Habeas</title>
  <meta name="description" content="${esc(t.indexIntro)}" />
  <link rel="canonical" href="${url}" />
${alts}
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="stylesheet" href="/style.css" />
  <style>
    .doc { max-width: 780px; margin: 0 auto; padding: 8px 20px 64px; }
    .doc h1 { font-size: 2rem; margin: 24px 0 10px; }
    .doc h2 { font-size: 1.25rem; margin: 32px 0 8px; }
    .doc p, .doc li { line-height: 1.65; }
    .doc ul { padding-left: 1.2em; }
    .doc .lead { color: var(--muted, #888); margin: 0 0 24px; }
    .doc a { color: inherit; }
  </style>
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${url}" />
  <meta property="og:title" content="${esc(t.indexTitle)} — Habeas" />
  <meta property="og:description" content="${esc(t.indexIntro)}" />
  <meta property="og:image" content="${ORIGIN}/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="Habeas" />
  <meta name="twitter:card" content="summary_large_image" />
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
${t.nav.map(([href, label]) => `        <a href="${href}">${esc(label)}</a>`).join('\n')}
        <a href="https://github.com/habeas-dev/habeas">GitHub</a>
      </nav>
    </div>
  </header>

  <main class="doc">
    <h1>${esc(t.indexTitle)}</h1>
    <p class="lead">${esc(t.indexIntro)}</p>

${sections}

    <h2>${esc(t.teachH)}</h2>
    <p>${t.teachBody}</p>

    <p style="margin-top:32px"><a href="/sources.html">${esc(t.indexAll)} →</a></p>
  </main>
</body>
</html>
`;
}

const raw = await fetch(INDEX_URL).then((r) => r.json());
const index = raw.sources || raw;
const overrides = JSON.parse(readFileSync(join(DOCS, 'source-pages.json'), 'utf8'));
const byId = new Map(index.map((s) => [s.id, s]));

for (const L of Object.values(LANGS)) {
  const dir = join(DOCS, ...L.dir.split('/'));
  mkdirSync(dir, { recursive: true });
  // Drop pages whose source lost its copy, so a removed entry leaves no orphan live.
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.html')) rmSync(join(dir, f));
}

let written = 0;
// Resolve every source up front: sibling links and the index both need the whole set.
const resolved = [];
const skipped = [];
for (const meta of index) {
  const full = await fetch(meta.url).then((r) => r.json());
  if (meta.beta || full.beta) { if (full.content) skipped.push(`${meta.id} (beta)`); continue; }
  const override = overrides[meta.id] || {};
  // Registry content is the source of truth; the local file overrides it field by field.
  const entry = { brand: override.brand || full.brand || meta.name };
  for (const lang of Object.keys(LANGS)) {
    const base = full.content?.[lang];
    if (base || override[lang]) entry[lang] = { ...base, ...override[lang] };
  }
  if (!Object.keys(LANGS).some((l) => entry[l])) { skipped.push(`${meta.id} (no content)`); continue; }
  resolved.push({ id: meta.id, entry, meta, full });
}

for (const { id, entry, meta, full } of resolved) {
  for (const lang of Object.keys(LANGS)) {
    if (!entry[lang]) { console.error(`  ! ${id}: no ${lang} copy — that language gets no page`); continue; }
    // Siblings: same category group, same language, excluding itself.
    const group = groupOf(meta);
    const siblings = resolved
      .filter((r) => r.id !== id && r.entry[lang] && groupOf(r.meta).id === group.id)
      .map((r) => ({ slug: r.entry[lang].slug, h1: r.entry[lang].h1 }));
    writeFileSync(join(DOCS, ...LANGS[lang].dir.split('/'), `${entry[lang].slug}.html`), page({ lang, meta, full, entry, siblings }));
    written++;
  }
}

for (const lang of Object.keys(LANGS)) {
  const groups = GROUPS.map((g) => ({ ...g, items: resolved
    .filter((r) => r.entry[lang] && groupOf(r.meta).id === g.id)
    .map((r) => ({ slug: r.entry[lang].slug, h1: r.entry[lang].h1 })) }));
  writeFileSync(join(DOCS, ...LANGS[lang].dir.split('/'), 'index.html'), indexPage({ lang, groups }));
  written++;
}

// Publish the map of generated guides so the catalog can link them without knowing how they are built.
const guides = Object.fromEntries(resolved.map(({ id, entry }) =>
  [id, Object.fromEntries(Object.keys(LANGS).filter((l) => entry[l]).map((l) => [l, entry[l].slug]))]));
writeFileSync(join(DOCS, 'guides.json'), JSON.stringify(guides, null, 2) + '\n');

console.log(`${written} pages written (${Object.keys(LANGS).join(', ')}) from ${resolved.length} sources`);
if (skipped.length) console.log(`no guide: ${skipped.join(', ')}`);
if (UNGROUPED.size) console.error(`  ! ungrouped, filed under "${GROUPS[1].en}" — add their category to GROUPS: ${[...UNGROUPED].join('; ')}`);
