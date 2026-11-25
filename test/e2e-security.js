// Essai du lot sécurité dans la version navigateur :
//   xvfb-run npx electron --no-sandbox test/e2e-security.js
// Caviardage, compression des images, enregistrement avec mot de passe, ouverture d'un PDF protégé,
// et choix d'une des polices embarquées.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const WEB = path.join(__dirname, '..', 'web');
const OUT = path.join(__dirname, 'out');
const EXTRA = {
  '/__exemple.pdf': path.join(OUT, 'exemple.pdf'),
  '/__scan.pdf': path.join(OUT, 'photo.pdf'),
  '/__protege.pdf': path.join(OUT, 'protege.pdf'),
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
  const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
  const out = {};
  window.__saved = [];
  window.claude = { use: async (name) => name === 'downloads' ? { save: async ({ filename, data }) => {
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.__saved.push({ filename, b64: btoa(bin) }); return { status: 'saved' }; } } : null };
  const open = async (url, name) => { const data = new Uint8Array(await (await fetch(url)).arrayBuffer()); window.trombone.openFiles = async () => [{ name, path: null, data }]; $('#btn-open').click(); await wait(2500); return data.length; };
  const firstText = async () => { $('[data-tool=select]').click(); await wait(800); const l = $('.page .textLayer'); return l ? l.textContent : ''; };

  // 1. Caviardage de la ligne « Facture… » de la page 1
  await open('/__exemple.pdf', 'contrat.pdf');
  $('[data-tool=edit]').click(); await wait(900);
  const line = all('.page svg .textbox')[1].getBoundingClientRect();
  $('[data-tool=redact]').click();
  const svg = $('.page svg');
  ptr(svg, 'pointerdown', line.left - 4, line.top - 3); ptr(svg, 'pointermove', line.right + 4, line.bottom + 3); ptr(svg, 'pointerup', line.right + 4, line.bottom + 3);
  out.zones = all('.page svg .annot.redact').length;
  $('#btn-save').click(); await wait(5000);
  out.redactToast = $('#toast').textContent;
  const after = await firstText();
  out.redacted = { titleKept: /Document A/.test(after), secretGone: !/Facture/.test(after) };

  // 2. Police embarquée choisie à la main (Montserrat) sur la page 2
  $('[data-tool=edit]').click(); await wait(900);
  const blocks = all('.page')[1].querySelectorAll('svg .textbox');
  all('.page')[1].scrollIntoView(); await wait(600);
  const b = blocks[1].getBoundingClientRect();
  ptr(blocks[1], 'pointerdown', b.left + 5, b.top + 5); ptr(blocks[1], 'pointerup', b.left + 5, b.top + 5); await wait(600);
  out.fontChoices = $('.stylebar select').options.length;
  const select = $('.stylebar select'); select.value = 'montserrat'; select.dispatchEvent(new Event('change')); await wait(800);
  const area = $('.note.edit'); area.focus(); area.value = 'Texte en Montserrat.'; area.dispatchEvent(new Event('input'));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(500);

  // 3. Enregistrement avec mot de passe
  $('#act-protect').click(); await wait(300);
  const fields = all('#panel-body input[type=password]'); fields[0].value = 'trombone-2026'; fields[1].value = 'trombone-2026';
  $('#panel-body button').click(); await wait(4500);
  out.protectToast = $('#toast').textContent.slice(0, 40);

  // 4. Ouverture d'un PDF protégé : mauvais mot de passe, puis le bon
  await open('/__protege.pdf', 'protege.pdf');
  out.asked = $('#panel-title').textContent;
  $('#panel-body input').value = 'faux'; $('#panel-body button').click(); await wait(1500);
  out.wrong = $('#toast').textContent;
  $('#panel-body input').value = 'secret-123'; $('#panel-body button').click(); await wait(3000);
  out.unlocked = document.title + ' / ' + all('.page').length + ' pages';

  // 5. Compression d'un scan
  const sizeBefore = await open('/__scan.pdf', 'scan.pdf');
  $('#act-shrink').click(); await wait(4000);
  out.shrinkToast = $('#toast').textContent;
  $('#btn-save').click(); await wait(3000);
  out.saved = window.__saved.map((s) => s.filename + ':' + Math.round(s.b64.length * 0.75));
  out.sizeBefore = sizeBefore;
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
      files.forEach((f, i) => fs.writeFileSync(path.join(OUT, `sec-${i + 1}-${f.filename}`), Buffer.from(f.b64, 'base64')));
      fs.writeFileSync(path.join(OUT, 'capture-security.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ...out, problems }, null, 1));
    } catch (err) { console.error('E2E', err); process.exitCode = 1; }
    server.close(); app.quit();
  });
});
