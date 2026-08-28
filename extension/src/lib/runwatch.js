// A run that stops without finishing must leave evidence.
//
// The failure this exists for produced none: a sync stopped, and because what stopped it was the
// BACKGROUND being taken away — Firefox suspending its event page, Chrome recycling its worker — no catch
// ran, nothing reached the activity log, no notification fired, and the status line kept its last words.
// It looked busy for four days.
//
// So a run writes a small in-flight marker, updates it as it advances, and clears it when it ends by any
// route including failure. A marker still present at the next start-up is proof the background died
// underneath a run, and it names the phase it died in. That distinguishes "the background was killed"
// from "a request hung" (which now ends in a timeout error) — on the user's own machine, with their own
// destinations, without asking them to reconfigure anything to find out.
import { chrome } from './ext.js';

const KEY = 'habeas:run';
const ABANDONED = KEY + ':abandoned';
// The marker only has to survive a suspension, so it is written on a coarse cadence — a per-document
// caller must be free to mark every document without turning progress into a write storm.
const MIN_WRITE_MS = 5000;

let current = null, lastWrite = 0;

async function persist() {
  if (!current) return;
  lastWrite = Date.now();
  try { await chrome.storage.local.set({ [KEY]: current }); } catch (e) { /* best-effort by design */ }
}

// Start a run. Any marker still sitting there belongs to a run that died; it is left alone so the next
// takeUnfinishedRun() still reports it — a crash must not be erased by the next attempt.
export async function beginRun(info = {}) {
  try {
    const prev = (await chrome.storage.local.get(KEY))[KEY];
    if (prev && !prev.abandoned) {
      // Preserve the corpse under its own key; the live marker takes KEY.
      await chrome.storage.local.set({ [ABANDONED]: { ...prev, abandoned: true } });
    }
  } catch (e) {}
  current = { ...info, phase: 'starting', startedAt: new Date().toISOString(), lastBeat: Date.now() };
  lastWrite = 0;
  await persist();
}

// Record where the run has got to. Safe to call per document / per page.
export async function markPhase(phase) {
  if (!current) return;
  current.phase = phase;
  current.lastBeat = Date.now();
  if (Date.now() - lastWrite >= MIN_WRITE_MS) await persist();
}

// The run finished — cleanly or with an error. Either way it is accounted for, so nothing is reported.
export async function endRun() {
  current = null;
  try { await chrome.storage.local.remove(KEY); } catch (e) {}
}

// Called at start-up: return the run that never finished, or null. Clears it, so a restart loop reports
// each death once rather than the same one forever.
export async function takeUnfinishedRun() {
  let rec = null;
  try {
    // Only the two keys. Asking for the whole of storage.local would deserialize every ledger, log and
    // document index on the way past — at start-up, which is the one moment that must stay cheap.
    const o = await chrome.storage.local.get([KEY, ABANDONED]);
    rec = o[ABANDONED] || (o[KEY] && !current ? o[KEY] : null);
    if (o[ABANDONED]) await chrome.storage.local.remove(ABANDONED);
    else if (rec) await chrome.storage.local.remove(KEY);
  } catch (e) { return null; }
  if (!rec) return null;
  const { abandoned, ...out } = rec;
  return out;
}
