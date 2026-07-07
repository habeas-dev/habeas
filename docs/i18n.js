// Client-side i18n for the landing. Default English; auto-detect browser language on
// first visit; manual EN/ES toggle persisted in localStorage. Updates <html lang>,
// <title>, meta description, and every [data-i18n] element.
const I18N = {
  en: {
    title: 'Habeas — export your own data from your own session',
    desc: 'Open-source browser extension that exports your own receipts, invoices and transactions from your authenticated browser session — no stored credentials, no server-side scraping.',
    nav_install: 'Install',
    nav_how: 'How it works',
    nav_sources: 'Sources',
    nav_github: 'GitHub',
    cta_install: 'Download alpha build',
    install_h2: 'Install',
    install_lead: 'Download the current alpha build from GitHub Releases. Store listings will come later.',
    install_chrome_h: 'Chrome & Chromium',
    install_chrome_b: 'Chrome, Edge, Brave, Opera and other Chromium browsers.',
    install_chrome_cta: 'Download latest build',
    install_soon_chrome: 'Chrome Web Store listing coming soon.',
    install_firefox_h: 'Firefox',
    install_firefox_b: 'Firefox 128 or newer.',
    install_firefox_cta: 'Download latest build',
    install_soon_firefox: 'Firefox Add-ons listing coming soon.',
    tagline: 'your data, in your hands',
    hero_h1: 'Export your own receipts, invoices and transactions.',
    hero_sub: 'Habeas runs inside your authenticated browser session, so you log in yourself, keep normal MFA, and never hand your credentials to a third-party server.',
    hero_note: 'Available today as an alpha extension: Carrefour España works end-to-end, with export to ZIP, local folders, Google Drive or HTTP.',
    feature_label: 'Highlights',
    feature_1: 'Runs in your browser',
    feature_2: 'You log in yourself',
    feature_3: 'No stored credentials',
    feature_4: 'Local-first',
    feature_5: 'Open source',
    cta_get: 'View on GitHub',
    cta_how: 'See how it works',
    problem_h2: 'The practical problem',
    problem_lead: 'Many sites let you view your history, but make real export slow or impractical.',
    problem1_h: 'No API or bulk export',
    problem1_b: 'You can see your receipts or statements on the website, but there is no usable export endpoint for you.',
    problem2_h: 'One document at a time',
    problem2_b: 'If a PDF exists at all, you often have to open and download every receipt manually.',
    problem3_h: 'Automation hits anti-bot walls',
    problem3_b: 'Cloudflare, Akamai and similar protections make remote scraping brittle or impossible.',
    problem4_h: 'Your right exists; the workflow does not',
    problem4_b: 'GDPR and habeas data support access to your own data, but everyday tooling still falls short.',
    how_h2: 'How it works',
    how_lead: 'Habeas stays inside the browser session you already use.',
    how1_h: '1. You log in normally',
    how1_b: 'Open the site, sign in yourself, and complete MFA or OTP in the usual flow.',
    how2_h: '2. Habeas reuses that live session',
    how2_b: 'It captures the same authenticated requests your browser already makes, without storing your password.',
    how3_h: '3. You export to your destination',
    how3_b: 'Download documents or send normalized records to a local folder, Google Drive or your own HTTP endpoint.',
    flow_h: 'Simple data flow',
    flow_step_1: 'Website',
    flow_step_2: 'Your authenticated browser',
    flow_step_3: 'Habeas extension',
    flow_step_4: 'ZIP / Drive / Folder / HTTP',
    flow_a11y: 'Data flow: website, then your authenticated browser, then the Habeas extension, then your chosen destination such as ZIP, Drive, Folder or HTTP.',
    flow_note: 'No backend logs into third-party services. No credentials leave the browser.',
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
    oss_h2: 'Free and open source',
    oss_lead: 'AGPL-3.0, built in the open, auditable by anyone, and open to contributions.',
    oss_cta: 'View on GitHub',
    footer_legal: 'Habeas is a tool for exercising your own data rights (GDPR Art. 20 / habeas data). It runs in your browser, under your own login, and never sends your data or credentials to us. It is not legal advice, and some services’ terms may restrict automated access — use responsibly.',
  },
  es: {
    title: 'Habeas — exporta tus propios datos desde tu propia sesión',
    desc: 'Extensión de navegador open-source que exporta tus propios tickets, facturas y movimientos desde tu sesión autenticada del navegador — sin guardar credenciales ni hacer scraping desde un servidor.',
    nav_install: 'Instalar',
    nav_how: 'Cómo funciona',
    nav_sources: 'Fuentes',
    cta_install: 'Descargar alpha',
    install_h2: 'Instalar',
    install_lead: 'Descarga la alpha actual desde GitHub Releases. Las tiendas del navegador llegarán después.',
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
    hero_h1: 'Exporta tus propios tickets, facturas y movimientos.',
    hero_sub: 'Habeas se ejecuta dentro de tu sesión autenticada del navegador: tú haces login, mantienes la MFA normal y nunca entregas tus credenciales a un servidor de terceros.',
    hero_note: 'Disponible hoy como extensión alpha: Carrefour España funciona de extremo a extremo, con exportación a ZIP, carpetas locales, Google Drive o HTTP.',
    feature_label: 'Puntos clave',
    feature_1: 'Corre en tu navegador',
    feature_2: 'Tú haces login',
    feature_3: 'No guarda credenciales',
    feature_4: 'Local-first',
    feature_5: 'Código abierto',
    cta_get: 'Ver en GitHub',
    cta_how: 'Ver cómo funciona',
    problem_h2: 'El problema práctico',
    problem_lead: 'Muchos sitios te dejan ver tu historial, pero hacen que exportarlo de verdad sea lento o poco práctico.',
    problem1_h: 'Sin API ni exportación masiva',
    problem1_b: 'Puedes ver tickets o extractos en la web, pero no existe un endpoint de exportación usable para ti.',
    problem2_h: 'Un documento cada vez',
    problem2_b: 'Si existe un PDF, muchas veces tienes que abrir y descargar cada recibo manualmente.',
    problem3_h: 'La automatización choca con muros anti-bot',
    problem3_b: 'Cloudflare, Akamai y protecciones similares hacen que el scraping remoto sea frágil o imposible.',
    problem4_h: 'El derecho existe; el flujo no',
    problem4_b: 'El RGPD y el habeas data respaldan el acceso a tus datos, pero las herramientas cotidianas siguen faltando.',
    how_h2: 'Cómo funciona',
    how_lead: 'Habeas se queda dentro de la sesión del navegador que ya usas.',
    how1_h: '1. Tú haces login normal',
    how1_b: 'Abres la web, inicias sesión tú mismo y completas la MFA u OTP en el flujo habitual.',
    how2_h: '2. Habeas reutiliza esa sesión viva',
    how2_b: 'Captura las mismas peticiones autenticadas que ya hace tu navegador, sin guardar tu contraseña.',
    how3_h: '3. Exportas al destino que quieras',
    how3_b: 'Descarga documentos o envía registros normalizados a una carpeta local, Google Drive o tu propio endpoint HTTP.',
    flow_h: 'Flujo simple de datos',
    flow_step_1: 'Sitio web',
    flow_step_2: 'Tu navegador autenticado',
    flow_step_3: 'Extensión Habeas',
    flow_step_4: 'ZIP / Drive / Carpeta / HTTP',
    flow_a11y: 'Flujo de datos: sitio web, luego tu navegador autenticado, luego la extensión Habeas y después el destino que elijas, como ZIP, Drive, Carpeta o HTTP.',
    flow_note: 'Ningún backend inicia sesión en servicios de terceros. Ninguna credencial sale del navegador.',
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
    oss_h2: 'Libre y de código abierto',
    oss_lead: 'AGPL-3.0, desarrollado en abierto, auditable por cualquiera y abierto a contribuciones.',
    oss_cta: 'Ver en GitHub',
    footer_legal: 'Habeas es una herramienta para ejercer tus propios derechos sobre tus datos (RGPD Art. 20 / habeas data). Corre en tu navegador, bajo tu propio login, y nunca nos envía tus datos ni credenciales. No es asesoramiento legal, y los términos de algunos servicios pueden restringir el acceso automatizado — úsalo con responsabilidad.',
  },
};

function detectLang() {
  const saved = localStorage.getItem('habeas-lang');
  if (saved && I18N[saved]) return saved;
  return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}

function apply(lang) {
  const dict = I18N[lang] || I18N.en;
  document.documentElement.lang = lang;
  document.title = dict.title;
  const md = document.querySelector('meta[name="description"]');
  if (md) md.setAttribute('content', dict.desc);
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute('content', dict.title);
  const ogDesc = document.querySelector('meta[property="og:description"]');
  if (ogDesc) ogDesc.setAttribute('content', dict.desc);
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = dict[el.dataset.i18n];
    if (v != null) el.textContent = v;
  });
  document.querySelectorAll('.langswitch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  });
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
});
