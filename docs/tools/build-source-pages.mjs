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
const ORIGIN_SOURCES = 'https://habeas-dev.github.io/sources';
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
      installH: 'Install Habeas',
      installLead: 'Free and open source (AGPL-3.0). Install it, then turn on the source you need from Settings → Browse sources.',
      chromeNote: 'Chrome will warn you that the extension is not trusted. That happens to any developer account recently registered on the Chrome Web Store, it fades after a few months, and it says nothing about the code — which you can read in full.',
      installChrome: 'Install on Chrome',
      installFirefox: 'Install on Firefox',
      free: (name) => `Free and open source (AGPL-3.0). Install the extension and enable the “${name}” source from Settings → Browse sources.`,
      faqH: 'Frequently asked questions',
      detailH: (brand) => `What ${brand} actually gives you`,
      retentionH: 'How far back it goes',
      quirksH: 'Worth knowing about this source',
      crumbHome: 'Home',
      crumbGuides: 'Guides',
      // Explicit, because deriving them by splitting the step text at the first "." cut every step that
      // mentioned a domain: Amazon's step 1 was named "You go to amazon."
      stepNames: ['Sign in yourself', 'Habeas reuses that session', 'You choose where it goes'],
      historyH: 'What has changed in this source',
      historyLead: 'This source is a public definition, and every change to it is on the record. Most recent first:',
      historyMore: 'See the full history in the catalog',
      creditH: 'Credit',
      // Three sentences, not one with a slot: who recorded a session and who wrote the definition are
      // different contributions, and collapsing them would credit each for the other's work.
      creditAuthor: (who) => `This source definition was written by ${who}.`,
      creditCapture: (who) => `This source exists thanks to the redacted recording ${who} contributed from their own session; the definition itself was written by the Habeas team.`,
      creditBoth: (cap, aut) => `This source exists thanks to the redacted recording ${cap} contributed from their own session, and the definition was written by ${aut}.`,
      creditSame: (who) => `${who} recorded their own session and wrote this source definition from it.`,
      creditThanks: 'Habeas exists because people map the services they use and share the result.',
      provenanceH: 'Where this definition came from',
      provenanceBy: (work) => `This definition was drafted using ${work} as a reference for the service's interface.`,
      siblings: (group) => `More ${group.toLowerCase()} guides`,
      teachH: 'Your service is not on the list?',
      teachBody: 'Habeas can learn a new one <strong>without any code</strong>. Record mode watches the site’s own API while you browse it normally and drafts the source for you; you test it against your own account, and then keep it to yourself or share it so everyone gets it. That is where most of the catalog came from.',
      indexKicker: 'Step-by-step guides',
      indexTitle: 'How to download your documents, service by service',
      indexIntro: 'A guide per service: what Habeas extracts from it, in what formats, and what it does not cover.',
      indexAll: 'See the full source catalog',
      other: 'Other sources',
      otherBody: 'Habeas works with more Spanish and international services. <a href="/sources.html">See the full catalog</a> or read <a href="/why-habeas.html">why Habeas exists</a>.',
      nav: [['/', 'Home'], ['/why-habeas.html', 'Why Habeas?'], ['/sources.html', 'Sources'], ['/developers.html', 'Developers'],
            ['/architecture.html', 'Architecture'], ['/privacy.html', 'Privacy'], ['/terms.html', 'Terms']],
      otherLang: 'Español', otherLangCode: 'ES',
      betaH1: (brand) => `${brand} — experimental source, not yet verified`,
      betaIntro: (brand) => `A draft definition for ${brand}. Nobody has run it against a real account yet, so it may extract nothing at all. This page exists so that somebody who HAS an account can try it and say what happened.`,
      betaWarnH: 'Do not expect this to work',
      betaWarnBody: (ref) => `This source was drafted from ${ref} — a map of which endpoints the service uses and what they return — and has never been validated against a live session. Endpoints move, responses change shape, and a definition written from a reference rather than from a capture is a hypothesis. Installing it is safe; the same rules apply as to any other source. It simply may not find anything.`,
      betaMeantH: 'What it is meant to extract',
      betaHelpH: 'If you have an account here',
      betaHelpBody: 'Install it, run it once, and open an issue with what happened — including "nothing at all", which is the most useful answer of the three. That is how a draft becomes a verified source, and it is the only way: the project cannot test an account it does not have.',
      asideAbout: 'About this source', asideVersion: 'Version', asideTrust: 'Trust',
      asideLicence: 'Licence', asideLicenceBody: 'Definition in the public domain (CC0-1.0); this page\u2019s text CC-BY-4.0.',
      asideDefinition: 'The definition itself', asideDefinitionBody: 'A source is data, never code — this is the whole of it.',
      asideRaw: 'Open the raw file', asideCountry: 'Coverage',
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
      installH: 'Instalar Habeas',
      installLead: 'Libre y de código abierto (AGPL-3.0). Instálala y activa en Ajustes → Explorar fuentes la que necesites.',
      chromeNote: 'Chrome te avisará de que la extensión no es de confianza. Le ocurre a cualquier cuenta de desarrollador registrada hace poco en la Chrome Web Store, se disipa en unos meses y no dice nada del código, que puedes leer entero.',
      installChrome: 'Instalar en Chrome',
      installFirefox: 'Instalar en Firefox',
      free: (name) => `Gratis y de código abierto (AGPL-3.0). Instala la extensión y activa la fuente «${name}» desde Ajustes → Explorar fuentes.`,
      faqH: 'Preguntas frecuentes',
      detailH: (brand) => `Qué te da ${brand} en realidad`,
      retentionH: 'Hasta dónde llega el histórico',
      quirksH: 'Particularidades de esta fuente',
      crumbHome: 'Inicio',
      crumbGuides: 'Guías',
      stepNames: ['Inicias sesión tú', 'Habeas reutiliza esa sesión', 'Eliges el destino'],
      historyH: 'Qué ha cambiado en esta fuente',
      historyLead: 'Esta fuente es una definición pública y cada cambio queda registrado. De lo más reciente a lo más antiguo:',
      historyMore: 'Ver el historial completo en el catálogo',
      creditH: 'Agradecimientos',
      creditAuthor: (who) => `Esta definición de fuente la escribió ${who}.`,
      creditCapture: (who) => `Esta fuente existe gracias a la grabación redactada que aportó ${who} desde su propia sesión; la definición la escribió el equipo de Habeas.`,
      creditBoth: (cap, aut) => `Esta fuente existe gracias a la grabación redactada que aportó ${cap} desde su propia sesión, y la definición la escribió ${aut}.`,
      creditSame: (who) => `${who} grabó su propia sesión y escribió esta definición a partir de ella.`,
      creditThanks: 'Habeas existe porque hay gente que mapea los servicios que usa y comparte el resultado.',
      provenanceH: 'De dónde sale esta definición',
      provenanceBy: (work) => `Esta definición se redactó tomando ${work} como referencia de la interfaz del servicio.`,
      siblings: (group) => `Más guías de ${group.toLowerCase()}`,
      teachH: '¿Tu servicio no está en la lista?',
      teachBody: 'Habeas puede aprender uno nuevo <strong>sin programar nada</strong>. El modo grabación observa la propia API del sitio mientras navegas con normalidad y te redacta la fuente; la pruebas contra tu propia cuenta y luego te la quedas o la compartes para que la tenga todo el mundo. De ahí sale la mayor parte del catálogo.',
      indexKicker: 'Guías paso a paso',
      indexTitle: 'Cómo descargar tus documentos, servicio a servicio',
      indexIntro: 'Una guía por servicio: qué extrae Habeas de él, en qué formatos y qué no cubre.',
      indexAll: 'Ver el catálogo completo de fuentes',
      other: 'Otras fuentes',
      otherBody: 'Habeas funciona con más servicios españoles e internacionales. <a href="/sources.html">Mira el catálogo completo</a> o lee <a href="/es/por-que-habeas.html">por qué existe Habeas</a>.',
      nav: [['/', 'Inicio'], ['/es/por-que-habeas.html', '¿Por qué Habeas?'], ['/sources.html', 'Fuentes'], ['/es/desarrolladores.html', 'Desarrolladores'],
            ['/architecture.html', 'Arquitectura'], ['/es/privacidad.html', 'Privacidad'], ['/es/terminos.html', 'Términos']],
      otherLang: 'English', otherLangCode: 'EN',
      betaH1: (brand) => `${brand} — fuente experimental, sin verificar`,
      betaIntro: (brand) => `Un borrador de definición para ${brand}. Nadie la ha ejecutado todavía contra una cuenta real, así que puede no extraer nada. Esta página existe para que quien SÍ tenga cuenta pueda probarla y contar qué pasó.`,
      betaWarnH: 'No des por hecho que funciona',
      betaWarnBody: (ref) => `Esta fuente se redactó a partir de ${ref} — un mapa de qué endpoints usa el servicio y qué devuelven — y nunca se ha validado contra una sesión real. Los endpoints se mueven, las respuestas cambian de forma, y una definición escrita desde una referencia y no desde una captura es una hipótesis. Instalarla es seguro: se le aplican las mismas reglas que a cualquier otra. Simplemente puede no encontrar nada.`,
      betaMeantH: 'Qué pretende extraer',
      betaHelpH: 'Si tienes cuenta aquí',
      betaHelpBody: 'Instálala, ejecútala una vez y abre una incidencia contando qué pasó — incluido «nada en absoluto», que de las tres respuestas es la más útil. Así es como un borrador se convierte en fuente verificada, y es la única forma: el proyecto no puede probar una cuenta que no tiene.',
      asideAbout: 'Sobre esta fuente', asideVersion: 'Versión', asideTrust: 'Confianza',
      asideLicence: 'Licencia', asideLicenceBody: 'La definición, de dominio público (CC0-1.0); el texto de esta página, CC-BY-4.0.',
      asideDefinition: 'La definición en sí', asideDefinitionBody: 'Una fuente son datos, nunca código — esto es todo lo que hay.',
      asideRaw: 'Abrir el fichero original', asideCountry: 'Cobertura',
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
const MONOLINGUAL = new Set();
const groupOf = (meta) => {
  const hit = GROUPS.find((g) => (meta.categories || []).some((c) => g.cats.includes(c)));
  if (!hit) UNGROUPED.add(`${meta.id} (${(meta.categories || []).join(', ') || 'no categories'})`);
  return hit || GROUPS[1];
};

const FORMAT = { pdf: 'PDF', excel: 'Excel', json: 'JSON', html: 'HTML', xls: 'Excel', csv: 'CSV' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Schemas are versioned (`investment@2`). The descriptions are keyed by version so a genuinely different
// shape can be described differently, but a bump that only adds fields must not make the page fall back to
// printing the raw identifier at the reader — so an unknown version borrows the base schema's wording, and
// an unknown schema says something true rather than something technical.
function schemaText(L, lang, schema) {
  if (!schema) return lang === 'es' ? 'los datos que el servicio expone' : 'the data the service exposes';
  if (L.schema[schema]) return L.schema[schema];
  const base = String(schema).split('@')[0];
  const sameBase = Object.keys(L.schema).find((k) => k.split('@')[0] === base);
  return sameBase ? L.schema[sameBase] : (lang === 'es' ? 'los datos que el servicio expone' : 'the data the service exposes');
}

function outputsOf(full) {
  if (full.streams?.length) {
    return full.streams.map((s) => ({ id: s.id, schema: s.schema || full.schema, formats: (s.formats || []).map((f) => f.id).filter(Boolean) }));
  }
  return [{ id: null, schema: full.schema, formats: [] }];
}

function page({ lang, meta, full, entry, siblings, isBeta }) {
  const L = LANGS[lang], t = L.t, copy = entry[lang];
  const brand = entry.brand || meta.name;
  const url = ORIGIN + L.path(copy.slug);
  const outputs = outputsOf(full);
  const formats = [...new Set([...(meta.formats || []), ...outputs.flatMap((o) => o.formats)])].map((f) => FORMAT[f] || f.toUpperCase());
  const title = `${copy.h1} — Habeas`;
  // A draft is reachable from the catalogue and absent from search. Ranking for "how to download your X"
  // while the extraction is unverified would be selling something that may not exist; and structured data
  // is a claim made to a machine, so an unrun procedure gets no HowTo and no FAQ.
  const robots = isBeta ? '\n  <meta name="robots" content="noindex,follow" />' : '';
  const desc = `${copy.intro.split('.')[0]}. ${t.descTail}`;

  const rows = outputs.map((o) => {
    const what = schemaText(L, lang, o.schema);
    const f = o.formats.length ? ` · ${o.formats.map((x) => FORMAT[x] || x).join(lang === 'es' ? ' o ' : ' or ')}` : '';
    return `        <li><strong>${esc(o.id || copy.docs)}</strong>${esc(f)} — ${esc(what)}.</li>`;
  }).join('\n');

  const gaps = (full.gaps || []).length
    ? `      <div class="box"><strong>${t.gaps}</strong> ${esc(t.gapsBody(full.gaps.map(esc).join(lang === 'es' ? ' ni ' : ' or ')))}</div>\n` : '';
  const note = copy.note ? `      <div class="box"><strong>${t.note}</strong> ${esc(copy.note)}</div>\n` : '';
  const trust = meta.trust === 'first-party' ? t.trustFp : t.trustCommunity;
  // Source-specific questions come FIRST: they are the reason this page deserves to exist separately
  // from the other 41, and burying them under the four boilerplate ones wastes them on both a reader
  // and an extractor.
  const ownFaq = (copy.faq || []).map((x) => [x.q, x.a]);
  const faq = [...ownFaq, ...t.faq(brand, formats)];

  // Prose that only applies to this service. Without at least one of these the page is the template
  // with a name swapped in, which is what left 30 of them unindexed.
  const quirks = copy.quirks || [];
  const enriched = Boolean(copy.whatYouGet || copy.retention || quirks.length || ownFaq.length);
  const detail = copy.whatYouGet
    ? `      <h2>${esc(t.detailH(brand))}</h2>\n      <p>${esc(copy.whatYouGet)}</p>\n` : '';
  const retention = copy.retention
    ? `      <h2>${esc(t.retentionH)}</h2>\n      <p class="retention">${esc(copy.retention)}</p>\n` : '';
  const quirksBlock = quirks.length
    ? `      <h2>${esc(t.quirksH)}</h2>\n      <ul class="quirks">\n${quirks.map((q) => `        <li>${esc(q)}</li>`).join('\n')}\n      </ul>\n` : '';

  // `changes` is either one string or a map keyed by language. Fall back rather than drop the entry:
  // a note in the wrong language still tells the reader something; a missing one tells them nothing.
  const noteIn = (ch) => {
    if (typeof ch !== 'string') return ch?.[lang] || ch?.en || Object.values(ch || {})[0] || '';
    // One string serves every language, so it lands verbatim on both pages. Most of the catalog's notes
    // are written in Spanish, which means the English guides currently carry Spanish paragraphs — the
    // exact low-quality signal these pages are being rebuilt to shed. Counted and reported, not hidden.
    MONOLINGUAL.add(meta.id);
    return ch;
  };
  const HISTORY_MAX = 5;
  const log = (full.changelog || []).filter((e) => e?.version && noteIn(e.changes));
  const shown = log.slice(0, HISTORY_MAX);
  const history = shown.length ? `      <h2>${esc(t.historyH)}</h2>
      <p>${esc(t.historyLead)}</p>
      <ul class="changelog">
${shown.map((e) => `        <li class="rev"><span class="ver">${esc(String(e.version))}</span> — ${esc(noteIn(e.changes))}</li>`).join('\n')}
      </ul>
${log.length > HISTORY_MAX ? `      <p class="lead"><a href="/sources.html#${esc(meta.id)}">${esc(t.historyMore)} →</a></p>\n` : ''}` : '';

  // Only ever what each person themselves supplied. Never derived from git, a PR author or a handoff —
  // publishing someone's name is theirs to consent to. The name is the link so the sentence reads as a
  // sentence, and only https survives: a contributor-supplied string lands in a published page.
  const cr = entry.credit || {};
  const person = (p) => {
    if (!p?.name) return null;
    const safe = /^https:\/\/[^\s"'<>]+$/i.test(p.url || '') ? p.url : null;
    const who = safe ? `<a href="${esc(safe)}" rel="nofollow noopener">${esc(p.name)}</a>` : esc(p.name);
    return p.note ? `${who} (${esc(p.note)})` : who;
  };
  const aut = person(cr.author);
  const cap = person(cr.capture);
  const sameHuman = cr.author?.name && cr.capture?.name && cr.author.name === cr.capture.name;
  const line = sameHuman ? t.creditSame(aut)
    : cap && aut ? t.creditBoth(cap, aut)
    : cap ? t.creditCapture(cap)
    : aut ? t.creditAuthor(aut) : null;
  // `line` now lives in the sidebar card rather than in a section of its own: attribution belongs at hand
  // while you read, not as a footnote after the FAQ.
  const credit = '';

  // Provenance, kept apart from credit on purpose: this one is a licence record. If a definition was
  // drafted from someone else's published work, saying so on the public page is part of honouring it.
  const at = entry.attribution;
  const atUrl = /^https:\/\/[^\s"'<>]+$/i.test(at?.url || '') ? at.url : null;
  const work = at?.derivedFrom
    ? (atUrl ? `<a href="${esc(atUrl)}" rel="nofollow noopener">${esc(at.derivedFrom)}</a>` : esc(at.derivedFrom))
    : null;
  const licBits = [at?.copyright, at?.referenceLicense || at?.referenceLicence].filter(Boolean);
  const lic = licBits.length && !licBits.every((b) => (at.note || '').includes(b)) ? licBits.join(', ') : '';
  const provenance = work ? `      <h2>${esc(t.provenanceH)}</h2>
      <p class="attribution">${t.provenanceBy(work)}${lic ? ` ${esc(lic)}.` : ''}${at.note ? ` ${esc(at.note)}` : ''}</p>
` : '';

  // hreflang across every language that has copy for this source, so neither side dead-ends.
  const alts = Object.keys(LANGS).filter((l) => entry[l]);
  // The same page in the other language, linked where a reader looks for it: in the nav, beside the
  // rest of the site's links. hreflang alone tells crawlers and nobody else.
  const other = alts.find((l) => l !== lang) || null;
  const hreflang = alts.map((l) => `  <link rel="alternate" hreflang="${l}" href="${ORIGIN}${LANGS[l].path(entry[l].slug)}" />`).join('\n')
    + `\n  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${LANGS.en.path(entry.en.slug)}" />`;

  const faqLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang,
    mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  // The three steps are a sequence, and saying so is the whole point of the page: "how do I download my
  // X invoices" is a procedure, and a procedure is what an assistant quotes back. They were marked up as
  // an unordered list, which said the opposite.
  const steps = [t.step1(meta.domain), t.step2, t.step3];
  const howToLd = {
    '@context': 'https://schema.org', '@type': 'HowTo', inLanguage: lang,
    name: copy.h1,
    description: copy.intro.split('.')[0] + '.',
    totalTime: 'PT2M',
    tool: [{ '@type': 'HowToTool', name: 'Habeas' }],
    step: steps.map((text, i) => ({ '@type': 'HowToStep', position: i + 1, name: t.stepNames[i], text })),
  };

  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t.crumbHome, item: ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: t.crumbGuides, item: `${ORIGIN}/${L.dir}/` },
      { '@type': 'ListItem', position: 3, name: copy.h1, item: url },
    ],
  };

  // A source's `version` IS its last-changed date (YYYY-MM-DD, by project convention), which makes it
  // the honest dateModified: it moves when the source actually changes and stays put when the page is
  // merely rebuilt. Deriving it from the build clock is what taught crawlers to ignore the sitemap's
  // <lastmod>, and repeating that mistake here would cost the same credibility.
  const modified = /^\d{4}-\d{2}-\d{2}/.test(String(meta.version || '')) ? String(meta.version).slice(0, 10) : null;
  const articleLd = {
    '@context': 'https://schema.org', '@type': 'TechArticle', inLanguage: lang,
    headline: copy.h1,
    description: desc,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    ...(modified ? { dateModified: modified } : {}),
    // Attribute the source's contributor when there is one, so the credit is machine-readable and not
    // just a line of prose an extractor may or may not carry across.
    // author = who wrote the definition; contributor = who supplied the recording it was built from.
    // schema.org draws the same distinction, so the credit survives extraction instead of flattening.
    author: cr.author?.name
      ? { '@type': 'Person', name: cr.author.name, ...(cr.author.url ? { url: cr.author.url } : {}) }
      : { '@type': 'Organization', name: 'Habeas', url: ORIGIN },
    ...(cr.capture?.name
      ? { contributor: { '@type': 'Person', name: cr.capture.name, ...(cr.capture.url ? { url: cr.capture.url } : {}) } }
      : {}),
    publisher: { '@type': 'Organization', name: 'Habeas', url: ORIGIN },
    about: { '@type': 'Thing', name: brand },
    ...(at?.derivedFrom
      ? { isBasedOn: { '@type': 'CreativeWork', name: at.derivedFrom, ...(atUrl ? { url: atUrl } : {}) } }
      : {}),
    isAccessibleForFree: true,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  };

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>${robots}
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${url}" />
${hreflang}
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="stylesheet" href="/style.css" />
  <style>
    /* Two columns: the prose reads at its own width, and everything ABOUT the source — what it is, which
       version, who wrote it, how to install it, and the definition itself — sits beside it instead of
       interrupting it. One column below 1000px, sidebar FIRST, so a phone gets the install buttons
       before the essay. */
    .doc { max-width: 1100px; margin: 0 auto; padding: 8px 20px 64px;
           display: grid; grid-template-columns: minmax(0,1fr) 300px; gap: 40px; align-items: start; }
    /* The columns are assigned EXPLICITLY because the aside comes first in the DOM — which is what puts
       the install buttons above the essay on a phone. Left to source order it would take the wide
       column and squeeze the prose into 300px, which is exactly what it did. */
    .doc > .body { min-width: 0; grid-column: 1; }
    .doc > aside { grid-column: 2; grid-row: 1; position: sticky; top: 78px; display: flex; flex-direction: column; gap: 14px; }
    @media (max-width: 1000px) { .doc { grid-template-columns: 1fr; gap: 22px; }
      .doc > .body, .doc > aside { grid-column: 1; grid-row: auto; }
      .doc > aside { position: static; } }
    .card { border: 1px solid var(--line, #3333); border-radius: 14px; padding: 15px 16px; }
    .card h2 { font-size: .78rem !important; text-transform: uppercase; letter-spacing: .6px;
               color: var(--muted, #888); margin: 0 0 10px !important; }
    .card dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 13.5px; }
    .card dt { color: var(--muted, #888); }
    .card dd { margin: 0; word-break: break-word; }
    .card .who { font-size: 13px; line-height: 1.55; margin: 12px 0 0; padding-top: 11px;
                 border-top: 1px solid var(--line, #3333); color: var(--muted, #888); }
${isBeta ? `    .box.warn { border-color: #c2410c66; background: #c2410c14; }
    .box.warn strong { color: #c2410c; }
` : ''}    .rev .ver { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em;
                white-space: nowrap; color: var(--muted, #888); }
    .card .note { font-size: 12.5px; line-height: 1.5; color: var(--muted, #888); margin: 8px 0 0; }
    aside .cta { display: flex; flex-direction: column; gap: 8px; margin: 0; }
    aside .cta .btn { text-align: center; }
    /* The definition, in full. It is the project's whole security claim — adapters are data, never code —
       and a claim you cannot read is a claim you are asked to take on faith. */
    .defn summary { cursor: pointer; font-weight: 600; font-size: 13.5px; }
    .defn pre { max-height: 420px; overflow: auto; margin: 10px 0 0; padding: 11px 12px; font-size: 11.5px;
                line-height: 1.5; border-radius: 9px; background: var(--surface-2, #0001); }
    header nav .langlink { font-weight: 700; }
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
${isBeta ? '' : `  <script type="application/ld+json">
${JSON.stringify(faqLd, null, 2)}
  </script>
  <script type="application/ld+json">
${JSON.stringify(howToLd, null, 2)}
  </script>`}
  <script type="application/ld+json">
${JSON.stringify(crumbLd, null, 2)}
  </script>
  <script type="application/ld+json">
${JSON.stringify(articleLd, null, 2)}
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
${other ? `        <a class="langlink" href="${LANGS[other].path(entry[other].slug)}" hreflang="${other}" rel="alternate">${esc(t.otherLangCode)}</a>` : ''}
      </nav>
    </div>
  </header>

  <main class="doc"${enriched ? ' data-habeas-enriched' : ''}>
    <aside>
      <div class="card">
        <h2>${esc(t.asideAbout)}</h2>
        <dl>
${[[t.asideVersion, esc(String(full.version || '-'))],
   [t.asideTrust, esc(String(full.trust || 'community'))],
   ...(full.country ? [[t.asideCountry, esc(String(full.country))]] : []),
   [t.asideLicence, 'CC0-1.0']]
  .map(([k, v]) => `          <dt>${esc(k)}</dt><dd>${v}</dd>`).join('\n')}
        </dl>
${line ? `        <p class="who">${line}</p>\n` : ''}        <p class="note">${esc(t.asideLicenceBody)}</p>
      </div>

      <div class="cta">
        <a class="btn primary" href="${CWS}" data-umami-event="install" data-umami-event-store="chrome" data-umami-event-source="${esc(meta.id)}">${esc(t.installChrome)}</a>
        <a class="btn primary" href="${AMO}" data-umami-event="install" data-umami-event-store="firefox" data-umami-event-source="${esc(meta.id)}">${esc(t.installFirefox)}</a>
      </div>

      <div class="card defn">
        <h2>${esc(t.asideDefinition)}</h2>
        <p class="note">${esc(t.asideDefinitionBody)}</p>
        <details>
          <summary>${esc(meta.id)}.json</summary>
          <pre>${esc(JSON.stringify(full, null, 2))}</pre>
        </details>
        <p class="note"><a href="${ORIGIN_SOURCES}/${esc(meta.id)}.json" rel="noopener">${esc(t.asideRaw)} -></a></p>
      </div>
    </aside>

    <div class="body">
    <h1>${esc(copy.h1)}</h1>
    <p class="lead">${esc(copy.intro)}</p>
${isBeta ? `    <div class="box warn">
      <strong>${esc(t.betaWarnH)}</strong>
      <p>${esc(t.betaWarnBody(copy._beta))}</p>
    </div>

    <h2>${esc(t.betaMeantH)}</h2>
    <ul>
${(() => {
      const outs = outputsOf(full);
      // The stream's own name is the author's wording, in the author's language. It disambiguates when a
      // source has several outputs; on a single-output source it would just put a foreign word in bold
      // where the schema description already says, in this page's language, what the records contain.
      return outs.map((s) => {
        const what = esc(schemaText(L, lang, s.schema));
        return outs.length > 1
          ? `      <li><strong>${esc(s.name || s.id || meta.id)}</strong> — ${what}</li>`
          : `      <li>${what}</li>`;
      }).join('\n');
    })()}
    </ul>

    <h2>${esc(t.betaHelpH)}</h2>
    <p>${esc(t.betaHelpBody)}</p>
` : ''}
${isBeta ? '' : `    <h2>${esc(t.whatYouGet)}</h2>
    <p>${esc(t.whatItIs(brand))}</p>
    <ul>
${rows}
    </ul>
${detail}${retention}${quirksBlock}${note}${gaps}
    <h2>${esc(t.how)}</h2>
    <p>${t.howIntro(esc(meta.domain))}</p>
    <ol class="steps">
${steps.map((x, i) => `      <li class="step"><h3>${esc(t.stepNames[i])}</h3><p>${esc(x)}</p></li>`).join('\n')}
    </ol>
    <p>${t.never} ${trust}</p>

    <div class="cta">
      <a class="btn primary" href="${CWS}" data-umami-event="install" data-umami-event-store="chrome" data-umami-event-source="${esc(meta.id)}">${esc(t.installChrome)}</a>
      <a class="btn primary" href="${AMO}" data-umami-event="install" data-umami-event-store="firefox" data-umami-event-source="${esc(meta.id)}">${esc(t.installFirefox)}</a>
    </div>
    <p class="lead">${esc(t.free(meta.name))}</p>
    <p class="lead">${esc(t.chromeNote)}</p>

    <h2>${esc(t.faqH)}</h2>
${faq.map(([q, a]) => `    <h3>${esc(q)}</h3>\n    <p>${esc(a)}</p>`).join('\n')}`}

${history}${credit}${provenance}
${siblings.length ? `    <h2>${esc(t.siblings(groupOf(meta)[lang]))}</h2>
    <ul>
${siblings.map((sb) => `      <li><a href="${LANGS[lang].path(sb.slug)}">${esc(sb.h1)}</a></li>`).join('\n')}
    </ul>

` : ''}    <h2>${esc(t.teachH)}</h2>
    <p>${t.teachBody}</p>

    <h2>${esc(t.other)}</h2>
    <p>${t.otherBody}</p>
    </div>
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

  // Declare the list. The page already shows every guide; an ItemList is what lets an extractor state
  // "these services are covered" without scraping cards out of markup.
  const flat = groups.flatMap((g) => g.items || []);
  const listLd = {
    '@context': 'https://schema.org', '@type': 'ItemList', inLanguage: lang,
    name: t.indexTitle, numberOfItems: flat.length,
    itemListElement: flat.map((e, n) => ({
      '@type': 'ListItem', position: n + 1, name: e.name || e.brand || e.id,
      url: ORIGIN + LANGS[lang].path(e.slug),
    })),
  };
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(t.indexTitle)} — Habeas</title>
  <script type="application/ld+json">
${JSON.stringify(listLd, null, 2)}
  </script>
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

  <section class="band">
    <div class="wrap">
      <p class="kicker">${esc(t.indexKicker)}</p>
      <h1>${esc(t.indexTitle)}</h1>
      <p class="lead">${esc(t.indexIntro)}</p>
      <div class="cta">
        <a class="btn btn-p" href="${CWS}" data-umami-event="install" data-umami-event-store="chrome" data-umami-event-source="guide-index-hero">${esc(t.installChrome)}</a>
        <a class="btn btn-s" href="${AMO}" data-umami-event="install" data-umami-event-store="firefox" data-umami-event-source="guide-index-hero">${esc(t.installFirefox)}</a>
      </div>
    </div>
  </section>

  <main class="doc">
    <p class="lead">${esc(t.installLead)} ${esc(t.chromeNote)}</p>

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
  // A beta source gets a page too, but NOT a how-to: it is a draft nobody has run against a real
  // account, so a page promising "how to download your X" would rank for a promise it cannot keep.
  // Its copy is synthesised from what such a source genuinely has — the brand, the streams it declares,
  // and the reference it was drafted from — which is source-specific, so it is not the doorway content
  // an empty template would be. It is also noindex: reachable from the catalogue, absent from search.
  const isBeta = !!(meta.beta || full.beta);
  const override = overrides[meta.id] || {};
  // Registry content is the source of truth; the local file overrides it field by field.
  const entry = { brand: override.brand || full.brand || meta.name, credit: override.credit || full.credit, attribution: override.attribution || full.attribution };
  for (const lang of Object.keys(LANGS)) {
    const base = full.content?.[lang];
    if (base || override[lang]) entry[lang] = { ...base, ...override[lang] };
  }
  if (isBeta) {
    const ref = full.attribution?.derivedFrom || 'a published reference';
    for (const lang of Object.keys(LANGS)) {
      const t = LANGS[lang].t, brand = entry.brand;
      entry[lang] = { ...(entry[lang] || {}), // A slug of its own: the id is already unique and readable, and prefixing it keeps a draft's URL
        // visibly distinct from a verified guide's.
        slug: (entry[lang]?.slug) || `${meta.id}-beta`,
        h1: t.betaH1(brand), intro: t.betaIntro(brand), _beta: ref };
    }
  }
  if (!Object.keys(LANGS).some((l) => entry[l])) { skipped.push(`${meta.id} (no content)`); continue; }
  resolved.push({ id: meta.id, entry, meta, full, isBeta });
}

for (const { id, entry, meta, full, isBeta } of resolved) {
  for (const lang of Object.keys(LANGS)) {
    if (!entry[lang]) { console.error(`  ! ${id}: no ${lang} copy — that language gets no page`); continue; }
    // Siblings: same category group, same language, excluding itself.
    const group = groupOf(meta);
    const siblings = resolved
      .filter((r) => r.id !== id && r.entry[lang] && groupOf(r.meta).id === group.id)
      .map((r) => ({ slug: r.entry[lang].slug, h1: r.entry[lang].h1 }));
    writeFileSync(join(DOCS, ...LANGS[lang].dir.split('/'), `${entry[lang].slug}.html`), page({ lang, meta, full, entry, siblings, isBeta }));
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
if (MONOLINGUAL.size) console.error(`  ! changelog notes are plain strings on ${MONOLINGUAL.size} source(s), so one language's text is served to every language: ${[...MONOLINGUAL].join(', ')}. Key "changes" by language to fix.`);
if (UNGROUPED.size) console.error(`  ! ungrouped, filed under "${GROUPS[1].en}" — add their category to GROUPS: ${[...UNGROUPED].join('; ')}`);
