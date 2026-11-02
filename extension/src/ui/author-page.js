// Boots the recorder as its own page (author.html). Kept out of the HTML: the extension CSP
// (script-src 'self') blocks inline scripts, which left the page blank.
import { RECORDER_HTML, initAuthor } from './author.js';

const root = document.getElementById('rec-root');
root.innerHTML = RECORDER_HTML;
const p = new URLSearchParams(location.search);
initAuthor(root, { url: p.get('url'), guide: p.get('guide'), endpoint: p.get('endpoint'), base: p.get('base'), handoff: p.get('handoff') });
