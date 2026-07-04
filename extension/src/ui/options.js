import { getConfig, upsert, remove } from '../lib/config.js';
import { setSecret } from '../lib/secrets.js';
import { connectDrive, redirectUri } from '../sinks/drive.js';
import CARREFOUR from '../adapters/carrefour-es.js';

const CATALOG = { 'carrefour-es': CARREFOUR };
const $ = (s) => document.querySelector(s);

async function render() {
  const cfg = await getConfig();

  $('#ds').innerHTML = Object.values(CATALOG).map((a) => {
    const on = cfg.datasources.some((d) => d.id === a.id && d.enabled);
    return `<div class="card"><b>${a.name}</b><code>${a.id}</code>
      <button data-ds="${a.id}" data-on="${on ? 1 : 0}">${on ? 'Desactivar' : 'Activar'}</button></div>`;
  }).join('');
  $('#ds').querySelectorAll('[data-ds]').forEach((b) => b.onclick = async () => {
    if (b.dataset.on === '1') await remove('datasources', b.dataset.ds);
    else await upsert('datasources', { id: b.dataset.ds, adapter: b.dataset.ds, enabled: true, options: {} });
    render();
  });

  $('#sinks').innerHTML = cfg.sinks.map((s) =>
    `<div class="card"><b>${s.id}</b><code>${s.type}</code>
      ${s.type === 'drive' ? `<button data-conn="${s.id}">Conectar Drive</button>` : ''}
      ${s.url ? `<small>${s.url}</small>` : ''}
      <button data-del="${s.id}">Eliminar</button></div>`).join('')
    || '<p class="muted">Aún no hay sinks.</p>';
  $('#sinks').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await remove('sinks', b.dataset.del); render(); });
  $('#sinks').querySelectorAll('[data-conn]').forEach((b) => b.onclick = async () => {
    const s = (await getConfig()).sinks.find((x) => x.id === b.dataset.conn);
    b.disabled = true; b.textContent = 'Conectando…';
    try { await connectDrive(s.clientId); b.textContent = '✓ Conectado'; }
    catch (e) { b.textContent = 'Conectar Drive'; alert('Drive: ' + e.message); }
    finally { b.disabled = false; }
  });
}

function renderFields() {
  const t = $('#stype').value;
  if (t === 'http') {
    $('#sfields').innerHTML = ' id:<input id="sid" size="8"> url:<input id="surl" size="26"> token:<input id="stok" size="12">';
  } else if (t === 'drive') {
    $('#sfields').innerHTML = ' id:<input id="sid" size="8"> <small>Client ID (opcional):</small><input id="sclient" size="30">'
      + `<div style="margin-top:6px"><small>Vacío = usa el client de Habeas. Redirect URI para Google Console (con la barra final):</small><br><code>${redirectUri()}</code></div>`;
  } else {
    $('#sfields').innerHTML = ' id:<input id="sid" size="8">';
  }
}

async function addSink() {
  const t = $('#stype').value;
  const id = ($('#sid') && $('#sid').value.trim()) || (t + '-1');
  const sink = { id, type: t };
  if (t === 'http') {
    sink.url = ($('#surl').value || '').trim();
    sink.tokenRef = 'secret://' + id;
    if ($('#stok').value.trim()) await setSecret(id, $('#stok').value.trim());
  } else if (t === 'drive') {
    sink.clientId = ($('#sclient').value || '').trim() || undefined;
    sink.rootFolderName = 'Habeas';
  }
  await upsert('sinks', sink);
  renderFields();
  render();
}

$('#stype').onchange = renderFields;
$('#addsink').onclick = addSink;
renderFields();
render();
