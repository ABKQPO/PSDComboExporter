// Preload: exposes a narrow, explicitly enumerated API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

const openFileListeners = new Set();
ipcRenderer.on('psd:open-file', (_e, payload) => {
  for (const fn of openFileListeners) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
});

contextBridge.exposeInMainWorld('psdExportNative', {
  isElectron: true,
  chooseZip: (suggestedName) => ipcRenderer.invoke('psd:choose-zip', suggestedName),
  chooseFolder: (suggestedName) => ipcRenderer.invoke('psd:choose-folder', suggestedName),
  beginFolder: (target) => ipcRenderer.invoke('psd:begin-folder', target),
  writeFolderFile: (file, data) => ipcRenderer.invoke('psd:write-folder-file', file, data),
  finishFolder: () => ipcRenderer.invoke('psd:finish-folder'),
  abortFolder: () => ipcRenderer.invoke('psd:abort-folder'),
  revealFolder: (folder) => ipcRenderer.invoke('psd:reveal-folder', folder),
  beginArchive: (target) => ipcRenderer.invoke('psd:begin-archive', target),
  appendArchive: (chunk) => ipcRenderer.invoke('psd:append-archive', chunk),
  finishArchive: () => ipcRenderer.invoke('psd:finish-archive'),
  abortArchive: () => ipcRenderer.invoke('psd:abort-archive'),
  revealFile: (file) => ipcRenderer.invoke('psd:reveal-file', file),
  saveText: (name, text) => ipcRenderer.invoke('psd:save-text', name, text),
  openText: () => ipcRenderer.invoke('psd:open-text'),
  onOpenFile: (fn) => {
    openFileListeners.add(fn);
    return () => openFileListeners.delete(fn);
  },
  ready: () => ipcRenderer.send('psd:ready'),
});

// Self-test hook (only answers when the app was started with --self-test).
contextBridge.exposeInMainWorld('psdExportNativeTestFile', () => ipcRenderer.invoke('psd:self-test-file'));
