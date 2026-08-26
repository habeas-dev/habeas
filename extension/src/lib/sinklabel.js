// One name for a destination, used everywhere one is shown.
//
// A local folder the user never renamed was displayed as its internal id — "local-folder-1" — which
// says nothing about WHICH folder it is, and that is the one destination type whose identity lives
// outside the extension. The File System Access API deliberately exposes no path (that would reveal
// the disk's layout), but it does give the directory's own name, which is what the user picked in the
// chooser and therefore what they will recognise. It is already stored as `folderName`, on creation
// and on every reconnect; it just was not being read.
//
// The id remains the last resort rather than the type's label: two unnamed Dropbox destinations would
// both read "Dropbox", and a name that cannot tell two things apart is worse than an ugly one.
//
// This lived in three places (popup, archive, settings) which had already drifted, so it lives here.
import { t } from './i18n.js';

export function sinkLabel(sink) {
  if (!sink) return '';
  if (sink.name) return sink.name;                                          // what the user called it wins
  // "Folder facturas" rather than the bare directory name: it says both WHAT kind of destination this
  // is and WHICH one, which the bare name alone does not once there are two of them.
  if (sink.type === 'local-folder' && sink.folderName) return t('sink_local_named', [sink.folderName]) || sink.folderName;
  return sink.id || sink.type || '';
}
