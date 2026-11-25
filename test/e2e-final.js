// Essai des dernières fonctions dans la version navigateur :
//   xvfb-run npx electron --no-sandbox test/e2e-final.js
// Suggestion de police absente, commentaires, création de champ, OCR en deux langues.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const WEB = path.join(__dirname, '..', 'web');
const OUT = path.join(__dirname, 'out');
const EXTRA = { '/__futura.pdf': path.join(__dirname, 'office', 'futura.pdf'), '/__scan.pdf': path.join(__dirname, 'scans', 'scan.pdf') };
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
  const open = async (url, name) => { const data = new Uint8Array(await (await fetch(url)).arrayBuffer()); window.trombone.openFiles = async () => [{ name, path: null, data }]; $('#btn-open').click(); await wait(2500); };
  out.printButton = !!$('#act-print');

  // 1. Police absente : Futura reconnue, Poppins suggérée
  await open('/__futura.pdf', 'commande.pdf');
  $('[data-tool=edit]').click(); await wait(900);
  const block = all('.page svg .textbox')[1]; const b = block.getBoundingClientRect();
  ptr(block, 'pointerdown', b.left + 5, b.top + 5); ptr(block, 'pointerup', b.left + 5, b.top + 5); await wait(700);
  out.origin = $('.stylebar .origin').textContent + ' | ' + $('.stylebar .origin').title;
  out.suggested = $('.stylebar select').value;
  const area = $('.note.edit'); area.focus(); area.value = 'Livraison prévue le 15 janvier.'; area.dispatchEvent(new Event('input'));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(400);
  out.advice = $('#toast').textContent;
  $('#act-fonts').click(); await wait(500);
  out.fontPanel = all('#panel-body .tag').map((t) => t.textContent).join(' / ');

  // 2. Commentaire, puis champ de texte, puis enregistrement
  const svg = $('.page svg'); const r = svg.getBoundingClientRect();
  $('[data-tool=comment]').click();
  ptr(svg, 'pointerdown', r.left + 400, r.top + 200); await wait(200);
  const note = $('textarea.comment'); note.value = 'À confirmer avec le fournisseur'; note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(300);
  $('#act-field-text').click(); await wait(200);
  ptr(svg, 'pointerdown', r.left + 100, r.top + 400); ptr(svg, 'pointermove', r.left + 380, r.top + 430); ptr(svg, 'pointerup', r.left + 380, r.top + 430); await wait(300);
  out.pending = { notes: all('.page svg .note-icon').length, fields: all('.page svg .annot.field').length };
  $('#btn-save').click(); await wait(4000);
  $('[data-tool=select]').click(); await wait(600);
  out.afterSave = { notes: all('.page svg .note-icon').length, title: $('.page svg .note-icon title') && $('.page svg .note-icon title').textContent, inputs: all('.formLayer input').length };
  $('#act-comments').click(); await wait(300);
  out.listed = all('#panel-body .comment-row p').map((p) => p.textContent);
  all('#panel-body .comment-row button').find((x) => /Supprimer/.test(x.textContent)).click(); await wait(2500);
  out.afterDelete = all('.page svg .note-icon').length;

  // 3. OCR en français et anglais
  await open('/__scan.pdf', 'scan.pdf');
  $('#act-ocr-lang').click(); await wait(300);
  const lang = $('#panel-body select'); lang.value = 'fra+eng'; lang.dispatchEvent(new Event('change')); await wait(200);
  $('#act-ocr').click();
  for (let i = 0; i < 90; i++) { await wait(1000); const t = $('#toast').textContent; if (/reconnue|chou|Aucun/.test(t) && !/…$/.test(t)) break; }
  out.ocr = $('#toast').textContent.slice(0, 60);
  out.saved = window.__saved.map((s) => s.filename);
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
      files.forEach((f, i) => fs.writeFileSync(path.join(OUT, `final-${i + 1}-${f.filename}`), Buffer.from(f.b64, 'base64')));
      fs.writeFileSync(path.join(OUT, 'capture-final.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ...out, problems }, null, 1));
    } catch (err) { console.error('E2E', err); process.exitCode = 1; }
    server.close(); app.quit();
  });
});
