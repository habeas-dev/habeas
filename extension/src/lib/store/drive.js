// Canonical store — Google Drive backend. A thin shim: the Drive API usage lives in the Drive sink
// (sinks/drive.js) so OAuth + REST calls stay in one place. Config: { backend:'drive', clientId?,
// rootFolderName?, storeFolder? }. Uses the shipped OAuth client (drive.file scope) by default.
export { driveStore as make } from '../../sinks/drive.js';
