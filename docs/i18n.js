// Client-side i18n for the landing. Default English; auto-detect browser language on
// first visit; manual EN/ES toggle persisted in localStorage. Updates <html lang>,
// <title>, meta description, and every [data-i18n] element.
const I18N = {
  en: {
    title: 'Habeas — your data, in your hands',
    desc: 'Open-source browser extension that extracts your own data from services that lock it behind non-automatable walls — within your own session.',
    nav_how: 'How it works',
    nav_github: 'GitHub',
    tagline: 'your data, in your hands',
    hero_h1: 'Reclaim your own data.',
    hero_sub: 'Habeas is an open-source browser extension that extracts your own data — receipts, invoices, transactions — from services that lock it behind non-automatable walls. Entirely within your own session.',
    cta_get: 'View on GitHub',
    cta_how: 'How it works',
    problem_h2: 'Your data is yours. Getting it out isn’t.',
    problem_lead: 'The GDPR grants you a right to your data. Yet many services make bulk export practically impossible: no API, no email export, and a web interface guarded by anti-bot walls like Cloudflare and Akamai.',
    how_h2: 'How it works',
    how_lead: 'Habeas runs where you already are — logged in, in your own browser.',
    how1_h: 'In your own session',
    how1_b: 'It runs in your browser, after you log in yourself. No stored credentials, no server-side login, no MFA bypass.',
    how2_h: 'Local-first',
    how2_b: 'Extracted data goes only where you choose. The project runs no servers and never receives your data.',
    how3_h: 'Declarative adapters',
    how3_b: 'Per-service adapters are data, not code — auditable and open to community contributions.',
    dest_h2: 'Send it where you want',
    dest_lead: 'One inventory, your choice of destination.',
    dest1_h: 'Local folder',
    dest1_b: 'Save to a folder on your disk — or a Drive/Dropbox-synced one for cloud with zero setup.',
    dest2_h: 'Google Drive',
    dest2_b: 'Upload natively to your own Drive (scope drive.file — only files Habeas creates).',
    dest3_h: 'Your own app',
    dest3_b: 'POST normalized records and PDFs to any endpoint you configure.',
    oss_h2: 'Free and open source',
    oss_lead: 'AGPL-3.0, built in the open. Contributions welcome.',
    oss_cta: 'View on GitHub',
    footer_legal: 'Habeas is a tool for exercising your own data rights (GDPR Art. 20 / habeas data). It runs in your browser, under your own login, and never sends your data or credentials to us. It is not legal advice, and some services’ terms may restrict automated access — use responsibly.',
  },
  es: {
    title: 'Habeas — tus datos, en tus manos',
    desc: 'Extensión de navegador open-source que extrae tus propios datos de servicios que los esconden tras muros no automatizables — dentro de tu propia sesión.',
    nav_how: 'Cómo funciona',
    nav_github: 'GitHub',
    tagline: 'tus datos, en tus manos',
    hero_h1: 'Recupera tus propios datos.',
    hero_sub: 'Habeas es una extensión de navegador open-source que extrae tus propios datos —tickets, facturas, movimientos— de servicios que los esconden tras muros no automatizables. Dentro de tu propia sesión.',
    cta_get: 'Ver en GitHub',
    cta_how: 'Cómo funciona',
    problem_h2: 'Tus datos son tuyos. Sacarlos, no tanto.',
    problem_lead: 'El RGPD te da derecho a tus datos. Pero muchos servicios hacen la exportación masiva casi imposible: sin API, sin export por email, y una web protegida por muros anti-bot como Cloudflare o Akamai.',
    how_h2: 'Cómo funciona',
    how_lead: 'Habeas se ejecuta donde ya estás — logueado, en tu propio navegador.',
    how1_h: 'En tu propia sesión',
    how1_b: 'Corre en tu navegador, después de que TÚ te loguees. Sin credenciales guardadas, sin login en servidor, sin saltarse la MFA.',
    how2_h: 'Local-first',
    how2_b: 'Los datos extraídos van solo a donde tú elijas. El proyecto no tiene servidores y nunca recibe tus datos.',
    how3_h: 'Adaptadores declarativos',
    how3_b: 'Los adaptadores por servicio son datos, no código — auditables y abiertos a la comunidad.',
    dest_h2: 'Envíalo a donde quieras',
    dest_lead: 'Un inventario, y tú eliges el destino.',
    dest1_h: 'Carpeta local',
    dest1_b: 'Guarda en una carpeta de tu disco — o en una sincronizada con Drive/Dropbox para tener nube sin configurar nada.',
    dest2_h: 'Google Drive',
    dest2_b: 'Sube de forma nativa a tu propio Drive (scope drive.file — solo los ficheros que Habeas crea).',
    dest3_h: 'Tu propia app',
    dest3_b: 'Envía por POST los registros normalizados y PDFs a cualquier endpoint que configures.',
    oss_h2: 'Libre y de código abierto',
    oss_lead: 'AGPL-3.0, desarrollado en abierto. Contribuciones bienvenidas.',
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
