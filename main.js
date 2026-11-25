// Processus principal : fenêtre, protocole local app://, dialogues de fichiers.
const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Un vrai schéma « standard » : modules ES, fetch et worker fonctionnent comme en https,
// sans jamais sortir du dossier de l'application.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let exportFolder = null;

function initialPdf(argv) {
  const candidate = argv.slice(1).find((a) => !a.startsWith('-') && /\.pdf$/i.test(a));
  return candidate && fs.existsSync(candidate) ? path.resolve(candidate) : null;
}

function safeName(name) {
  return path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

async function readEntry(file) {
  return { path: file, name: path.basename(file), data: await fs.promises.readFile(file) };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#e7e6ef',
    icon: path.join(ROOT, 'src', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://trombone/src/index.html');
  // Aucun lien d'un PDF ne doit naviguer dans la fenêtre de l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://trombone/')) e.preventDefault();
  });
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Interdit', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      return new Response('Introuvable', { status: 404 });
    }
  });

  ipcMain.handle('initial-file', async () => {
    const file = initialPdf(process.argv);
    return file ? readEntry(file) : null;
  });

  ipcMain.handle('open-files', async (event, { title, extensions, multi }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title,
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: title, extensions }],
    });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(readEntry));
  });

  ipcMain.handle('save-pdf', async (event, { defaultPath, data }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // Le type proposé suit l'extension du nom suggéré : PDF, mais aussi Word ou Excel pour les exports.
    const extension = (path.extname(defaultPath).slice(1) || 'pdf').toLowerCase();
    const res = await dialog.showSaveDialog(win, {
      title: 'Enregistrer',
      defaultPath,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, Buffer.from(data));
    return res.filePath;
  });

  ipcMain.handle('choose-export-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: "Dossier d'export",
      properties: ['openDirectory', 'createDirectory'],
    });
    exportFolder = res.canceled ? null : res.filePaths[0];
    return exportFolder;
  });

  // Écrit uniquement dans le dossier que l'utilisateur vient de choisir.
  ipcMain.handle('write-export', async (_event, { name, data }) => {
    if (!exportFolder) throw new Error("Aucun dossier d'export choisi");
    const target = path.join(exportFolder, safeName(name));
    await fs.promises.writeFile(target, Buffer.from(data));
    return target;
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
