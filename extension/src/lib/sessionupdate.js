// Serialized read → modify → write on a storage area, per key. The record-mode buffers (samples, assets,
// page texts, WebSocket frames) are updated this way from messages that arrive together — a page that loads
// three lists at once — and unserialized, each update reads the same old value and the last write wins.
//
//   const update = makeSessionUpdater(chrome.storage.session);
//   update('samples:x', (arr = []) => [sample, ...arr]);   // resolves once written
export function makeSessionUpdater(area) {
  const tails = new Map(); // key → the last queued update, so the next one starts after it
  return function update(key, fn) {
    const run = (tails.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const o = await area.get(key);
      await area.set({ [key]: fn(o[key]) });
    });
    tails.set(key, run);
    run.finally(() => { if (tails.get(key) === run) tails.delete(key); }).catch(() => {});
    return run;
  };
}
