// Canonical store — S3 (or S3-compatible) backend. Reuses a configured S3 sink's bucket + SigV4 creds
// (sinks/sinks.js). Config: { backend:'s3', sinkId, storeFolder? }.
import { getConfig } from '../config.js';
import { s3Store } from '../../sinks/sinks.js';
export async function make(cfg) {
  const sink = ((await getConfig()).sinks || []).find((s) => s.id === (cfg && cfg.sinkId) && s.type === 's3');
  if (!sink) throw new Error('store s3: configure an S3 sink first');
  return s3Store(sink, cfg);
}
