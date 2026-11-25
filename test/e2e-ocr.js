// Essai de l'OCR dans la version navigateur : xvfb-run npx electron --no-sandbox test/e2e-ocr.js
// Ouvre un PDF scanné, lance la reconnaissance, modifie une ligne, enregistre et contrôle le résultat.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const WEB = path.join(__dirname, '..', 'web');
const OUT = path.join(__dirname, 'out');
const SCAN = path.join(__dirname, 'scans', process.env.TROMBONE_SCAN || 'scan.pdf');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.txt': 'text/plain' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = rel === '/__scan.pdf' ? SCAN : path.join(WEB, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(WEB) && file !== SCAN) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', async () => {
    const problems = [];
    const win = new BrowserWindow({ width: 1360, height: 900 });
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') problems.push(`${e.level}: ${e.message}`.slice(0, 300)); });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const run = (code) => win.webContents.executeJavaScript(code, true);
    try {
      fs.mkdirSync(OUT, { recursive: true });
      await wait(800);
      await run(`(async () => {
        window.__saved = [];
        window.claude = { use: async (name) => name === 'downloads' ? { save: async ({ filename, data }) => {
          const bytes = new Uint8Array(await data.arrayBuffer());
          let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          window.__saved.push({ filename, b64: btoa(bin) }); return { status: 'saved' }; } } : null };
        const bytes = await (await fetch('/__scan.pdf')).arrayBuffer();
        const dt = new DataTransfer(); dt.items.add(new File([bytes], 'scan.pdf', { type: 'application/pdf' }));
        document.getElementById('viewer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      })()`);
      await wait(2500);
      const started = Date.now();
      await run(process.env.TROMBONE_AUTO ? `document.querySelector('[data-tool=edit]').click()` : `document.getElementById('act-ocr').click()`);
      let toast = '';
      for (let i = 0; i < 120; i++) {
        await wait(1000);
        toast = await run(`document.getElementById('toast').textContent`);
        if (/reconnue|Aucun texte|déjà du texte|pu être|rror/i.test(toast) && !/…$/.test(toast)) break;
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      if (process.env.TROMBONE_WORD) { await run(`document.getElementById('act-word').click()`); await wait(5000); }
      await wait(1500);
      const edit = await run(`(async () => {
        const fire = (el, type, x, y) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerId: 1, clientX: r.left + x, clientY: r.top + y})); };
        document.querySelector('[data-tool=edit]').click();
        await new Promise((r) => setTimeout(r, 900));
        window.__hint = document.getElementById('toast').textContent;
        const boxes = [...document.querySelectorAll('.page svg .textbox')];
        const target = boxes[${Number(process.env.TROMBONE_BLOCK || 0)}];
        const at = (el, type, ox = 0, oy = 0) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerId: 1, clientX: r.left + r.width / 2 + ox, clientY: r.top + r.height / 2 + oy})); };
        let guides = null;
        if (${process.env.TROMBONE_MOVE ? 'true' : 'false'}) {
          // Glisser le bloc : légèrement de travers d'abord (l'aimantation doit le recaler), puis franchement.
          const mover = boxes[boxes.length - 1];
          at(mover, 'pointerdown'); at(mover, 'pointermove', 3, 40); at(mover, 'pointermove', 3, 40);
          guides = document.querySelectorAll('.page svg .guide').length;
          at(mover, 'pointermove', 180, 90); at(mover, 'pointerup', 180, 90);
          await new Promise((r) => setTimeout(r, 2500));
          window.__moved = document.querySelectorAll('.page svg .annot.edit image').length;
        }
        const live = document.querySelectorAll('.page svg .textbox')[${Number(process.env.TROMBONE_BLOCK || 0)}] || target;
        at(live, 'pointerdown'); at(live, 'pointerup');
        await new Promise((r) => setTimeout(r, 500));
        const field = document.querySelector('.note.edit'); const before = field.value;
        field.value = ${process.env.TROMBONE_BLOCK ? "field.value + ' Texte ajouté pour vérifier le retour à la ligne automatique dans le bloc, sans chevauchement avec le reste.'" : "'Devis n° 2026-000'"}; field.dispatchEvent(new Event('input')); field.blur();
        await new Promise((r) => setTimeout(r, 150));
        // Reprise de la ligne déjà modifiée.
        const done = [...document.querySelectorAll('.page svg .annot.edit')].find((g) => !g.querySelector('image')); const dr = done.getBoundingClientRect();
        for (const type of ['pointerdown', 'pointerup']) done.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerId: 1, clientX: dr.left + dr.width / 2, clientY: dr.top + dr.height / 2}));
        await new Promise((r) => setTimeout(r, 500));
        const second = document.querySelector('.note.edit'); const reopened = second.value;
        second.value = ${process.env.TROMBONE_BLOCK ? "second.value + ' Fin.'" : "'Devis n° 2026-999'"}; second.blur();
        await new Promise((r) => setTimeout(r, 150));
        const edits = document.querySelectorAll('.page svg .annot.edit').length;
        return { reopened, edits, guides, movedImages: window.__moved, boxes: boxes.length, hint: window.__hint, before, toast: document.getElementById('toast').textContent };
      })()`);
      await wait(300);
      fs.writeFileSync(path.join(OUT, `capture-${path.basename(SCAN, '.pdf')}.png`), (await win.webContents.capturePage()).toPNG());
      await run(`document.getElementById('btn-save').click()`);
      await wait(4000);
      const saved = await run(`window.__saved`);
      for (const s of saved) fs.writeFileSync(path.join(OUT, 'ocr-' + (/\.pdf$/.test(s.filename) ? path.basename(SCAN) : s.filename)), Buffer.from(s.b64, 'base64'));
      console.log(JSON.stringify({ seconds, toast, edit, saved: saved.map((s) => s.filename), problems }, null, 1));
    } catch (err) { console.error('E2E', err); process.exitCode = 1; }
    server.close(); app.quit();
  });
});
