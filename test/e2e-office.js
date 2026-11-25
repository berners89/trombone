// Essai des conversions et des formulaires dans la version navigateur :
//   xvfb-run npx electron --no-sandbox test/e2e-office.js
// Word → PDF, Excel → PDF, PDF → Word, PDF → Excel, puis remplissage d'un formulaire.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const WEB = path.join(__dirname, '..', 'web');
const OUT = path.join(__dirname, 'out');
const EXTRA = {
  '/__lettre.docx': path.join(__dirname, 'office', 'lettre.docx'),
  '/__tableau.xlsx': path.join(__dirname, 'office', 'tableau.xlsx'),
  '/__formulaire.pdf': path.join(OUT, 'formulaire.pdf'),
  '/__devis.pdf': path.join(__dirname, 'office', 'couleurs.pdf'),
  '/__couleurs.docx': path.join(__dirname, 'office', 'couleurs.docx'),
};
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = EXTRA[rel] || path.join(WEB, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(WEB) && !EXTRA[rel]) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

const PAGE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const all = (sel) => [...document.querySelectorAll(sel)];
  const out = {};
  window.__saved = [];
  window.claude = { use: async (name) => name === 'downloads' ? { save: async ({ filename, data }) => {
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.__saved.push({ filename, b64: btoa(bin) }); return { status: 'saved' }; } } : null };
  // Le sélecteur de fichiers est remplacé par un fichier servi localement.
  const pick = async (url, name) => { const data = new Uint8Array(await (await fetch(url)).arrayBuffer()); window.trombone.openFiles = async () => [{ name, path: null, data }]; };
  const firstText = async () => { $('[data-tool=select]').click(); await wait(800); const l = $('.page .textLayer'); return l ? l.textContent : ''; };

  await pick('/__lettre.docx', 'lettre.docx'); $('#act-office').click(); await wait(3000);
  out.wordToPdf = /Devis de rénovation/.test(await firstText()) && document.title;
  await pick('/__tableau.xlsx', 'tableau.xlsx'); $('#act-office').click(); await wait(3000);
  out.excelToPdf = /Carrelage grès cérame/.test(await firstText()) && document.title;

  await pick('/__devis.pdf', 'devis.pdf'); $('#btn-open').click(); await wait(2500);
  $('#act-word').click(); await wait(4000);
  window.__saved[window.__saved.length - 1].filename = 'devis-fidele.docx';
  $('#act-word-text').click(); await wait(3000);
  $('#act-excel').click(); await wait(3000);
  out.exports = window.__saved.map((s) => s.filename);

  await pick('/__formulaire.pdf', 'formulaire.pdf'); $('#btn-open').click(); await wait(2500);
  out.formToast = $('#toast').textContent;
  const fields = all('.formLayer > *');
  out.fields = fields.map((f) => f.tagName + (f.type ? ':' + f.type : ''));
  const type = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  type(fields[0], 'Camille Martin'); type(fields[1], 'Ligne une');
  fields[2].click();
  fields[3].value = 'Montluçon'; fields[3].dispatchEvent(new Event('change', { bubbles: true }));
  fields[5].click();
  await wait(200);
  $('#btn-save').click(); await wait(3500);
  out.saved = window.__saved.map((s) => s.filename);
  out.toast = $('#toast').textContent;
  return { out, files: window.__saved };
})()`;

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', async () => {
    const problems = [];
    const win = new BrowserWindow({ width: 1360, height: 900 });
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') problems.push(`${e.level}: ${e.message}`.slice(0, 300)); });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    try {
      await new Promise((r) => setTimeout(r, 800));
      const { out, files } = await win.webContents.executeJavaScript(PAGE, true);
      for (const f of files) fs.writeFileSync(path.join(OUT, 'office-' + f.filename), Buffer.from(f.b64, 'base64'));
      fs.writeFileSync(path.join(OUT, 'capture-office.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ...out, problems }, null, 1));
    } catch (err) { console.error('E2E', err); process.exitCode = 1; }
    server.close(); app.quit();
  });
});
