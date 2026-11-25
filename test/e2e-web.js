// Essai de la version navigateur : xvfb-run npx electron --no-sandbox test/e2e-web.js
// Sert web/ en HTTP local, simule la capacité de téléchargement et vérifie ouverture, enregistrement et export ZIP.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const WEB = path.join(__dirname, '..', 'web');
const OUT = path.join(__dirname, 'out');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.pdf': 'application/pdf' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = rel === '/__sample.pdf' ? path.join(OUT, 'annote.pdf') : path.join(WEB, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(WEB) && rel !== '/__sample.pdf') return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', async () => {
    const problems = [];
    const win = new BrowserWindow({ width: 1360, height: 900 });
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') problems.push(`${e.level}: ${e.message}`); });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const run = (code) => win.webContents.executeJavaScript(code, true);
    try {
      await wait(800);
      await run(`(async () => {
        window.__saved = [];
        window.claude = { use: async (name) => name === 'downloads' ? { save: async ({ filename, data }) => {
          const bytes = new Uint8Array(await data.arrayBuffer());
          let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          window.__saved.push({ filename, size: bytes.length, b64: btoa(bin) }); return { status: 'saved' }; } } : null };
        const bytes = await (await fetch('/__sample.pdf')).arrayBuffer();
        const dt = new DataTransfer(); dt.items.add(new File([bytes], 'devis.pdf', { type: 'application/pdf' }));
        document.getElementById('viewer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      })()`);
      await wait(2500);
      const loaded = await run(`({pages: document.querySelectorAll('.page').length, canvases: document.querySelectorAll('.page canvas').length, title: document.title})`);
      await run(`(async () => {
        const fire = (el, type, x, y) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerId: 1, clientX: r.left + x, clientY: r.top + y})); };
        const svg = document.querySelector('.page svg'); svg.setPointerCapture = () => {};
        document.querySelector('[data-tool=edit]').click();
        await new Promise((r) => setTimeout(r, 700));
        const boxes = document.querySelectorAll('.page svg .textbox');
        window.__boxes = boxes.length;
        fire(boxes[1], 'pointerdown', 5, 5); fire(boxes[1], 'pointerup', 5, 5);
        await new Promise((r) => setTimeout(r, 500));
        const field = document.querySelector('.note.edit'); window.__before = field.value; window.__style = field.style.fontFamily + ' / ' + field.style.color;
        field.value = 'Facture numéro 2026-0099, montant réglé.'; field.blur();
        window.__toast = document.getElementById('toast').textContent;
        document.querySelector('[data-tool=ink]').click();
        fire(svg, 'pointerdown', 90, 300); fire(svg, 'pointermove', 200, 340); fire(svg, 'pointermove', 320, 300); fire(svg, 'pointerup', 320, 300);
        document.getElementById('act-export').click();
      })()`);
      await wait(3500);
      await run(`document.getElementById('btn-save').click()`);
      await wait(2500);
      const saved = await run(`window.__saved`);
      for (const s of saved) fs.writeFileSync(path.join(OUT, 'web-' + s.filename), Buffer.from(s.b64, 'base64'));
      const after = await run(`({title: document.title, pages: document.querySelectorAll('.page').length, toast: document.getElementById('toast').textContent, boxes: window.__boxes, before: window.__before, style: window.__style, editToast: window.__toast})`);
      fs.writeFileSync(path.join(OUT, 'capture-web.png'), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ loaded, saved: saved.map(({ filename, size }) => ({ filename, size })), after, problems }, null, 1));
    } catch (err) { console.error('E2E', err); process.exitCode = 1; }
    server.close(); app.quit();
  });
});
