// Canonical store — WebDAV backend. Reuses a configured WebDAV sink's URL + Basic auth (sinks/sinks.js).
// Config: { backend:'webdav', sinkId, storeFolder? }.
import { getConfig } from '../config.js';
import { webdavStore } from '../../sinks/sinks.js';
export async function make(cfg) {
  const sink = ((await getConfig()).sinks || []).find((s) => s.id === (cfg && cfg.sinkId) && s.type === 'webdav');
  if (!sink) throw new Error('store webdav: configure a WebDAV sink first');
  return webdavStore(sink, cfg);
}
