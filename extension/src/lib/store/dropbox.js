// Canonical store — Dropbox backend. Thin shim: the Dropbox API usage lives in the sink (sinks/dropbox.js)
// so token/refresh stay in one place. Config: { backend:'dropbox', sinkId, storeFolder? } — reuses the
// credentials of a configured Dropbox sink.
import { getConfig } from '../config.js';
import { dropboxStore } from '../../sinks/dropbox.js';
export async function make(cfg) {
  const sink = ((await getConfig()).sinks || []).find((s) => s.id === (cfg && cfg.sinkId) && s.type === 'dropbox');
  if (!sink) throw new Error('store dropbox: configure a Dropbox sink first');
  return dropboxStore(sink, cfg);
}
