// Thin, shared helpers to point the canonical store at a cloud/local backend — a single abstraction over the
// already-tested primitives (store.js#moveStoreTo, sinks/drive.js#driveSignIn, lib/fs.js#putHandle). The
// first-run assistant (and, in future, Settings) call THESE so the store-move flow lives in one place.
import { moveStoreTo } from './store.js';
import { putHandle } from './fs.js';
import { driveSignIn, driveConnected } from '../sinks/drive.js';

// Move the canonical store to Google Drive: connect once (interactive), then migrate. Returns items moved.
export async function useDriveStore() {
  if (!(await driveConnected())) await driveSignIn();
  return moveStoreTo({ backend: 'drive' });
}

// Move the canonical store to a local folder (Chromium File System Access): prompt for the folder, remember
// its handle (the key store/folder.js reads), then migrate. Returns items moved.
export async function useFolderStore() {
  const dir = await window.showDirectoryPicker();
  await putHandle('store-dir:canon', dir);
  return moveStoreTo({ backend: 'folder' });
}

// Whether the local-folder store is available (Chromium File System Access only).
export const folderStoreAvailable = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
