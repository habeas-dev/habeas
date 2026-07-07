// Client-side i18n for the landing. Default English; auto-detect browser language on
// first visit; manual EN/ES toggle persisted in localStorage. Updates <html lang>,
// <title>, meta description, and every [data-i18n] element.
const I18N = {
  en: {
    title: 'Habeas — export your own data from your own session',
    desc: 'Open-source browser runtime that helps you preserve your own receipts, invoices, statements and reports from your authenticated browser session — no stored credentials, no server-side scraping.',
    nav_install: 'Install',
    nav_how: 'How it works',
    nav_sources: 'Sources',
    nav_github: 'GitHub',
    cta_install: 'Download latest build',
    install_h2: 'Install',
    install_lead: 'Download the latest build from GitHub Releases. Store listings will come later.',
    install_chrome_h: 'Chrome & Chromium',
    install_chrome_b: 'Chrome, Edge, Brave, Opera and other Chromium browsers.',
    install_chrome_cta: 'Download latest build',
    install_soon_chrome: 'Chrome Web Store listing coming soon.',
    install_firefox_h: 'Firefox',
    install_firefox_b: 'Firefox 128 or newer.',
    install_firefox_cta: 'Download latest build',
    install_soon_firefox: 'Firefox Add-ons listing coming soon.',
    tagline: 'your data, in your hands',
    hero_h1: 'Export your own data.',
    hero_sub: 'Habeas helps you recover and preserve your own receipts, invoices, statements, investment reports and tax documents from your authenticated browser session — with no stored credentials.',
    feature_label: 'Highlights',
    feature_1: 'Runs in your browser',
    feature_2: 'No stored credentials',
    feature_3: 'Local-first',
    feature_4: 'Open source',
    cta_get: 'View on GitHub',
    cta_how: 'See how it works',
    sources_h2: 'Supported sources',
    sources_lead: 'Already works with multiple services.',
    sources_cta: 'View all supported sources →',
    sources_count: 'Currently supports {count} sources',
    problem_h2: 'The practical problem',
    problem_lead: 'You may need years of receipts, invoices, bank statements, investment reports or tax documents, but many sites make that history hard to keep.',
    problem1_h: 'No API or bulk export',
    problem1_b: 'You can see your receipts or statements on the website, but there is no usable export endpoint for you.',
    problem2_h: 'One document at a time',
    problem2_b: 'If a PDF exists at all, you often have to open and download every receipt manually.',
    problem3_h: 'Automation hits anti-bot walls',
    problem3_b: 'Cloudflare, Akamai and similar protections make remote scraping brittle or impossible.',
    problem4_h: 'Your right exists; the workflow does not',
    problem4_b: 'GDPR and habeas data support access to your own data, but everyday tooling still falls short.',
    how_h2: 'How it works',
    how_lead: 'Habeas runs inside the browser session you already use, so you keep control from login to export.',
    how1_h: '1. You log in normally',
    how1_b: 'Open the site, sign in yourself, and complete MFA or OTP in the usual flow.',
    how2_h: '2. Habeas reuses that live session',
    how2_b: 'It captures the same authenticated requests your browser already makes, without storing your password.',
    how3_h: '3. You export to your destination',
    how3_b: 'Download your original files and/or send structured output to a folder, Drive, app or HTTP endpoint you choose.',
    flow_h: 'Source → Habeas runtime → Sink',
    flow_step_source: 'Sources: websites holding your data (retailers, banks, providers)',
    flow_step_runtime: 'Habeas: local runtime inside your browser session',
    flow_step_sink: 'Sinks: Folder • Drive • Apps • HTTP',
    flow_note: 'Habeas standardizes access to each source. It does not replace or rewrite your documents.',
    flow_access_h: 'Common access interface, not common data format',
    flow_access_b: 'Each sink connects through one runtime and one access mechanism, instead of custom logic for every website.',
    flow_native_h: 'Sources keep native outputs',
    flow_native_b: 'A source can return original files (PDF, XLS, etc.) and/or structured JSON. Habeas does not transform originals.',
    source_defs_h2: 'Source definitions are independent',
    source_defs_lead: 'Supported services can grow without changing the Habeas runtime.',
    source_defs1_h: 'Sources are maintained as open definitions',
    source_defs1_b: 'Each source describes how to read one service within your own session, and can evolve separately from the runtime.',
    source_defs2_h: 'Grow support service by service',
    source_defs2_b: 'Adding support for a new website means adding a new source definition, not rebuilding your whole workflow.',
    recorder_h2: 'Session recorder for community growth',
    recorder_lead: 'Habeas includes a recorder that can help infer new source definitions from your own browsing session.',
    recorder_steps_h: 'Typical workflow',
    recorder_step_1: 'Record a supported workflow while you browse and authenticate normally.',
    recorder_step_2: 'Review the inferred source definition.',
    recorder_step_3: 'Refine fields and behavior when needed.',
    recorder_step_4: 'Share it back to the community if you want.',
    recorder_note: 'You stay in control: no credential sharing, no hidden remote automation.',
    why_h2: 'Why Habeas is different',
    why_lead: 'Traditional aggregators move the login and scraping to their servers. Habeas does not.',
    why_col_traditional: 'Traditional aggregators',
    why_col_habeas: 'Habeas',
    why_row_1: 'Stores credentials',
    why_row_1_traditional: 'Often',
    why_row_1_habeas: 'Never',
    why_row_2: 'Remote login',
    why_row_2_traditional: 'Yes',
    why_row_2_habeas: 'No',
    why_row_3: 'Server-side scraping',
    why_row_3_traditional: 'Yes',
    why_row_3_habeas: 'No',
    why_row_4: 'Runs in your own browser',
    why_row_4_traditional: 'No',
    why_row_4_habeas: 'Yes',
    why_row_5: 'Local-first',
    why_row_5_traditional: 'Rarely',
    why_row_5_habeas: 'Yes',
    dest_h2: 'Send it where you want',
    dest_lead: 'One inventory, then choose how to keep it or where to send it.',
    dest1_h: 'Local folder',
    dest1_b: 'Save to a folder on your disk — or a Drive/Dropbox-synced one for cloud with zero setup.',
    dest2_h: 'Google Drive',
    dest2_b: 'Upload natively to your own Drive (scope drive.file — only files Habeas creates).',
    dest3_h: 'Your own app',
    dest3_b: 'POST normalized records and PDFs to any endpoint you configure.',
    dev_h2: 'For developers',
    dev_lead: 'Build apps on top of users’ own sessions without handling their credentials.',
    dev_1: 'Integrate once with Habeas sinks instead of implementing provider-specific extraction per website.',
    dev_2: 'Users authenticate themselves in their own browser sessions.',
    dev_3: 'Your app receives user-authorized outputs, not login secrets.',
    dev_4: 'Interoperability lives at the access layer; sources keep native documents and data.',
    oss_h2: 'Free and open source',
    oss_lead: 'AGPL-3.0, built in the open, auditable by anyone, and open to contributions.',
    oss_cta: 'View on GitHub',
    footer_legal: 'Habeas is a tool for exercising your own data rights (GDPR Art. 20 / habeas data). It runs in your browser, under your own login, and never sends your data or credentials to us. It is not legal advice, and some services’ terms may restrict automated access — use responsibly.',
  },
  es: {
    title: 'Habeas — exporta tus propios datos desde tu propia sesión',
    desc: 'Runtime open-source en el navegador que te ayuda a preservar tus tickets, facturas, extractos e informes desde tu sesión autenticada — sin guardar credenciales ni hacer scraping desde un servidor.',
    nav_install: 'Instalar',
    nav_how: 'Cómo funciona',
    nav_sources: 'Fuentes',
    cta_install: 'Descargar la última versión',
    install_h2: 'Instalar',
    install_lead: 'Descarga la última versión desde GitHub Releases. Las tiendas del navegador llegarán después.',
    install_chrome_h: 'Chrome y Chromium',
    install_chrome_b: 'Chrome, Edge, Brave, Opera y otros navegadores Chromium.',
    install_chrome_cta: 'Descargar la última versión',
    install_soon_chrome: 'Ficha en la Chrome Web Store: próximamente.',
    install_firefox_h: 'Firefox',
    install_firefox_b: 'Firefox 128 o superior.',
    install_firefox_cta: 'Descargar la última versión',
    install_soon_firefox: 'Ficha en Firefox Add-ons: próximamente.',
    nav_github: 'GitHub',
    tagline: 'tus datos, en tus manos',
    hero_h1: 'Exporta tus propios datos.',
    hero_sub: 'Habeas te ayuda a recuperar y preservar tus tickets, facturas, extractos, informes de inversión y documentos fiscales desde tu sesión autenticada del navegador, sin guardar credenciales.',
    feature_label: 'Puntos clave',
    feature_1: 'Corre en tu navegador',
    feature_2: 'No guarda credenciales',
    feature_3: 'Local-first',
    feature_4: 'Código abierto',
    cta_get: 'Ver en GitHub',
    cta_how: 'Ver cómo funciona',
    sources_h2: 'Fuentes disponibles',
    sources_lead: 'Ya funciona con múltiples servicios.',
    sources_cta: 'Ver todas las fuentes disponibles →',
    sources_count: 'Actualmente soporta {count} fuentes',
    problem_h2: 'El problema práctico',
    problem_lead: 'Puede que necesites años de tickets, facturas, extractos bancarios, informes de inversión o documentos fiscales, pero muchos sitios dificultan conservar ese historial.',
    problem1_h: 'Sin API ni exportación masiva',
    problem1_b: 'Puedes ver tickets o extractos en la web, pero no existe un endpoint de exportación usable para ti.',
    problem2_h: 'Un documento cada vez',
    problem2_b: 'Si existe un PDF, muchas veces tienes que abrir y descargar cada recibo manualmente.',
    problem3_h: 'La automatización choca con muros anti-bot',
    problem3_b: 'Cloudflare, Akamai y protecciones similares hacen que el scraping remoto sea frágil o imposible.',
    problem4_h: 'El derecho existe; el flujo no',
    problem4_b: 'El RGPD y el habeas data respaldan el acceso a tus datos, pero las herramientas cotidianas siguen faltando.',
    how_h2: 'Cómo funciona',
    how_lead: 'Habeas corre dentro de la sesión del navegador que ya usas, para que mantengas el control desde el login hasta la exportación.',
    how1_h: '1. Tú haces login normal',
    how1_b: 'Abres la web, inicias sesión tú mismo y completas la MFA u OTP en el flujo habitual.',
    how2_h: '2. Habeas reutiliza esa sesión viva',
    how2_b: 'Captura las mismas peticiones autenticadas que ya hace tu navegador, sin guardar tu contraseña.',
    how3_h: '3. Exportas al destino que quieras',
    how3_b: 'Descarga tus ficheros originales y/o envía salida estructurada a la carpeta, Drive, app o endpoint HTTP que elijas.',
    flow_h: 'Fuente → Runtime Habeas → Destino',
    flow_step_source: 'Fuentes: webs con tus datos (retail, bancos, proveedores)',
    flow_step_runtime: 'Habeas: runtime local dentro de tu sesión del navegador',
    flow_step_sink: 'Destinos: Carpeta • Drive • Apps • HTTP',
    flow_note: 'Habeas estandariza cómo se accede a cada fuente. No sustituye ni reescribe tus documentos.',
    flow_access_h: 'Interfaz de acceso común, no formato de datos común',
    flow_access_b: 'Cada destino se conecta por un runtime y un mecanismo de acceso comunes, en vez de lógica a medida para cada web.',
    flow_native_h: 'Las fuentes mantienen salidas nativas',
    flow_native_b: 'Una fuente puede devolver ficheros originales (PDF, XLS, etc.) y/o JSON estructurado. Habeas no transforma los originales.',
    source_defs_h2: 'Las definiciones de fuente son independientes',
    source_defs_lead: 'La lista de servicios soportados puede crecer sin cambiar el runtime de Habeas.',
    source_defs1_h: 'Las fuentes se mantienen como definiciones abiertas',
    source_defs1_b: 'Cada fuente describe cómo leer un servicio dentro de tu propia sesión y puede evolucionar separada del runtime.',
    source_defs2_h: 'Soporte que crece servicio a servicio',
    source_defs2_b: 'Añadir soporte para una web nueva significa añadir una definición de fuente, no rehacer todo el flujo.',
    recorder_h2: 'Grabador de sesión para crecer en comunidad',
    recorder_lead: 'Habeas incluye un grabador que puede ayudar a inferir nuevas definiciones de fuente desde tu propia navegación.',
    recorder_steps_h: 'Flujo habitual',
    recorder_step_1: 'Graba un flujo soportado mientras navegas y te autenticas de forma normal.',
    recorder_step_2: 'Revisa la definición de fuente inferida.',
    recorder_step_3: 'Refina campos y comportamiento si hace falta.',
    recorder_step_4: 'Compártela de vuelta con la comunidad si quieres.',
    recorder_note: 'Mantienes el control: sin compartir credenciales y sin automatización remota oculta.',
    why_h2: 'Por qué Habeas es diferente',
    why_lead: 'Los agregadores tradicionales trasladan el login y el scraping a sus servidores. Habeas no.',
    why_col_traditional: 'Agregadores tradicionales',
    why_col_habeas: 'Habeas',
    why_row_1: 'Guardan credenciales',
    why_row_1_traditional: 'A menudo',
    why_row_1_habeas: 'Nunca',
    why_row_2: 'Login remoto',
    why_row_2_traditional: 'Sí',
    why_row_2_habeas: 'No',
    why_row_3: 'Scraping del lado servidor',
    why_row_3_traditional: 'Sí',
    why_row_3_habeas: 'No',
    why_row_4: 'Se ejecuta en tu propio navegador',
    why_row_4_traditional: 'No',
    why_row_4_habeas: 'Sí',
    why_row_5: 'Local-first',
    why_row_5_traditional: 'Rara vez',
    why_row_5_habeas: 'Sí',
    dest_h2: 'Envíalo a donde quieras',
    dest_lead: 'Un inventario, y luego eliges cómo guardarlo o a dónde enviarlo.',
    dest1_h: 'Carpeta local',
    dest1_b: 'Guarda en una carpeta de tu disco — o en una sincronizada con Drive/Dropbox para tener nube sin configurar nada.',
    dest2_h: 'Google Drive',
    dest2_b: 'Sube de forma nativa a tu propio Drive (scope drive.file — solo los ficheros que Habeas crea).',
    dest3_h: 'Tu propia app',
    dest3_b: 'Envía por POST los registros normalizados y PDFs a cualquier endpoint que configures.',
    dev_h2: 'Para desarrolladores',
    dev_lead: 'Construye apps sobre las sesiones reales de los usuarios sin gestionar sus credenciales.',
    dev_1: 'Integra una vez con los destinos de Habeas en vez de implementar extracción específica por cada web.',
    dev_2: 'Los usuarios se autentican ellos mismos en su propio navegador.',
    dev_3: 'Tu app recibe salidas autorizadas por el usuario, no secretos de login.',
    dev_4: 'La interoperabilidad está en la capa de acceso; las fuentes conservan documentos y datos nativos.',
    oss_h2: 'Libre y de código abierto',
    oss_lead: 'AGPL-3.0, desarrollado en abierto, auditable por cualquiera y abierto a contribuciones.',
    oss_cta: 'Ver en GitHub',
    footer_legal: 'Habeas es una herramienta para ejercer tus propios derechos sobre tus datos (RGPD Art. 20 / habeas data). Corre en tu navegador, bajo tu propio login, y nunca nos envía tus datos ni credenciales. No es asesoramiento legal, y los términos de algunos servicios pueden restringir el acceso automatizado — úsalo con responsabilidad.',
  },
};

const SOURCES_INDEX = 'https://habeas-dev.github.io/sources/index.json';
const SOURCE_PREVIEW_LIMIT = 8;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
let LANG = 'en';
let SOURCE_PREVIEW = [];
let SOURCE_COUNT = 0;

function detectLang() {
  const saved = localStorage.getItem('habeas-lang');
  if (saved && I18N[saved]) return saved;
  return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}

function translate(lang, key, params = {}) {
  const dict = I18N[lang] || I18N.en;
  const value = dict[key];
  if (value == null) return '';
  return String(value).replace(/\{(\w+)\}/g, (_, token) => params[token] ?? '');
}

function safeUpdateMetaTag(selector, attr, value) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.setAttribute(attr, value);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function flag(code) {
  if (!code) return '';
  if (code === 'global') return '🌐';
  if (!/^[a-z]{2}$/i.test(code)) return '';
  return code.toUpperCase().replace(/./g, (char) => String.fromCodePoint(0x1F1E6 + char.charCodeAt(0) - 'A'.charCodeAt(0)));
}

function shuffleArray(sources) {
  const pool = sources.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function pickRandomSources(sources, count) {
  return shuffleArray(sources).slice(0, count);
}

function previewCard(source) {
  const country = typeof source.country === 'string' ? source.country : '';
  return `<div class="src"><div class="top"><span class="name">${esc(source.name)}</span></div><div class="meta">${country ? `${flag(country)} ` : ''}${esc(source.service)}</div></div>`;
}

function isValidSource(source) {
  return !!(source && typeof source.name === 'string' && typeof source.service === 'string');
}

function renderSourcePreview() {
  const section = document.getElementById('sources-preview');
  if (!section || !SOURCE_PREVIEW.length) return;
  const count = document.getElementById('sources-preview-count');
  const list = document.getElementById('sources-preview-list');
  if (count) count.textContent = translate(LANG, 'sources_count', { count: SOURCE_COUNT });
  if (list) list.innerHTML = SOURCE_PREVIEW.map(previewCard).join('');
  section.hidden = false;
}

async function initSourcePreview() {
  const section = document.getElementById('sources-preview');
  if (!section) return;
  try {
    const response = await fetch(SOURCES_INDEX);
    if (!response.ok) throw new Error('catalog fetch failed');
    const data = await response.json();
    const sources = Array.isArray(data?.sources) ? data.sources.filter(isValidSource) : [];
    if (!sources.length) return;
    SOURCE_COUNT = sources.length;
    SOURCE_PREVIEW = pickRandomSources(sources, Math.min(SOURCE_PREVIEW_LIMIT, sources.length));
    renderSourcePreview();
  } catch (error) {
    console.debug('Source catalog unavailable:', error);
  }
}

function apply(lang) {
  LANG = lang;
  const dict = I18N[lang] || I18N.en;
  document.documentElement.lang = lang;
  document.title = dict.title;
  safeUpdateMetaTag('meta[name="description"]', 'content', dict.desc);
  safeUpdateMetaTag('meta[property="og:title"]', 'content', dict.title);
  safeUpdateMetaTag('meta[property="og:description"]', 'content', dict.desc);
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = dict[el.dataset.i18n];
    if (v != null) el.textContent = v;
  });
  document.querySelectorAll('.langswitch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  });
  renderSourcePreview();
}

function setLang(lang) {
  localStorage.setItem('habeas-lang', lang);
  apply(lang);
}

document.addEventListener('DOMContentLoaded', () => {
  apply(detectLang());
  document.querySelectorAll('.langswitch button').forEach((b) => {
    b.addEventListener('click', () => setLang(b.dataset.lang));
  });
  initSourcePreview();
});
