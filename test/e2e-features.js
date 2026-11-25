// Essai des fonctions d'édition avancées dans la version navigateur :
//   xvfb-run npx electron --no-sandbox test/e2e-features.js
// Sélection de texte, annuler / rétablir, organisation des pages, numérotation, filigrane,
// signature, image déplacée et redimensionnée, style du texte, extraction par plage.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const WEB = path.join(__dirname, '..', 'web');
const OUT = path.join(__dirname, 'out');
const SAMPLE = path.join(OUT, 'exemple.pdf');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = rel === '/__sample.pdf' ? SAMPLE : path.join(WEB, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(WEB) && file !== SAMPLE) return res.writeHead(403).end();
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
  const mid = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const firstPageText = async () => { $('[data-tool=select]').click(); await wait(700); return all('.page')[0].querySelector('.textLayer') ? all('.page')[0].querySelector('.textLayer').textContent : ''; };
  const pages = () => all('.page').length;
  const out = {};
  window.__saved = [];
  window.claude = { use: async (name) => name === 'downloads' ? { save: async ({ filename, data }) => {
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.__saved.push({ filename, b64: btoa(bin) }); return { status: 'saved' }; } } : null };
  const bytes = await (await fetch('/__sample.pdf')).arrayBuffer();
  const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dossier.pdf', { type: 'application/pdf' }));
  $('#viewer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await wait(2500);

  // 1. Sélection du texte
  out.selectable = /Document A/.test(await firstPageText());

  // 2. Annuler / rétablir une annotation
  $('[data-tool=ink]').click();
  const svg = $('.page svg'); const r = svg.getBoundingClientRect();
  ptr(svg, 'pointerdown', r.left + 90, r.top + 300); ptr(svg, 'pointermove', r.left + 200, r.top + 340); ptr(svg, 'pointerup', r.left + 200, r.top + 340);
  const annots = () => all('.page svg .annot').length;
  out.undo = [annots()];
  $('#btn-undo').click(); await wait(300); out.undo.push(annots());
  $('#btn-redo').click(); await wait(300); out.undo.push(annots());

  // 3. Descendre la page 1, puis annuler (l'annotation doit revenir avec l'ancien document)
  $('#act-move-down').click(); await wait(1800);
  out.moved = /page 2/.test(await firstPageText());
  $('#btn-undo').click(); await wait(1800);
  out.movedBack = /page 1/.test(await firstPageText()) && annots() === 1;

  // 4. Page blanche, puis annuler
  $('#act-insert-blank').click(); await wait(1800); out.blank = pages();
  $('#btn-undo').click(); await wait(1800); out.blankUndone = pages();

  // 5. Glisser la miniature 3 avant la miniature 1
  const thumbs = all('.thumb'); const move = new DataTransfer();
  thumbs[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: move }));
  const t0 = thumbs[0].getBoundingClientRect();
  thumbs[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: move, clientY: t0.top + 3 }));
  thumbs[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: move, clientY: t0.top + 3 }));
  await wait(1800);
  out.dragged = /page 3/.test(await firstPageText());
  $('#btn-undo').click(); await wait(1800);

  // 6. Numérotation et filigrane
  $('#act-number').click(); await wait(1800);
  out.numbered = /1 \\/ 3/.test(await firstPageText());
  $('#act-watermark').click(); await wait(300);
  $('#panel-body input').value = 'BROUILLON'; $('#panel-body button').click(); await wait(1800);
  out.watermark = /BROUILLON/.test(await firstPageText());

  // 7. Signature dessinée, déplacée puis redimensionnée
  $('#act-sign').click(); await wait(300);
  const pad = $('canvas.pad'); const p = pad.getBoundingClientRect();
  ptr(pad, 'pointerdown', p.left + 40, p.top + 60);
  for (let i = 1; i <= 12; i++) ptr(pad, 'pointermove', p.left + 40 + i * 12, p.top + 60 + Math.sin(i) * 25);
  ptr(pad, 'pointerup', p.left + 190, p.top + 60);
  all('#panel-body button').find((b) => /Insérer/.test(b.textContent)).click(); await wait(800);
  const box = () => { const i = $('.annot.image image'); return i ? ['x', 'y', 'width', 'height'].map((k) => Math.round(Number(i.getAttribute(k)))) : null; };
  const before = box();
  let pic = $('.annot.image image'); let [cx, cy] = mid(pic); const sv = () => $('.annot.image').closest('svg');
  ptr(pic, 'pointerdown', cx, cy); ptr(sv(), 'pointermove', cx + 120, cy + 180); ptr(sv(), 'pointerup', cx + 120, cy + 180); await wait(300);
  const movedTo = box();
  const handle = $('.annot.image .handle'); [cx, cy] = mid(handle);
  ptr(handle, 'pointerdown', cx, cy); ptr(sv(), 'pointermove', cx + 60, cy + 10); ptr(sv(), 'pointerup', cx + 60, cy + 10); await wait(300);
  out.signature = { before, movedTo, resized: box() };

  // 8. Style du texte : bloc passé en machine à écrire, gras
  $('[data-tool=edit]').click(); await wait(900);
  const block = all('.page svg .textbox')[1]; const [bx, by] = mid(block);
  ptr(block, 'pointerdown', bx, by); ptr(block, 'pointerup', bx, by); await wait(600);
  out.stylebar = !!$('.stylebar');
  const select = $('.stylebar select'); select.value = 'mono'; select.dispatchEvent(new Event('change')); await wait(500);
  all('.stylebar button').find((b) => b.textContent === 'G').click(); await wait(400);
  const area = $('.note.edit'); area.focus(); area.value = 'Facture réglée le 12 novembre.'; area.dispatchEvent(new Event('input'));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(400);
  out.styled = all('.annot.edit text').map((t) => t.getAttribute('font-family').split(',')[0] + '/' + t.getAttribute('font-weight'))[0];

  // 9. Extraction des pages 2 à 3
  $('#act-extract').click(); await wait(300);
  $('#panel-body input').value = '2-3'; $('#panel-body button').click(); await wait(2500);

  // 10. Enregistrement
  $('#btn-save').click(); await wait(3500);
  out.saved = window.__saved.map((s) => s.filename);
  out.toast = $('#toast').hidden ? '' : $('#toast').textContent;
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
      for (const f of files) fs.writeFileSync(path.join(OUT, 'feat-' + f.filename), Buffer.from(f.b64, 'base64'));
      fs.writeFileSync(path.join(OUT, 'capture-features.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ...out, problems }, null, 1));
    } catch (err) { console.error('E2E', err); process.exitCode = 1; }
    server.close(); app.quit();
  });
});
