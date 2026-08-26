// Is a local-folder destination usable in THIS browser?
//
// It never is in Firefox: the File System Access API is Chromium-only, and a folder destination is
// nothing but a handle obtained through it. Settings already hides the option to CREATE one — but
// configuration syncs between browsers, so a folder created in Chrome arrives in Firefox intact, and
// there it looked completely ordinary: listed among the destinations, offered as a copy origin and as a
// copy target, and failing only at the moment of use.
//
// The answer is not to drop it. Configuration sync adopts what it finds and never prunes, so deleting
// the entry here would take it away from Chrome too — losing a working destination to tidy up a
// cosmetic problem on the other machine. It stays, it is marked as unavailable here, and it is left out
// of every operation that could only fail.
export const folderSinksUsable = () => typeof globalThis.showDirectoryPicker === 'function';

// A sink this browser cannot act on at all — as a source or as a destination.
export const sinkUnavailableHere = (sink) => !!sink && sink.type === 'local-folder' && !folderSinksUsable();
