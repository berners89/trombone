// Pont minimal entre l'interface et le système de fichiers.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trombone', {
  initialFile: () => ipcRenderer.invoke('initial-file'),
  openFiles: (options) => ipcRenderer.invoke('open-files', options),
  savePdf: (defaultPath, data) => ipcRenderer.invoke('save-pdf', { defaultPath, data }),
  chooseExportFolder: () => ipcRenderer.invoke('choose-export-folder'),
  writeExport: (name, data) => ipcRenderer.invoke('write-export', { name, data }),
  finishExport: async () => null, // rien à finaliser : les fichiers sont déjà écrits dans le dossier
});
